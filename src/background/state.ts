import { ext } from "../shared/browser";
import type { AppState, CredentialsStatus, Settings } from "../shared/model";
import { codexStatus } from "./codex-auth";
import { githubDeviceStatus } from "./github-device";

const STATE_KEY = "productPassState";
const CREDENTIALS_KEY = "productPassCredentials";
const defaultSettings: Settings = {
  aiProvider: "codex-subscription",
  aiEndpoint: "https://api.openai.com/v1/chat/completions",
  aiModel: "gpt-4o-mini",
  codexModel: "gpt-5.4",
  githubAuth: "github-app",
  githubRepo: "",
  githubAppClientId: "Iv23li0eh1QsLt4ca7LN",
  githubAppInstallUrl: "https://github.com/apps/product-pass-by-dotdev/installations/new"
};
const defaults: AppState = { sessions: [], activeSessionId: null, enabledOrigins: [], settings: defaultSettings };
let queue: Promise<unknown> = Promise.resolve();

export function normalizeSettings(value: unknown): Settings {
  const saved = value && typeof value === "object" ? value as Partial<Settings> : {};
  return {
    ...defaultSettings,
    ...saved,
    aiProvider: saved.aiProvider === "openai-compatible" ? "openai-compatible" : "codex-subscription",
    githubAuth: saved.githubAuth === "pat" ? "pat" : "github-app",
    aiEndpoint: typeof saved.aiEndpoint === "string" ? saved.aiEndpoint : defaultSettings.aiEndpoint,
    aiModel: typeof saved.aiModel === "string" ? saved.aiModel : defaultSettings.aiModel,
    codexModel: typeof saved.codexModel === "string" ? saved.codexModel : defaultSettings.codexModel,
    githubRepo: typeof saved.githubRepo === "string" ? saved.githubRepo : "",
    githubAppClientId: typeof saved.githubAppClientId === "string" && saved.githubAppClientId.trim() ? saved.githubAppClientId : defaultSettings.githubAppClientId,
    githubAppInstallUrl: typeof saved.githubAppInstallUrl === "string" && saved.githubAppInstallUrl.trim() ? saved.githubAppInstallUrl : defaultSettings.githubAppInstallUrl
  };
}

export async function getState(): Promise<AppState> {
  const data = await ext.storage.local.get(STATE_KEY);
  const saved = data[STATE_KEY] as Partial<AppState> | undefined;
  return {
    ...defaults,
    ...saved,
    sessions: Array.isArray(saved?.sessions) ? saved.sessions : [],
    enabledOrigins: Array.isArray(saved?.enabledOrigins) ? saved.enabledOrigins : [],
    settings: normalizeSettings(saved?.settings)
  };
}

export function updateState<T>(change: (state: AppState) => T | Promise<T>): Promise<T> {
  const operation = queue.then(async () => {
    const state = await getState();
    const result = await change(state);
    await ext.storage.local.set({ [STATE_KEY]: state });
    return result;
  });
  queue = operation.catch(() => undefined);
  return operation;
}

export async function getCredentials(): Promise<{ aiKey: string; githubToken: string }> {
  const localData = await ext.storage.local.get(CREDENTIALS_KEY);
  let value = localData[CREDENTIALS_KEY] as { aiKey?: unknown; githubToken?: unknown } | undefined;
  if (!value) {
    const legacy = (await ext.storage.session.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] as typeof value;
    if (legacy) {
      value = legacy;
      await ext.storage.local.set({ [CREDENTIALS_KEY]: legacy });
      await ext.storage.session.remove(CREDENTIALS_KEY);
    }
  }
  return {
    aiKey: typeof value?.aiKey === "string" ? value.aiKey : "",
    githubToken: typeof value?.githubToken === "string" ? value.githubToken : ""
  };
}

export async function credentialsStatus(settings?: Settings): Promise<CredentialsStatus> {
  const value = await getCredentials();
  const resolvedSettings = settings ?? (await getState()).settings;
  return {
    aiKey: Boolean(value.aiKey),
    githubToken: Boolean(value.githubToken),
    codexSubscription: await codexStatus(),
    githubApp: await githubDeviceStatus(resolvedSettings.githubAppClientId)
  };
}

export async function saveSettings(settings: Settings, aiKey?: string, githubToken?: string): Promise<void> {
  await updateState(state => { state.settings = settings; });
  const current = await getCredentials();
  if (aiKey !== undefined) current.aiKey = aiKey.trim();
  if (githubToken !== undefined) current.githubToken = githubToken.trim();
  await ext.storage.local.set({ [CREDENTIALS_KEY]: current });
}
