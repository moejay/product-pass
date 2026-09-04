import { ext } from "../shared/browser";

const PENDING_KEY = "productPassGithubDevicePending";
const STATUS_KEY = "productPassGithubDeviceStatus";
const TOKEN_KEY = "productPassGithubAppToken";
export const GITHUB_DEVICE_ALARM = "productPassGithubDevicePoll";
const MAX_SECONDS = 31_536_000;
const MAX_NETWORK_FAILURES = 5;
let flowGeneration = 0;
let lifecycleQueue: Promise<unknown> = Promise.resolve();

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(operation);
  lifecycleQueue = result.catch(() => undefined);
  return result;
}

export interface GithubAppTokenRecord { accessToken: string; clientId?: string; expiresAt?: number }
export interface GithubDevicePending {
  version: 1;
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  networkFailures: number;
}
export interface GithubDevicePublicStatus {
  state: "idle" | "awaiting-user" | "authorized" | "denied" | "expired" | "error";
  connected: boolean;
  expiresAt?: number;
  userCode?: string;
  verificationUri?: string;
  flowExpiresAt?: number;
  message?: string;
}

type TokenPollResult =
  | { kind: "success"; token: GithubAppTokenRecord }
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

export function parseDeviceCodeResponse(value: unknown, now = Date.now()): GithubDevicePending {
  const data = record(value);
  const verificationUri = requiredString(data.verification_uri, "verification URL", 2_048);
  if (!validVerificationUri(verificationUri)) throw new Error("GitHub returned an unsafe verification URL.");
  const expiresIn = boundedInteger(data.expires_in, "expiry", 1);
  const intervalSeconds = boundedInteger(data.interval, "polling interval", 1);
  return {
    version: 1,
    clientId: "",
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
    return { kind: "success", token: { accessToken, ...(expiresAt === undefined ? {} : { expiresAt }) } };
  }
  switch (data.error) {
    case "authorization_pending": return { kind: "pending" };
    case "slow_down": return { kind: "slow-down" };
    case "access_denied": return { kind: "terminal", state: "denied", message: "GitHub authorization was declined." };
    case "expired_token": return { kind: "terminal", state: "expired", message: "The GitHub sign-in code expired. Start again." };
    case "device_flow_disabled": return { kind: "terminal", state: "error", message: "Device Flow is not enabled for this GitHub App." };
    case "incorrect_client_credentials": return { kind: "terminal", state: "error", message: "The GitHub App client ID is invalid." };
    case "incorrect_device_code":
    case "unsupported_grant_type": return { kind: "terminal", state: "error", message: "GitHub rejected the Device Flow request." };
    default: throw new Error("GitHub returned an invalid Device Flow response.");
  }
}

export function nextPendingPoll(pending: GithubDevicePending, result: "pending" | "slow-down", now: number): GithubDevicePending {
  const intervalSeconds = result === "slow-down" ? Math.min(MAX_SECONDS, pending.intervalSeconds + 5) : pending.intervalSeconds;
  return { ...pending, intervalSeconds, networkFailures: 0, nextPollAt: now + intervalSeconds * 1_000 };
}

export async function requestDeviceCode(clientId: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<GithubDevicePending> {
  const response = await fetcher("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId }).toString(),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`GitHub Device Flow request failed (${response.status}).`);
  const pending = parseDeviceCodeResponse(await response.json(), now);
  pending.clientId = clientId;
  return pending;
}

export async function pollDeviceCode(pending: GithubDevicePending, fetcher: typeof fetch = fetch, now = Date.now()): Promise<TokenPollResult> {
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
function validPending(value: unknown): value is GithubDevicePending {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GithubDevicePending>;
  return item.version === 1 && validClientId(item.clientId ?? "") && typeof item.deviceCode === "string" && item.deviceCode.length > 0 && item.deviceCode.length <= 4_096 && typeof item.userCode === "string" && item.userCode.length > 0 && item.userCode.length <= 256 && typeof item.verificationUri === "string" && validVerificationUri(item.verificationUri) && Number.isFinite(item.expiresAt) && Number.isFinite(item.nextPollAt) && Number.isInteger(item.intervalSeconds) && item.intervalSeconds! >= 1 && item.intervalSeconds! <= MAX_SECONDS && Number.isInteger(item.networkFailures) && item.networkFailures! >= 0 && item.networkFailures! <= MAX_NETWORK_FAILURES;
}
async function getPending(): Promise<GithubDevicePending | null> {
  const value = (await ext.storage.local.get(PENDING_KEY))[PENDING_KEY];
  if (validPending(value)) return value;
  if (value !== undefined) await ext.storage.local.remove(PENDING_KEY);
  return null;
}
async function getStoredToken(): Promise<Partial<GithubAppTokenRecord> | undefined> {
  let token = (await ext.storage.local.get(TOKEN_KEY))[TOKEN_KEY] as Partial<GithubAppTokenRecord> | undefined;
  if (!token) {
    token = (await ext.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as Partial<GithubAppTokenRecord> | undefined;
    if (token) { await ext.storage.local.set({ [TOKEN_KEY]: token }); await ext.storage.session.remove(TOKEN_KEY); }
  }
  return token;
}
async function removeStoredToken(): Promise<void> { await ext.storage.local.remove(TOKEN_KEY); await ext.storage.session.remove(TOKEN_KEY); }
async function setPublicStatus(status: Omit<GithubDevicePublicStatus, "connected">): Promise<void> {
  await ext.storage.local.set({ [STATUS_KEY]: status });
}
function schedule(when: number): void { ext.alarms.create(GITHUB_DEVICE_ALARM, { when: Math.max(Date.now() + 1_000, when) }); }
async function finish(state: "denied" | "expired" | "error", message: string): Promise<void> {
  await ext.storage.local.remove(PENDING_KEY);
  await setPublicStatus({ state, message });
  await ext.alarms.clear(GITHUB_DEVICE_ALARM);
}

async function startGithubDeviceFlowInternal(clientId: string): Promise<GithubDevicePublicStatus> {
  const normalized = clientId.trim();
  if (!validClientId(normalized)) throw new Error("Enter a valid GitHub App client ID.");
  const generation = ++flowGeneration;
  await ext.alarms.clear(GITHUB_DEVICE_ALARM);
  await ext.storage.local.remove(PENDING_KEY);
  await removeStoredToken();
  await setPublicStatus({ state: "idle" });
  const pending = await requestDeviceCode(normalized);
  if (generation !== flowGeneration) throw new Error("GitHub sign-in was canceled.");
  await ext.storage.local.set({ [PENDING_KEY]: pending, [STATUS_KEY]: { state: "awaiting-user" } });
  schedule(pending.nextPollAt);
  return { state: "awaiting-user", connected: false, userCode: pending.userCode, verificationUri: pending.verificationUri, flowExpiresAt: pending.expiresAt };
}

async function pollGithubDeviceFlowInternal(now = Date.now()): Promise<void> {
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
    await ext.storage.local.set({ [TOKEN_KEY]: { ...result.token, clientId: pending.clientId } });
    const latest = await getPending();
    if (!latest || latest.deviceCode !== pending.deviceCode) { await removeStoredToken(); return; }
    await ext.storage.local.remove(PENDING_KEY);
    await setPublicStatus({ state: "authorized" });
    await ext.alarms.clear(GITHUB_DEVICE_ALARM);
    return;
  }
  if (result.kind === "terminal") { await finish(result.state, result.message); return; }
  const next = nextPendingPoll(current, result.kind, now);
  await ext.storage.local.set({ [PENDING_KEY]: next }); schedule(next.nextPollAt);
}

async function resumeGithubDeviceFlowInternal(): Promise<void> {
  const pending = await getPending();
  if (!pending) return;
  if (Date.now() >= pending.expiresAt) await finish("expired", "The GitHub sign-in code expired. Start again.");
  else schedule(pending.nextPollAt);
}

async function cancelGithubDeviceFlowInternal(): Promise<void> {
  flowGeneration++;
  await ext.alarms.clear(GITHUB_DEVICE_ALARM);
  await ext.storage.local.remove(PENDING_KEY);
  // A queued cancellation may run immediately after an in-flight poll commits.
  // Removing the token makes the user's cancellation authoritative.
  await removeStoredToken();
  await setPublicStatus({ state: "idle" });
}

async function disconnectGithubAppInternal(): Promise<void> {
  await cancelGithubDeviceFlowInternal();
  await removeStoredToken();
}

async function getGithubAppTokenInternal(expectedClientId: string, now = Date.now()): Promise<string> {
  const value = await getStoredToken();
  if (!value || typeof value.accessToken !== "string" || !value.accessToken || value.clientId !== expectedClientId || (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= now))) {
    if (value !== undefined) {
      await removeStoredToken();
      await setPublicStatus({ state: "expired", message: "The GitHub App token expired. Connect again." });
    }
    throw new Error("Connect the selected GitHub App in Settings before publishing.");
  }
  return value.accessToken;
}

async function githubDeviceStatusInternal(expectedClientId: string, now = Date.now()): Promise<GithubDevicePublicStatus> {
  const pending = await getPending();
  if (pending) {
    if (pending.clientId !== expectedClientId) {
      await ext.storage.local.remove(PENDING_KEY); await ext.alarms.clear(GITHUB_DEVICE_ALARM);
      return { state: "idle", connected: false };
    }
    if (pending.expiresAt <= now) { await finish("expired", "The GitHub sign-in code expired. Start again."); return { state: "expired", connected: false, message: "The GitHub sign-in code expired. Start again." }; }
    return { state: "awaiting-user", connected: false, userCode: pending.userCode, verificationUri: pending.verificationUri, flowExpiresAt: pending.expiresAt };
  }
  const token = await getStoredToken();
  if (token && typeof token.accessToken === "string" && token.accessToken && token.clientId === expectedClientId && (token.expiresAt === undefined || (Number.isFinite(token.expiresAt) && token.expiresAt > now))) return { state: "authorized", connected: true, ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }) };
  if (token !== undefined) {
    await removeStoredToken();
    const expired = { state: "expired" as const, connected: false, message: "The GitHub App token expired. Connect again." };
    await setPublicStatus(expired);
    return expired;
  }
  const stored = (await ext.storage.local.get(STATUS_KEY))[STATUS_KEY] as Partial<GithubDevicePublicStatus> | undefined;
  if (stored && ["denied", "expired", "error"].includes(stored.state ?? "") && typeof stored.message === "string") return { state: stored.state as "denied" | "expired" | "error", connected: false, message: stored.message.slice(0, 300) };
  return { state: "idle", connected: false };
}

// All persisted lifecycle transitions are serialized. This prevents an alarm
// poll from committing a token after cancel/replacement, or an old flow from
// deleting the state and alarm belonging to a newer flow.
export function startGithubDeviceFlow(clientId: string): Promise<GithubDevicePublicStatus> {
  return serializeLifecycle(() => startGithubDeviceFlowInternal(clientId));
}
export function pollGithubDeviceFlow(now = Date.now()): Promise<void> {
  return serializeLifecycle(() => pollGithubDeviceFlowInternal(now));
}
export function resumeGithubDeviceFlow(): Promise<void> {
  return serializeLifecycle(() => resumeGithubDeviceFlowInternal());
}
export function cancelGithubDeviceFlow(): Promise<void> {
  return serializeLifecycle(() => cancelGithubDeviceFlowInternal());
}
export function disconnectGithubApp(): Promise<void> {
  return serializeLifecycle(() => disconnectGithubAppInternal());
}
export function getGithubAppToken(expectedClientId: string, now = Date.now()): Promise<string> {
  return serializeLifecycle(() => getGithubAppTokenInternal(expectedClientId, now));
}
export function githubDeviceStatus(expectedClientId: string, now = Date.now()): Promise<GithubDevicePublicStatus> {
  return serializeLifecycle(() => githubDeviceStatusInternal(expectedClientId, now));
}
