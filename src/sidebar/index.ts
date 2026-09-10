import { ext } from "../shared/browser";
import type { Annotation, AppState, Bootstrap, CaptureKind, IssueDraft, RecordingRef, RequestMessage, ReviewSession } from "../shared/model";
import { draftIsLocked, MAX_RECORDING_BYTES, MAX_RECORDING_MS, originPattern, safeUrl } from "../shared/pure";
import { getMediaBlob, getScreenshotBlob, putMediaBlob } from "../shared/media-store";

const app = document.querySelector<HTMLElement>("#app")!;
const pageStatus = document.querySelector<HTMLElement>("#page-status")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
let data: Bootstrap | null = null;
let selectedDraft = 0;
let busy = false;
let settingsOpen = false;
let captureOpen = true;
let reviewOpen = true;
let setupOpen: boolean | null = null;
let repoSearchTimer: number | undefined;
let focusedAnnotationId: string | null = null;
let annotationFocusTimer: number | undefined;
const screenshotCache = new Map<string, string>();
const screenshotLoads = new Map<string, Promise<string>>();
function releaseScreenshot(id: string): void { const url = screenshotCache.get(id); if (url) URL.revokeObjectURL(url); screenshotCache.delete(id); screenshotLoads.delete(id); }
const recordingUrls = new Map<string, string>();
const recordingLoads = new Map<string, Promise<string>>();
const draftEdits = new Map<string, { title: string; body: string }>();
type PendingRecordingNote = { text: string; timestampMs: number; url: string; pageTitle: string };
type ActiveRecording = { id: string; sessionId: string; recorder: MediaRecorder; stream: MediaStream; startedAt: number; chunks: Blob[]; bytes: number; notes: PendingRecordingNote[]; discard: boolean; failure?: string; done: Promise<void>; resolveDone: () => void };
let recording: ActiveRecording | null = null;
let recordingNoteDraft = "";
let recordingTimer: number | undefined;

async function rpc<T>(message: RequestMessage): Promise<T> {
  const response = await ext.runtime.sendMessage(message) as { ok: boolean; value?: T; error?: string };
  if (!response?.ok) throw new Error(response?.error || "The operation failed.");
  return response.value as T;
}

function say(text: string, error = false): void { notice.textContent = text; notice.className = error ? "error" : "success"; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
}
function button(text: string, action: () => void | Promise<void>, className = ""): HTMLButtonElement {
  const node = element("button", text, className); node.type = "button"; node.disabled = busy;
  node.addEventListener("click", () => void run(action)); return node;
}
function directButton(text: string, action: () => void, className = ""): HTMLButtonElement {
  const node = element("button", text, className); node.type = "button"; node.addEventListener("click", action); return node;
}
async function hydrateScreenshot(note: Annotation, image: HTMLImageElement, placeholder: HTMLElement): Promise<void> {
  try {
    let source = screenshotCache.get(note.id);
    if (!source) {
      let pending = screenshotLoads.get(note.id);
      if (!pending) { pending = getScreenshotBlob(note.screenshot!.id).then(blob => { if (!blob) throw new Error(); return URL.createObjectURL(blob); }); screenshotLoads.set(note.id, pending); }
      try { source = await pending; } finally { screenshotLoads.delete(note.id); }
      const referenced = data?.state.sessions.some(session => session.annotations.some(item => item.id === note.id && item.screenshot?.id === note.screenshot?.id));
      if (!referenced) { URL.revokeObjectURL(source); return; }
      const existing = screenshotCache.get(note.id); if (existing && existing !== source) URL.revokeObjectURL(source); else screenshotCache.set(note.id, source);
      source = existing ?? source;
    }
    if (!image.isConnected) return;
    image.src = source; image.hidden = false; placeholder.remove();
  } catch { if (placeholder.isConnected) { placeholder.textContent = "Screenshot unavailable"; placeholder.classList.add("error"); } }
}
function openScreenshot(note: Annotation, source: string): void {
  const dialog = element("dialog", undefined, "lightbox"); dialog.setAttribute("aria-label", `Screenshot from ${note.pageTitle || "page"}`);
  const heading = element("div", undefined, "lightbox-heading"); heading.append(element("strong", note.pageTitle || "Captured annotation"), directButton("Close", () => dialog.close(), "secondary compact"));
  const image = element("img"); image.src = source; image.alt = `Captured ${note.kind} annotation on ${note.pageTitle || "page"}`;
  dialog.append(heading, image, element("p", note.safeUrl, "meta")); dialog.addEventListener("close", () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
function screenshotFigure(note: Annotation, variant: "note" | "preview" = "note"): HTMLElement {
  const figure = element("figure", undefined, `screenshot-frame ${variant}`); const placeholder = element("div", "Loading screenshot…", "screenshot-placeholder");
  const image = element("img"); image.hidden = true; image.alt = `Captured ${note.kind} annotation on ${note.pageTitle || "page"}`;
  const open = directButton("", () => { const source = screenshotCache.get(note.id); if (source) openScreenshot(note, source); }, "image-button");
  open.setAttribute("aria-label", `Open screenshot from ${note.pageTitle || "page"}`); open.append(image); figure.append(placeholder, open);
  if (variant === "preview") figure.append(element("figcaption", note.text || note.contextLabel || note.pageTitle || "Source annotation"));
  const download = directButton("Download", () => { const source = screenshotCache.get(note.id); if (!source) return; const link = element("a"); link.href = source; link.download = `product-pass-${note.id}.jpg`; link.click(); }, "secondary compact"); download.disabled = true;
  void hydrateScreenshot(note, image, placeholder).then(() => { download.disabled = !screenshotCache.has(note.id); }); figure.append(download); return figure;
}
function timestamp(value: number): string { return `${Math.floor(value / 60_000)}:${String(Math.floor(value / 1_000) % 60).padStart(2, "0")}`; }
async function hydrateRecording(ref: RecordingRef, video: HTMLVideoElement, placeholder: HTMLElement): Promise<void> {
  try {
    let source = recordingUrls.get(ref.id);
    if (!source) {
      let pending = recordingLoads.get(ref.id);
      if (!pending) {
        pending = getMediaBlob(ref.id).then(blob => { if (!blob) throw new Error(); return URL.createObjectURL(blob); }); recordingLoads.set(ref.id, pending);
      }
      try { source = await pending; } finally { recordingLoads.delete(ref.id); }
      const referenced = data?.state.sessions.some(session => session.recordings.some(item => item.id === ref.id));
      if (!referenced) { URL.revokeObjectURL(source); return; }
      const existing = recordingUrls.get(ref.id); if (existing && existing !== source) URL.revokeObjectURL(source); else recordingUrls.set(ref.id, source);
      source = existing ?? source;
    }
    if (!video.isConnected) return; video.src = source; video.hidden = false; placeholder.remove();
  } catch { if (placeholder.isConnected) { placeholder.textContent = "Recording unavailable"; placeholder.classList.add("error"); } }
}
function recordingFigure(ref: RecordingRef, notes: Annotation[], variant: "recording" | "preview" = "recording"): HTMLElement {
  const figure = element("figure", undefined, `recording-frame ${variant}`); const placeholder = element("div", "Loading recording…", "screenshot-placeholder");
  const video = element("video"); video.controls = true; video.preload = "metadata"; video.hidden = true; video.setAttribute("aria-label", `Screen recording from ${new Date(ref.createdAt).toLocaleString()}`);
  figure.append(placeholder, video);
  if (notes.length) {
    const markers = element("div", undefined, "recording-markers");
    for (const note of [...notes].sort((a, b) => (a.anchor.kind === "video" ? a.anchor.timestampMs : 0) - (b.anchor.kind === "video" ? b.anchor.timestampMs : 0))) {
      if (note.anchor.kind !== "video") continue;
      markers.append(directButton(`${timestamp(note.anchor.timestampMs)} — ${note.text}`, () => { video.currentTime = note.anchor.kind === "video" ? note.anchor.timestampMs / 1_000 : 0; void video.play(); }, "secondary compact"));
    }
    figure.append(markers);
  }
  void hydrateRecording(ref, video, placeholder); return figure;
}
function stopTracks(stream: MediaStream): void { stream.getTracks().forEach(track => track.stop()); }
function updateRecordingStatus(): void {
  const status = document.querySelector<HTMLElement>("#recording-status"); if (!status || !recording) return;
  const elapsed = Math.min(MAX_RECORDING_MS, Date.now() - recording.startedAt); status.textContent = `Recording ${timestamp(elapsed)} / 1:00 · ${(recording.bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function chooseRecordingMime(): string {
  for (const mime of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) if (MediaRecorder.isTypeSupported(mime)) return mime;
  throw new Error("This browser cannot record WebM video.");
}
async function startRecording(): Promise<void> {
  if (recording) throw new Error("A recording is already active.");
  const session = activeSession(); if (!session) throw new Error("Create or select a review session first.");
  if (session.drafts.some(draft => draft.publishState === "publishing")) throw new Error("Wait for the current GitHub publication to finish before recording.");
  if (session.drafts.some(draft => draft.publishState === "unknown")) throw new Error("Reconcile the unknown GitHub publication before recording more evidence.");
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") throw new Error("Screen recording is unavailable in this browser.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream, { mimeType: chooseRecordingMime(), videoBitsPerSecond: 2_500_000 }); }
  catch (error) { stopTracks(stream); throw error; }
  let resolveDone!: () => void; const done = new Promise<void>(resolve => { resolveDone = resolve; });
  recordingNoteDraft = "";
  const current: ActiveRecording = recording = { id: crypto.randomUUID(), sessionId: session.id, recorder, stream, startedAt: Date.now(), chunks: [], bytes: 0, notes: [], discard: false, done, resolveDone };
  recorder.ondataavailable = event => { if (!event.data.size) return; current.chunks.push(event.data); current.bytes += event.data.size; if (current.bytes > MAX_RECORDING_BYTES) { current.failure = "Recording exceeded the 100 MiB limit and was discarded."; current.discard = true; if (recorder.state !== "inactive") recorder.stop(); } };
  recorder.onerror = () => { current.failure = "Screen recording failed and was discarded."; current.discard = true; if (recorder.state !== "inactive") recorder.stop(); };
  recorder.onstop = () => void (async () => {
    window.clearInterval(recordingTimer); stopTracks(stream);
    const durationMs = Math.min(MAX_RECORDING_MS, Date.now() - current.startedAt); const blob = new Blob(current.chunks, { type: "video/webm" });
    try {
      if (current.discard) { if (current.failure) say(current.failure, true); return; }
      if (!blob.size || blob.size > MAX_RECORDING_BYTES || durationMs < 1) throw new Error("The recording was empty or exceeded its limit.");
      await putMediaBlob(current.id, blob);
      await rpc({ type: "SAVE_RECORDING", sessionId: current.sessionId, recording: { id: current.id, mimeType: "video/webm", byteSize: blob.size, durationMs, createdAt: current.startedAt }, notes: current.notes });
      say("Recording saved locally. It is not shared unless a draft explicitly enables GitHub media upload.");
    } catch (error) { say(error instanceof Error ? error.message : "Could not save recording. Product Pass will retry cleanup if it was staged locally.", true); }
    finally { if (recording === current) recording = null; recordingNoteDraft = ""; current.resolveDone(); await load(false); }
  })();
  stream.getVideoTracks().forEach(track => track.addEventListener("ended", () => { if (recorder.state !== "inactive") recorder.stop(); }, { once: true }));
  try { recorder.start(1_000); }
  catch (error) { recording = null; stopTracks(stream); throw error; }
  recordingTimer = window.setInterval(() => { updateRecordingStatus(); if (Date.now() - current.startedAt >= MAX_RECORDING_MS && recorder.state !== "inactive") recorder.stop(); }, 250); render();
}
async function stopRecording(discard = false): Promise<void> {
  const current = recording; if (!current) return; current.discard ||= discard;
  if (current.recorder.state !== "inactive") current.recorder.stop(); stopTracks(current.stream); await current.done;
}
async function run(action: () => void | Promise<void>): Promise<void> {
  try { busy = true; render(); await action(); } catch (error) { say(error instanceof Error ? error.message : "The operation failed.", true); }
  finally { busy = false; await load(false); }
}
async function load(showLoading = true): Promise<void> {
  if (showLoading) app.textContent = "Loading…";
  try {
    data = await rpc<Bootstrap>({ type: "BOOTSTRAP" });
    const screenshotIds = new Set(data.state.sessions.flatMap(session => session.annotations.flatMap(note => note.screenshot ? [note.id] : [])));
    for (const id of screenshotCache.keys()) if (!screenshotIds.has(id)) releaseScreenshot(id);
    const recordingIds = new Set(data.state.sessions.flatMap(session => session.recordings.map(item => item.id)));
    for (const [id, url] of recordingUrls) if (!recordingIds.has(id)) { URL.revokeObjectURL(url); recordingUrls.delete(id); }
    const drafts = new Map(data.state.sessions.flatMap(session => session.drafts.map(draft => [draft.id, draft] as const)));
    for (const id of draftEdits.keys()) { const draft = drafts.get(id); if (!draft || draftIsLocked(draft)) draftEdits.delete(id); }
    render();
  } catch (error) { app.textContent = "Could not load Product Pass."; say(error instanceof Error ? error.message : "Load failed.", true); }
}
function activeSession(): ReviewSession | undefined { return data?.state.sessions.find(session => session.id === data?.state.activeSessionId); }

function render(): void {
  if (!data) return;
  const pendingSelection = data.state.selectedAnnotationId;
  if (pendingSelection) { focusedAnnotationId = pendingSelection; captureOpen = true; }
  app.replaceChildren();
  pageStatus.textContent = data.tab.supported ? `${data.tab.title || "Untitled page"} — ${safeUrl(data.tab.url)}` : "Annotations unavailable on this page";
  renderSessionChooser(data.state);
  renderConnectionChecklist(data.state);
  const session = activeSession();
  if (!session) { if (!data.state.sessions.length) renderCreate(); renderSettings(data.state); return; }
  renderCapture(session);
  if (session.drafts.length) renderDrafts(session);
  renderSettings(data.state);
  if (pendingSelection) requestAnimationFrame(() => {
    const item = app.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(pendingSelection)}"]`);
    item?.scrollIntoView({ behavior: "smooth", block: "center" }); item?.focus({ preventScroll: true });
    window.setTimeout(() => void rpc({ type: "CLEAR_ANNOTATION_SELECTION" }), 600); window.clearTimeout(annotationFocusTimer);
    annotationFocusTimer = window.setTimeout(() => { focusedAnnotationId = null; app.querySelector(`[data-annotation-id="${CSS.escape(pendingSelection)}"]`)?.classList.remove("selected"); }, 2_500);
  });
}

function renderSessionChooser(state: AppState): void {
  if (!state.sessions.length) return;
  const wrap = element("section", undefined, "session-select");
  const label = element("label", "Review session"); label.htmlFor = "session";
  const select = element("select"); select.id = "session";
  if (!state.activeSessionId) { const placeholder = element("option", "Select a saved session…"); placeholder.value = ""; placeholder.selected = true; placeholder.disabled = true; select.append(placeholder); }
  for (const session of [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const option = element("option", `${session.title} — ${session.annotations.length} notes — ${session.status}`); option.value = session.id; option.selected = session.id === state.activeSessionId; select.append(option);
  }
  select.disabled = Boolean(recording); select.addEventListener("change", () => { if (select.value) void run(() => rpc({ type: "SET_ACTIVE_SESSION", sessionId: select.value })); });
  const actions = element("div", undefined, "session-actions"); const newReview = button("New review", () => createSession(), "secondary"); newReview.disabled ||= Boolean(recording); actions.append(newReview);
  const session = activeSession();
  if (session) {
    const finish = button("Finish", () => finishSession(session), "secondary"); const remove = button("Delete session", () => removeSession(session), "danger"); finish.disabled ||= Boolean(recording); remove.disabled ||= Boolean(recording); actions.append(finish, remove);
  }
  wrap.append(label, select, actions); app.append(wrap);
}

function renderCreate(): void {
  const section = element("section", undefined, "empty-state"); section.append(element("h2", "Start your first review"), element("p", "Capture visual feedback across pages, then turn it into reviewed GitHub issues.", "meta"), button("Start review", createSession)); app.append(section);
}
async function createSession(): Promise<void> {
  if (recording) throw new Error("Stop or cancel the active recording before starting another review.");
  if (activeSession() && !confirm("Start a new review? Your saved notes remain in the current session.")) return;
  const title = prompt("Review name (optional):", ""); if (title === null) return;
  await rpc({ type: "CREATE_SESSION", title: title.slice(0, 120) }); say("Review started.");
}

async function connectCodex(): Promise<void> {
  if (!await ext.permissions.request({ origins: ["https://auth.openai.com/*", "https://chatgpt.com/*"] })) throw new Error("OpenAI access permission was not granted.");
  await rpc({ type: "SAVE_SETTINGS", settings: { ...data!.state.settings, aiProvider: "codex-subscription" } });
  await rpc({ type: "START_CODEX_DEVICE_FLOW" }); say("Enter the displayed code on the OpenAI verification page.");
}
async function connectGithub(): Promise<void> {
  if (!await ext.permissions.request({ origins: ["https://github.com/*", "https://api.github.com/*"] })) throw new Error("GitHub access permission was not granted.");
  await rpc({ type: "SAVE_SETTINGS", settings: { ...data!.state.settings, githubAuth: "oauth" } });
  await rpc({ type: "START_GITHUB_OAUTH_FLOW" }); say("Enter the displayed code on GitHub.");
}
function deviceFlow(code: string, url: string, label: string): HTMLElement {
  const panel = element("div", undefined, "connection-flow"); panel.append(element("span", code, "device-code"));
  const link = element("a", label); link.href = url; link.target = "_blank"; link.rel = "noreferrer"; panel.append(link); return panel;
}
function renderConnectionChecklist(state: AppState): void {
  const usingCodex = state.settings.aiProvider === "codex-subscription";
  const aiStatus = data!.credentials.codexSubscription; const githubStatus = data!.credentials.githubOAuth;
  const aiReady = usingCodex ? aiStatus.connected : data!.credentials.aiKey;
  const githubConnected = state.settings.githubAuth === "oauth" ? githubStatus.connected : data!.credentials.githubToken;
  const githubReady = Boolean(state.settings.githubRepo) && githubConnected;
  const complete = Number(aiReady) + Number(githubReady);
  const details = element("details", undefined, "setup-checklist"); details.open = setupOpen ?? complete < 2; details.addEventListener("toggle", () => { setupOpen = details.open; });
  const summary = element("summary"); summary.append(element("span", "Setup", "section-title"), element("span", `${complete}/2 ready`, "count")); details.append(summary);
  const list = element("div", undefined, "checklist");
  const addItem = (checked: boolean, title: string, description: string, action?: () => Promise<void>) => {
    const row = element("div", undefined, `checklist-item${checked ? " ready" : ""}`); const mark = element("input"); mark.type = "checkbox"; mark.checked = checked; mark.disabled = true; mark.setAttribute("aria-label", `${title}: ${checked ? "ready" : "not connected"}`);
    const copy = element("div"); copy.append(element("strong", title), element("span", description, "meta")); row.append(mark, copy);
    if (!checked && action) row.append(button("Connect", action, "secondary compact")); list.append(row); return row;
  };
  const aiRow = addItem(aiReady, "AI organization", aiReady ? (usingCodex ? "Codex subscription connected" : "OpenAI-compatible API connected") : "Codex subscription · local fallback remains available", aiStatus.state === "awaiting-user" ? undefined : connectCodex);
  if (aiStatus.state === "awaiting-user" && aiStatus.userCode && aiStatus.verificationUri) aiRow.append(deviceFlow(aiStatus.userCode, aiStatus.verificationUri, "Open OpenAI verification"));
  const githubRow = addItem(githubReady, "GitHub issue destination", githubReady ? state.settings.githubRepo : githubConnected ? "Connected · choose a repository below" : `Product Pass OAuth · ${state.settings.githubOAuthScope === "repo" ? "public and private repos" : "public repos"}`, githubConnected || githubStatus.state === "awaiting-user" ? undefined : connectGithub);
  if (githubStatus.state === "awaiting-user" && githubStatus.userCode && githubStatus.verificationUri) githubRow.append(deviceFlow(githubStatus.userCode, githubStatus.verificationUri, "Open GitHub verification"));
  const repo = element("div", undefined, "repo-picker");
  const accessLabel = element("label", "OAuth repository access"); accessLabel.htmlFor = "github-oauth-scope"; const access = element("select"); access.id = "github-oauth-scope";
  const publicOnly = element("option", "Public repositories only"); publicOnly.value = "public_repo"; const privateAccess = element("option", "Public and private repositories (broad repo scope)"); privateAccess.value = "repo"; access.append(publicOnly, privateAccess); access.value = state.settings.githubOAuthScope;
  access.addEventListener("change", () => void run(async () => { if (githubStatus.connected && !confirm("Changing repository access disconnects GitHub. Continue?")) { access.value = state.settings.githubOAuthScope; return; } await rpc({ type: "SAVE_SETTINGS", settings: { ...state.settings, githubAuth: "oauth", githubOAuthScope: access.value as "public_repo" | "repo" } }); say("GitHub access level saved. Connect GitHub to authorize it."); }));
  const label = element("label", "Issue repository"); label.htmlFor = "setup-repo";
  const input = element("input"); input.id = "setup-repo"; input.value = state.settings.githubRepo; input.placeholder = githubConnected ? "Search owner/repository" : "Connect GitHub to search repositories"; input.setAttribute("list", "github-repositories");
  const options = element("datalist"); options.id = "github-repositories"; const searchStatus = element("span", githubConnected ? "Type to search repositories available to the connected account." : "Repository search becomes available after GitHub is connected.", "meta");
  const search = () => {
    if (!githubConnected) return; window.clearTimeout(repoSearchTimer); const query = input.value;
    repoSearchTimer = window.setTimeout(async () => {
      try {
        searchStatus.textContent = "Searching GitHub…"; const names = await rpc<string[]>({ type: "SEARCH_GITHUB_REPOS", query });
        if (!input.isConnected || input.value !== query) return; options.replaceChildren(...names.map(name => { const option = element("option"); option.value = name; return option; })); searchStatus.textContent = names.length ? `${names.length} matching repositor${names.length === 1 ? "y" : "ies"}.` : "No accessible repositories matched.";
      } catch (error) { searchStatus.textContent = error instanceof Error ? error.message : "Repository search failed."; }
    }, 250);
  };
  input.addEventListener("focus", search); input.addEventListener("input", search); input.addEventListener("change", () => void run(async () => { await rpc({ type: "SET_GITHUB_REPO", repo: input.value }); say("Issue repository saved."); }));
  repo.append(accessLabel, access, label, input, options, searchStatus);
  details.append(list, repo); app.append(details);
}
async function finishSession(session: ReviewSession): Promise<void> {
  if (recording) throw new Error("Stop or cancel the active recording before finishing this review.");
  const unpublished = session.drafts.some(draft => draft.publishState !== "published" && draft.decision === "accepted");
  const warning = unpublished ? " It has accepted issues that have not been published." : "";
  if (!confirm(`Finish “${session.title}”?${warning}\n\nThe session remains saved and can be reopened later.`)) return;
  await rpc({ type: "FINISH_SESSION", sessionId: session.id }); say("Session finished.");
}
async function removeSession(session: ReviewSession): Promise<void> {
  if (recording) throw new Error("Stop or cancel the active recording before deleting this review.");
  if (!confirm(`Permanently delete “${session.title}” and its ${session.annotations.length} local note${session.annotations.length === 1 ? "" : "s"}, screenshots, ${session.recordings.length} recording${session.recordings.length === 1 ? "" : "s"}, and drafts?\n\nPublished GitHub issues and already uploaded media are unaffected. This cannot be undone.`)) return;
  await rpc({ type: "DELETE_SESSION", sessionId: session.id });
  session.annotations.forEach(note => releaseScreenshot(note.id)); session.recordings.forEach(ref => { const url = recordingUrls.get(ref.id); if (url) URL.revokeObjectURL(url); recordingUrls.delete(ref.id); }); say("Session deleted.");
}

function renderCapture(session: ReviewSession): void {
  const section = element("details", undefined, "workflow-section"); section.open = captureOpen; section.addEventListener("toggle", () => { captureOpen = section.open; });
  const heading = element("summary", undefined, "section-heading"); heading.append(element("span", "1. Capture", "section-title"), element("span", `${session.annotations.length} note${session.annotations.length === 1 ? "" : "s"}`, "count")); section.append(heading);
  const display = element("label", undefined, "annotation-toggle"); const toggle = element("input"); toggle.type = "checkbox"; toggle.checked = data!.state.settings.showAnnotations; toggle.addEventListener("change", () => void run(() => rpc({ type: "SET_ANNOTATIONS_VISIBLE", visible: toggle.checked })));
  display.append(toggle, element("span", "Show annotations on page")); section.append(display);
  const recordControls = element("div", undefined, "recording-controls");
  if (recording) {
    const status = element("span", `Recording ${timestamp(Math.min(MAX_RECORDING_MS, Date.now() - recording.startedAt))} / 1:00 · ${(recording.bytes / 1024 / 1024).toFixed(1)} MiB`, "recording-status"); status.id = "recording-status";
    const noteLimitReached = recording.notes.length >= 100;
    const noteInput = element("input"); noteInput.type = "text"; noteInput.maxLength = 2_000; noteInput.placeholder = noteLimitReached ? "100 timestamp notes reached" : "Timestamped note"; noteInput.setAttribute("aria-label", "Timestamped recording note"); noteInput.value = recordingNoteDraft; noteInput.disabled = noteLimitReached; noteInput.addEventListener("input", () => { recordingNoteDraft = noteInput.value; });
    const add = directButton(noteLimitReached ? "Timestamp limit reached" : `Add timestamp (${recording.notes.length}/100)`, () => { const text = recordingNoteDraft.trim(); if (!text) { say("Enter a timestamped note first.", true); noteInput.focus(); return; } if (!recording || recording.notes.length >= 100) { say("This recording already has the maximum 100 timestamp notes.", true); return; } recording.notes.push({ text, timestampMs: Math.min(MAX_RECORDING_MS, Date.now() - recording.startedAt), url: data!.tab.supported ? data!.tab.url : "", pageTitle: data!.tab.supported ? data!.tab.title : "Screen recording" }); recordingNoteDraft = ""; say(`Timestamp note added at ${timestamp(recording.notes.at(-1)!.timestampMs)}.`); render(); }, "secondary"); add.disabled = noteLimitReached;
    recordControls.append(status, noteInput, add, button("Stop & save", () => stopRecording(false)), button("Cancel", () => stopRecording(true), "danger"));
  } else recordControls.append(button("Record screen", startRecording), element("span", "Chooser required · no audio · max 1 minute / 100 MiB", "meta"));
  section.append(recordControls);
  for (const ref of [...session.recordings].sort((a, b) => b.createdAt - a.createdAt)) {
    const notes = session.annotations.filter(note => note.anchor.kind === "video" && note.anchor.recordingId === ref.id);
    const card = element("article", undefined, "recording-card card"); card.append(element("h3", `Screen recording · ${timestamp(ref.durationMs)}`), element("p", `${new Date(ref.createdAt).toLocaleString()} · ${(ref.byteSize / 1024 / 1024).toFixed(1)} MiB`, "meta"), recordingFigure(ref, notes));
    const actions = element("div", undefined, "actions"); actions.append(button("Download", async () => { const blob = await getMediaBlob(ref.id); if (!blob) throw new Error("Recording unavailable."); const url = URL.createObjectURL(blob); const link = element("a"); link.href = url; link.download = `product-pass-${ref.id}.webm`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000); }, "secondary"), button("Delete recording", async () => { const warning = session.drafts.length ? " This also discards generated drafts." : ""; if (!confirm(`Delete this local recording and all its timestamp notes?${warning}`)) return; await rpc({ type: "DELETE_RECORDING", recordingId: ref.id }); const url = recordingUrls.get(ref.id); if (url) URL.revokeObjectURL(url); recordingUrls.delete(ref.id); say("Recording deleted."); }, "danger")); card.append(actions); section.append(card);
  }
  if (!data!.tab.supported) section.append(element("p", "Annotations are unavailable on this page. Open a regular HTTP or HTTPS page.", "warning"));
  else if (!data!.tab.enabled) section.append(button("Enable on this site", enableSite));
  else {
    const controls = element("div", undefined, "row");
    controls.append(button("Element rectangle", () => beginCapture("element")), button("Freehand boundary", () => beginCapture("freehand")));
    section.append(controls);
  }
  for (const note of [...session.annotations].sort((a, b) => b.createdAt - a.createdAt)) {
    const item = element("article", undefined, `note card${focusedAnnotationId === note.id ? " selected" : ""}`); item.dataset.annotationId = note.id; item.tabIndex = -1;
    const noteHead = element("div", undefined, "note-heading"); noteHead.append(element("span", note.kind === "element" ? "Element" : note.kind === "freehand" ? "Freehand" : "Video", "badge"), element("span", note.anchor.kind === "video" ? timestamp(note.anchor.timestampMs) : new Date(note.createdAt).toLocaleDateString(), "meta")); item.append(noteHead, element("h3", note.pageTitle || "Untitled page"), element("p", note.safeUrl, "meta"));
    if (note.screenshot) item.append(screenshotFigure(note));
    else if (note.screenshotStatus === "pending") item.append(element("p", "Capturing screenshot…", "meta"));
    else if (note.screenshotStatus === "failed" && note.kind !== "video") item.append(element("p", "Screenshot capture failed. Keep this tab active and recapture the annotation to include an image.", "warning"));
    item.append(element("p", note.text || "No note text", note.text ? "note-text" : "meta note-text"));
    const actions = element("div", undefined, "actions"); actions.append(button("Edit", async () => {
      if (session.drafts.length && !confirm("This will discard generated issue drafts. Published GitHub issues are unaffected.")) return;
      const text = prompt("Edit annotation text (optional):", note.text); if (text === null) return;
      await rpc({ type: "UPDATE_ANNOTATION", annotationId: note.id, text: text.slice(0, 2_000) }); say("Note updated.");
    }, "secondary"), button("Delete", async () => {
      const warning = session.drafts.length ? " This also discards generated drafts; published GitHub issues are unaffected." : "";
      if (!confirm(`Delete this note?${warning}`)) return;
      await rpc({ type: "DELETE_ANNOTATION", annotationId: note.id }); releaseScreenshot(note.id); say(note.kind === "video" ? "Timestamp note deleted; the recording remains." : "Note deleted.");
    }, "danger")); item.append(actions); section.append(item);
  }
  const organizeButton = button(`Organize ${session.annotations.length} note${session.annotations.length === 1 ? "" : "s"}`, organize);
  organizeButton.disabled = busy || session.annotations.length === 0 || session.annotations.some(note => note.screenshotStatus === "pending"); section.append(organizeButton); app.append(section);
}

async function enableSite(): Promise<void> {
  const pattern = originPattern(data!.tab.url); if (!pattern || data!.tab.id === undefined) throw new Error("This page is unsupported.");
  const granted = await ext.permissions.request({ origins: [pattern] }); if (!granted) throw new Error("Site access was not granted.");
  await rpc({ type: "ENABLE_ORIGIN", origin: data!.tab.url, tabId: data!.tab.id }); say("Annotations enabled on this site.");
}
async function beginCapture(mode: CaptureKind): Promise<void> {
  if (data!.tab.id === undefined) throw new Error("No active tab.");
  await rpc({ type: "BEGIN_CAPTURE", mode, tabId: data!.tab.id }); say(`${mode === "element" ? "Element selection" : "Freehand capture"} started on the page. Press Escape to cancel.`);
}
async function organize(): Promise<void> {
  const session = activeSession()!;
  const usingCodex = data!.state.settings.aiProvider === "codex-subscription";
  if (usingCodex && !data!.credentials.codexSubscription.connected) throw new Error("Connect experimental Codex in Settings first.");
  const provider = usingCodex ? `experimental ChatGPT Codex (${data!.state.settings.codexModel})` : data!.credentials.aiKey ? new URL(data!.state.settings.aiEndpoint).hostname : "the local deterministic fallback";
  const domains = [...new Set(session.annotations.map(note => { try { return new URL(note.safeUrl).hostname; } catch { return "unknown"; } }))].join(", ");
  if (!confirm(`Organize ${session.annotations.length} notes using ${provider}?\n\nShared with a configured AI: note text, page title, sanitized URL, annotation type, and element label. No screenshots, page DOM, query strings, fragments, or credentials.\n\nDomains: ${domains}`)) return;
  const result = await rpc<{ fallback: boolean }>({ type: "GENERATE_DRAFTS" });
  selectedDraft = 0; reviewOpen = true; say(result.fallback ? "Drafts created with deterministic local grouping (AI unavailable or unconfigured)." : "AI drafts created.");
}

function renderDrafts(session: ReviewSession): void {
  selectedDraft = Math.min(selectedDraft, session.drafts.length - 1);
  const draft = session.drafts[selectedDraft];
  const section = element("details", undefined, "workflow-section"); section.open = reviewOpen; section.addEventListener("toggle", () => { reviewOpen = section.open; });
  const heading = element("summary", undefined, "section-heading"); heading.append(element("span", "2. Review & publish", "section-title"), element("span", `${selectedDraft + 1} / ${session.drafts.length}`, "count")); section.append(heading);
  const nav = element("div", undefined, "row");
  const previous = button("Previous", () => { selectedDraft--; render(); }, "secondary"); previous.disabled = busy || selectedDraft === 0;
  const next = button("Next", () => { selectedDraft++; render(); }, "secondary"); next.disabled = busy || selectedDraft === session.drafts.length - 1; nav.append(previous, next); section.append(nav);
  const card = element("article", undefined, `card ${draft.publishState === "published" ? "published" : ""}`);
  const statuses = element("div", undefined, "status-row"); statuses.append(element("span", draft.decision, `badge decision-${draft.decision}`), element("span", draft.publishState, `badge publish-${draft.publishState}`)); card.append(statuses);
  const titleLabel = element("label", "Issue title"); titleLabel.htmlFor = "draft-title";
  const locked = draftIsLocked(draft); if (locked) draftEdits.delete(draft.id);
  const edit = draftEdits.get(draft.id) ?? { title: draft.title, body: draft.body };
  const title = element("input"); title.id = "draft-title"; title.value = edit.title; title.maxLength = 256; title.disabled = locked;
  const bodyLabel = element("label", "Issue body (Markdown)"); bodyLabel.htmlFor = "draft-body";
  const body = element("textarea"); body.id = "draft-body"; body.value = edit.body; body.maxLength = 65_536; body.disabled = locked;
  const rememberEdit = () => { draftEdits.set(draft.id, { title: title.value, body: body.value }); }; title.addEventListener("input", rememberEdit); body.addEventListener("input", rememberEdit);
  card.append(titleLabel, title, bodyLabel, body);
  if (!locked) card.append(button("Save edits", async () => { await rpc({ type: "UPDATE_DRAFT", draftId: draft.id, title: title.value, body: body.value }); draftEdits.delete(draft.id); say("Draft edits saved; accept the updated content before publishing."); }));
  const sourceNotes = draft.sourceAnnotationIds.map(id => session.annotations.find(note => note.id === id)).filter((note): note is Annotation => Boolean(note));
  const screenshotNotes = sourceNotes.filter(note => Boolean(note.screenshot));
  const recordingRefs = [...new Map(sourceNotes.flatMap(note => { if (note.anchor.kind !== "video") return []; const recordingId = note.anchor.recordingId; return session.recordings.filter(ref => ref.id === recordingId).map(ref => [ref.id, ref] as const); })).values()];
  const sourceMediaCount = screenshotNotes.length + recordingRefs.length;
  if (sourceMediaCount) {
    const retainedUploads = Object.entries(draft.uploadedMedia ?? {});
    const uploadLabel = element("label", undefined, "media-upload-toggle"); const upload = element("input"); upload.type = "checkbox"; upload.checked = draft.uploadMedia === true; upload.disabled = locked || retainedUploads.length > 0;
    upload.addEventListener("change", () => void run(async () => { await rpc({ type: "SET_DRAFT_MEDIA_UPLOAD", draftId: draft.id, upload: upload.checked }); say("Media publishing choice changed. Review and accept the draft again."); }));
    uploadLabel.append(upload, element("span", `Upload ${sourceMediaCount} source image/video file${sourceMediaCount === 1 ? "" : "s"} to GitHub (experimental undocumented API)`)); card.append(uploadLabel);
    if (retainedUploads.length) {
      const uploaded = element("div", undefined, "uploaded-media"); uploaded.append(element("p", "Already uploaded files are retained and must remain attached on retry.", "warning"));
      const links = element("ul"); for (const [id, url] of retainedUploads) { const item = element("li"); const link = element("a", id); link.href = url; link.target = "_blank"; link.rel = "noreferrer"; item.append(link); links.append(item); } uploaded.append(links); card.append(uploaded);
    }
  }
  const previewDetails = element("details", undefined, "issue-preview"); previewDetails.open = true; const summary = element("summary", "Issue preview"); const preview = element("div", body.value, "preview"); preview.setAttribute("aria-label", "Markdown preview"); body.addEventListener("input", () => { preview.textContent = body.value; }); previewDetails.append(summary, preview);
  if (sourceMediaCount) {
    previewDetails.append(element("p", draft.uploadMedia ? "Local evidence preview — files will upload only after publish confirmation" : "Local evidence preview — files will not be uploaded to GitHub", "preview-label"));
    const gallery = element("div", undefined, "screenshot-gallery"); screenshotNotes.forEach(note => gallery.append(screenshotFigure(note, "preview")));
    recordingRefs.forEach(ref => gallery.append(recordingFigure(ref, sourceNotes.filter(note => note.anchor.kind === "video" && note.anchor.recordingId === ref.id), "preview"))); previewDetails.append(gallery);
  }
  card.append(previewDetails);
  const sources = element("details"); const sourceSummary = element("summary", `Source notes (${draft.sourceAnnotationIds.length})`); const list = element("ul", undefined, "sources");
  for (const id of draft.sourceAnnotationIds) {
    const note = session.annotations.find(item => item.id === id); if (!note) continue;
    const item = element("li"); item.append(element("strong", note.text || note.contextLabel || "No note text"), element("span", `${note.anchor.kind === "video" ? `${timestamp(note.anchor.timestampMs)} · ` : ""}${note.pageTitle || "Untitled page"} · ${note.safeUrl}`, "meta"));
    list.append(item);
  }
  sources.append(sourceSummary, list); card.append(sources);
  if (!locked) {
    const decisions = element("div", undefined, "row");
    decisions.append(button("Accept", () => saveAndDecide(draft, title.value, body.value, "accepted")), button("Skip", () => saveAndDecide(draft, title.value, body.value, "skipped"), "secondary"), button("Needs review", () => saveAndDecide(draft, title.value, body.value, "review"), "secondary")); card.append(decisions);
  }
  if (draft.error) card.append(element("p", draft.error, "error"));
  if (draft.publishState === "published" && draft.githubIssueUrl) { const link = element("a", `View GitHub issue #${draft.githubIssueNumber}`); link.href = draft.githubIssueUrl; link.target = "_blank"; link.rel = "noreferrer"; card.append(link); }
  else if (draft.publishState === "publishing") card.append(element("p", "Publishing to GitHub…", "meta"));
  else if (draft.decision === "accepted") card.append(button(draft.publishState === "unknown" ? "Check status / reconcile" : draft.publishState === "failed" ? "Retry publish" : "Publish this accepted issue", () => publishDraft(draft)));
  section.append(card); app.append(section);
}

async function saveAndDecide(draft: IssueDraft, title: string, body: string, decision: "accepted" | "skipped" | "review"): Promise<void> {
  await rpc({ type: "UPDATE_DRAFT", draftId: draft.id, title, body }); await rpc({ type: "SET_DRAFT_DECISION", draftId: draft.id, decision }); draftEdits.delete(draft.id); say(`Draft marked ${decision}.`);
}
async function publishDraft(draft: IssueDraft): Promise<void> {
  const repo = data!.state.settings.githubRepo;
  if (draft.publishState === "unknown" && !draft.publishRepo) throw new Error("This legacy unknown publication has no recorded repository. Check GitHub manually before retrying.");
  if (draft.publishState === "unknown" && draft.publishRepo !== repo) throw new Error(`Switch the selected repository back to ${draft.publishRepo} before reconciling this publication.`);
  const githubReady = data!.state.settings.githubAuth === "oauth" ? data!.credentials.githubOAuth.connected : data!.credentials.githubToken;
  if (!githubReady) throw new Error(data!.state.settings.githubAuth === "oauth" ? "Connect GitHub in Setup first." : "Add a GitHub token in Settings first.");
  const session = activeSession()!; const source = draft.sourceAnnotationIds.map(id => session.annotations.find(note => note.id === id)).filter((note): note is Annotation => Boolean(note));
  const mediaIds = new Set(source.flatMap(note => [...(note.screenshot ? [note.screenshot.id] : []), ...(note.anchor.kind === "video" ? [note.anchor.recordingId] : [])]));
  const mediaNotice = draft.uploadMedia ? `\n\n${mediaIds.size} local media file${mediaIds.size === 1 ? "" : "s"} will first be uploaded using GitHub's experimental, undocumented attachment endpoint. Uploads cannot be deleted by Product Pass and partial failures may leave orphaned files.` : "\n\nLocal screenshots and recordings will remain local.";
  const action = draft.publishState === "unknown" ? "Reconcile this publication" : `Create “${draft.title}”`;
  if (!confirm(`${action} in ${repo}? GitHub issue creation cannot be undone from Product Pass.${mediaNotice}`)) return;
  if (draft.uploadMedia && !await ext.permissions.request({ origins: ["https://uploads.github.com/*"] })) throw new Error("GitHub media upload permission was not granted.");
  await rpc({ type: "PUBLISH_DRAFT", draftId: draft.id }); say("GitHub issue published.");
}

function renderSettings(state: AppState): void {
  const status = data!.credentials.githubOAuth;
  const codexStatus = data!.credentials.codexSubscription;
  const forceOpen = Boolean(status.message) || Boolean(codexStatus.message);
  const details = element("details", undefined, "settings-panel"); details.open = settingsOpen || forceOpen;
  details.addEventListener("toggle", () => { settingsOpen = details.open; });
  const summary = element("summary", "Settings"); details.append(summary);

  const aiProviderLabel = element("label", "Organization provider"); aiProviderLabel.htmlFor = "ai-provider";
  const aiProvider = element("select"); aiProvider.id = "ai-provider";
  const compatible = element("option", "OpenAI-compatible endpoint or local fallback"); compatible.value = "openai-compatible";
  const codex = element("option", "EXPERIMENTAL — ChatGPT Plus/Pro Codex subscription"); codex.value = "codex-subscription";
  aiProvider.append(compatible, codex); aiProvider.value = state.settings.aiProvider;
  const codexNotice = element("p", "Experimental sideloaded compatibility using the public Codex CLI client registration. Product Pass is not endorsed by OpenAI. This flow or private backend may change or reject this extension.", "warning");

  const endpointLabel = element("label", "OpenAI-compatible chat completions endpoint"); endpointLabel.htmlFor = "ai-endpoint";
  const endpoint = element("input"); endpoint.id = "ai-endpoint"; endpoint.type = "url"; endpoint.value = state.settings.aiEndpoint;
  const modelLabel = element("label", "AI model"); modelLabel.htmlFor = "ai-model";
  const model = element("input"); model.id = "ai-model"; model.value = state.settings.aiModel;
  const keyLabel = element("label", "AI API key (stored locally)"); keyLabel.htmlFor = "ai-key";
  const key = element("input"); key.id = "ai-key"; key.type = "password"; key.autocomplete = "off"; key.placeholder = data!.credentials.aiKey ? "Stored in extension local storage" : "Optional — local fallback is available";
  const codexModelLabel = element("label", "Experimental Codex model"); codexModelLabel.htmlFor = "codex-model";
  const codexModel = element("input"); codexModel.id = "codex-model"; codexModel.value = state.settings.codexModel; codexModel.placeholder = "gpt-5.4";

  const githubAuthLabel = element("label", "GitHub publishing authentication"); githubAuthLabel.htmlFor = "github-auth";
  const githubAuth = element("select"); githubAuth.id = "github-auth";
  const oauthOption = element("option", "Product Pass OAuth Device Flow"); oauthOption.value = "oauth";
  const patOption = element("option", "Fine-grained personal access token"); patOption.value = "pat";
  githubAuth.append(oauthOption, patOption); githubAuth.value = state.settings.githubAuth;
  const tokenLabel = element("label", "GitHub fine-grained token (stored locally)"); tokenLabel.htmlFor = "github-token";
  const token = element("input"); token.id = "github-token"; token.type = "password"; token.autocomplete = "off"; token.placeholder = data!.credentials.githubToken ? "Stored in extension local storage" : "Not configured";

  const compatibleFields = element("div", undefined, "settings-group"); compatibleFields.append(endpointLabel, endpoint, modelLabel, model, keyLabel, key);
  const codexFields = element("div", undefined, "settings-group"); codexFields.append(codexNotice, codexModelLabel, codexModel);
  if (codexStatus.state === "authorized") codexFields.append(element("p", `Connected until ${new Date(codexStatus.expiresAt!).toLocaleString()}.`, "success"));
  else if (codexStatus.state === "awaiting-user" && codexStatus.userCode && codexStatus.verificationUri) {
    const code = element("p", `Codex code: ${codexStatus.userCode}`, "device-code"); code.setAttribute("aria-live", "polite");
    const link = element("a", "Open OpenAI Codex verification page"); link.href = codexStatus.verificationUri; link.target = "_blank"; link.rel = "noreferrer";
    codexFields.append(code, link, element("p", `Expires ${new Date(codexStatus.flowExpiresAt!).toLocaleString()}. Polling continues safely.`, "meta"), button("Cancel sign-in", async () => { await rpc({ type: "CANCEL_CODEX_DEVICE_FLOW" }); say("Codex sign-in canceled."); }, "secondary"));
  } else if (codexStatus.message) codexFields.append(element("p", codexStatus.message, "error"));
  details.append(element("h3", "AI organization", "settings-heading"), aiProviderLabel, aiProvider, compatibleFields, codexFields);

  const patFields = element("div", undefined, "settings-group"); patFields.append(tokenLabel, token);
  const oauthFields = element("div", undefined, "settings-group"); oauthFields.append(element("p", `OAuth access is selected in Setup (${state.settings.githubOAuthScope === "repo" ? "public and private repositories" : "public repositories only"}).`, "meta"));
  if (status.state === "authorized") oauthFields.append(element("p", `Connected${status.expiresAt ? ` until ${new Date(status.expiresAt).toLocaleString()}` : " until removed"}.`, "success"));
  else if (status.state === "awaiting-user" && status.userCode && status.verificationUri) {
    const code = element("p", `GitHub code: ${status.userCode}`, "device-code"); code.setAttribute("aria-live", "polite");
    const link = element("a", "Open GitHub verification page"); link.href = status.verificationUri; link.target = "_blank"; link.rel = "noreferrer";
    oauthFields.append(code, link, element("p", `Expires ${new Date(status.flowExpiresAt!).toLocaleString()}.`, "meta"), button("Cancel sign-in", async () => { await rpc({ type: "CANCEL_GITHUB_OAUTH_FLOW" }); say("GitHub sign-in canceled."); }, "secondary"));
  } else if (status.message) oauthFields.append(element("p", status.message, "error"));
  details.append(element("h3", "GitHub publishing", "settings-heading"), githubAuthLabel, githubAuth, oauthFields, patFields);
  const syncSettingsVisibility = () => { compatibleFields.hidden = aiProvider.value !== "openai-compatible"; codexFields.hidden = aiProvider.value !== "codex-subscription"; patFields.hidden = githubAuth.value !== "pat"; oauthFields.hidden = githubAuth.value !== "oauth"; };
  aiProvider.addEventListener("change", syncSettingsVisibility); githubAuth.addEventListener("change", syncSettingsVisibility); syncSettingsVisibility();

  const settingsValue = () => ({
    showAnnotations: state.settings.showAnnotations,
    aiProvider: aiProvider.value as "openai-compatible" | "codex-subscription",
    aiEndpoint: endpoint.value,
    aiModel: model.value,
    codexModel: codexModel.value,
    githubAuth: githubAuth.value as "pat" | "oauth",
    githubOAuthScope: state.settings.githubOAuthScope,
    githubRepo: state.settings.githubRepo
  });
  const save = async (): Promise<void> => {
    const origins: string[] = [];
    const aiOrigin = originPattern(endpoint.value);
    if (aiProvider.value === "openai-compatible" && (key.value || data!.credentials.aiKey) && aiOrigin) origins.push(aiOrigin);
    if (aiProvider.value === "codex-subscription") origins.push("https://auth.openai.com/*", "https://chatgpt.com/*");
    if (githubAuth.value === "oauth") origins.push("https://github.com/*", "https://api.github.com/*");
    else if (token.value || data!.credentials.githubToken) origins.push("https://api.github.com/*");
    if (origins.length && !await ext.permissions.request({ origins: [...new Set(origins)] })) throw new Error("Network access permission was not granted.");
    await rpc({ type: "SAVE_SETTINGS", settings: settingsValue(), ...(key.value ? { aiKey: key.value } : {}), ...(token.value ? { githubToken: token.value } : {}) });
  };
  details.append(element("p", "Credentials persist in extension storage.local, isolated from page scripts. Extension storage is not a hardware-backed vault.", "meta"));
  details.append(element("p", "Upgraded from the former GitHub App? Product Pass removes its local credentials, but you must separately revoke its authorization and installation in GitHub Settings → Applications.", "meta"));
  const settingsActions = element("div", undefined, "settings-actions");
  settingsActions.append(button("Save settings", async () => { await save(); say("Settings saved."); }));
  settingsActions.append(button("Connect Codex", async () => { aiProvider.value = "codex-subscription"; await save(); await rpc({ type: "START_CODEX_DEVICE_FLOW" }); say("Enter the displayed code on the OpenAI Codex verification page."); }, "secondary"));
  if (codexStatus.connected || codexStatus.state === "awaiting-user") settingsActions.append(button("Disconnect Codex", async () => { await rpc({ type: "DISCONNECT_CODEX" }); say("Local Codex credentials and pending sign-in removed."); }, "danger"));
  settingsActions.append(button("Connect GitHub", async () => { githubAuth.value = "oauth"; await save(); await rpc({ type: "START_GITHUB_OAUTH_FLOW" }); say("Enter the displayed code on GitHub."); }, "secondary"));
  if (status.connected || status.state === "awaiting-user") settingsActions.append(button("Disconnect GitHub OAuth", async () => { await rpc({ type: "DISCONNECT_GITHUB_OAUTH" }); say("Local GitHub OAuth credentials and pending sign-in removed. Revoke access in GitHub Settings if needed."); }, "danger"));
  settingsActions.append(button("Clear API key and PAT", async () => { await rpc({ type: "SAVE_SETTINGS", settings: settingsValue(), aiKey: "", githubToken: "" }); say("API key and PAT cleared."); }, "danger"));
  details.append(settingsActions);
  app.append(details);
}

ext.tabs.onActivated.addListener(() => void load(false));
ext.tabs.onUpdated.addListener((id, change) => { if (id === data?.tab.id && (change.status === "complete" || change.url)) void load(false); });
ext.storage.onChanged.addListener((_changes, area) => { if (area === "local" || area === "session") void load(false); });
window.addEventListener("beforeunload", () => { for (const url of screenshotCache.values()) URL.revokeObjectURL(url); for (const url of recordingUrls.values()) URL.revokeObjectURL(url); if (recording) { recording.discard = true; stopTracks(recording.stream); if (recording.recorder.state !== "inactive") recording.recorder.stop(); } });
void load();
