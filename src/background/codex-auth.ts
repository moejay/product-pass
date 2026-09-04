import { ext } from "../shared/browser";

// Experimental: public client and protocol pinned to OpenAI Codex CLI source.
export const CODEX_PUBLIC_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_CLIENT_ID = CODEX_PUBLIC_CLIENT_ID;
export const CODEX_DEVICE_ALARM = "productPassCodexDevicePoll";
const AUTH_BASE = "https://auth.openai.com";
const PENDING_KEY = "productPassCodexPending";
const STATUS_KEY = "productPassCodexStatus";
const TOKEN_KEY = "productPassCodexTokens";
const FLOW_LIFETIME_MS = 15 * 60_000;
let queue: Promise<unknown> = Promise.resolve();

export interface CodexPending {
  version: 1;
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  nextPollAt: number;
  expiresAt: number;
}
export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number;
}
export interface CodexStatus {
  state: "idle" | "awaiting-user" | "authorized" | "expired" | "error";
  connected: boolean;
  userCode?: string;
  verificationUri?: string;
  flowExpiresAt?: number;
  expiresAt?: number;
  message?: string;
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}
function requiredString(value: unknown, label: string, max = 16_384): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(`OpenAI returned an invalid ${label}.`);
  return value;
}
function parseInterval(value: unknown): number {
  const interval = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 300) throw new Error("OpenAI returned an invalid polling interval.");
  return interval as number;
}
export function parseCodexDeviceResponse(value: unknown, now = Date.now()): CodexPending {
  if (!value || typeof value !== "object") throw new Error("OpenAI returned an invalid device response.");
  const data = value as Record<string, unknown>;
  const intervalSeconds = parseInterval(data.interval);
  return {
    version: 1,
    deviceAuthId: requiredString(data.device_auth_id, "device authorization ID", 4_096),
    userCode: requiredString(data.user_code ?? data.usercode, "user code", 256),
    verificationUri: `${AUTH_BASE}/codex/device`,
    intervalSeconds,
    nextPollAt: now + intervalSeconds * 1_000,
    expiresAt: now + FLOW_LIFETIME_MS
  };
}
export function parseCodexJwt(jwt: string): { accountId: string; expiresAt: number } {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("OpenAI returned an invalid JWT.");
  let claims: Record<string, unknown>;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch { throw new Error("OpenAI returned an invalid JWT payload."); }
  const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new Error("The Codex token did not contain a valid expiry.");
  if (typeof auth?.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) throw new Error("The Codex token did not identify a ChatGPT account.");
  return { accountId: auth.chatgpt_account_id, expiresAt: claims.exp * 1_000 };
}
export const parseJwtClaims = parseCodexJwt;

export function parseCodexTokenResponse(value: unknown, previous?: CodexTokens, now = Date.now()): CodexTokens {
  if (!value || typeof value !== "object") throw new Error("OpenAI returned an invalid token response.");
  const data = value as Record<string, unknown>;
  const accessToken = requiredString(data.access_token, "access token");
  const claims = parseCodexJwt(accessToken);
  if (claims.expiresAt <= now) throw new Error("OpenAI returned an expired access token.");
  const idToken = typeof data.id_token === "string" && data.id_token ? data.id_token : previous?.idToken ?? accessToken;
  const refreshToken = typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : previous?.refreshToken ?? "";
  if (!refreshToken) throw new Error("OpenAI did not return a refresh token.");
  return { accessToken, idToken, refreshToken, accountId: claims.accountId, expiresAt: claims.expiresAt };
}

export type CodexPollResult = { kind: "pending" } | { kind: "code"; authorizationCode: string; codeChallenge: string; codeVerifier: string };
export function parseCodexUserCode(value: unknown, now = Date.now()): CodexPending { return parseCodexDeviceResponse(value, now); }
export function parseCodexPollResponse(value: unknown): CodexPollResult {
  if (!value || typeof value !== "object") throw new Error("OpenAI returned an invalid polling response.");
  const data = value as Record<string, unknown>;
  if (!data.authorization_code) return { kind: "pending" };
  return { kind: "code", authorizationCode: requiredString(data.authorization_code, "authorization code"), codeChallenge: requiredString(data.code_challenge, "code challenge"), codeVerifier: requiredString(data.code_verifier, "code verifier") };
}
export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function verifyReturnedPkce(verifier: string, challenge: string): Promise<void> {
  if (await pkceS256(verifier) !== challenge) throw new Error("OpenAI returned inconsistent PKCE values.");
}
function validPending(value: unknown): value is CodexPending {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CodexPending>;
  return item.version === 1 && typeof item.deviceAuthId === "string" && item.deviceAuthId.length > 0 && item.deviceAuthId.length <= 4_096 && typeof item.userCode === "string" && item.userCode.length > 0 && item.userCode.length <= 256 && item.verificationUri === `${AUTH_BASE}/codex/device` && Number.isInteger(item.intervalSeconds) && item.intervalSeconds! >= 1 && item.intervalSeconds! <= 300 && Number.isFinite(item.nextPollAt) && Number.isFinite(item.expiresAt);
}
async function getPending(): Promise<CodexPending | null> {
  const value = (await ext.storage.local.get(PENDING_KEY))[PENDING_KEY];
  if (validPending(value)) return value;
  if (value !== undefined) await ext.storage.local.remove(PENDING_KEY);
  return null;
}
function schedule(when: number): void { ext.alarms.create(CODEX_DEVICE_ALARM, { when: Math.max(Date.now() + 1_000, when) }); }
async function getStoredTokens(): Promise<Partial<CodexTokens> | undefined> {
  let tokens = (await ext.storage.local.get(TOKEN_KEY))[TOKEN_KEY] as Partial<CodexTokens> | undefined;
  if (!tokens) {
    tokens = (await ext.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as Partial<CodexTokens> | undefined;
    if (tokens) { await ext.storage.local.set({ [TOKEN_KEY]: tokens }); await ext.storage.session.remove(TOKEN_KEY); }
  }
  return tokens;
}
async function removeStoredTokens(): Promise<void> { await ext.storage.local.remove(TOKEN_KEY); await ext.storage.session.remove(TOKEN_KEY); }
async function setStatus(status: Omit<CodexStatus, "connected">): Promise<void> { await ext.storage.local.set({ [STATUS_KEY]: status }); }
export async function requestCodexUserCode(fetcher: typeof fetch = fetch, now = Date.now()): Promise<CodexPending> {
  const response = await fetcher(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CODEX_CLIENT_ID }), signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Codex device login failed (${response.status}).`);
  return parseCodexDeviceResponse(await response.json(), now);
}
async function pollAuthorization(pending: CodexPending): Promise<null | Record<string, unknown>> {
  const response = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }), signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Codex authorization failed (${response.status}).`);
  return await response.json() as Record<string, unknown>;
}
export async function exchangeCodexCode(value: Extract<CodexPollResult, { kind: "code" }>, fetcher: typeof fetch = fetch): Promise<CodexTokens> {
  await verifyReturnedPkce(value.codeVerifier, value.codeChallenge);
  const response = await fetcher(`${AUTH_BASE}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: value.authorizationCode, redirect_uri: `${AUTH_BASE}/deviceauth/callback`, client_id: CODEX_CLIENT_ID, code_verifier: value.codeVerifier }).toString(),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Codex token exchange failed (${response.status}).`);
  return parseCodexTokenResponse(await response.json());
}
async function startInternal(): Promise<CodexStatus> {
  await ext.alarms.clear(CODEX_DEVICE_ALARM); await ext.storage.local.remove(PENDING_KEY); await removeStoredTokens();
  const pending = await requestCodexUserCode();
  await ext.storage.local.set({ [PENDING_KEY]: pending, [STATUS_KEY]: { state: "awaiting-user" } }); schedule(pending.nextPollAt);
  return { state: "awaiting-user", connected: false, userCode: pending.userCode, verificationUri: pending.verificationUri, flowExpiresAt: pending.expiresAt };
}
async function cancelInternal(): Promise<void> {
  await ext.alarms.clear(CODEX_DEVICE_ALARM); await ext.storage.local.remove(PENDING_KEY); await removeStoredTokens(); await setStatus({ state: "idle" });
}
async function pollInternal(now = Date.now()): Promise<void> {
  const pending = await getPending(); if (!pending) return;
  if (now >= pending.expiresAt) { await cancelInternal(); await setStatus({ state: "expired", message: "The Codex sign-in code expired. Start again." }); return; }
  if (now < pending.nextPollAt) { schedule(pending.nextPollAt); return; }
  try {
    const authorization = await pollAuthorization(pending);
    if (!authorization) { pending.nextPollAt = now + pending.intervalSeconds * 1_000; await ext.storage.local.set({ [PENDING_KEY]: pending }); schedule(pending.nextPollAt); return; }
    const parsed = parseCodexPollResponse(authorization);
    if (parsed.kind === "pending") { pending.nextPollAt = now + pending.intervalSeconds * 1_000; await ext.storage.local.set({ [PENDING_KEY]: pending }); schedule(pending.nextPollAt); return; }
    const tokens = await exchangeCodexCode(parsed);
    await ext.storage.local.set({ [TOKEN_KEY]: tokens }); await ext.storage.local.remove(PENDING_KEY); await setStatus({ state: "authorized" }); await ext.alarms.clear(CODEX_DEVICE_ALARM);
  } catch (error) {
    await cancelInternal(); await setStatus({ state: "error", message: error instanceof Error ? error.message.slice(0, 300) : "Codex sign-in failed." });
  }
}
export async function requestCodexRefresh(current: CodexTokens, fetcher: typeof fetch = fetch): Promise<CodexTokens> {
  const response = await fetcher(`${AUTH_BASE}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: current.refreshToken }), signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error("The ChatGPT session expired. Connect again.");
  return parseCodexTokenResponse(await response.json(), current);
}
async function refreshInternal(): Promise<CodexTokens> {
  const current = await getStoredTokens() as CodexTokens | undefined;
  if (!current || typeof current.refreshToken !== "string" || !current.refreshToken) throw new Error("Connect ChatGPT in Settings first.");
  let tokens: CodexTokens;
  try { tokens = await requestCodexRefresh(current); }
  catch (error) { await cancelInternal(); throw error; }
  await ext.storage.local.set({ [TOKEN_KEY]: tokens }); await setStatus({ state: "authorized" }); return tokens;
}
async function tokensInternal(forceRefresh = false): Promise<CodexTokens> {
  const value = await getStoredTokens();
  if (!forceRefresh && value && typeof value.accessToken === "string" && typeof value.refreshToken === "string" && typeof value.idToken === "string" && typeof value.accountId === "string" && typeof value.expiresAt === "number" && value.expiresAt > Date.now() + 60_000) return value as CodexTokens;
  return refreshInternal();
}
async function statusInternal(now = Date.now()): Promise<CodexStatus> {
  const pending = await getPending();
  if (pending && pending.expiresAt > now) return { state: "awaiting-user", connected: false, userCode: pending.userCode, verificationUri: pending.verificationUri, flowExpiresAt: pending.expiresAt };
  if (pending) { await cancelInternal(); await setStatus({ state: "expired", message: "The Codex sign-in code expired. Start again." }); }
  const token = await getStoredTokens();
  if (token && typeof token.accessToken === "string" && typeof token.accountId === "string" && typeof token.expiresAt === "number") return { state: "authorized", connected: true, expiresAt: token.expiresAt };
  const stored = (await ext.storage.local.get(STATUS_KEY))[STATUS_KEY] as Partial<CodexStatus> | undefined;
  if (stored && ["expired", "error"].includes(stored.state ?? "") && typeof stored.message === "string") return { state: stored.state as "expired" | "error", connected: false, message: stored.message.slice(0, 300) };
  return { state: "idle", connected: false };
}

export const startCodexDeviceFlow = (): Promise<CodexStatus> => serialized(startInternal);
export const pollCodexDeviceFlow = (now = Date.now()): Promise<void> => serialized(() => pollInternal(now));
export const cancelCodexDeviceFlow = (): Promise<void> => serialized(cancelInternal);
export const disconnectCodex = (): Promise<void> => serialized(cancelInternal);
export const resumeCodexDeviceFlow = (): Promise<void> => serialized(async () => { const pending = await getPending(); if (pending) schedule(pending.nextPollAt); });
export const getCodexTokens = (forceRefresh = false): Promise<CodexTokens> => serialized(() => tokensInternal(forceRefresh));
export const codexStatus = (now = Date.now()): Promise<CodexStatus> => serialized(() => statusInternal(now));
