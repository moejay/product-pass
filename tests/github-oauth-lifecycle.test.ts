import assert from "node:assert/strict";
import test from "node:test";

interface StorageAreaFake {
  values: Record<string, unknown>;
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
}
function storageArea(): StorageAreaFake {
  return {
    values: {},
    async get(key) { return { [key]: this.values[key] }; },
    async set(values) { Object.assign(this.values, values); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key]; }
  };
}
const local = storageArea(); const session = storageArea(); const alarms = new Map<string, unknown>();
Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local, session }, alarms: { create(name: string, info: unknown) { alarms.set(name, info); }, async clear(name: string) { return alarms.delete(name); } } } });
const githubOAuth = await import("../src/background/github-oauth");
const deviceResponse = { device_code: "device-secret", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 };

test("startup cleanup removes legacy GitHub App data without deleting OAuth data", async () => {
  for (const area of [local, session]) Object.assign(area.values, {
    productPassGithubDevicePending: { old: true }, productPassGithubDeviceStatus: { old: true }, productPassGithubAppToken: { accessToken: "ghu_old" },
    productPassGithubOAuthToken: { accessToken: "gho_current" }
  });
  alarms.set("product-pass-github-device-poll", {});
  await githubOAuth.cleanupLegacyGithubApp();
  for (const area of [local, session]) {
    assert.equal(area.values.productPassGithubDevicePending, undefined); assert.equal(area.values.productPassGithubDeviceStatus, undefined); assert.equal(area.values.productPassGithubAppToken, undefined);
    assert.deepEqual(area.values.productPassGithubOAuthToken, { accessToken: "gho_current" });
  }
  assert.equal(alarms.has("product-pass-github-device-poll"), false);
  delete local.values.productPassGithubOAuthToken; delete session.values.productPassGithubOAuthToken;
});

test("cancel wins over an in-flight successful OAuth Device Flow poll", async t => {
  let resolvePoll!: (response: Response) => void; let pollStarted!: () => void; const started = new Promise<void>(resolve => { pollStarted = resolve; }); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; if (calls === 1) return new Response(JSON.stringify(deviceResponse), { status: 200 }); pollStarted(); return new Promise<Response>(resolve => { resolvePoll = resolve; }); });
  await githubOAuth.startGithubOAuthFlow("public_repo"); const poll = githubOAuth.pollGithubOAuthFlow(Date.now() + 2_000); await started; const cancel = githubOAuth.cancelGithubOAuthFlow();
  resolvePoll(new Response(JSON.stringify({ access_token: "gho_token", token_type: "bearer", scope: "public_repo", expires_in: 60 }), { status: 200 })); await Promise.all([poll, cancel]);
  const status = await githubOAuth.githubOAuthStatus("public_repo"); assert.equal(status.state, "idle"); assert.equal(status.connected, false); assert.equal(local.values.productPassGithubOAuthToken, undefined);
});

test("OAuth refuses a token whose granted scope differs from the selected scope", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify(calls === 1 ? deviceResponse : { access_token: "gho_token", token_type: "bearer", scope: "repo" }), { status: 200 });
  });
  await githubOAuth.startGithubOAuthFlow("public_repo");
  await githubOAuth.pollGithubOAuthFlow(Date.now() + 2_000);
  const status = await githubOAuth.githubOAuthStatus("public_repo");
  assert.equal(status.state, "error");
  assert.match(status.message ?? "", /different access/);
  assert.equal(local.values.productPassGithubOAuthToken, undefined);
});

test("stored OAuth tokens are bound to the requested repository scope", async () => {
  local.values.productPassGithubOAuthToken = { accessToken: "gho_token", clientId: githubOAuth.GITHUB_OAUTH_CLIENT_ID, scope: "public_repo", expiresAt: Date.now() + 60_000 };
  assert.equal(await githubOAuth.getGithubOAuthToken("public_repo"), "gho_token");
  await assert.rejects(() => githubOAuth.getGithubOAuthToken("repo"), /Connect GitHub/); assert.equal(local.values.productPassGithubOAuthToken, undefined);
});
