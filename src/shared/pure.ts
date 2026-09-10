import type { Annotation, IssueDraft, RecordingRef, ReviewSession } from "./model";

export const MAX_NOTE_TEXT = 2_000;
export const MAX_POINTS = 1_000;
export const MAX_RECORDING_MS = 60_000;

export function draftIsLocked(draft: Pick<IssueDraft, "publishState">): boolean { return ["publishing", "published", "unknown"].includes(draft.publishState); }
export function resolvePublishRepo(draft: Pick<IssueDraft, "publishState" | "publishRepo" | "uploadedMedia" | "uploadedMediaRepo">, currentRepo: string): string {
  if (draft.publishState === "unknown") {
    if (!draft.publishRepo) throw new Error("This legacy unknown publication has no recorded repository. Check GitHub manually before retrying.");
    if (draft.publishRepo !== currentRepo) throw new Error(`Switch the selected repository back to ${draft.publishRepo} before reconciling this publication.`);
    return draft.publishRepo;
  }
  if (Object.keys(draft.uploadedMedia ?? {}).length && draft.uploadedMediaRepo !== currentRepo) throw new Error(`Some media was already uploaded for ${draft.uploadedMediaRepo || "another repository"}. Switch back to that repository to finish publishing.`);
  return currentRepo;
}

export function assertSessionDeletable(session: Pick<ReviewSession, "drafts">): void {
  if (session.drafts.some(draft => draft.publishState === "publishing")) throw new Error("Wait for the current GitHub publication to finish before deleting this session.");
}
export function assertSessionMutable(session: Pick<ReviewSession, "drafts">): void {
  assertSessionDeletable(session);
  if (session.drafts.some(draft => draft.publishState === "unknown")) throw new Error("Reconcile the unknown GitHub publication before changing source evidence.");
  if (session.drafts.some(draft => draft.publishState !== "published" && Object.keys(draft.uploadedMedia ?? {}).length)) throw new Error("Finish publishing the draft with its already-uploaded files before changing source evidence.");
}
export function assertMediaUploadCanChange(draft: Pick<IssueDraft, "uploadedMedia">, upload: boolean): void {
  if (!upload && Object.keys(draft.uploadedMedia ?? {}).length) throw new Error("Already-uploaded files must remain attached to this issue draft.");
}
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

export function validRecordingRef(value: unknown, now = Date.now()): value is RecordingRef {
  if (!value || typeof value !== "object") return false; const item = value as Partial<RecordingRef>;
  return typeof item.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id) && item.mimeType === "video/webm" && Number.isSafeInteger(item.byteSize) && item.byteSize! >= 1 && item.byteSize! <= MAX_RECORDING_BYTES && Number.isFinite(item.durationMs) && item.durationMs! >= 1 && item.durationMs! <= MAX_RECORDING_MS + 500 && Number.isFinite(item.createdAt) && item.createdAt! >= 1 && item.createdAt! <= now + 60_000;
}

export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function originPattern(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // WebExtension match patterns do not support explicit ports; host access
    // applies to every port while enabledOrigins still tracks the exact origin.
    const host = url.hostname.includes(":") ? `[${url.hostname.replace(/^\[|\]$/g, "")}]` : url.hostname;
    return `${url.protocol}//${host}/*`;
  } catch {
    return null;
  }
}

export function annotationRevision(notes: Annotation[]): string {
  return notes.map(note => `${note.id}:${note.updatedAt}`).sort().join("|");
}

export function deterministicDrafts(notes: Annotation[], sessionId: string, now = Date.now()): IssueDraft[] {
  const groups = new Map<string, Annotation[]>();
  for (const note of notes) {
    let key = "Other pages";
    try { key = new URL(note.safeUrl).hostname; } catch { /* retained fallback */ }
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  return [...groups.entries()].map(([host, members], index) => ({
    id: crypto.randomUUID(),
    sessionId,
    title: `Review findings for ${host}`,
    body: members.map((note, i) => {
      const detail = note.text.trim() || `${note.kind === "element" ? "Element" : note.kind === "freehand" ? "Freehand" : "Video"} annotation${note.contextLabel ? `: ${note.contextLabel}` : ""}`;
      return `## Finding ${i + 1}\n\n${detail}\n\nSource: ${note.safeUrl}`;
    }).join("\n\n"),
    sourceAnnotationIds: members.map(note => note.id),
    decision: "review",
    publishState: "not-published",
    uploadMedia: false,
    uploadedMedia: {},
    createdAt: now + index,
    updatedAt: now + index
  }));
}

interface RawDraft { title?: unknown; body?: unknown; sourceAnnotationIds?: unknown }

export function parseAIContent(content: string, notes: Annotation[], sessionId: string, now = Date.now()): IssueDraft[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch { throw new Error("The AI response was not valid JSON."); }
  const drafts = (value as { drafts?: unknown })?.drafts;
  if (!Array.isArray(drafts) || drafts.length === 0) throw new Error("The AI response contained no drafts.");
  const allowed = new Set(notes.map(note => note.id));
  const seen = new Set<string>();
  return drafts.map((raw: RawDraft, index) => {
    if (typeof raw?.title !== "string" || !raw.title.trim() || raw.title.length > 256) throw new Error("An AI draft had an invalid title.");
    if (typeof raw.body !== "string" || !raw.body.trim() || raw.body.length > 65_536) throw new Error("An AI draft had an invalid body.");
    if (!Array.isArray(raw.sourceAnnotationIds) || raw.sourceAnnotationIds.length === 0) throw new Error("An AI draft had no source notes.");
    const ids = raw.sourceAnnotationIds.map(id => {
      if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) throw new Error("The AI response had an unknown or duplicate note assignment.");
      seen.add(id);
      return id;
    });
    return { id: crypto.randomUUID(), sessionId, title: raw.title.trim(), body: raw.body.trim(), sourceAnnotationIds: ids, decision: "review" as const, publishState: "not-published" as const, uploadMedia: false, uploadedMedia: {}, createdAt: now + index, updatedAt: now + index };
  }).map(draft => draft);
}

export function validateCompleteAssignments(drafts: IssueDraft[], notes: Annotation[]): IssueDraft[] {
  const assigned = drafts.flatMap(draft => draft.sourceAnnotationIds);
  if (assigned.length !== notes.length || new Set(assigned).size !== notes.length) throw new Error("The AI response did not assign every note exactly once.");
  return drafts;
}

function evidenceText(value: string): string { return value.replace(/[\r\n]+/g, " ").replace(/`/g, "'").trim(); }

export function appendSourceEvidence(drafts: IssueDraft[], notes: Annotation[]): IssueDraft[] {
  const byId = new Map(notes.map(note => [note.id, note]));
  return drafts.map(draft => {
    const evidence = draft.sourceAnnotationIds.map((id, index) => {
      const note = byId.get(id);
      if (!note) throw new Error("A draft referenced missing source evidence.");
      const lines = [
        `### Note ${index + 1}: ${evidenceText(note.pageTitle) || "Untitled page"}`,
        note.safeUrl ? `- Page: <${note.safeUrl}>` : "- Page: unavailable",
        `- Annotation: ${note.kind === "element" ? "selected element" : note.kind === "freehand" ? "drawn boundary" : "video timestamp"}`
      ];
      if (note.contextLabel) lines.push(`- Element/context: ${evidenceText(note.contextLabel)}`);
      if (note.anchor.kind === "element") lines.push(`- Selector: \`${evidenceText(note.anchor.selector)}\``);
      if (note.anchor.kind === "video") lines.push(`- Recording timestamp: ${Math.floor(note.anchor.timestampMs / 60_000)}:${String(Math.floor(note.anchor.timestampMs / 1_000) % 60).padStart(2, "0")}`);
      if (note.screenshot) lines.push("- Screenshot: stored locally in Product Pass; uploaded to GitHub only if explicitly enabled for this draft");
      if (note.anchor.kind === "video") lines.push("- Recording: stored locally in Product Pass; uploaded to GitHub only if explicitly enabled for this draft");
      return lines.join("\n");
    }).join("\n\n");
    return { ...draft, body: `${draft.body.trim()}\n\n## Source evidence\n\n${evidence}` };
  });
}

export function githubMarker(sessionId: string, draftId: string): string {
  return `<!-- product-pass:${sessionId}:${draftId} -->`;
}

export function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}
