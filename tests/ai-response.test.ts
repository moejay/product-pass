import assert from "node:assert/strict";
import test from "node:test";
import type { Annotation } from "../src/shared/model";
import { parseAIContent, validateCompleteAssignments } from "../src/shared/pure";

const notes = ["n1", "n2", "n3"].map((id): Annotation => ({ id, sessionId: "s", kind: "freehand", url: "https://example.test", safeUrl: "https://example.test/", pageTitle: "Test", text: id, contextLabel: "", anchor: { kind: "freehand", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], bounds: { x: 0, y: 0, width: 20, height: 20 } }, createdAt: 1, updatedAt: 1 }));

test("AI parser accepts fenced JSON and complete multi-note assignments", () => {
  const content = '```json\n{"drafts":[{"title":"One","body":"Body one","sourceAnnotationIds":["n1","n3"]},{"title":"Two","body":"Body two","sourceAnnotationIds":["n2"]}]}\n```';
  const drafts = validateCompleteAssignments(parseAIContent(content, notes, "s", 10), notes);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0].sourceAnnotationIds, ["n1", "n3"]);
  assert.equal(drafts[0].decision, "review");
});

test("AI parser rejects unknown and duplicate assignments", () => {
  assert.throws(() => parseAIContent('{"drafts":[{"title":"One","body":"Body","sourceAnnotationIds":["missing"]}]}', notes, "s"), /unknown or duplicate/);
  assert.throws(() => parseAIContent('{"drafts":[{"title":"One","body":"Body","sourceAnnotationIds":["n1","n1"]}]}', notes, "s"), /unknown or duplicate/);
});

test("complete validation rejects omitted notes", () => {
  const drafts = parseAIContent('{"drafts":[{"title":"One","body":"Body","sourceAnnotationIds":["n1"]}]}', notes, "s");
  assert.throws(() => validateCompleteAssignments(drafts, notes), /every note exactly once/);
});
