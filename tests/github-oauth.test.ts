import assert from "node:assert/strict";
import test from "node:test";
import { GITHUB_OAUTH_CLIENT_ID, nextPendingPoll, parseDeviceCodeResponse, parseTokenPollResponse, pollDeviceCode, requestDeviceCode } from "../src/background/github-oauth";
import { listPatRepositories, selectGithubCredential } from "../src/background/github";
import { normalizeSettings } from "../src/background/state";

const deviceResponse = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5
};

test("new settings use Product Pass OAuth while explicit overrides survive", () => {
  const settings = normalizeSettings({ aiEndpoint: "https://example.test/chat", aiModel: "model", githubRepo: "owner/repo" });
  assert.equal(settings.showAnnotations, true);
  assert.equal(normalizeSettings({ showAnnotations: false }).showAnnotations, false);
  assert.equal(settings.aiProvider, "codex-subscription");
  assert.equal(normalizeSettings({ aiProvider: "openai-compatible" }).aiProvider, "openai-compatible");
  assert.equal(settings.githubAuth, "oauth");
  assert.equal(settings.githubOAuthScope, "public_repo");
  assert.equal(normalizeSettings({ githubAuth: "pat", githubOAuthScope: "repo" }).githubAuth, "pat");
  assert.equal(normalizeSettings({ githubOAuthScope: "repo" }).githubOAuthScope, "repo");
});

test("device-code parser validates URL and derives bounded poll timing", () => {
  const parsed = parseDeviceCodeResponse(deviceResponse, 1_000);
  assert.equal(parsed.verificationUri, "https://github.com/login/device");
  assert.equal(parsed.expiresAt, 901_000);
  assert.equal(parsed.nextPollAt, 6_000);
  assert.throws(() => parseDeviceCodeResponse({ ...deviceResponse, verification_uri: "https://evil.example/device" }), /unsafe verification URL/);
  assert.throws(() => parseDeviceCodeResponse({ ...deviceResponse, interval: 0 }), /polling interval/);
});

test("Device Flow requests use official form endpoints without a client secret", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [deviceResponse, { error: "authorization_pending" }];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const pending = await requestDeviceCode("public_repo", fetcher, 1_000);
  await pollDeviceCode(pending, fetcher, 6_000);
  assert.equal(requests[0].url, "https://github.com/login/device/code");
  assert.equal(requests[0].init?.body, `client_id=${GITHUB_OAUTH_CLIENT_ID}&scope=public_repo`);
  assert.match(String(requests[1].init?.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
  assert.doesNotMatch(String(requests[0].init?.body) + String(requests[1].init?.body), /client_secret/);
});

test("token polling distinguishes pending, slow_down, terminal errors, and expiry", () => {
  const pending = parseDeviceCodeResponse(deviceResponse, 1_000);
  assert.equal(nextPendingPoll(pending, "pending", 6_000).nextPollAt, 11_000);
  const slowed = nextPendingPoll(pending, "slow-down", 6_000);
  assert.equal(slowed.intervalSeconds, 10);
  assert.equal(slowed.nextPollAt, 16_000);
  assert.deepEqual(parseTokenPollResponse({ error: "authorization_pending" }), { kind: "pending" });
  assert.deepEqual(parseTokenPollResponse({ error: "slow_down" }), { kind: "slow-down" });
  assert.equal(parseTokenPollResponse({ error: "access_denied" }).kind, "terminal");
  assert.deepEqual(parseTokenPollResponse({ access_token: "gho_token", token_type: "bearer", scope: "public_repo", expires_in: 60 }, 2_000), {
    kind: "success", token: { accessToken: "gho_token", expiresAt: 62_000 }, grantedScopes: ["public_repo"]
  });
  assert.throws(() => parseTokenPollResponse({ access_token: "token", token_type: "mac" }), /unsupported token type/);
});

test("repository autocomplete lists OAuth or PAT repositories defensively", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify([{ full_name: "owner/repo" }, { full_name: null }]), { status: 200 });
  assert.deepEqual(await listPatRepositories("oauth-or-pat-token", fetcher), ["owner/repo"]);
});

test("publishing credential selection keeps PAT and OAuth modes separate", () => {
  assert.equal(selectGithubCredential("pat", "pat-token", "", undefined), "pat-token");
  assert.equal(selectGithubCredential("oauth", "pat-token", "oauth-token", 2_000, 1_000), "oauth-token");
  assert.throws(() => selectGithubCredential("oauth", "pat-token", "oauth-token", 999, 1_000), /Connect GitHub/);
  assert.throws(() => selectGithubCredential("pat", "", "oauth-token"), /fine-grained token/);
});
