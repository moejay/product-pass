import { ext } from "../shared/browser";
import type { GithubOAuthScope } from "../shared/model";

const PENDING_KEY = "productPassGithubOAuthPending";
const STATUS_KEY = "productPassGithubOAuthStatus";
const TOKEN_KEY = "productPassGithubOAuthToken";
const LEGACY_KEYS = ["productPassGithubDevicePending", "productPassGithubDeviceStatus", "productPassGithubAppToken"];
const LEGACY_ALARM = "product-pass-github-device-poll";
export const GITHUB_OAUTH_CLIENT_ID = "Ov23lifwCRsz0PsjTzhA";
export const GITHUB_OAUTH_ALARM = "productPassGithubOAuthPoll";
const MAX_SECONDS = 31_536_000;
const MAX_NETWORK_FAILURES = 5;
let flowGeneration = 0;
let lifecycleQueue: Promise<unknown> = Promise.resolve();

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(operation);
  lifecycleQueue = result.catch(() => undefined);
  return result;
}

export interface GithubOAuthTokenRecord { accessToken: string; clientId?: string; scope?: GithubOAuthScope; expiresAt?: number }
export interface GithubOAuthPending {
  version: 2;
  clientId: string;
  scope: GithubOAuthScope;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  networkFailures: number;
}
export interface GithubOAuthPublicStatus {
  state: "idle" | "awaiting-user" | "authorized" | "denied" | "expired" | "error";
  connected: boolean;
  expiresAt?: number;
  userCode?: string;
  verificationUri?: string;
  flowExpiresAt?: number;
  message?: string;
}

type TokenPollResult =
  | { kind: "success"; token: Omit<GithubOAuthTokenRecord, "clientId" | "scope">; grantedScopes: string[] }
  | { kind: "pending" }
  | { kind: "slow-down" }
  | { kind: "terminal"; state: "denied" | "expired" | "error"; message: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned an invalid Device Flow response.");
  return value as Record<string, unknown>;
}
function boundedInteger(value: unknown, name: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > MAX_SECONDS) throw new Error(`GitHub returned an invalid ${name}.`);
  return value as number;
}
function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`GitHub returned an invalid ${name}.`);
  return value;
}
function validVerificationUri(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password; } catch { return false; }
}

export function parseDeviceCodeResponse(value: unknown, now = Date.now(), clientId = GITHUB_OAUTH_CLIENT_ID, scope: GithubOAuthScope = "public_repo"): GithubOAuthPending {
  const data = record(value);
  const verificationUri = requiredString(data.verification_uri, "verification URL", 2_048);
  if (!validVerificationUri(verificationUri)) throw new Error("GitHub returned an unsafe verification URL.");
  const expiresIn = boundedInteger(data.expires_in, "expiry", 1);
  const intervalSeconds = boundedInteger(data.interval, "polling interval", 1);
  return {
    version: 2,
    clientId,
    scope,
    deviceCode: requiredString(data.device_code, "device code", 4_096),
    userCode: requiredString(data.user_code, "user code", 256),
    verificationUri,
    expiresAt: now + expiresIn * 1_000,
    intervalSeconds,
    nextPollAt: now + intervalSeconds * 1_000,
    networkFailures: 0
  };
}

export function parseTokenPollResponse(value: unknown, now = Date.now()): TokenPollResult {
  const data = record(value);
  if (typeof data.access_token === "string") {
    const accessToken = requiredString(data.access_token, "access token", 16_384);
    if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") throw new Error("GitHub returned an unsupported token type.");
    const expiresAt = data.expires_in === undefined ? undefined : now + boundedInteger(data.expires_in, "token expiry", 1) * 1_000;
    const scope = requiredString(data.scope, "granted scope", 2_048);
    const grantedScopes = scope.split(/[ ,]+/).filter(Boolean);
    if (!grantedScopes.length) throw new Error("GitHub returned an invalid granted scope.");
    return { kind: "success", token: { accessToken, ...(expiresAt === undefined ? {} : { expiresAt }) }, grantedScopes };
  }
  switch (data.error) {
    case "authorization_pending": return { kind: "pending" };
    case "slow_down": return { kind: "slow-down" };
    case "access_denied": return { kind: "terminal", state: "denied", message: "GitHub authorization was declined." };
    case "expired_token": return { kind: "terminal", state: "expired", message: "The GitHub sign-in code expired. Start again." };
    case "device_flow_disabled": return { kind: "terminal", state: "error", message: "Device Flow is not enabled for this GitHub OAuth App." };
    case "incorrect_client_credentials": return { kind: "terminal", state: "error", message: "The GitHub OAuth client ID is invalid." };
    case "incorrect_device_code":
    case "unsupported_grant_type": return { kind: "terminal", state: "error", message: "GitHub rejected the Device Flow request." };
    default: throw new Error("GitHub returned an invalid Device Flow response.");
  }
}

export function nextPendingPoll(pending: GithubOAuthPending, result: "pending" | "slow-down", now: number): GithubOAuthPending {
  const intervalSeconds = result === "slow-down" ? Math.min(MAX_SECONDS, pending.intervalSeconds + 5) : pending.intervalSeconds;
  return { ...pending, intervalSeconds, networkFailures: 0, nextPollAt: now + intervalSeconds * 1_000 };
}

export async function requestDeviceCode(scope: GithubOAuthScope, fetcher: typeof fetch = fetch, now = Date.now(), clientId = GITHUB_OAUTH_CLIENT_ID): Promise<GithubOAuthPending> {
  const response = await fetcher("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`GitHub Device Flow request failed (${response.status}).`);
  return parseDeviceCodeResponse(await response.json(), now, clientId, scope);
}

export async function pollDeviceCode(pending: GithubOAuthPending, fetcher: typeof fetch = fetch, now = Date.now()): Promise<TokenPollResult> {
  const response = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: pending.clientId,
      device_code: pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    }).toString(),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`GitHub token request failed (${response.status}).`);
  return parseTokenPollResponse(await response.json(), now);
}

function validClientId(value: string): boolean { return /^[A-Za-z0-9._-]{8,200}$/.test(value); }
function validPending(value: unknown): value is GithubOAuthPending {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GithubOAuthPending>;
  return item.version === 2 && validClientId(item.clientId ?? "") && ["public_repo", "repo"].includes(item.scope ?? "") && typeof item.deviceCode === "string" && item.deviceCode.length > 0 && item.deviceCode.length <= 4_096 && typeof item.userCode === "string" && item.userCode.length > 0 && item.userCode.length <= 256 && typeof item.verificationUri === "string" && validVerificationUri(item.verificationUri) && Number.isFinite(item.expiresAt) && Number.isFinite(item.nextPollAt) && Number.isInteger(item.intervalSeconds) && item.intervalSeconds! >= 1 && item.intervalSeconds! <= MAX_SECONDS && Number.isInteger(item.networkFailures) && item.networkFailures! >= 0 && item.networkFailures! <= MAX_NETWORK_FAILURES;
}
async function getPending(): Promise<GithubOAuthPending | null> {
  const value = (await ext.storage.local.get(PENDING_KEY))[PENDING_KEY];
  if (validPending(value)) return value;
  if (value !== undefined) await ext.storage.local.remove(PENDING_KEY);
  return null;
}
async function getStoredToken(): Promise<Partial<GithubOAuthTokenRecord> | undefined> {
  let token = (await ext.storage.local.get(TOKEN_KEY))[TOKEN_KEY] as Partial<GithubOAuthTokenRecord> | undefined;
  if (!token) {
    token = (await ext.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as Partial<GithubOAuthTokenRecord> | undefined;
    if (token) { await ext.storage.local.set({ [TOKEN_KEY]: token }); await ext.storage.session.remove(TOKEN_KEY); }
  }
  return token;
}
async function removeLegacyGithubAppData(): Promise<void> { await ext.storage.local.remove(LEGACY_KEYS); await ext.storage.session.remove(LEGACY_KEYS); await ext.alarms.clear(LEGACY_ALARM); }
async function removeStoredToken(): Promise<void> { await ext.storage.local.remove(TOKEN_KEY); await ext.storage.session.remove(TOKEN_KEY); await removeLegacyGithubAppData(); }
async function setPublicStatus(status: Omit<GithubOAuthPublicStatus, "connected">): Promise<void> {
  await ext.storage.local.set({ [STATUS_KEY]: status });
}
function schedule(when: number): void { ext.alarms.create(GITHUB_OAUTH_ALARM, { when: Math.max(Date.now() + 1_000, when) }); }
async function finish(state: "denied" | "expired" | "error", message: string): Promise<void> {
  await ext.storage.local.remove(PENDING_KEY);
  await setPublicStatus({ state, message });
  await ext.alarms.clear(GITHUB_OAUTH_ALARM);
}

async function startGithubOAuthFlowInternal(scope: GithubOAuthScope): Promise<GithubOAuthPublicStatus> {
  if (!["public_repo", "repo"].includes(scope)) throw new Error("Select a valid GitHub repository access level.");
  const generation = ++flowGeneration;
  await ext.alarms.clear(GITHUB_OAUTH_ALARM);
  await ext.storage.local.remove(PENDING_KEY);
  await removeStoredToken();
  await setPublicStatus({ state: "idle" });
  const pending = await requestDeviceCode(scope);
  if (generation !== flowGeneration) throw new Error("GitHub sign-in was canceled.");
  await ext.storage.local.set({ [PENDING_KEY]: pending, [STATUS_KEY]: { state: "awaiting-user" } });
  schedule(pending.nextPollAt);
  return { state: "awaiting-user", connected: false, userCode: pending.userCode, verificationUri: pending.verificationUri, flowExpiresAt: pending.expiresAt };
}

async function pollGithubOAuthFlowInternal(now = Date.now()): Promise<void> {
  const generation = flowGeneration;
  const pending = await getPending();
  if (!pending) return;
  if (now >= pending.expiresAt) { await finish("expired", "The GitHub sign-in code expired. Start again."); return; }
  if (now < pending.nextPollAt) { schedule(pending.nextPollAt); return; }
  let result: TokenPollResult;
  try { result = await pollDeviceCode(pending, fetch, now); }
  catch {
    if (generation !== flowGeneration) return;
    const current = await getPending();
    if (!current || current.deviceCode !== pending.deviceCode) return;
    current.networkFailures++;
    const failures = current.networkFailures;
    if (failures >= MAX_NETWORK_FAILURES) { await finish("error", "GitHub sign-in stopped after repeated network failures. Start again."); return; }
    const backoffSeconds = Math.max(current.intervalSeconds, Math.min(60, 5 * 2 ** failures));
    current.nextPollAt = now + backoffSeconds * 1_000;
    await ext.storage.local.set({ [PENDING_KEY]: current }); schedule(current.nextPollAt); return;
  }
  if (generation !== flowGeneration) return;
  const current = await getPending();
  if (!current || current.deviceCode !== pending.deviceCode) return;
  if (result.kind === "success") {
    const grantedScopes = [...new Set(result.grantedScopes)];
    if (grantedScopes.length !== 1 || grantedScopes[0] !== pending.scope) {
      await finish("error", "GitHub granted different access than selected. Revoke Product Pass under GitHub Authorized OAuth Apps, then connect again.");
      return;
    }
    await ext.storage.local.set({ [TOKEN_KEY]: { ...result.token, clientId: pending.clientId, scope: pending.scope } });
    const latest = await getPending();
    if (!latest || latest.deviceCode !== pending.deviceCode) { await removeStoredToken(); return; }
    await ext.storage.local.remove(PENDING_KEY);
    await setPublicStatus({ state: "authorized" });
    await ext.alarms.clear(GITHUB_OAUTH_ALARM);
    return;
  }
  if (result.kind === "terminal") { await finish(result.state, result.message); return; }
  const next = nextPendingPoll(current, result.kind, now);
  await ext.storage.local.set({ [PENDING_KEY]: next }); schedule(next.nextPollAt);
}

async function resumeGithubOAuthFlowInternal(): Promise<void> {
  const pending = await getPending();
  if (!pending) return;
  if (Date.now() >= pending.expiresAt) await finish("expired", "The GitHub sign-in code expired. Start again.");
  else schedule(pending.nextPollAt);
}

async function cancelGithubOAuthFlowInternal(): Promise<void> {
  flowGeneration++;
  await ext.alarms.clear(GITHUB_OAUTH_ALARM);
  await ext.storage.local.remove(PENDING_KEY);
  // A queued cancellation may run immediately after an in-flight poll commits.
  // Removing the token makes the user's cancellation authoritative.
  await removeStoredToken();
  await setPublicStatus({ state: "idle" });
}

async function disconnectGithubOAuthInternal(): Promise<void> {
  await cancelGithubOAuthFlowInternal();
  await removeStoredToken();
}

async function getGithubOAuthTokenInternal(expectedScope: GithubOAuthScope, now = Date.now()): Promise<string> {
  const value = await getStoredToken();
  if (!value || typeof value.accessToken !== "string" || !value.accessToken || value.clientId !== GITHUB_OAUTH_CLIENT_ID || value.scope !== expectedScope || (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= now))) {
    if (value !== undefined) {
      await removeStoredToken();
      await setPublicStatus({ state: "expired", message: "The GitHub OAuth token expired or its access level changed. Connect again." });
    }
    throw new Error("Connect GitHub in Setup before publishing.");
  }
  return value.accessToken;
}

async function githubOAuthStatusInternal(expectedScope: GithubOAuthScope, now = Date.now()): Promise<GithubOAuthPublicStatus> {
  const pending = await getPending();
  if (pending) {
    if (pending.clientId !== GITHUB_OAUTH_CLIENT_ID || pending.scope !== expectedScope) {
      await ext.storage.local.remove(PENDING_KEY); await ext.alarms.clear(GITHUB_OAUTH_ALARM);
      return { state: "idle", connected: false };
    }
    if (pending.expiresAt <= now) { await finish("expired", "The GitHub sign-in code expired. Start again."); return { state: "expired", connected: false, message: "The GitHub sign-in code expired. Start again." }; }
    return { state: "awaiting-user", connected: false, userCode: pending.userCode, verificationUri: pending.verificationUri, flowExpiresAt: pending.expiresAt };
  }
  const token = await getStoredToken();
  if (token && typeof token.accessToken === "string" && token.accessToken && token.clientId === GITHUB_OAUTH_CLIENT_ID && token.scope === expectedScope && (token.expiresAt === undefined || (Number.isFinite(token.expiresAt) && token.expiresAt > now))) return { state: "authorized", connected: true, ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }) };
  if (token !== undefined) {
    await removeStoredToken();
    const expired = { state: "expired" as const, connected: false, message: "The GitHub OAuth token expired or its access level changed. Connect again." };
    await setPublicStatus(expired);
    return expired;
  }
  const stored = (await ext.storage.local.get(STATUS_KEY))[STATUS_KEY] as Partial<GithubOAuthPublicStatus> | undefined;
  if (stored && ["denied", "expired", "error"].includes(stored.state ?? "") && typeof stored.message === "string") return { state: stored.state as "denied" | "expired" | "error", connected: false, message: stored.message.slice(0, 300) };
  return { state: "idle", connected: false };
}

// All persisted lifecycle transitions are serialized. This prevents an alarm
// poll from committing a token after cancel/replacement, or an old flow from
// deleting the state and alarm belonging to a newer flow.
export function cleanupLegacyGithubApp(): Promise<void> {
  return serializeLifecycle(removeLegacyGithubAppData);
}
export function startGithubOAuthFlow(scope: GithubOAuthScope): Promise<GithubOAuthPublicStatus> {
  return serializeLifecycle(() => startGithubOAuthFlowInternal(scope));
}
export function pollGithubOAuthFlow(now = Date.now()): Promise<void> {
  return serializeLifecycle(() => pollGithubOAuthFlowInternal(now));
}
export function resumeGithubOAuthFlow(): Promise<void> {
  return serializeLifecycle(() => resumeGithubOAuthFlowInternal());
}
export function cancelGithubOAuthFlow(): Promise<void> {
  return serializeLifecycle(() => cancelGithubOAuthFlowInternal());
}
export function disconnectGithubOAuth(): Promise<void> {
  return serializeLifecycle(() => disconnectGithubOAuthInternal());
}
export function getGithubOAuthToken(expectedScope: GithubOAuthScope, now = Date.now()): Promise<string> {
  return serializeLifecycle(() => getGithubOAuthTokenInternal(expectedScope, now));
}
export function githubOAuthStatus(expectedScope: GithubOAuthScope, now = Date.now()): Promise<GithubOAuthPublicStatus> {
  return serializeLifecycle(() => githubOAuthStatusInternal(expectedScope, now));
}
