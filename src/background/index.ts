import { ext } from "../shared/browser";
import type { Annotation, Bootstrap, ElementAnchor, FreehandAnchor, RequestMessage, ReviewSession } from "../shared/model";
import { annotationRevision, assertMediaUploadCanChange, assertSessionDeletable, assertSessionMutable, draftIsLocked, MAX_NOTE_TEXT, MAX_POINTS, originPattern, resolvePublishRepo, safeUrl, validRecordingRef, validRepo } from "../shared/pure";
import { organize } from "./ai";
import { cancelCodexDeviceFlow, CODEX_DEVICE_ALARM, disconnectCodex, pollCodexDeviceFlow, resumeCodexDeviceFlow, startCodexDeviceFlow } from "./codex-auth";
import { organizeWithCodex } from "./codex";
import { appendUploadedMedia, listPatRepositories, publish, repositoryId, uploadUserAttachment, validateUploadBlob, type UploadedMedia } from "./github";
import { cancelGithubOAuthFlow, cleanupLegacyGithubApp, disconnectGithubOAuth, getGithubOAuthToken, GITHUB_OAUTH_ALARM, pollGithubOAuthFlow, resumeGithubOAuthFlow, startGithubOAuthFlow } from "./github-oauth";
import { captureScreenshot, deleteScreenshot, screenshotBlob } from "./screenshots";
import { deleteMediaBlob, getMediaBlob } from "../shared/media-store";
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
function validRect(rect: { x: number; y: number; width: number; height: number }): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0 && rect.width <= 100_000 && rect.height <= 100_000;
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : "The operation failed."; }
function appendDeleteIds(target: string[], ids: string[]): void { for (const id of ids) if (!target.includes(id)) target.push(id); }
async function queueAssetDeletes(screenshots: string[] = [], media: string[] = []): Promise<void> {
  await updateState(state => { appendDeleteIds(state.pendingAssetDeletes.screenshots, screenshots); appendDeleteIds(state.pendingAssetDeletes.media, media); });
  await processPendingAssetDeletes();
}
async function processPendingAssetDeletes(): Promise<void> {
  const pending = (await getState()).pendingAssetDeletes;
  const removedScreenshots: string[] = []; const removedMedia: string[] = [];
  await Promise.all([
    ...pending.screenshots.map(async id => { try { await deleteScreenshot(id); removedScreenshots.push(id); } catch { /* retained for retry */ } }),
    ...pending.media.map(async id => { try { await deleteMediaBlob(id); removedMedia.push(id); } catch { /* retained for retry */ } })
  ]);
  if (!removedScreenshots.length && !removedMedia.length) return;
  await updateState(state => {
    state.pendingAssetDeletes.screenshots = state.pendingAssetDeletes.screenshots.filter(id => !removedScreenshots.includes(id));
    state.pendingAssetDeletes.media = state.pendingAssetDeletes.media.filter(id => !removedMedia.includes(id));
  });
}

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
  const contentRequests = new Set(["GET_PAGE", "SELECT_ANNOTATION", "PAGE_CHANGED", "SAVE_ANNOTATION"]);
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
        const created: ReviewSession = { id: uuid(), title, status: "capturing", annotations: [], recordings: [], drafts: [], createdAt: stamp, updatedAt: stamp };
        state.sessions.unshift(created); state.activeSessionId = created.id; return created;
      });
      await refreshContentScripts(); return session;
    }
    case "SET_ACTIVE_SESSION": {
      await updateState(state => {
        if (!state.sessions.some(session => session.id === message.sessionId)) throw new Error("Session not found.");
        state.activeSessionId = message.sessionId; state.selectedAnnotationId = null;
      });
      await refreshContentScripts(); return undefined;
    }
    case "SET_ANNOTATIONS_VISIBLE": {
      await updateState(state => { state.settings.showAnnotations = message.visible === true; });
      await refreshContentScripts(); return undefined;
    }
    case "CLEAR_ANNOTATION_SELECTION": {
      await updateState(state => { state.selectedAnnotationId = null; }); return undefined;
    }
    case "SET_GITHUB_REPO": {
      const repo = message.repo.trim(); if (repo && !validRepo(repo)) throw new Error("Repository must be owner/name.");
      await updateState(state => { state.settings.githubRepo = repo; }); return undefined;
    }
    case "SEARCH_GITHUB_REPOS": {
      if (typeof message.query !== "string" || message.query.length > 120) throw new Error("Invalid repository search.");
      const state = await getState(); const identity = `${state.settings.githubAuth}:${state.settings.githubOAuthScope}`;
      let names = repositoryCache?.identity === identity && repositoryCache.expiresAt > now() ? repositoryCache.names : undefined;
      if (!names) {
        const token = state.settings.githubAuth === "oauth" ? await getGithubOAuthToken(state.settings.githubOAuthScope) : (await getCredentials()).githubToken;
        names = await listPatRepositories(token); repositoryCache = { identity, expiresAt: now() + 60_000, names };
      }
      const query = message.query.trim().toLowerCase(); return names.filter(name => !query || name.toLowerCase().includes(query)).slice(0, 50);
    }
    case "FINISH_SESSION": {
      await updateState(state => {
        const session = state.sessions.find(item => item.id === message.sessionId);
        if (!session) throw new Error("Session not found.");
        session.status = "complete"; session.updatedAt = now();
        if (state.activeSessionId === session.id) { state.activeSessionId = null; state.selectedAnnotationId = null; }
      });
      await refreshContentScripts(); return undefined;
    }
    case "DELETE_SESSION": {
      await updateState(state => {
        const session = state.sessions.find(item => item.id === message.sessionId);
        if (!session) throw new Error("Session not found.");
        assertSessionDeletable(session);
        appendDeleteIds(state.pendingAssetDeletes.screenshots, session.annotations.flatMap(note => note.screenshot ? [note.screenshot.id] : []));
        appendDeleteIds(state.pendingAssetDeletes.media, session.recordings.map(recording => recording.id));
        state.sessions = state.sessions.filter(item => item.id !== session.id);
        if (state.activeSessionId === session.id) { state.activeSessionId = null; state.selectedAnnotationId = null; }
      });
      await processPendingAssetDeletes(); await refreshContentScripts(); return undefined;
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
      if (!validHttpUrl(message.url)) return { annotations: [], visible: false };
      const state = await getState();
      const session = state.sessions.find(item => item.id === state.activeSessionId);
      return { annotations: session?.annotations.filter(note => note.kind !== "video" && note.url === message.url) ?? [], visible: state.settings.showAnnotations };
    }
    case "SELECT_ANNOTATION": {
      if (!sender.tab || sender.tab.url !== message.url || !validHttpUrl(message.url)) throw new Error("Annotation page did not match its sender.");
      await updateState(state => {
        const session = activeSession(state); const note = session.annotations.find(item => item.id === message.annotationId && item.url === message.url);
        if (!note) throw new Error("Annotation not found."); state.selectedAnnotationId = note.id;
      });
      if (sender.tab.id !== undefined) {
        let opened = false;
        try { if (ext.sidePanel?.open) { await ext.sidePanel.open({ tabId: sender.tab.id }); opened = true; } else if (firefoxExt.sidebarAction?.open) { await firefoxExt.sidebarAction.open(); opened = true; } } catch { /* browser may reject sidebar opening */ }
        if (!opened) await ext.tabs.create({ url: ext.runtime.getURL("sidebar/index.html") });
      }
      return undefined;
    }
    case "SAVE_RECORDING": {
      const recording = message.recording;
      if (typeof message.sessionId !== "string" || !validRecordingRef(recording, now())) throw new Error("Invalid recording metadata.");
      try {
        if (!Array.isArray(message.notes) || message.notes.length > 100) throw new Error("Invalid recording notes.");
        const tab = await activeTab();
        const notes = (message.notes.length ? message.notes : [{ text: "Screen recording", timestampMs: 0, url: tab.supported ? tab.url : "", pageTitle: tab.title || "Screen recording" }]).map(note => {
          if (!note || typeof note.text !== "string" || !note.text.trim() || note.text.length > MAX_NOTE_TEXT || !Number.isFinite(note.timestampMs) || note.timestampMs < 0 || note.timestampMs > recording.durationMs || typeof note.url !== "string" || (note.url !== "" && !validHttpUrl(note.url)) || note.url.length > 5_000 || typeof note.pageTitle !== "string" || note.pageTitle.length > 300) throw new Error("Invalid timestamped recording note.");
          return { ...note, text: note.text.trim(), timestampMs: Math.min(recording.durationMs, Math.round(note.timestampMs)) };
        });
        await updateState(async current => {
          const target = current.sessions.find(session => session.id === message.sessionId);
          if (!target) throw new Error("The recording's review session no longer exists.");
          assertSessionMutable(target);
          if (target.recordings.some(item => item.id === recording.id)) throw new Error("Recording already exists.");
          const blob = await getMediaBlob(recording.id);
          if (!blob || blob.size !== recording.byteSize) throw new Error("The local recording is missing or incomplete.");
          validateUploadBlob(blob, recording.mimeType);
          target.recordings.push(recording); const stamp = now();
          for (const entry of notes) target.annotations.push({ id: uuid(), sessionId: target.id, kind: "video", url: entry.url, safeUrl: safeUrl(entry.url), pageTitle: entry.pageTitle, text: entry.text, contextLabel: `Recording at ${Math.floor(entry.timestampMs / 60_000)}:${String(Math.floor(entry.timestampMs / 1_000) % 60).padStart(2, "0")}`, anchor: { kind: "video", recordingId: recording.id, timestampMs: entry.timestampMs }, createdAt: stamp + entry.timestampMs, updatedAt: stamp });
          target.drafts = []; target.status = "capturing"; target.updatedAt = stamp;
        });
        return undefined;
      } catch (error) {
        try { if (!(await getState()).sessions.some(session => session.recordings.some(item => item.id === recording.id))) await queueAssetDeletes([], [recording.id]); } catch { /* cleanup will retry only if it was durably queued */ }
        throw error;
      }
    }
    case "DELETE_RECORDING": {
      if (typeof message.recordingId !== "string") throw new Error("Invalid recording.");
      await updateState(state => {
        const session = activeSession(state); assertSessionMutable(session);
        if (!session.recordings.some(item => item.id === message.recordingId)) throw new Error("Recording not found.");
        appendDeleteIds(state.pendingAssetDeletes.media, [message.recordingId]);
        session.recordings = session.recordings.filter(item => item.id !== message.recordingId);
        session.annotations = session.annotations.filter(note => note.anchor.kind !== "video" || note.anchor.recordingId !== message.recordingId);
        session.drafts = []; session.status = "capturing"; session.updatedAt = now();
      });
      await processPendingAssetDeletes(); return undefined;
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
        const session = activeSession(state); assertSessionMutable(session); const stamp = now();
        const created: Annotation = { ...annotation, id: uuid(), sessionId: session.id, safeUrl: safeUrl(value.url), screenshotStatus: "pending", createdAt: stamp, updatedAt: stamp };
        session.annotations.push(created); session.drafts = []; session.status = "capturing"; session.updatedAt = stamp; return created;
      });
      let screenshotAttached = false;
      if (sender.tab.id !== undefined && sender.tab.windowId !== undefined) {
        let screenshot: Awaited<ReturnType<typeof captureScreenshot>> = undefined;
        try {
          const before = await ext.tabs.get(sender.tab.id);
          if (!before.active || before.url !== note.url || before.windowId !== sender.tab.windowId) throw new Error("The annotation tab is no longer active.");
          screenshot = await captureScreenshot(sender.tab.windowId, note.anchor as ElementAnchor | FreehandAnchor, viewport, note.id);
          if (screenshot) {
            const after = await ext.tabs.get(sender.tab.id);
            if (!after.active || after.url !== note.url || after.windowId !== sender.tab.windowId) { await queueAssetDeletes([screenshot.id]); screenshot = undefined; }
          }
          if (screenshot) {
            screenshotAttached = await updateState(state => {
              const session = state.sessions.find(item => item.id === note.sessionId); const current = session?.annotations.find(item => item.id === note.id);
              if (!session || !current || session.drafts.length) return false;
              const stamp = now(); current.screenshot = screenshot; current.screenshotStatus = undefined; current.updatedAt = stamp; session.updatedAt = stamp; return true;
            });
            if (!screenshotAttached) await queueAssetDeletes([screenshot.id]);
          }
        } catch { if (screenshot) await queueAssetDeletes([screenshot.id]).catch(() => undefined); }
      }
      if (!screenshotAttached) await updateState(state => {
        const current = state.sessions.find(item => item.id === note.sessionId)?.annotations.find(item => item.id === note.id);
        if (current && current.screenshotStatus === "pending") current.screenshotStatus = "failed";
      });
      await refreshContentScripts();
      return note;
    }
    case "UPDATE_ANNOTATION": {
      await updateState(state => {
        const session = activeSession(state); assertSessionMutable(session); const note = session.annotations.find(item => item.id === message.annotationId);
        if (!note || typeof message.text !== "string" || message.text.length > MAX_NOTE_TEXT) throw new Error("Invalid note update.");
        note.text = message.text; note.updatedAt = now(); session.drafts = []; session.status = "capturing"; session.updatedAt = now();
      });
      await refreshContentScripts(); return undefined;
    }
    case "DELETE_ANNOTATION": {
      await updateState(state => {
        const session = activeSession(state); assertSessionMutable(session);
        const note = session.annotations.find(item => item.id === message.annotationId);
        if (!note) throw new Error("Note not found.");
        if (note.screenshot) appendDeleteIds(state.pendingAssetDeletes.screenshots, [note.screenshot.id]);
        session.annotations = session.annotations.filter(item => item.id !== message.annotationId);
        if (state.selectedAnnotationId === message.annotationId) state.selectedAnnotationId = null;
        session.drafts = []; session.status = "capturing"; session.updatedAt = now();
      });
      await processPendingAssetDeletes(); await refreshContentScripts(); return undefined;
    }
    case "GENERATE_DRAFTS": {
      const state = await getState(); const session = activeSession(state); assertSessionMutable(session);
      if (!session.annotations.length) throw new Error("Capture at least one note first.");
      if (session.annotations.some(note => note.screenshotStatus === "pending")) throw new Error("Wait for screenshot capture to finish before organizing notes.");
      const revision = annotationRevision(session.annotations);
      const result = state.settings.aiProvider === "codex-subscription"
        ? await organizeWithCodex(session.annotations, session.id, state.settings)
        : await organize(session.annotations, session.id, state.settings, (await getCredentials()).aiKey);
      await updateState(current => {
        const target = current.sessions.find(item => item.id === session.id);
        if (!target || annotationRevision(target.annotations) !== revision) throw new Error("Notes changed while organizing. Generate the drafts again.");
        assertSessionMutable(target);
        target.drafts = result.drafts; target.status = "reviewing"; target.updatedAt = now();
      });
      return result;
    }
    case "UPDATE_DRAFT": return updateState(state => {
      const session = activeSession(state); const draft = session.drafts.find(item => item.id === message.draftId);
      if (!draft || !message.title.trim() || message.title.length > 256 || message.body.length > 65_536) throw new Error("Draft title or body is invalid.");
      if (draftIsLocked(draft)) throw new Error("A published, publishing, or unknown-result draft cannot be edited.");
      const title = message.title.trim();
      if (draft.title !== title || draft.body !== message.body) {
        draft.title = title; draft.body = message.body; draft.decision = "review"; draft.updatedAt = now(); session.updatedAt = now();
      }
    });
    case "SET_DRAFT_DECISION": return updateState(state => {
      const session = activeSession(state); const draft = session.drafts.find(item => item.id === message.draftId);
      if (!draft || !["review", "accepted", "skipped"].includes(message.decision)) throw new Error("Invalid draft decision.");
      if (draftIsLocked(draft)) throw new Error("A published, publishing, or unknown-result draft cannot be changed.");
      if (message.decision === "accepted" && (!draft.title.trim() || draft.title.length > 256 || draft.body.length > 65_536)) throw new Error("Fix the draft before accepting it.");
      draft.decision = message.decision; draft.updatedAt = now(); session.updatedAt = now();
    });
    case "SET_DRAFT_MEDIA_UPLOAD": return updateState(state => {
      const session = activeSession(state); const draft = session.drafts.find(item => item.id === message.draftId);
      if (!draft || typeof message.upload !== "boolean") throw new Error("Invalid media upload selection.");
      if (draftIsLocked(draft)) throw new Error("A published, publishing, or unknown-result draft cannot be changed.");
      assertMediaUploadCanChange(draft, message.upload);
      if (draft.uploadMedia !== message.upload) { draft.uploadMedia = message.upload; draft.decision = "review"; draft.updatedAt = now(); session.updatedAt = now(); }
    });
    case "PUBLISH_DRAFT": {
      const claim = await updateState(current => {
        const session = activeSession(current);
        const item = session.drafts.find(value => value.id === message.draftId);
        if (!item || item.decision !== "accepted") throw new Error("Accept this draft before publishing.");
        const media: Array<{ id: string; kind: "image" | "video"; mimeType: "image/jpeg" | "video/webm"; name: string }> = [];
        if (item.uploadMedia) {
          for (const annotationId of item.sourceAnnotationIds) {
            const note = session.annotations.find(value => value.id === annotationId); if (!note) continue;
            if (note.screenshot && !media.some(value => value.id === note.screenshot!.id)) media.push({ id: note.screenshot.id, kind: "image", mimeType: "image/jpeg", name: `product-pass-${note.id}.jpg` });
            if (note.anchor.kind === "video") { const recordingId = note.anchor.recordingId; if (!media.some(value => value.id === recordingId)) media.push({ id: recordingId, kind: "video", mimeType: "video/webm", name: `product-pass-${recordingId}.webm` }); }
          }
        }
        if (item.publishState === "published") return { sessionId: session.id, repo: item.publishRepo ?? current.settings.githubRepo, githubAuth: current.settings.githubAuth, githubOAuthScope: current.settings.githubOAuthScope, draft: { ...item, uploadedMedia: { ...(item.uploadedMedia ?? {}) } }, media, alreadyPublished: item };
        if (item.publishState === "publishing") throw new Error("This draft is already being published.");
        if (!validRepo(current.settings.githubRepo)) throw new Error("Configure GitHub repository as owner/name.");
        const claimedPublishState = item.publishState;
        const publishRepo = resolvePublishRepo(item, current.settings.githubRepo);
        if (claimedPublishState !== "unknown") item.publishRepo = publishRepo;
        item.publishState = "publishing"; item.error = undefined; item.updatedAt = now(); session.updatedAt = now();
        return { sessionId: session.id, repo: publishRepo, githubAuth: current.settings.githubAuth, githubOAuthScope: current.settings.githubOAuthScope, draft: { ...item, publishState: claimedPublishState, uploadedMedia: { ...(item.uploadedMedia ?? {}) } }, media, alreadyPublished: undefined };

      });
      if (claim.alreadyPublished) return claim.alreadyPublished;
      try {
        const githubToken = claim.githubAuth === "oauth" ? await getGithubOAuthToken(claim.githubOAuthScope) : (await getCredentials()).githubToken;
        const uploaded: UploadedMedia[] = []; const blobs = new Map<string, Blob>();
        for (const media of claim.media) {
          if (claim.draft.uploadedMedia?.[media.id]) continue;
          const blob = media.kind === "image" ? await screenshotBlob(media.id) : (await getMediaBlob(media.id)) ?? null;
          if (!blob) throw new Error(Object.keys(claim.draft.uploadedMedia ?? {}).length ? "Local media is missing after a partial upload. Restore or recapture it; already-uploaded files must remain attached." : "Local media is missing. Disable media upload or recapture it.");
          validateUploadBlob(blob, media.mimeType); blobs.set(media.id, blob);
        }
        let repoId: number | undefined;
        for (const media of claim.media) {
          let url = claim.draft.uploadedMedia?.[media.id];
          if (!url) {
            repoId ??= await repositoryId(claim.repo, githubToken);
            url = await uploadUserAttachment(repoId, media.name, media.mimeType, blobs.get(media.id)!, githubToken);
            try {
              await updateState(current => {
                const item = current.sessions.find(value => value.id === claim.sessionId)?.drafts.find(value => value.id === claim.draft.id);
                if (!item) throw new Error("Draft not found while saving an uploaded attachment.");
                item.uploadedMedia = { ...(item.uploadedMedia ?? {}), [media.id]: url! }; item.uploadedMediaRepo = claim.repo; item.updatedAt = now();
              });
            } catch { throw new Error("GitHub uploaded media, but Product Pass could not save its URL. The attachment is orphaned; do not retry immediately."); }
            claim.draft.uploadedMedia = { ...(claim.draft.uploadedMedia ?? {}), [media.id]: url };
          }
          uploaded.push({ id: media.id, kind: media.kind, name: media.name, url });
        }
        const issueDraft = uploaded.length ? { ...claim.draft, body: appendUploadedMedia(claim.draft.body, uploaded) } : claim.draft;
        const issue = await publish(claim.repo, issueDraft, githubToken);
        return updateState(current => {
          const target = current.sessions.find(value => value.id === claim.sessionId); const item = target?.drafts.find(value => value.id === claim.draft.id);
          if (!target || !item) throw new Error("Draft not found.");
          item.publishState = "published"; item.githubIssueNumber = issue.number; item.githubIssueUrl = issue.url; item.error = undefined; item.updatedAt = now();
          if (target.drafts.every(value => value.decision === "skipped" || (value.decision === "accepted" && value.publishState === "published"))) target.status = "complete";
          target.updatedAt = now(); return item;
        });
      } catch (error) {
        const messageText = safeMessage(error); const unknown = claim.draft.publishState === "unknown" || messageText.startsWith("UNKNOWN:");
        await updateState(current => {
          const target = current.sessions.find(value => value.id === claim.sessionId); const item = target?.drafts.find(value => value.id === claim.draft.id);
          if (item) { item.publishState = unknown ? "unknown" : "failed"; item.error = messageText.replace(/^UNKNOWN:/, ""); item.updatedAt = now(); }
          if (target) target.updatedAt = now();
        });
        throw new Error(messageText.replace(/^UNKNOWN:/, ""));
      }
    }
    case "SAVE_SETTINGS": {
      if (!["openai-compatible", "codex-subscription"].includes(message.settings.aiProvider) || !["pat", "oauth"].includes(message.settings.githubAuth) || !["public_repo", "repo"].includes(message.settings.githubOAuthScope)) throw new Error("Invalid authentication selection.");
      if (!validAIEndpoint(message.settings.aiEndpoint) || !message.settings.aiModel.trim() || message.settings.aiModel.length > 120) throw new Error("Use an HTTPS AI endpoint (HTTP is allowed only on localhost) and a valid model.");
      if (!message.settings.codexModel.trim() || message.settings.codexModel.length > 120) throw new Error("Enter a valid experimental Codex model.");
      if (message.settings.githubRepo && !validRepo(message.settings.githubRepo)) throw new Error("Repository must be owner/name.");
      const settings = { ...message.settings, aiModel: message.settings.aiModel.trim(), codexModel: message.settings.codexModel.trim(), githubRepo: message.settings.githubRepo.trim() };
      const previous = await getState();
      if (previous.settings.githubOAuthScope !== settings.githubOAuthScope || previous.settings.githubAuth !== settings.githubAuth) await disconnectGithubOAuth();
      await saveSettings(settings, message.aiKey, message.githubToken);
      repositoryCache = undefined;
      return undefined;
    }
    case "START_GITHUB_OAUTH_FLOW": {
      const state = await getState();
      if (state.settings.githubAuth !== "oauth") throw new Error("Select GitHub OAuth and save settings first.");
      repositoryCache = undefined;
      return startGithubOAuthFlow(state.settings.githubOAuthScope);
    }
    case "CANCEL_GITHUB_OAUTH_FLOW": await cancelGithubOAuthFlow(); repositoryCache = undefined; return undefined;
    case "DISCONNECT_GITHUB_OAUTH": await disconnectGithubOAuth(); repositoryCache = undefined; return undefined;
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
  if (alarm.name === GITHUB_OAUTH_ALARM) void pollGithubOAuthFlow();
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
ext.runtime.onStartup.addListener(() => { void processPendingAssetDeletes().catch(() => undefined); });
void processPendingAssetDeletes().catch(() => undefined);
void cleanupLegacyGithubApp().then(() => resumeGithubOAuthFlow());
void resumeCodexDeviceFlow();
void updateState(state => {
  for (const session of state.sessions) for (const draft of session.drafts) {
    if (draft.publishState === "publishing") {
      draft.publishState = "unknown";
      draft.error = "Publication was interrupted. Reconcile with GitHub before retrying.";
    }
  }
});
