import type { IssueDraft } from "../shared/model";
import { githubMarker, validRepo } from "../shared/pure";

export interface PublishedIssue { number: number; url: string }
export interface UploadedMedia { id: string; kind: "image" | "video"; name: string; url: string }
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function headers(token: string): HeadersInit {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
}

async function safeError(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return "GitHub authentication or repository permission failed.";
  if (response.status === 404) return "The GitHub repository was not found.";
  if (response.status === 422) return "GitHub rejected this issue title or body.";
  if (response.status === 429) return "GitHub rate limit reached. Retry later.";
  return `GitHub request failed (${response.status}).`;
}

export async function reconcile(repo: string, marker: string, token: string, fetcher: typeof fetch = fetch): Promise<PublishedIssue | null> {
  for (let page = 1; page <= 10; page++) {
    const response = await fetcher(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`, { headers: headers(token) });
    if (!response.ok) throw new Error(await safeError(response));
    const issues = await response.json() as Array<{ number?: unknown; html_url?: unknown; body?: unknown; pull_request?: unknown }>;
    if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid issue list.");
    const match = issues.find(issue => !issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker));
    if (match && typeof match.number === "number" && typeof match.html_url === "string") return { number: match.number, url: match.html_url };
    if (issues.length < 100) return null;
  }
  return null;
}

export function selectGithubCredential(mode: "pat" | "oauth", pat: string, oauthToken: string, oauthExpiresAt?: number, now = Date.now()): string {
  if (mode === "pat") {
    if (!pat) throw new Error("Enter a GitHub fine-grained token in Settings.");
    return pat;
  }
  if (!oauthToken || (oauthExpiresAt !== undefined && oauthExpiresAt <= now)) throw new Error("Connect GitHub in Setup before publishing.");
  return oauthToken;
}

export async function listPatRepositories(token: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", { headers: headers(token) });
  if (!response.ok) throw new Error(await safeError(response));
  const repositories = await response.json() as Array<{ full_name?: unknown }>;
  if (!Array.isArray(repositories)) throw new Error("GitHub returned an incomplete repository list.");
  return [...new Set(repositories.flatMap(item => typeof item.full_name === "string" && validRepo(item.full_name) ? [item.full_name] : []))];
}

export function validateUploadBlob(blob: Blob, mimeType: string): "image" | "video" {
  if (!(blob instanceof Blob) || blob.size < 1) throw new Error("A local media file is empty or missing.");
  if (mimeType === "image/jpeg" && blob.type === "image/jpeg" && blob.size <= MAX_IMAGE_BYTES) return "image";
  if (mimeType === "video/webm" && blob.type.startsWith("video/webm") && blob.size <= MAX_VIDEO_BYTES) return "video";
  if (mimeType === "image/jpeg" && blob.size > MAX_IMAGE_BYTES) throw new Error("A screenshot exceeds GitHub's 10 MiB upload limit.");
  if (mimeType === "video/webm" && blob.size > MAX_VIDEO_BYTES) throw new Error("A recording exceeds GitHub's 100 MiB upload limit.");
  throw new Error("Only Product Pass JPEG screenshots and WebM recordings can be uploaded.");
}

export async function repositoryId(repo: string, token: string, fetcher: typeof fetch = fetch): Promise<number> {
  if (!validRepo(repo)) throw new Error("Enter a repository as owner/name.");
  const response = await fetcher(`https://api.github.com/repos/${repo}`, { headers: headers(token) });
  if (!response.ok) throw new Error(await safeError(response));
  const value = await response.json() as { id?: unknown; permissions?: { push?: unknown } };
  if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) throw new Error("GitHub returned an invalid repository identifier.");
  if (value.permissions && value.permissions.push !== true) throw new Error("GitHub repository write permission is required for media uploads.");
  return value.id as number;
}

function validAssetUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/assets/") && !url.username && !url.password; } catch { return false; }
}
export async function uploadUserAttachment(repository: number, name: string, mimeType: "image/jpeg" | "video/webm", blob: Blob, token: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!Number.isSafeInteger(repository) || repository <= 0 || !token) throw new Error("Invalid GitHub media upload request.");
  validateUploadBlob(blob, mimeType);
  const filename = name.split(/[\\/]/).at(-1)!.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 120);
  const extension = mimeType === "image/jpeg" ? ".jpg" : ".webm";
  const safeName = (filename || "product-pass-media").replace(/\.[^.]*$/, "") + extension;
  const url = new URL("https://uploads.github.com/user-attachments/assets");
  url.search = new URLSearchParams({ name: safeName, content_type: mimeType, repository_id: String(repository) }).toString();
  let response: Response;
  try {
    response = await fetcher(url.toString(), { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `token ${token}`, "Content-Type": "application/octet-stream" }, body: blob });
  } catch { throw new Error("GitHub media upload may have succeeded without returning a result, leaving an orphaned attachment. Do not retry immediately without checking GitHub."); }
  if (!response.ok) {
    if (response.status === 404) throw new Error("GitHub media upload was unavailable or repository write permission is missing.");
    if (response.status === 413) throw new Error("GitHub rejected the media size for this account plan.");
    if (response.status === 422) throw new Error("GitHub rejected the media file type or metadata.");
    if (response.status === 429) throw new Error(`GitHub media upload rate limit reached${response.headers.get("Retry-After") ? `; retry after ${response.headers.get("Retry-After")} seconds` : ""}.`);
    if (response.status >= 500) throw new Error(`GitHub media upload may have succeeded despite server error ${response.status}, leaving an orphaned attachment. Check GitHub before retrying.`);
    throw new Error(`GitHub media upload failed (${response.status}).`);
  }
  let value: { url?: unknown };
  try { value = await response.json() as { url?: unknown }; } catch { throw new Error("GitHub may have stored the media but returned an unreadable result, leaving an orphaned attachment."); }
  if (!validAssetUrl(value.url)) throw new Error("GitHub may have stored the media but returned an invalid asset URL, leaving an orphaned attachment.");
  return value.url;
}

function markdownAlt(value: string): string { return value.replace(/[\r\n]+/g, " ").replace(/([\\\[\]])/g, "\\$1"); }
export function appendUploadedMedia(body: string, media: UploadedMedia[]): string {
  if (!media.length) return body.trim();
  const seen = new Set<string>(); const unique = media.filter(item => !seen.has(item.id) && Boolean(seen.add(item.id)));
  if (unique.some(item => !validAssetUrl(item.url) || !["image", "video"].includes(item.kind))) throw new Error("Invalid uploaded media reference.");
  const markdown = unique.map(item => item.kind === "image" ? `![${markdownAlt(item.name.replace(/\.[^.]+$/, "").replace(/\./g, " "))}](${item.url})` : item.url).join("\n\n");
  return `${body.trim()}\n\n## Attached evidence\n\n${markdown}`;
}

export async function publish(repo: string, draft: IssueDraft, token: string): Promise<PublishedIssue> {
  if (!validRepo(repo)) throw new Error("Enter a repository as owner/name.");
  if (!token) throw new Error("Connect the selected GitHub publishing credential in Settings.");
  const marker = githubMarker(draft.sessionId, draft.id);
  if (draft.publishState === "unknown") {
    try {
      const found = await reconcile(repo, marker, token);
      if (found) return found;
    } catch {
      throw new Error("UNKNOWN:Could not reconcile the unknown GitHub result. Check the repository before trying again.");
    }
  }
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ title: draft.title.trim(), body: `${draft.body.trim()}\n\n${marker}` })
    });
  } catch {
    throw new Error("UNKNOWN:GitHub may have created the issue. Retry to reconcile before another creation attempt.");
  }
  if (!response.ok) {
    // The POST may have reached GitHub even when a gateway times out or returns
    // a server error. Force marker reconciliation before any further POST.
    if (response.status === 408 || response.status >= 500) {
      throw new Error(`UNKNOWN:${await safeError(response)} Check GitHub before retrying.`);
    }
    throw new Error(await safeError(response));
  }
  let issue: { number?: unknown; html_url?: unknown };
  try { issue = await response.json() as { number?: unknown; html_url?: unknown }; }
  catch { throw new Error("UNKNOWN:GitHub returned an unreadable issue result."); }
  if (typeof issue.number !== "number" || typeof issue.html_url !== "string") throw new Error("UNKNOWN:GitHub returned an incomplete issue result.");
  return { number: issue.number, url: issue.html_url };
}
