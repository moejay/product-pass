import { ext } from "../shared/browser";
import type { Annotation, Bootstrap, RequestMessage, ReviewSession } from "../shared/model";
import { annotationRevision, MAX_NOTE_TEXT, MAX_POINTS, originPattern, safeUrl, validRepo } from "../shared/pure";
import { organize } from "./ai";
import { cancelCodexDeviceFlow, CODEX_DEVICE_ALARM, disconnectCodex, pollCodexDeviceFlow, resumeCodexDeviceFlow, startCodexDeviceFlow } from "./codex-auth";
import { organizeWithCodex } from "./codex";
import { listGithubAppRepositories, listPatRepositories, publish, verifyGithubAppRepoAccess } from "./github";
import { cancelGithubDeviceFlow, disconnectGithubApp, getGithubAppToken, GITHUB_DEVICE_ALARM, pollGithubDeviceFlow, resumeGithubDeviceFlow, startGithubDeviceFlow } from "./github-device";
import { captureScreenshot, deleteScreenshot, screenshotDataUrl } from "./screenshots";
import { credentialsStatus, getCredentials, getState, saveSettings, updateState } from "./state";

const uuid = () => crypto.randomUUID();
const now = () => Date.now();
let repositoryCache: { identity: string; expiresAt: number; names: string[] } | undefined;

function activeSession(state: Awaited<ReturnType<typeof getState>>): ReviewSession {
  const session = state.sessions.find(item => item.id === state.activeSessionId);
  if (!session) throw new Error("Create or select a review session first.");
  return session;
}

function validHttpUrl(value: string): boolean { return originPattern(value) !== null; }
function validAIEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}
function validGithubClientId(value: string): boolean { return !value || /^[A-Za-z0-9._-]{8,200}$/.test(value); }
function validGithubInstallUrl(value: string): boolean {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password; } catch { return false; }
}
function validRect(rect: { x: number; y: number; width: number; height: number }): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0 && rect.width <= 100_000 && rect.height <= 100_000;
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : "The operation failed."; }

async function activeTab(): Promise<Bootstrap["tab"]> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";
  const pattern = originPattern(url);
  const state = await getState();
  const origin = pattern ? new URL(url).origin : "";
  const permitted = pattern ? await ext.permissions.contains({ origins: [pattern] }) : false;
  return { id: tab?.id, url, title: tab?.title ?? "", supported: Boolean(pattern), enabled: Boolean(pattern && permitted && state.enabledOrigins.includes(origin)) };
}

async function inject(tabId: number): Promise<void> {
  try { await ext.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); } catch { /* restricted or navigating tab */ }
}

async function refreshContentScripts(): Promise<void> {
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (tab.id === undefined) return;
    try { await ext.tabs.sendMessage(tab.id, { type: "REFRESH" }); } catch { /* no Product Pass content script */ }
  }));
}

async function handle(message: RequestMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!message || typeof message.type !== "string") throw new Error("Invalid request.");
  const contentRequests = new Set(["GET_PAGE", "PAGE_CHANGED", "SAVE_ANNOTATION"]);
  const fromExtensionPage = sender.url?.startsWith(ext.runtime.getURL("")) ?? false;
  if ((contentRequests.has(message.type) && !sender.tab) || (!contentRequests.has(message.type) && !fromExtensionPage)) throw new Error("This request is not allowed from that extension context.");
  switch (message.type) {
    case "BOOTSTRAP": {
      const state = await getState();
      return { state, credentials: await credentialsStatus(state.settings), tab: await activeTab() } satisfies Bootstrap;
    }
    case "CREATE_SESSION": {
      const title = message.title.trim().slice(0, 120) || `Review — ${new Date().toLocaleString()}`;
      const session = await updateState(state => {
        const stamp = now();
        const created: ReviewSession = { id: uuid(), title, status: "capturing", annotations: [], drafts: [], createdAt: stamp, updatedAt: stamp };
        state.sessions.unshift(created); state.activeSessionId = created.id; return created;
      });
      await refreshContentScripts(); return session;
    }
    case "SET_ACTIVE_SESSION": {
      await updateState(state => {
        if (!state.sessions.some(session => session.id === message.sessionId)) throw new Error("Session not found.");
        state.activeSessionId = message.sessionId;
      });
      await refreshContentScripts(); return undefined;
    }
    case "SET_GITHUB_REPO": {
      const repo = message.repo.trim(); if (repo && !validRepo(repo)) throw new Error("Repository must be owner/name.");
      await updateState(state => { state.settings.githubRepo = repo; }); return undefined;
    }
    case "SEARCH_GITHUB_REPOS": {
      if (typeof message.query !== "string" || message.query.length > 120) throw new Error("Invalid repository search.");
      const state = await getState(); const identity = `${state.settings.githubAuth}:${state.settings.githubAppClientId}`;
      let names = repositoryCache?.identity === identity && repositoryCache.expiresAt > now() ? repositoryCache.names : undefined;
      if (!names) {
        if (state.settings.githubAuth === "github-app") names = await listGithubAppRepositories(await getGithubAppToken(state.settings.githubAppClientId));
        else names = await listPatRepositories((await getCredentials()).githubToken);
        repositoryCache = { identity, expiresAt: now() + 60_000, names };
      }
      const query = message.query.trim().toLowerCase(); return names.filter(name => !query || name.toLowerCase().includes(query)).slice(0, 50);
    }
    case "FINISH_SESSION": {
      await updateState(state => {
        const session = state.sessions.find(item => item.id === message.sessionId);
        if (!session) throw new Error("Session not found.");
        session.status = "complete"; session.updatedAt = now();
        if (state.activeSessionId === session.id) state.activeSessionId = null;
      });
      await refreshContentScripts(); return undefined;
    }
    case "DELETE_SESSION": {
      let screenshotIds: string[] = [];
      await updateState(state => {
        const session = state.sessions.find(item => item.id === message.sessionId);
        if (!session) throw new Error("Session not found.");
        screenshotIds = session.annotations.flatMap(note => note.screenshot ? [note.screenshot.id] : []);
        state.sessions = state.sessions.filter(item => item.id !== session.id);
        if (state.activeSessionId === session.id) state.activeSessionId = null;
      });
      await Promise.all(screenshotIds.map(id => deleteScreenshot(id).catch(() => undefined)));
      await refreshContentScripts(); return undefined;
    }
    case "ENABLE_ORIGIN": {
      const pattern = originPattern(message.origin);
      if (!pattern || !Number.isInteger(message.tabId) || !await ext.permissions.contains({ origins: [pattern] })) throw new Error("Site access has not been granted.");
      await updateState(state => { const origin = new URL(message.origin).origin; if (!state.enabledOrigins.includes(origin)) state.enabledOrigins.push(origin); });
      await inject(message.tabId); return undefined;
    }
    case "BEGIN_CAPTURE": {
      if (!Number.isInteger(message.tabId) || !["element", "freehand"].includes(message.mode)) throw new Error("Invalid capture request.");
      const tab = await ext.tabs.get(message.tabId);
      const pattern = originPattern(tab.url ?? "");
      if (!pattern || !await ext.permissions.contains({ origins: [pattern] })) throw new Error("Enable annotations on this site first.");
      await inject(message.tabId);
      return ext.tabs.sendMessage(message.tabId, { type: "START_CAPTURE", mode: message.mode });
    }
    case "GET_PAGE": {
      if (!validHttpUrl(message.url)) return [];
      const state = await getState();
      const session = state.sessions.find(item => item.id === state.activeSessionId);
      return session?.annotations.filter(note => note.url === message.url) ?? [];
    }
    case "GET_SCREENSHOT": {
      const state = await getState(); const session = activeSession(state);
      const note = session.annotations.find(item => item.id === message.annotationId);
      if (!note?.screenshot) throw new Error("No local screenshot is available for this annotation.");
      const dataUrl = await screenshotDataUrl(note.screenshot.id);
      if (!dataUrl) throw new Error("The local screenshot could not be found.");
      return dataUrl;
    }
    case "PAGE_CHANGED": return undefined;
    case "SAVE_ANNOTATION": {
      const value = message.annotation;
      if (!value || !sender.tab || sender.tab.url !== value.url || !validHttpUrl(value.url) || value.url.length > 5_000) throw new Error("Annotation page did not match its sender.");
      if (!value.viewport || ![value.viewport.scrollX, value.viewport.scrollY, value.viewport.width, value.viewport.height].every(Number.isFinite) || value.viewport.width < 1 || value.viewport.height < 1 || value.viewport.width > 20_000 || value.viewport.height > 20_000) throw new Error("Invalid capture viewport.");
      if (typeof value.text !== "string" || value.text.length > MAX_NOTE_TEXT || typeof value.pageTitle !== "string" || value.pageTitle.length > 300 || typeof value.contextLabel !== "string" || value.contextLabel.length > 160) throw new Error("Annotation text or context is invalid.");
      if (!value.anchor || !["element", "freehand"].includes(value.anchor.kind)) throw new Error("Invalid annotation anchor.");
      if (value.anchor.kind === "element" && (typeof value.anchor.selector !== "string" || value.anchor.selector.length > 1_000 || typeof value.anchor.quote !== "string" || value.anchor.quote.length > 160 || !validRect(value.anchor.rect))) throw new Error("Invalid element boundary.");
      if (value.anchor.kind === "freehand" && (value.anchor.points.length < 3 || value.anchor.points.length > MAX_POINTS || !value.anchor.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 10_000_000 && Math.abs(point.y) <= 10_000_000) || !validRect(value.anchor.bounds) || value.anchor.bounds.width < 10 || value.anchor.bounds.height < 10)) throw new Error("Invalid freehand boundary.");
      const { viewport, ...annotation } = value;
      const note = await updateState(state => {
        const session = activeSession(state); const stamp = now();
        const created: Annotation = { ...annotation, id: uuid(), sessionId: session.id, safeUrl: safeUrl(value.url), createdAt: stamp, updatedAt: stamp };
        session.annotations.push(created); session.drafts = []; session.status = "capturing"; session.updatedAt = stamp; return created;
      });
      if (sender.tab.active && sender.tab.windowId !== undefined) {
        try {
          const screenshot = await captureScreenshot(sender.tab.windowId, note.anchor, viewport, note.id);
          if (screenshot) {
            const attached = await updateState(state => {
              const current = state.sessions.find(item => item.id === note.sessionId)?.annotations.find(item => item.id === note.id);
              if (!current) return false;
              current.screenshot = screenshot; return true;
            });
            if (!attached) await deleteScreenshot(screenshot.id);
          }
        } catch { /* annotation remains usable when capture is unavailable */ }
      }
      await refreshContentScripts();
      return note;
    }
    case "UPDATE_ANNOTATION": {
      await updateState(state => {
        const session = activeSession(state); const note = session.annotations.find(item => item.id === message.annotationId);
        if (!note || typeof message.text !== "string" || message.text.length > MAX_NOTE_TEXT) throw new Error("Invalid note update.");
        note.text = message.text; note.updatedAt = now(); session.drafts = []; session.status = "capturing"; session.updatedAt = now();
      });
      await refreshContentScripts(); return undefined;
    }
    case "DELETE_ANNOTATION": {
      let screenshotId: string | undefined;
      await updateState(state => {
        const session = activeSession(state); const before = session.annotations.length;
        screenshotId = session.annotations.find(note => note.id === message.annotationId)?.screenshot?.id;
        session.annotations = session.annotations.filter(note => note.id !== message.annotationId);
        if (before === session.annotations.length) throw new Error("Note not found.");
        session.drafts = []; session.status = "capturing"; session.updatedAt = now();
      });
      if (screenshotId) await deleteScreenshot(screenshotId).catch(() => undefined);
      await refreshContentScripts(); return undefined;
    }
    case "GENERATE_DRAFTS": {
      const state = await getState(); const session = activeSession(state);
      if (!session.annotations.length) throw new Error("Capture at least one note first.");
      const revision = annotationRevision(session.annotations);
      const result = state.settings.aiProvider === "codex-subscription"
        ? await organizeWithCodex(session.annotations, session.id, state.settings)
        : await organize(session.annotations, session.id, state.settings, (await getCredentials()).aiKey);
      await updateState(current => {
        const target = current.sessions.find(item => item.id === session.id);
        if (!target || annotationRevision(target.annotations) !== revision) throw new Error("Notes changed while organizing. Generate the drafts again.");
        target.drafts = result.drafts; target.status = "reviewing"; target.updatedAt = now();
      });
      return result;
    }
    case "UPDATE_DRAFT": return updateState(state => {
      const session = activeSession(state); const draft = session.drafts.find(item => item.id === message.draftId);
      if (!draft || !message.title.trim() || message.title.length > 256 || message.body.length > 65_536) throw new Error("Draft title or body is invalid.");
      if (draft.publishState === "published" || draft.publishState === "publishing") throw new Error("A published or publishing draft cannot be edited.");
      const title = message.title.trim();
      if (draft.title !== title || draft.body !== message.body) {
        draft.title = title; draft.body = message.body; draft.decision = "review"; draft.updatedAt = now(); session.updatedAt = now();
      }
    });
    case "SET_DRAFT_DECISION": return updateState(state => {
      const session = activeSession(state); const draft = session.drafts.find(item => item.id === message.draftId);
      if (!draft || !["review", "accepted", "skipped"].includes(message.decision)) throw new Error("Invalid draft decision.");
      if (draft.publishState === "published" || draft.publishState === "publishing") throw new Error("A published or publishing draft cannot be changed.");
      if (message.decision === "accepted" && (!draft.title.trim() || draft.title.length > 256 || draft.body.length > 65_536)) throw new Error("Fix the draft before accepting it.");
      draft.decision = message.decision; draft.updatedAt = now(); session.updatedAt = now();
    });
    case "PUBLISH_DRAFT": {
      const claim = await updateState(current => {
        const session = activeSession(current);
        const item = session.drafts.find(value => value.id === message.draftId);
        if (!item || item.decision !== "accepted") throw new Error("Accept this draft before publishing.");
        if (item.publishState === "published") return { alreadyPublished: item, sessionId: session.id, repo: current.settings.githubRepo, githubAuth: current.settings.githubAuth, githubAppClientId: current.settings.githubAppClientId, draft: { ...item } };
        if (item.publishState === "publishing") throw new Error("This draft is already being published.");
        if (!validRepo(current.settings.githubRepo)) throw new Error("Configure GitHub repository as owner/name.");
        const snapshot = { ...item };
        item.publishState = "publishing"; item.error = undefined; item.updatedAt = now(); session.updatedAt = now();
        return { sessionId: session.id, repo: current.settings.githubRepo, githubAuth: current.settings.githubAuth, githubAppClientId: current.settings.githubAppClientId, draft: snapshot };
      });
      if (claim.alreadyPublished) return claim.alreadyPublished;
      try {
        const githubToken = claim.githubAuth === "github-app" ? await getGithubAppToken(claim.githubAppClientId) : (await getCredentials()).githubToken;
        if (claim.githubAuth === "github-app") await verifyGithubAppRepoAccess(claim.repo, githubToken);
        const issue = await publish(claim.repo, claim.draft, githubToken);
        return updateState(current => {
          const target = current.sessions.find(value => value.id === claim.sessionId); const item = target?.drafts.find(value => value.id === claim.draft.id);
          if (!target || !item) throw new Error("Draft not found.");
          item.publishState = "published"; item.githubIssueNumber = issue.number; item.githubIssueUrl = issue.url; item.error = undefined; item.updatedAt = now();
          if (target.drafts.every(value => value.decision === "skipped" || (value.decision === "accepted" && value.publishState === "published"))) target.status = "complete";
          target.updatedAt = now(); return item;
        });
      } catch (error) {
        const messageText = safeMessage(error); const unknown = messageText.startsWith("UNKNOWN:");
        await updateState(current => {
          const target = current.sessions.find(value => value.id === claim.sessionId); const item = target?.drafts.find(value => value.id === claim.draft.id);
          if (item) { item.publishState = unknown ? "unknown" : "failed"; item.error = messageText.replace(/^UNKNOWN:/, ""); item.updatedAt = now(); }
          if (target) target.updatedAt = now();
        });
        throw new Error(messageText.replace(/^UNKNOWN:/, ""));
      }
    }
    case "SAVE_SETTINGS": {
      if (!["openai-compatible", "codex-subscription"].includes(message.settings.aiProvider) || !["pat", "github-app"].includes(message.settings.githubAuth)) throw new Error("Invalid authentication selection.");
      if (!validAIEndpoint(message.settings.aiEndpoint) || !message.settings.aiModel.trim() || message.settings.aiModel.length > 120) throw new Error("Use an HTTPS AI endpoint (HTTP is allowed only on localhost) and a valid model.");
      if (!message.settings.codexModel.trim() || message.settings.codexModel.length > 120) throw new Error("Enter a valid experimental Codex model.");
      if (message.settings.githubRepo && !validRepo(message.settings.githubRepo)) throw new Error("Repository must be owner/name.");
      if (!validGithubClientId(message.settings.githubAppClientId.trim())) throw new Error("Enter a valid GitHub App client ID.");
      if (!validGithubInstallUrl(message.settings.githubAppInstallUrl.trim())) throw new Error("GitHub App installation URL must be an HTTPS github.com URL.");
      const settings = { ...message.settings, aiModel: message.settings.aiModel.trim(), codexModel: message.settings.codexModel.trim(), githubRepo: message.settings.githubRepo.trim(), githubAppClientId: message.settings.githubAppClientId.trim(), githubAppInstallUrl: message.settings.githubAppInstallUrl.trim() };
      const previous = await getState();
      if (previous.settings.githubAppClientId !== settings.githubAppClientId) await disconnectGithubApp();
      await saveSettings(settings, message.aiKey, message.githubToken);
      return undefined;
    }
    case "START_GITHUB_DEVICE_FLOW": {
      const state = await getState();
      if (state.settings.githubAuth !== "github-app") throw new Error("Select GitHub App Device Flow and save settings first.");
      return startGithubDeviceFlow(state.settings.githubAppClientId);
    }
    case "CANCEL_GITHUB_DEVICE_FLOW": await cancelGithubDeviceFlow(); return undefined;
    case "DISCONNECT_GITHUB_APP": await disconnectGithubApp(); return undefined;
    case "START_CODEX_DEVICE_FLOW": {
      const state = await getState();
      if (state.settings.aiProvider !== "codex-subscription") throw new Error("Select experimental Codex subscription and save settings first.");
      return startCodexDeviceFlow();
    }
    case "CANCEL_CODEX_DEVICE_FLOW": await cancelCodexDeviceFlow(); return undefined;
    case "DISCONNECT_CODEX": await disconnectCodex(); return undefined;
  }
}

ext.runtime.onMessage.addListener((message: RequestMessage, sender, sendResponse) => {
  handle(message, sender).then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: safeMessage(error) }));
  return true;
});

ext.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== "complete" || !tab.url) return;
  void getState().then(async state => {
    try {
      const pattern = originPattern(tab.url!);
      if (pattern && state.enabledOrigins.includes(new URL(tab.url!).origin) && await ext.permissions.contains({ origins: [pattern] })) void inject(tabId);
    } catch { /* unsupported URL */ }
  });
});

ext.permissions.onRemoved.addListener(permissions => {
  if (!permissions.origins?.length) return;
  void updateState(async state => {
    const kept: string[] = [];
    for (const origin of state.enabledOrigins) {
      const pattern = originPattern(origin);
      if (pattern && await ext.permissions.contains({ origins: [pattern] })) kept.push(origin);
    }
    state.enabledOrigins = kept;
  });
});

ext.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === GITHUB_DEVICE_ALARM) void pollGithubDeviceFlow();
  if (alarm.name === CODEX_DEVICE_ALARM) void pollCodexDeviceFlow();
});
const firefoxExt = ext as typeof ext & { sidebarAction?: { open(): Promise<void> } };
if (ext.sidePanel?.setPanelBehavior) {
  void ext.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
} else {
  // Firefox does not open a declared sidebar_action when the generic toolbar
  // action is clicked. Zen also hides Firefox's normal sidebar picker, so the
  // toolbar action is the reliable entry point there.
  ext.action.onClicked.addListener(() => {
    const fallback = () => ext.tabs.create({ url: ext.runtime.getURL("sidebar/index.html") });
    if (firefoxExt.sidebarAction?.open) void firefoxExt.sidebarAction.open().catch(fallback);
    else void fallback();
  });
}
void resumeGithubDeviceFlow();
void resumeCodexDeviceFlow();
void updateState(state => {
  for (const session of state.sessions) for (const draft of session.drafts) {
    if (draft.publishState === "publishing") {
      draft.publishState = "unknown";
      draft.error = "Publication was interrupted. Reconcile with GitHub before retrying.";
    }
  }
});
