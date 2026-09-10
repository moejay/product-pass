import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServiceAccountAssertion, publishChrome } from "../scripts/publish-chrome.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = {
  client_email: "publisher@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

test("service account assertion targets the Chrome Web Store scope", () => {
  const [, payload] = createServiceAccountAssertion(credentials, 1000).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/chromewebstore",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1000,
    exp: 4600,
  });
});

test("Chrome publisher treats the expected submitted version as an idempotent success", async () => {
  const requests: string[] = [];
  const replies = [
    { access_token: "token" },
    { submittedItemRevisionStatus: { distributionChannels: [{ crxVersion: "1.2.3" }] } },
  ];
  const fetchImpl = async (url: string | URL) => {
    requests.push(String(url));
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  };

  await publishChrome({
    credentials,
    publisherId: "publisher",
    extensionId: "extension",
    archivePath: "unused.zip",
    expectedVersion: "1.2.3",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.deepEqual(requests, [
    "https://oauth2.googleapis.com/token",
    "https://chromewebstore.googleapis.com/v2/publishers/publisher/items/extension:fetchStatus",
  ]);
});

test("Chrome publisher polls an asynchronous upload before publishing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "product-pass-chrome-"));
  const archivePath = path.join(directory, "extension.zip");
  await writeFile(archivePath, "zip");
  const requests: Array<{ url: string; method: string }> = [];
  const replies = [
    { access_token: "token" },
    {},
    { uploadState: "IN_PROGRESS" },
    { lastAsyncUploadState: "SUCCEEDED" },
    { itemId: "extension" },
  ];
  const fetchImpl = async (url: string | URL, init: RequestInit = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET" });
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  };

  await publishChrome({
    credentials,
    publisherId: "publisher",
    extensionId: "extension",
    archivePath,
    expectedVersion: "1.2.3",
    fetchImpl: fetchImpl as typeof fetch,
    sleep: async () => undefined,
  });

  assert.deepEqual(requests, [
    { url: "https://oauth2.googleapis.com/token", method: "POST" },
    { url: "https://chromewebstore.googleapis.com/v2/publishers/publisher/items/extension:fetchStatus", method: "GET" },
    { url: "https://chromewebstore.googleapis.com/upload/v2/publishers/publisher/items/extension:upload", method: "POST" },
    { url: "https://chromewebstore.googleapis.com/v2/publishers/publisher/items/extension:fetchStatus", method: "GET" },
    { url: "https://chromewebstore.googleapis.com/v2/publishers/publisher/items/extension:publish", method: "POST" },
  ]);
});
