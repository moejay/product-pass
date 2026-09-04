import assert from "node:assert/strict";
import test from "node:test";
import { nextPendingPoll, parseDeviceCodeResponse, parseTokenPollResponse, pollDeviceCode, requestDeviceCode } from "../src/background/github-device";
import { selectGithubCredential, verifyGithubAppRepoAccess } from "../src/background/github";
import { normalizeSettings } from "../src/background/state";

const deviceResponse = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5
};

test("legacy settings migrate to existing OpenAI-compatible and PAT defaults", () => {
  const settings = normalizeSettings({ aiEndpoint: "https://example.test/chat", aiModel: "model", githubRepo: "owner/repo" });
  assert.equal(settings.aiProvider, "openai-compatible");
  assert.equal(settings.githubAuth, "pat");
  assert.equal(settings.githubAppClientId, "");
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
  const pending = await requestDeviceCode("Iv1.public-client", fetcher, 1_000);
  await pollDeviceCode(pending, fetcher, 6_000);
  assert.equal(requests[0].url, "https://github.com/login/device/code");
  assert.equal(requests[0].init?.body, "client_id=Iv1.public-client");
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
  assert.deepEqual(parseTokenPollResponse({ access_token: "ghu_token", token_type: "bearer", expires_in: 60 }, 2_000), {
    kind: "success", token: { accessToken: "ghu_token", expiresAt: 62_000 }
  });
  assert.throws(() => parseTokenPollResponse({ access_token: "token", token_type: "mac" }), /unsupported token type/);
});

test("GitHub App repository access is checked through installations", async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => {
    urls.push(String(input));
    const body = urls.length === 1 ? { installations: [{ id: 42 }] } : { repositories: [{ full_name: "Owner/Repo" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await verifyGithubAppRepoAccess("owner/repo", "app-token", fetcher);
  assert.deepEqual(urls, ["https://api.github.com/user/installations?per_page=100", "https://api.github.com/user/installations/42/repositories?per_page=100"]);
});

test("publishing credential selection keeps PAT and GitHub App modes separate", () => {
  assert.equal(selectGithubCredential("pat", "pat-token", "", undefined), "pat-token");
  assert.equal(selectGithubCredential("github-app", "pat-token", "app-token", 2_000, 1_000), "app-token");
  assert.throws(() => selectGithubCredential("github-app", "pat-token", "app-token", 999, 1_000), /Connect the selected GitHub App/);
  assert.throws(() => selectGithubCredential("pat", "", "app-token"), /fine-grained token/);
});
