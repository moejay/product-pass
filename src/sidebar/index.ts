import { ext } from "../shared/browser";
import type { Annotation, AppState, Bootstrap, CaptureKind, IssueDraft, RequestMessage, ReviewSession } from "../shared/model";
import { originPattern, safeUrl } from "../shared/pure";

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
const screenshotCache = new Map<string, string>();
const screenshotLoads = new Map<string, Promise<string>>();

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
      if (!pending) { pending = rpc<string>({ type: "GET_SCREENSHOT", annotationId: note.id }); screenshotLoads.set(note.id, pending); }
      try { source = await pending; screenshotCache.set(note.id, source); } finally { screenshotLoads.delete(note.id); }
    }
    if (!image.isConnected) return;
    image.src = source; image.hidden = false; placeholder.remove();
  } catch { placeholder.textContent = "Screenshot unavailable"; placeholder.classList.add("error"); }
}
function openScreenshot(note: Annotation, source: string): void {
  const dialog = element("dialog", undefined, "lightbox");
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
  void hydrateScreenshot(note, image, placeholder); return figure;
}
async function run(action: () => void | Promise<void>): Promise<void> {
  try { busy = true; render(); await action(); } catch (error) { say(error instanceof Error ? error.message : "The operation failed.", true); }
  finally { busy = false; await load(false); }
}
async function load(showLoading = true): Promise<void> {
  if (showLoading) app.textContent = "Loading…";
  try { data = await rpc<Bootstrap>({ type: "BOOTSTRAP" }); render(); } catch (error) { app.textContent = "Could not load Product Pass."; say(error instanceof Error ? error.message : "Load failed.", true); }
}
function activeSession(): ReviewSession | undefined { return data?.state.sessions.find(session => session.id === data?.state.activeSessionId); }

function render(): void {
  if (!data) return;
  app.replaceChildren();
  pageStatus.textContent = data.tab.supported ? `${data.tab.title || "Untitled page"} — ${safeUrl(data.tab.url)}` : "Annotations unavailable on this page";
  renderSessionChooser(data.state);
  renderConnectionChecklist(data.state);
  const session = activeSession();
  if (!session) { if (!data.state.sessions.length) renderCreate(); renderSettings(data.state); return; }
  renderCapture(session);
  if (session.drafts.length) renderDrafts(session);
  renderSettings(data.state);
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
  select.addEventListener("change", () => { if (select.value) void run(() => rpc({ type: "SET_ACTIVE_SESSION", sessionId: select.value })); });
  const actions = element("div", undefined, "session-actions"); actions.append(button("New review", () => createSession(), "secondary"));
  const session = activeSession();
  if (session) {
    actions.append(button("Finish", () => finishSession(session), "secondary"), button("Delete session", () => removeSession(session), "danger"));
  }
  wrap.append(label, select, actions); app.append(wrap);
}

function renderCreate(): void {
  const section = element("section", undefined, "empty-state"); section.append(element("h2", "Start your first review"), element("p", "Capture visual feedback across pages, then turn it into reviewed GitHub issues.", "meta"), button("Start review", createSession)); app.append(section);
}
async function createSession(): Promise<void> {
  if (activeSession() && !confirm("Start a new review? Your saved notes remain in the current session.")) return;
  const title = prompt("Review name (optional):", ""); if (title === null) return;
  await rpc({ type: "CREATE_SESSION", title: title.slice(0, 120) }); say("Review started.");
}

function openSettings(): void {
  settingsOpen = true; render();
  requestAnimationFrame(() => document.querySelector(".settings-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}
function renderConnectionChecklist(state: AppState): void {
  const usingCodex = state.settings.aiProvider === "codex-subscription";
  const aiReady = usingCodex ? data!.credentials.codexSubscription.connected : data!.credentials.aiKey;
  const githubReady = Boolean(state.settings.githubRepo) && (state.settings.githubAuth === "github-app" ? data!.credentials.githubApp.connected : data!.credentials.githubToken);
  const complete = Number(aiReady) + Number(githubReady);
  const details = element("details", undefined, "setup-checklist"); details.open = setupOpen ?? complete < 2; details.addEventListener("toggle", () => { setupOpen = details.open; });
  const summary = element("summary"); summary.append(element("span", "Connections", "section-title"), element("span", `${complete}/2 ready`, "count")); details.append(summary);
  const list = element("div", undefined, "checklist");
  const addItem = (checked: boolean, title: string, description: string) => {
    const row = element("div", undefined, `checklist-item${checked ? " ready" : ""}`); const mark = element("input"); mark.type = "checkbox"; mark.checked = checked; mark.disabled = true; mark.setAttribute("aria-label", `${title}: ${checked ? "ready" : "not configured"}`);
    const copy = element("div"); copy.append(element("strong", title), element("span", description, "meta")); row.append(mark, copy);
    if (!checked) row.append(directButton("Configure", openSettings, "secondary compact")); list.append(row);
  };
  addItem(aiReady, "AI organization", aiReady ? (usingCodex ? "Codex subscription connected" : "OpenAI-compatible API connected") : "Optional — local grouping remains available");
  addItem(githubReady, "Issue destination", githubReady ? `GitHub · ${state.settings.githubRepo}` : "Connect GitHub and choose a repository");
  details.append(list); app.append(details);
}
async function finishSession(session: ReviewSession): Promise<void> {
  const unpublished = session.drafts.some(draft => draft.publishState !== "published" && draft.decision === "accepted");
  const warning = unpublished ? " It has accepted issues that have not been published." : "";
  if (!confirm(`Finish “${session.title}”?${warning}\n\nThe session remains saved and can be reopened later.`)) return;
  await rpc({ type: "FINISH_SESSION", sessionId: session.id }); say("Session finished.");
}
async function removeSession(session: ReviewSession): Promise<void> {
  if (!confirm(`Permanently delete “${session.title}” and its ${session.annotations.length} local note${session.annotations.length === 1 ? "" : "s"}, screenshots, and drafts?\n\nPublished GitHub issues are unaffected. This cannot be undone.`)) return;
  await rpc({ type: "DELETE_SESSION", sessionId: session.id });
  session.annotations.forEach(note => { screenshotCache.delete(note.id); screenshotLoads.delete(note.id); }); say("Session deleted.");
}

function renderCapture(session: ReviewSession): void {
  const section = element("details", undefined, "workflow-section"); section.open = captureOpen; section.addEventListener("toggle", () => { captureOpen = section.open; });
  const heading = element("summary", undefined, "section-heading"); heading.append(element("span", "1. Capture", "section-title"), element("span", `${session.annotations.length} note${session.annotations.length === 1 ? "" : "s"}`, "count")); section.append(heading);
  if (!data!.tab.supported) section.append(element("p", "Annotations are unavailable on this page. Open a regular HTTP or HTTPS page.", "warning"));
  else if (!data!.tab.enabled) section.append(button("Enable on this site", enableSite));
  else {
    const controls = element("div", undefined, "row");
    controls.append(button("Element rectangle", () => beginCapture("element")), button("Freehand boundary", () => beginCapture("freehand")));
    section.append(controls);
  }
  for (const note of [...session.annotations].sort((a, b) => b.createdAt - a.createdAt)) {
    const item = element("article", undefined, "note card");
    const noteHead = element("div", undefined, "note-heading"); noteHead.append(element("span", note.kind === "element" ? "Element" : "Freehand", "badge"), element("span", new Date(note.createdAt).toLocaleDateString(), "meta")); item.append(noteHead, element("h3", note.pageTitle || "Untitled page"), element("p", note.safeUrl, "meta"));
    if (note.screenshot) item.append(screenshotFigure(note));
    item.append(element("p", note.text || "No note text", note.text ? "note-text" : "meta note-text"));
    const actions = element("div", undefined, "actions"); actions.append(button("Edit", async () => {
      if (session.drafts.length && !confirm("This will discard generated issue drafts. Published GitHub issues are unaffected.")) return;
      const text = prompt("Edit annotation text (optional):", note.text); if (text === null) return;
      await rpc({ type: "UPDATE_ANNOTATION", annotationId: note.id, text: text.slice(0, 2_000) }); say("Note updated.");
    }, "secondary"), button("Delete", async () => {
      const warning = session.drafts.length ? " This also discards generated drafts; published GitHub issues are unaffected." : "";
      if (!confirm(`Delete this note?${warning}`)) return;
      await rpc({ type: "DELETE_ANNOTATION", annotationId: note.id }); screenshotCache.delete(note.id); screenshotLoads.delete(note.id); say("Note deleted.");
    }, "danger")); item.append(actions); section.append(item);
  }
  const organizeButton = button(`Organize ${session.annotations.length} note${session.annotations.length === 1 ? "" : "s"}`, organize);
  organizeButton.disabled = busy || session.annotations.length === 0; section.append(organizeButton); app.append(section);
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
  const locked = draft.publishState === "published" || draft.publishState === "publishing";
  const title = element("input"); title.id = "draft-title"; title.value = draft.title; title.maxLength = 256; title.disabled = locked;
  const bodyLabel = element("label", "Issue body (Markdown)"); bodyLabel.htmlFor = "draft-body";
  const body = element("textarea"); body.id = "draft-body"; body.value = draft.body; body.maxLength = 65_536; body.disabled = locked;
  card.append(titleLabel, title, bodyLabel, body);
  if (!locked) card.append(button("Save edits", async () => { await rpc({ type: "UPDATE_DRAFT", draftId: draft.id, title: title.value, body: body.value }); say("Draft edits saved; accept the updated content before publishing."); }));
  const previewDetails = element("details", undefined, "issue-preview"); previewDetails.open = true; const summary = element("summary", "Issue preview"); const preview = element("div", body.value, "preview"); preview.setAttribute("aria-label", "Markdown preview"); body.addEventListener("input", () => { preview.textContent = body.value; }); previewDetails.append(summary, preview);
  const screenshotNotes = draft.sourceAnnotationIds.map(id => session.annotations.find(note => note.id === id)).filter((note): note is Annotation => Boolean(note?.screenshot));
  if (screenshotNotes.length) {
    previewDetails.append(element("p", "Local screenshots — visible here, not uploaded to GitHub", "preview-label"));
    const gallery = element("div", undefined, "screenshot-gallery"); screenshotNotes.forEach(note => gallery.append(screenshotFigure(note, "preview"))); previewDetails.append(gallery);
  }
  card.append(previewDetails);
  const sources = element("details"); const sourceSummary = element("summary", `Source notes (${draft.sourceAnnotationIds.length})`); const list = element("ul", undefined, "sources");
  for (const id of draft.sourceAnnotationIds) {
    const note = session.annotations.find(item => item.id === id); if (!note) continue;
    const item = element("li"); item.append(element("strong", note.text || note.contextLabel || "No note text"), element("span", `${note.pageTitle || "Untitled page"} · ${note.safeUrl}`, "meta"));
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
  await rpc({ type: "UPDATE_DRAFT", draftId: draft.id, title, body }); await rpc({ type: "SET_DRAFT_DECISION", draftId: draft.id, decision }); say(`Draft marked ${decision}.`);
}
async function publishDraft(draft: IssueDraft): Promise<void> {
  const repo = data!.state.settings.githubRepo;
  const githubReady = data!.state.settings.githubAuth === "github-app" ? data!.credentials.githubApp.connected : data!.credentials.githubToken;
  if (!githubReady) throw new Error(data!.state.settings.githubAuth === "github-app" ? "Connect the GitHub App in Settings first." : "Add a GitHub token in Settings first.");
  if (!confirm(`Create this issue in ${repo}? GitHub issue creation cannot be undone from Product Pass.`)) return;
  await rpc({ type: "PUBLISH_DRAFT", draftId: draft.id }); say("GitHub issue published.");
}

function renderSettings(state: AppState): void {
  const status = data!.credentials.githubApp;
  const codexStatus = data!.credentials.codexSubscription;
  const forceOpen = status.state === "awaiting-user" || Boolean(status.message) || codexStatus.state === "awaiting-user" || Boolean(codexStatus.message);
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

  const repoLabel = element("label", "GitHub repository (owner/name)"); repoLabel.htmlFor = "github-repo";
  const repo = element("input"); repo.id = "github-repo"; repo.value = state.settings.githubRepo; repo.placeholder = "owner/repository";
  const githubAuthLabel = element("label", "GitHub publishing authentication"); githubAuthLabel.htmlFor = "github-auth";
  const githubAuth = element("select"); githubAuth.id = "github-auth";
  const patOption = element("option", "Fine-grained personal access token"); patOption.value = "pat";
  const appOption = element("option", "GitHub App Device Flow"); appOption.value = "github-app";
  githubAuth.append(patOption, appOption); githubAuth.value = state.settings.githubAuth;
  const tokenLabel = element("label", "GitHub fine-grained token (stored locally)"); tokenLabel.htmlFor = "github-token";
  const token = element("input"); token.id = "github-token"; token.type = "password"; token.autocomplete = "off"; token.placeholder = data!.credentials.githubToken ? "Stored in extension local storage" : "Not configured";
  const clientLabel = element("label", "GitHub App client ID (public identifier)"); clientLabel.htmlFor = "github-client-id";
  const clientId = element("input"); clientId.id = "github-client-id"; clientId.value = state.settings.githubAppClientId; clientId.autocomplete = "off";
  const installLabel = element("label", "GitHub App installation URL (optional)"); installLabel.htmlFor = "github-install-url";
  const installUrl = element("input"); installUrl.id = "github-install-url"; installUrl.type = "url"; installUrl.value = state.settings.githubAppInstallUrl; installUrl.placeholder = "https://github.com/apps/your-app/installations/new";

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
  const appFields = element("div", undefined, "settings-group"); appFields.append(clientLabel, clientId, installLabel, installUrl);
  if (status.state === "authorized") appFields.append(element("p", `Connected${status.expiresAt ? ` until ${new Date(status.expiresAt).toLocaleString()}` : " until removed"}.`, "success"));
  else if (status.state === "awaiting-user" && status.userCode && status.verificationUri) {
    const code = element("p", `GitHub code: ${status.userCode}`, "device-code"); code.setAttribute("aria-live", "polite");
    const link = element("a", "Open GitHub verification page"); link.href = status.verificationUri; link.target = "_blank"; link.rel = "noreferrer";
    appFields.append(code, link, element("p", `Expires ${new Date(status.flowExpiresAt!).toLocaleString()}. Polling continues while installed.`, "meta"), button("Cancel sign-in", async () => { await rpc({ type: "CANCEL_GITHUB_DEVICE_FLOW" }); say("GitHub sign-in canceled."); }, "secondary"));
  } else if (status.message) appFields.append(element("p", status.message, "error"));
  if (installUrl.value) { const install = element("a", "Install or configure this GitHub App"); install.href = installUrl.value; install.target = "_blank"; install.rel = "noreferrer"; appFields.append(install); }
  details.append(element("h3", "GitHub publishing", "settings-heading"), repoLabel, repo, githubAuthLabel, githubAuth, patFields, appFields);
  const syncSettingsVisibility = () => { compatibleFields.hidden = aiProvider.value !== "openai-compatible"; codexFields.hidden = aiProvider.value !== "codex-subscription"; patFields.hidden = githubAuth.value !== "pat"; appFields.hidden = githubAuth.value !== "github-app"; };
  aiProvider.addEventListener("change", syncSettingsVisibility); githubAuth.addEventListener("change", syncSettingsVisibility); syncSettingsVisibility();

  const settingsValue = () => ({
    aiProvider: aiProvider.value as "openai-compatible" | "codex-subscription",
    aiEndpoint: endpoint.value,
    aiModel: model.value,
    codexModel: codexModel.value,
    githubAuth: githubAuth.value as "pat" | "github-app",
    githubRepo: repo.value,
    githubAppClientId: clientId.value,
    githubAppInstallUrl: installUrl.value
  });
  const save = async (): Promise<void> => {
    const origins: string[] = [];
    const aiOrigin = originPattern(endpoint.value);
    if (aiProvider.value === "openai-compatible" && (key.value || data!.credentials.aiKey) && aiOrigin) origins.push(aiOrigin);
    if (aiProvider.value === "codex-subscription") origins.push("https://auth.openai.com/*", "https://chatgpt.com/*");
    if (githubAuth.value === "github-app") origins.push("https://github.com/*", "https://api.github.com/*");
    else if ((token.value || data!.credentials.githubToken) && repo.value) origins.push("https://api.github.com/*");
    if (origins.length && !await ext.permissions.request({ origins: [...new Set(origins)] })) throw new Error("Network access permission was not granted.");
    await rpc({ type: "SAVE_SETTINGS", settings: settingsValue(), ...(key.value ? { aiKey: key.value } : {}), ...(token.value ? { githubToken: token.value } : {}) });
  };
  details.append(element("p", "Credentials persist in extension storage.local, isolated from page scripts. Extension storage is not a hardware-backed vault.", "meta"));
  const settingsActions = element("div", undefined, "settings-actions");
  settingsActions.append(button("Save settings", async () => { await save(); say("Settings saved."); }));
  settingsActions.append(button("Connect Codex", async () => { aiProvider.value = "codex-subscription"; await save(); await rpc({ type: "START_CODEX_DEVICE_FLOW" }); say("Enter the displayed code on the OpenAI Codex verification page."); }, "secondary"));
  if (codexStatus.connected || codexStatus.state === "awaiting-user") settingsActions.append(button("Disconnect Codex", async () => { await rpc({ type: "DISCONNECT_CODEX" }); say("Local Codex credentials and pending sign-in removed."); }, "danger"));
  settingsActions.append(button("Connect GitHub App", async () => { githubAuth.value = "github-app"; await save(); await rpc({ type: "START_GITHUB_DEVICE_FLOW" }); say("Enter the displayed code on GitHub."); }, "secondary"));
  if (status.connected || status.state === "awaiting-user") settingsActions.append(button("Remove GitHub App token", async () => { await rpc({ type: "DISCONNECT_GITHUB_APP" }); say("Local GitHub App token and pending sign-in removed. Revoke server access in GitHub Settings if needed."); }, "danger"));
  settingsActions.append(button("Clear API key and PAT", async () => { await rpc({ type: "SAVE_SETTINGS", settings: settingsValue(), aiKey: "", githubToken: "" }); say("API key and PAT cleared."); }, "danger"));
  details.append(settingsActions);
  app.append(details);
}

ext.tabs.onActivated.addListener(() => void load(false));
ext.tabs.onUpdated.addListener((_id, change) => { if (change.status === "complete" || change.url) void load(false); });
ext.storage.onChanged.addListener((_changes, area) => { if (area === "local" || area === "session") void load(false); });
void load();
