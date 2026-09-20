import assert from "node:assert/strict";
import test from "node:test";
import { blobCrc32, buildRawManifest, encodeRawPrefix, MAX_RAW_HEADER_BYTES, parseRawCaptureHeader, projectImportedRawSession, RAW_MAGIC, remapRawCapture, validRawAssetBlob } from "../src/shared/raw-capture";
import type { RawAsset } from "../src/shared/raw-capture";
import type { ReviewSession } from "../src/shared/model";

const sessionId = "11111111-1111-4111-8111-111111111111"; const noteId = "22222222-2222-4222-8222-222222222222"; const shotId = "33333333-3333-4333-8333-333333333333"; const recordingId = "44444444-4444-4444-8444-444444444444";
function session(): ReviewSession { return { id: sessionId, title: "Raw review", status: "reviewing", createdAt: 1, updatedAt: 2, drafts: [{ id: "draft", sessionId, title: "Secret", body: "not portable", sourceAnnotationIds: [], decision: "accepted", publishState: "published", createdAt: 1, updatedAt: 1 }], recordings: [{ id: recordingId, mimeType: "video/webm", byteSize: 5, durationMs: 100, createdAt: 1 }], annotations: [{ id: noteId, sessionId, kind: "element", url: "https://user:pass@example.test/path?q=secret#fragment", safeUrl: "wrong", pageTitle: "Page", text: "Note", contextLabel: "button", anchor: { kind: "element", selector: "button", quote: "Button", rect: { x: 1, y: 2, width: 3, height: 4, ignored: true } as never }, screenshot: { id: shotId, mimeType: "image/jpeg", width: 3, height: 2, createdAt: 1 }, createdAt: 1, updatedAt: 2 }, { id: "55555555-5555-4555-8555-555555555555", sessionId, kind: "video", url: "", safeUrl: "", pageTitle: "Recording", text: "At ten", contextLabel: "Recording", anchor: { kind: "video", recordingId, timestampMs: 10 }, createdAt: 1, updatedAt: 2 }] }; }
async function assets(): Promise<{ assets: RawAsset[]; payload: Uint8Array }> { const image = new Uint8Array([0xff, 0xd8, 0xff]); const video = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x55]); return { assets: [{ sourceId: shotId, kind: "screenshot", mimeType: "image/jpeg", byteSize: image.length, crc32: await blobCrc32(new Blob([image], { type: "image/jpeg" })) }, { sourceId: recordingId, kind: "recording", mimeType: "video/webm", byteSize: video.length, crc32: await blobCrc32(new Blob([video], { type: "video/webm" })) }], payload: new Uint8Array([...image, ...video]) }; }
async function parsed() { const source = await assets(); const manifest = buildRawManifest(session(), source.assets, 3); const prefix = encodeRawPrefix(manifest); const archive = new Uint8Array(prefix.length + source.payload.length); archive.set(prefix); archive.set(source.payload, prefix.length); return parseRawCaptureHeader(archive, archive.length); }
test("raw capture excludes drafts and sanitizes URLs while projecting geometry", async () => {
  const value = await parsed(); const note = value.manifest.session.annotations[0]; assert.equal("drafts" in value.manifest.session, false); assert.equal(note.url, "https://example.test/path"); assert.equal(note.safeUrl, "https://example.test/path"); assert.deepEqual(note.anchor.kind === "element" ? note.anchor.rect : undefined, { x: 1, y: 2, width: 3, height: 4 });
  let count = 0; const remapped = remapRawCapture(value.manifest, () => `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`); assert.equal(remapped.session.status, "capturing"); assert.deepEqual(remapped.session.drafts, []); assert.notEqual(remapped.session.id, sessionId); assert.notEqual(remapped.session.annotations[0].id, noteId); assert.notEqual(remapped.session.annotations[0].screenshot!.id, shotId); assert.notEqual((remapped.session.annotations[1].anchor as { recordingId: string }).recordingId, recordingId);
});
test("raw parser rejects corruption, duplicate/dangling assets, and malformed bounds", async () => {
  const value = await parsed(); const prefix = encodeRawPrefix(value.manifest); assert.throws(() => parseRawCaptureHeader(new Uint8Array([1, ...prefix]), prefix.length + 1), /magic/); assert.throws(() => parseRawCaptureHeader(prefix, prefix.length), /payload length/);
  const duplicate = structuredClone(value.manifest); duplicate.assets.push({ ...duplicate.assets[0] }); const duplicatePrefix = encodeRawPrefix(duplicate); assert.throws(() => parseRawCaptureHeader(duplicatePrefix, duplicatePrefix.length + duplicate.assets.reduce((sum, asset) => sum + asset.byteSize, 0)), /duplicate assets/);
  const bad = structuredClone(value.manifest); (bad.session.annotations[1].anchor as { timestampMs: number }).timestampMs = 101; const badPrefix = encodeRawPrefix(bad); assert.throws(() => parseRawCaptureHeader(badPrefix, badPrefix.length + bad.assets.reduce((sum, asset) => sum + asset.byteSize, 0)), /recording timestamp/);
});
test("background import projection drops untrusted fields and validates exact references", async () => {
  const source = await parsed(); const remapped = remapRawCapture(source.manifest); const input = structuredClone(remapped.session) as ReviewSession & { ignored?: string }; input.ignored = "discard"; (input.annotations[0].anchor as { rect?: Record<string, unknown> }).rect!.unknown = "discard";
  const projected = projectImportedRawSession(input, remapped.assets); assert.equal("ignored" in projected, false); assert.deepEqual(projected.annotations[0].anchor.kind === "element" ? projected.annotations[0].anchor.rect : undefined, { x: 1, y: 2, width: 3, height: 4 });
  (input.annotations[1].anchor as { timestampMs: number }).timestampMs = 101; assert.throws(() => projectImportedRawSession(input, remapped.assets), /recording timestamp/);
});

test("raw capture supports notes-only archives with no media", () => {
  const value = session(); value.recordings = []; value.annotations = [value.annotations[0]]; delete value.annotations[0].screenshot;
  const manifest = buildRawManifest(value, [], 3); const prefix = encodeRawPrefix(manifest); const parsed = parseRawCaptureHeader(prefix, prefix.byteLength); const remapped = remapRawCapture(parsed.manifest, () => crypto.randomUUID());
  assert.equal(parsed.manifest.assets.length, 0); assert.equal(remapped.session.annotations.length, 1); assert.deepEqual(remapped.session.recordings, []);
});

test("raw asset CRC catches same-size later-byte corruption", async () => {
  const source = await assets(); const valid = new Blob([source.payload.slice(3)], { type: "video/webm" }); assert.equal(await validRawAssetBlob(source.assets[1], valid), true); const corrupted = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x56])], { type: "video/webm" }); assert.equal(await validRawAssetBlob(source.assets[1], corrupted), false);
});
test("header preflight rejects an oversized declared header before file slicing", () => {
  const prefix = new Uint8Array(12); prefix.set(RAW_MAGIC); new DataView(prefix.buffer).setUint32(8, MAX_RAW_HEADER_BYTES + 1, true); assert.throws(() => parseRawCaptureHeader(prefix, prefix.length), /header length/);
});
