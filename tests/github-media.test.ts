import assert from "node:assert/strict";
import test from "node:test";
import { appendUploadedMedia, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, repositoryId, uploadUserAttachment, validateUploadBlob } from "../src/background/github";
import { normalizePendingAssetDeletes, normalizeSession } from "../src/background/state";
import { draftIsLocked, MAX_RECORDING_MS, resolvePublishRepo, validRecordingRef } from "../src/shared/pure";

test("recording metadata enforces UUID, byte, MIME, and one-minute bounds", () => {
  const valid = { id: "00000000-0000-4000-8000-000000000000", mimeType: "video/webm", byteSize: 1, durationMs: MAX_RECORDING_MS, createdAt: 1 };
  assert.equal(validRecordingRef(valid, 1), true);
  assert.equal(validRecordingRef({ ...valid, durationMs: MAX_RECORDING_MS + 501 }, 1), false);
  assert.equal(validRecordingRef({ ...valid, byteSize: MAX_VIDEO_BYTES + 1 }, 1), false);
  assert.equal(validRecordingRef({ ...valid, mimeType: "video/mp4" }, 1), false);
});

test("media validation enforces type, non-empty bytes, and documented client bounds", () => {
  assert.equal(validateUploadBlob(new Blob(["x"], { type: "image/jpeg" }), "image/jpeg"), "image");
  assert.equal(validateUploadBlob(new Blob(["x"], { type: "video/webm;codecs=vp8" }), "video/webm"), "video");
  assert.throws(() => validateUploadBlob(new Blob([], { type: "image/jpeg" }), "image/jpeg"), /empty or missing/);
  assert.throws(() => validateUploadBlob(new Blob(["x"], { type: "image/png" }), "image/jpeg"), /Only Product Pass/);
  class SizedBlob extends Blob { constructor(type: string, private readonly declaredSize: number) { super(["x"], { type }); } override get size(): number { return this.declaredSize; } }
  assert.throws(() => validateUploadBlob(new SizedBlob("image/jpeg", MAX_IMAGE_BYTES + 1), "image/jpeg"), /10 MiB/);
  assert.throws(() => validateUploadBlob(new SizedBlob("video/webm", MAX_VIDEO_BYTES + 1), "video/webm"), /100 MiB/);
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_VIDEO_BYTES, 100 * 1024 * 1024);
});

test("upload uses the GitHub CLI raw attachment contract and validates the result", async () => {
  const blob = new Blob(["jpeg"], { type: "image/jpeg" });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://uploads.github.com/user-attachments/assets");
    assert.equal(url.searchParams.get("name"), "unsafe-name.jpg");
    assert.equal(url.searchParams.get("content_type"), "image/jpeg");
    assert.equal(url.searchParams.get("repository_id"), "42");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Accept, "application/vnd.github+json");
    assert.equal((init?.headers as Record<string, string>).Authorization, "token secret");
    assert.equal((init?.headers as Record<string, string>)["Content-Type"], "application/octet-stream");
    assert.equal(init?.body, blob);
    return new Response(JSON.stringify({ url: "https://github.com/user-attachments/assets/abc" }), { status: 201 });
  };
  assert.equal(await uploadUserAttachment(42, "../unsafe name.png", "image/jpeg", blob, "secret", fetcher), "https://github.com/user-attachments/assets/abc");
  await assert.rejects(() => uploadUserAttachment(42, "a.jpg", "image/jpeg", blob, "secret", async () => new Response(JSON.stringify({ url: "https://evil.test/file" }), { status: 201 })), /invalid asset URL/);
  await assert.rejects(() => uploadUserAttachment(42, "a.jpg", "image/jpeg", blob, "secret", async () => { throw new Error("offline"); }), /orphaned attachment/);
});

test("repository metadata requires a positive id and optional push access", async () => {
  assert.equal(await repositoryId("owner/repo", "token", async () => new Response(JSON.stringify({ id: 123, permissions: { push: true } }), { status: 200 })), 123);
  await assert.rejects(() => repositoryId("owner/repo", "token", async () => new Response(JSON.stringify({ id: 123, permissions: { push: false } }), { status: 200 })), /write permission/);
});

test("attachment markdown preserves order, escapes alt text, and deduplicates ids", () => {
  const body = appendUploadedMedia("Issue body", [
    { id: "one", kind: "image", name: "bad[alt].jpg", url: "https://github.com/user-attachments/assets/one" },
    { id: "one", kind: "image", name: "duplicate.jpg", url: "https://github.com/user-attachments/assets/other" },
    { id: "two", kind: "video", name: "clip.webm", url: "https://github.com/user-attachments/assets/two" }
  ]);
  assert.equal(body, "Issue body\n\n## Attached evidence\n\n![bad\\[alt\\]](https://github.com/user-attachments/assets/one)\n\nhttps://github.com/user-attachments/assets/two");
  assert.throws(() => appendUploadedMedia("body", [{ id: "x", kind: "image", name: "x.jpg", url: "https://evil.test/x" }]), /Invalid uploaded media/);
});

test("legacy sessions normalize recordings and upload state without data loss", () => {
  const legacy = { id: "s", title: "Old", status: "capturing", annotations: [], drafts: [{ id: "d", sessionId: "s", title: "T", body: "B", sourceAnnotationIds: [], decision: "review", publishState: "not-published", createdAt: 1, updatedAt: 1 }], createdAt: 1, updatedAt: 1 };
  const normalized = normalizeSession(legacy as never);
  assert.deepEqual(normalized.recordings, []);
  assert.equal(normalized.drafts[0].uploadMedia, false);
  assert.deepEqual(normalized.drafts[0].uploadedMedia, {});
  assert.equal(normalized.drafts[0].publishRepo, undefined);
  assert.deepEqual(normalizePendingAssetDeletes(undefined), { screenshots: [], media: [] });
  assert.deepEqual(normalizePendingAssetDeletes({ screenshots: ["one", "one", 2], media: ["two"] }), { screenshots: ["one"], media: ["two"] });
});

test("unknown publication is locked and remains bound to its recorded repository", () => {
  assert.equal(draftIsLocked({ publishState: "unknown" }), true);
  assert.equal(draftIsLocked({ publishState: "failed" }), false);
  const unknown = { publishState: "unknown" as const, publishRepo: "owner/original", uploadedMedia: {}, uploadedMediaRepo: undefined };
  assert.equal(resolvePublishRepo(unknown, "owner/original"), "owner/original");
  assert.throws(() => resolvePublishRepo(unknown, "owner/other"), /owner\/original/);
  assert.throws(() => resolvePublishRepo({ ...unknown, publishRepo: undefined }, "owner/original"), /no recorded repository/);
  const failedWithUpload = { publishState: "failed" as const, publishRepo: "owner/original", uploadedMedia: { media: "https://github.com/user-attachments/assets/x" }, uploadedMediaRepo: "owner/original" };
  assert.throws(() => resolvePublishRepo(failedWithUpload, "owner/other"), /Switch back/);
  assert.equal(resolvePublishRepo({ ...failedWithUpload, uploadedMedia: {} }, "owner/other"), "owner/other");
});
