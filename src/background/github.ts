import type { IssueDraft } from "../shared/model";
import { githubMarker, validRepo } from "../shared/pure";

export interface PublishedIssue { number: number; url: string }

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

export async function reconcile(repo: string, marker: string, token: string): Promise<PublishedIssue | null> {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100`, { headers: headers(token) });
  if (!response.ok) throw new Error(await safeError(response));
  const issues = await response.json() as Array<{ number?: unknown; html_url?: unknown; body?: unknown; pull_request?: unknown }>;
  const match = issues.find(issue => !issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker));
  return match && typeof match.number === "number" && typeof match.html_url === "string" ? { number: match.number, url: match.html_url } : null;
}

export function selectGithubCredential(mode: "pat" | "github-app", pat: string, appToken: string, appExpiresAt?: number, now = Date.now()): string {
  if (mode === "pat") {
    if (!pat) throw new Error("Enter a GitHub fine-grained token in Settings.");
    return pat;
  }
  if (!appToken || (appExpiresAt !== undefined && appExpiresAt <= now)) throw new Error("Connect the selected GitHub App in Settings before publishing.");
  return appToken;
}

export async function listGithubAppRepositories(token: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const installationsResponse = await fetcher("https://api.github.com/user/installations?per_page=100", { headers: headers(token) });
  if (!installationsResponse.ok) throw new Error(await safeError(installationsResponse));
  const payload = await installationsResponse.json() as { installations?: Array<{ id?: unknown }> };
  if (!Array.isArray(payload.installations)) throw new Error("GitHub returned an incomplete installation list.");
  const names = new Set<string>();
  for (const installation of payload.installations.slice(0, 100)) {
    if (!Number.isSafeInteger(installation.id) || (installation.id as number) <= 0) continue;
    const response = await fetcher(`https://api.github.com/user/installations/${installation.id}/repositories?per_page=100`, { headers: headers(token) });
    if (!response.ok) throw new Error(await safeError(response));
    const repositories = await response.json() as { repositories?: Array<{ full_name?: unknown }> };
    if (!Array.isArray(repositories.repositories)) throw new Error("GitHub returned an incomplete repository list.");
    repositories.repositories.forEach(item => { if (typeof item.full_name === "string" && validRepo(item.full_name)) names.add(item.full_name); });
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export async function listPatRepositories(token: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", { headers: headers(token) });
  if (!response.ok) throw new Error(await safeError(response));
  const repositories = await response.json() as Array<{ full_name?: unknown }>;
  if (!Array.isArray(repositories)) throw new Error("GitHub returned an incomplete repository list.");
  return [...new Set(repositories.flatMap(item => typeof item.full_name === "string" && validRepo(item.full_name) ? [item.full_name] : []))];
}

export async function verifyGithubAppRepoAccess(repo: string, token: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!validRepo(repo)) throw new Error("Enter a repository as owner/name.");
  if ((await listGithubAppRepositories(token, fetcher)).some(name => name.toLowerCase() === repo.toLowerCase())) return;
  throw new Error("The selected GitHub App is not installed with access to this repository. Check its installation and repository selection.");
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
  const issue = await response.json() as { number?: unknown; html_url?: unknown };
  if (typeof issue.number !== "number" || typeof issue.html_url !== "string") throw new Error("UNKNOWN:GitHub returned an incomplete issue result.");
  return { number: issue.number, url: issue.html_url };
}
