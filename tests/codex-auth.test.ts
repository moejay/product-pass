import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_PUBLIC_CLIENT_ID,
  exchangeCodexCode,
  parseCodexJwt,
  parseCodexPollResponse,
  parseCodexTokenResponse,
  parseCodexUserCode,
  pkceS256,
  requestCodexRefresh,
  requestCodexUserCode,
  verifyReturnedPkce
} from "../src/background/codex-auth";
import { parseCodexJsonResponse, parseCodexSseEvents, readCodexResponse, readCodexSse, requestCodexWithRefresh } from "../src/background/codex";
import type { CodexTokens } from "../src/background/codex-auth";

function jwt(exp: number, accountId = "account-123"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`;
}
const tokens = (accessToken = jwt(4_000_000_000)): CodexTokens => ({ accessToken, refreshToken: "refresh-old", idToken: "id-old", expiresAt: 4_000_000_000_000, accountId: "account-123" });

test("Codex device user-code protocol is pinned to official JSON endpoint and fields", async () => {
  let url = ""; let request: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    url = String(input); request = init;
    return new Response(JSON.stringify({ device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: "5" }), { status: 200 });
  };
  const pending = await requestCodexUserCode(fetcher, 1_000);
  assert.equal(url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.deepEqual(JSON.parse(String(request?.body)), { client_id: CODEX_PUBLIC_CLIENT_ID });
  assert.equal(pending.verificationUri, "https://auth.openai.com/codex/device");
  assert.equal(pending.expiresAt, 901_000);
  assert.equal(pending.nextPollAt, 6_000);
  assert.throws(() => parseCodexUserCode({ device_auth_id: "id", user_code: "code", interval: "0" }), /polling interval/);
  assert.equal(parseCodexPollResponse({ authorization_code: "code", code_challenge: "challenge", code_verifier: "verifier" }).kind, "code");
});

test("Codex returned PKCE is verified and token exchange uses the pinned callback", async () => {
  const verifier = "test-verifier"; const challenge = await pkceS256(verifier);
  await verifyReturnedPkce(verifier, challenge);
  await assert.rejects(() => verifyReturnedPkce(verifier, "wrong"), /inconsistent PKCE/);
  let body = "";
  const fetcher: typeof fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ access_token: jwt(4_000_000_000), refresh_token: "refresh", id_token: "header.payload.signature" }), { status: 200 });
  };
  const exchanged = await exchangeCodexCode({ kind: "code", authorizationCode: "authorization", codeChallenge: challenge, codeVerifier: verifier }, fetcher);
  const params = new URLSearchParams(body);
  assert.equal(params.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
  assert.equal(params.get("client_id"), CODEX_PUBLIC_CLIENT_ID);
  assert.equal(params.get("code_verifier"), verifier);
  assert.equal(exchanged.accountId, "account-123");
});

test("Codex JWT parsing is defensive and uses only the namespaced routing claim", () => {
  assert.deepEqual(parseCodexJwt(jwt(2_000_000_000, "route-1")), { expiresAt: 2_000_000_000_000, accountId: "route-1" });
  assert.throws(() => parseCodexJwt("not-a-jwt"), /invalid JWT/);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.throws(() => parseCodexJwt(`a.${encode({ exp: "tomorrow" })}.c`), /valid expiry/);
  assert.throws(() => parseCodexTokenResponse({ access_token: jwt(1, "route"), refresh_token: "r", id_token: "i" }, undefined, 2_000), /expired/);
});

test("refresh uses JSON grant and preserves omitted rotated fields", async () => {
  let request: RequestInit | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    request = init;
    return new Response(JSON.stringify({ access_token: jwt(4_100_000_000), id_token: "id-new" }), { status: 200 });
  };
  const refreshed = await requestCodexRefresh(tokens(), fetcher);
  assert.deepEqual(JSON.parse(String(request?.body)), { client_id: CODEX_PUBLIC_CLIENT_ID, grant_type: "refresh_token", refresh_token: "refresh-old" });
  assert.equal(refreshed.refreshToken, "refresh-old");
  assert.equal(refreshed.idToken, "id-new");
  assert.equal(refreshed.expiresAt, 4_100_000_000_000);
});

test("SSE parser joins deltas, requires completion, and rejects malformed/failure events", async () => {
  const blocks = [
    'data: {"type":"response.output_text.delta","delta":"{\\"drafts\\":"}',
    'data: {"type":"response.output_text.delta","delta":"[]}"}',
    'data: {"type":"response.completed"}'
  ];
  assert.deepEqual(parseCodexSseEvents(blocks), { text: '{"drafts":[]}', completed: true });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(blocks.join("\n\n"))); controller.close(); } });
  assert.equal(await readCodexSse(new Response(stream)), '{"drafts":[]}');
  await assert.rejects(() => readCodexSse(new Response('data: {"type":"response.output_text.delta","delta":"x"}\n\n')), /before completion/);
  assert.throws(() => parseCodexSseEvents(['data: {"type":"response.failed"}']), /could not complete/);
});

test("Codex response detection tolerates rewritten content types and completed JSON", async () => {
  const sse = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed"}\n\n';
  assert.equal(await readCodexResponse(new Response(sse, { headers: { "content-type": "application/octet-stream" } })), "ok");
  const json = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: '{"drafts":[]}' }] }] });
  assert.equal(parseCodexJsonResponse(json), '{"drafts":[]}');
  assert.equal(await readCodexResponse(new Response(json, { headers: { "content-type": "application/json" } })), '{"drafts":[]}');
});

test("Codex Responses request retries exactly once after 401 with refreshed auth selection", async () => {
  const forceValues: Array<boolean | undefined> = []; const authHeaders: string[] = [];
  const tokenGetter = async (force?: boolean) => { forceValues.push(force); return tokens(force ? jwt(4_200_000_000, "account-new") : jwt(4_000_000_000)); };
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++; authHeaders.push((init?.headers as Record<string, string>).Authorization);
    return new Response("", { status: calls === 1 ? 401 : 200 });
  };
  const response = await requestCodexWithRefresh("prompt", "model", tokenGetter, fetcher);
  assert.equal(response.status, 200);
  assert.deepEqual(forceValues, [false, true]);
  assert.equal(calls, 2);
  assert.notEqual(authHeaders[0], authHeaders[1]);
});
