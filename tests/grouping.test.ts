import assert from "node:assert/strict";
import test from "node:test";
import type { Annotation } from "../src/shared/model";
import { annotationRevision, appendSourceEvidence, deterministicDrafts, originPattern, safeUrl } from "../src/shared/pure";

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
  assert.match(enriched, /Screenshot: captured locally/);
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
