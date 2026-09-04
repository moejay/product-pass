import type { Annotation, IssueDraft } from "./model";

export const MAX_NOTE_TEXT = 2_000;
export const MAX_POINTS = 1_000;

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
      const detail = note.text.trim() || `${note.kind === "element" ? "Element" : "Freehand"} annotation${note.contextLabel ? `: ${note.contextLabel}` : ""}`;
      return `## Finding ${i + 1}\n\n${detail}\n\nSource: ${note.safeUrl}`;
    }).join("\n\n"),
    sourceAnnotationIds: members.map(note => note.id),
    decision: "review",
    publishState: "not-published",
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
    return { id: crypto.randomUUID(), sessionId, title: raw.title.trim(), body: raw.body.trim(), sourceAnnotationIds: ids, decision: "review" as const, publishState: "not-published" as const, createdAt: now + index, updatedAt: now + index };
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
        `- Page: <${note.safeUrl}>`,
        `- Annotation: ${note.kind === "element" ? "selected element" : "drawn boundary"}`
      ];
      if (note.contextLabel) lines.push(`- Element/context: ${evidenceText(note.contextLabel)}`);
      if (note.anchor.kind === "element") lines.push(`- Selector: \`${evidenceText(note.anchor.selector)}\``);
      if (note.screenshot) lines.push("- Screenshot: captured locally in Product Pass (not uploaded to GitHub)");
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
