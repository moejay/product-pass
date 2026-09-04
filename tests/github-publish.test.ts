import assert from "node:assert/strict";
import test from "node:test";
import type { IssueDraft } from "../src/shared/model";
import { publish } from "../src/background/github";
import { githubMarker, validRepo } from "../src/shared/pure";

const draft: IssueDraft = { id: "d1", sessionId: "s1", title: "Issue title", body: "Issue body", sourceAnnotationIds: ["n1"], decision: "accepted", publishState: "not-published", createdAt: 1, updatedAt: 1 };

test("GitHub marker is stable and repository validation is narrow", () => {
  assert.equal(githubMarker("s1", "d1"), "<!-- product-pass:s1:d1 -->");
  assert.equal(validRepo("owner/repo"), true);
  assert.equal(validRepo("owner/repo/issues"), false);
});

test("publish appends marker without exposing token in body", async t => {
  let request: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/owner/repo/issues/7" }), { status: 201, headers: { "Content-Type": "application/json" } });
  });
  const result = await publish("owner/repo", draft, "secret-token");
  const body = String(request?.body);
  assert.match(body, /product-pass:s1:d1/);
  assert.doesNotMatch(body, /secret-token/);
  assert.equal(result.number, 7);
});

test("ambiguous GitHub server errors require reconciliation before retry", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("upstream failed", { status: 502 }));
  await assert.rejects(() => publish("owner/repo", draft, "token"), /^Error: UNKNOWN:GitHub request failed \(502\)/);
});

test("unknown publication reconciles marker before creating", async t => {
  const unknown = { ...draft, publishState: "unknown" as const };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify([{ number: 8, html_url: "https://github.com/owner/repo/issues/8", body: `Created\n${githubMarker("s1", "d1")}` }]), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const result = await publish("owner/repo", unknown, "token");
  assert.equal(result.number, 8);
  assert.equal(calls, 1);
});
