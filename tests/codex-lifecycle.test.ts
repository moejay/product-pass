import assert from "node:assert/strict";
import test from "node:test";

function area() {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(key: string) { return { [key]: values[key] }; },
    async set(next: Record<string, unknown>) { Object.assign(values, next); },
    async remove(key: string) { delete values[key]; }
  };
}
const local = area(); const session = area(); const alarms = new Map<string, unknown>();
Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: { storage: { local, session }, alarms: { create(name: string, info: unknown) { alarms.set(name, info); }, async clear(name: string) { return alarms.delete(name); } } }
});
const codex = await import("../src/background/codex-auth");

function jwt(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })}.signature`;
}

test("Codex cancellation wins over an in-flight successful poll", async t => {
  const verifier = "device-verifier"; const challenge = await codex.pkceS256(verifier);
  let pollStarted!: () => void; const started = new Promise<void>(resolve => { pollStarted = resolve; });
  let releasePoll!: () => void; const released = new Promise<void>(resolve => { releasePoll = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "1" }), { status: 200 });
    if (calls === 2) { pollStarted(); await released; return new Response(JSON.stringify({ authorization_code: "code", code_challenge: challenge, code_verifier: verifier }), { status: 200 }); }
    return new Response(JSON.stringify({ access_token: jwt(4_000_000_000), refresh_token: "refresh", id_token: "id" }), { status: 200 });
  });
  await codex.startCodexDeviceFlow();
  const polling = codex.pollCodexDeviceFlow(Date.now() + 2_000);
  await started;
  const cancel = codex.cancelCodexDeviceFlow();
  releasePoll();
  await Promise.all([polling, cancel]);
  const status = await codex.codexStatus();
  assert.equal(status.state, "idle");
  assert.equal(status.connected, false);
  assert.equal(local.values.productPassCodexTokens, undefined);
});
