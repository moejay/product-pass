import { ext } from "../shared/browser";
import type { AppState, CredentialsStatus, ReviewSession, Settings } from "../shared/model";
import { codexStatus } from "./codex-auth";
import { githubOAuthStatus } from "./github-oauth";

const STATE_KEY = "productPassState";
const CREDENTIALS_KEY = "productPassCredentials";
const defaultSettings: Settings = {
  showAnnotations: true,
  aiProvider: "codex-subscription",
  aiEndpoint: "https://api.openai.com/v1/chat/completions",
  aiModel: "gpt-4o-mini",
  codexModel: "gpt-5.4",
  githubAuth: "oauth",
  githubOAuthScope: "public_repo",
  githubRepo: ""
};
const defaults: AppState = { sessions: [], activeSessionId: null, selectedAnnotationId: null, enabledOrigins: [], pendingAssetDeletes: { screenshots: [], media: [] }, settings: defaultSettings };
let queue: Promise<unknown> = Promise.resolve();

export function normalizeSettings(value: unknown): Settings {
  const saved = value && typeof value === "object" ? value as Partial<Settings> : {};
  return {
    ...defaultSettings,
    ...saved,
    showAnnotations: saved.showAnnotations !== false,
    aiProvider: saved.aiProvider === "openai-compatible" ? "openai-compatible" : "codex-subscription",
    githubAuth: saved.githubAuth === "pat" ? "pat" : "oauth",
    githubOAuthScope: saved.githubOAuthScope === "repo" ? "repo" : "public_repo",
    aiEndpoint: typeof saved.aiEndpoint === "string" ? saved.aiEndpoint : defaultSettings.aiEndpoint,
    aiModel: typeof saved.aiModel === "string" ? saved.aiModel : defaultSettings.aiModel,
    codexModel: typeof saved.codexModel === "string" ? saved.codexModel : defaultSettings.codexModel,
    githubRepo: typeof saved.githubRepo === "string" ? saved.githubRepo : ""
  };
}

export function normalizeSession(value: ReviewSession): ReviewSession {
  return { ...value, annotations: Array.isArray(value.annotations) ? value.annotations : [], recordings: Array.isArray(value.recordings) ? value.recordings : [], drafts: Array.isArray(value.drafts) ? value.drafts.map(draft => ({ ...draft, uploadMedia: draft.uploadMedia === true, uploadedMedia: draft.uploadedMedia && typeof draft.uploadedMedia === "object" ? draft.uploadedMedia : {}, uploadedMediaRepo: typeof draft.uploadedMediaRepo === "string" ? draft.uploadedMediaRepo : undefined, publishRepo: typeof draft.publishRepo === "string" ? draft.publishRepo : undefined })) : [] };
}
function stringIds(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : []; }
export function normalizePendingAssetDeletes(value: unknown): AppState["pendingAssetDeletes"] {
  const pending = value && typeof value === "object" ? value as Partial<AppState["pendingAssetDeletes"]> : {};
  return { screenshots: stringIds(pending.screenshots), media: stringIds(pending.media) };
}

export async function getState(): Promise<AppState> {
  const data = await ext.storage.local.get(STATE_KEY);
  const saved = data[STATE_KEY] as Partial<AppState> | undefined;
  return {
    ...defaults,
    ...saved,
    sessions: Array.isArray(saved?.sessions) ? saved.sessions.map(session => normalizeSession(session)) : [],
    selectedAnnotationId: typeof saved?.selectedAnnotationId === "string" ? saved.selectedAnnotationId : null,
    enabledOrigins: Array.isArray(saved?.enabledOrigins) ? saved.enabledOrigins : [],
    pendingAssetDeletes: normalizePendingAssetDeletes(saved?.pendingAssetDeletes),
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
    githubOAuth: await githubOAuthStatus(resolvedSettings.githubOAuthScope)
  };
}

export async function saveSettings(settings: Settings, aiKey?: string, githubToken?: string): Promise<void> {
  await updateState(state => { state.settings = settings; });
  const current = await getCredentials();
  if (aiKey !== undefined) current.aiKey = aiKey.trim();
  if (githubToken !== undefined) current.githubToken = githubToken.trim();
  await ext.storage.local.set({ [CREDENTIALS_KEY]: current });
}
