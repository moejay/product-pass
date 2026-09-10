import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const scope = "https://www.googleapis.com/auth/chromewebstore";
const tokenAudience = "https://oauth2.googleapis.com/token";
const apiRoot = "https://chromewebstore.googleapis.com";

function encode(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

export function createServiceAccountAssertion(credentials, now = Math.floor(Date.now() / 1000)) {
  if (!credentials.client_email || !credentials.private_key) throw new Error("Chrome service account JSON is missing client_email or private_key.");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: credentials.client_email,
    scope,
    aud: tokenAudience,
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credentials.private_key).toString("base64url")}`;
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Chrome Web Store API returned non-JSON (${response.status}): ${text.slice(0, 500)}`); }
  if (!response.ok) throw new Error(`Chrome Web Store API request failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

export async function publishChrome({ credentials, publisherId, extensionId, archivePath, expectedVersion, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!publisherId || !extensionId || !expectedVersion) throw new Error("Chrome publisher ID, extension ID, and expected version are required.");
  const assertion = createServiceAccountAssertion(credentials);
  const token = await requestJson(fetchImpl, tokenAudience, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!token.access_token) throw new Error("Google token exchange did not return an access token.");

  const name = `publishers/${publisherId}/items/${extensionId}`;
  const headers = { authorization: `Bearer ${token.access_token}` };
  const statusUrl = `${apiRoot}/v2/${name}:fetchStatus`;
  const hasVersion = status => [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]
    .some(revision => revision?.distributionChannels?.some(channel => channel.crxVersion === expectedVersion));
  const existing = await requestJson(fetchImpl, statusUrl, { headers });
  if (hasVersion(existing)) {
    console.log(`Chrome Web Store already has ${extensionId} ${expectedVersion} published or submitted.`);
    return;
  }

  let upload;
  try {
    upload = await requestJson(fetchImpl, `${apiRoot}/upload/v2/${name}:upload`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/zip" },
      body: await readFile(archivePath),
    });
  } catch (error) {
    throw new Error(`Chrome upload outcome is unknown; inspect the Web Store dashboard before rerunning. ${error.message}`);
  }

  let uploadState = upload.uploadState;
  for (let attempt = 0; uploadState === "IN_PROGRESS" && attempt < 60; attempt += 1) {
    await sleep(5000);
    const status = await requestJson(fetchImpl, statusUrl, { headers });
    uploadState = status.lastAsyncUploadState;
  }
  if (uploadState !== "SUCCEEDED") throw new Error(`Chrome package upload failed or timed out with state: ${uploadState ?? "missing"}.`);
  if (upload.crxVersion && upload.crxVersion !== expectedVersion) throw new Error(`Chrome uploaded version ${upload.crxVersion}; expected ${expectedVersion}.`);

  try {
    const published = await requestJson(fetchImpl, `${apiRoot}/v2/${name}:publish`, { method: "POST", headers });
    console.log(`Chrome Web Store accepted ${extensionId} ${expectedVersion} for publishing.`, published);
  } catch (error) {
    const status = await requestJson(fetchImpl, statusUrl, { headers });
    if (hasVersion(status)) {
      console.log(`Chrome Web Store accepted ${extensionId} ${expectedVersion} despite a lost publish response.`);
      return;
    }
    throw new Error(`Chrome publish outcome is unknown; inspect the Web Store dashboard before rerunning. ${error.message}`);
  }
}

async function main() {
  const rawCredentials = process.env.CHROME_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) throw new Error("CHROME_SERVICE_ACCOUNT_JSON is required.");
  let credentials;
  try { credentials = JSON.parse(rawCredentials); }
  catch { throw new Error("CHROME_SERVICE_ACCOUNT_JSON must contain the complete service account JSON object."); }
  await publishChrome({
    credentials,
    publisherId: process.env.CHROME_PUBLISHER_ID,
    extensionId: process.env.CHROME_EXTENSION_ID,
    archivePath: process.argv[2],
    expectedVersion: process.argv[3],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
