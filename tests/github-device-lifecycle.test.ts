import assert from "node:assert/strict";
import test from "node:test";

interface StorageAreaFake {
  values: Record<string, unknown>;
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function storageArea(): StorageAreaFake {
  return {
    values: {},
    async get(key) { return { [key]: this.values[key] }; },
    async set(values) { Object.assign(this.values, values); },
    async remove(key) { delete this.values[key]; }
  };
}

const local = storageArea();
const session = storageArea();
const alarms = new Map<string, unknown>();
Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    storage: { local, session },
    alarms: {
      create(name: string, info: unknown) { alarms.set(name, info); },
      async clear(name: string) { return alarms.delete(name); }
    }
  }
});

const githubDevice = await import("../src/background/github-device");

const deviceResponse = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 1
};

test("cancel wins over an in-flight successful Device Flow poll", async t => {
  let resolvePoll!: (response: Response) => void;
  let pollStarted!: () => void;
  const started = new Promise<void>(resolve => { pollStarted = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify(deviceResponse), { status: 200 });
    pollStarted();
    return new Promise<Response>(resolve => { resolvePoll = resolve; });
  });

  await githubDevice.startGithubDeviceFlow("Iv1.public-client");
  const poll = githubDevice.pollGithubDeviceFlow(Date.now() + 2_000);
  await started;
  const cancel = githubDevice.cancelGithubDeviceFlow();
  resolvePoll(new Response(JSON.stringify({ access_token: "ghu_token", token_type: "bearer", expires_in: 60 }), { status: 200 }));
  await Promise.all([poll, cancel]);

  const status = await githubDevice.githubDeviceStatus("Iv1.public-client");
  assert.equal(status.state, "idle");
  assert.equal(status.connected, false);
  assert.equal(local.values.productPassGithubAppToken, undefined);
});

test("stored GitHub App tokens are bound to the authorizing client ID", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(deviceResponse), { status: 200 }));
  await githubDevice.startGithubDeviceFlow("Iv1.first-client");
  local.values.productPassGithubAppToken = { accessToken: "ghu_token", clientId: "Iv1.first-client", expiresAt: Date.now() + 60_000 };

  assert.equal(await githubDevice.getGithubAppToken("Iv1.first-client"), "ghu_token");
  await assert.rejects(() => githubDevice.getGithubAppToken("Iv1.second-client"), /Connect the selected GitHub App/);
  assert.equal(local.values.productPassGithubAppToken, undefined);
  await githubDevice.cancelGithubDeviceFlow();
});
