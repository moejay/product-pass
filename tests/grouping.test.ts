import assert from "node:assert/strict";
import test from "node:test";
import type { Annotation } from "../src/shared/model";
import { annotationRevision, appendSourceEvidence, assertMediaUploadCanChange, assertSessionDeletable, assertSessionMutable, deterministicDrafts, originPattern, safeUrl } from "../src/shared/pure";

function note(id: string, url: string, text = ""): Annotation {
  return { id, sessionId: "s1", kind: "element", url, safeUrl: safeUrl(url), pageTitle: "Page", text, contextLabel: "button", anchor: { kind: "element", selector: "button", quote: "button", rect: { x: 0, y: 0, width: 20, height: 20 } }, createdAt: 1, updatedAt: 1 };
}

test("safeUrl strips credentials, query, and fragment", () => {
  assert.equal(safeUrl("https://user:pass@example.com/path?q=secret#state"), "https://example.com/path");
  assert.equal(originPattern("https://example.com/path"), "https://example.com/*");
  assert.equal(originPattern("about:config"), null);
});

test("origin permission patterns omit ports while revisions detect note changes", () => {
  assert.equal(originPattern("http://localhost:3000/review"), "http://localhost/*");
  assert.equal(originPattern("https://example.com:8443/path"), "https://example.com/*");
  const original = note("a", "https://a.test", "one");
  assert.notEqual(annotationRevision([original]), annotationRevision([{ ...original, updatedAt: 2 }]));
});

test("source evidence guarantees page and selected-element details", () => {
  const source = { ...note("a", "https://example.test/page?private=1", "Broken"), screenshot: { id: "a", mimeType: "image/jpeg" as const, width: 100, height: 80, createdAt: 1 } };
  const draft = deterministicDrafts([source], "s1", 10)[0];
  const enriched = appendSourceEvidence([draft], [source])[0].body;
  assert.match(enriched, /## Source evidence/);
  assert.match(enriched, /Page: <https:\/\/example\.test\/page>/);
  assert.match(enriched, /Selector: `button`/);
  assert.match(enriched, /Screenshot: stored locally.*explicitly enabled/);
});

test("source evidence includes video timestamps and explicit upload behavior", () => {
  const source: Annotation = { ...note("v", "https://example.test/video", "Button fails after loading"), kind: "video", contextLabel: "Recording at 0:12", anchor: { kind: "video", recordingId: "00000000-0000-4000-8000-000000000000", timestampMs: 12_345 } };
  const draft = deterministicDrafts([source], "s1", 10)[0];
  const enriched = appendSourceEvidence([draft], [source])[0].body;
  assert.match(enriched, /Annotation: video timestamp/);
  assert.match(enriched, /Recording timestamp: 0:12/);
  assert.match(enriched, /Recording: stored locally.*explicitly enabled/);
  assert.equal(draft.uploadMedia, false);
});

test("source mutations are blocked while a draft is publishing", () => {
  const issue = deterministicDrafts([note("lock", "https://example.test", "Lock")], "s1", 1)[0];
  assert.doesNotThrow(() => assertSessionMutable({ drafts: [issue] }));
  assert.throws(() => assertSessionMutable({ drafts: [{ ...issue, publishState: "publishing" }] }), /publication to finish/);
  assert.throws(() => assertSessionMutable({ drafts: [{ ...issue, publishState: "unknown" }] }), /Reconcile the unknown/);
});

test("partial GitHub uploads cannot be detached or erased with source mutations", () => {
  const issue = { ...deterministicDrafts([note("partial", "https://example.test", "Partial")], "s1", 1)[0], publishState: "failed" as const, uploadedMedia: { media: "https://github.com/user-attachments/assets/x" } };
  assert.doesNotThrow(() => assertMediaUploadCanChange({ uploadedMedia: {} }, false));
  assert.throws(() => assertMediaUploadCanChange(issue, false), /must remain attached/);
  assert.throws(() => assertSessionMutable({ drafts: [issue] }), /already-uploaded files/);
  assert.doesNotThrow(() => assertSessionDeletable({ drafts: [issue] }));
});

test("fallback groups all notes deterministically by hostname", () => {
  const drafts = deterministicDrafts([
    note("a", "https://one.test/a", "First"),
    note("b", "https://one.test/b"),
    note("c", "https://two.test/c", "Third")
  ], "s1", 10);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0].sourceAnnotationIds, ["a", "b"]);
  assert.deepEqual(drafts[1].sourceAnnotationIds, ["c"]);
  assert.match(drafts[0].body, /No text|Element annotation/);
});
