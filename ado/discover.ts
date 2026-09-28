// `--active <project or repository URL>`: the pull requests to review, asked of Azure DevOps
// instead of kept by hand.
//
// `--batch` reads a file of URLs somebody has to maintain, and a scheduled sweep over a
// hand-kept list reviews last week's pull requests and misses today's. The REST API lists the
// active ones of a repository or a whole project; this turns them into the same URLs a person
// would paste, so everything after — the batch, its children, their exit codes — is unchanged.
import { ADO_API_VERSION, ADO_BASE_URL } from "../config";
import { log } from "../libs/log";
import { AdoError, adoGet } from "./client";

export interface DiscoveryScope {
  /** Where the REST paths hang off: the collection, and any virtual directory on-prem. */
  baseUrl: string;
  /** The same, as the browser addresses it: what a pull request URL is built from. */
  webBase: string;
  project: string;
  /** Set for a repository URL; absent for a whole project. */
  repo?: string;
}

/**
 * A project URL (`…/{project}`) or a repository URL (`…/{project}/_git/{repo}`), either as a
 * browser shows it. Anything after the repository — `/pullrequests`, a branch view — is ignored.
 */
export function parseScopeUrl(raw: string, apiBase: string = ADO_BASE_URL): DiscoveryScope {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AdoError(`Cannot parse a project or repository URL: ${raw}`);
  }
  const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // The project is the segment before the first of ADO's own pages (`_git`, `_boards`, …), or
  // the last one when there is none. Everything before it is the collection.
  const page = segs.findIndex((s) => s.startsWith("_"));
  const at = page >= 0 ? page - 1 : segs.length - 1;
  const project = segs[at];
  if (at < 0 || !project) throw new AdoError(`No project in ${raw}: expected …/{project} or …/{project}/_git/{repo}`);
  const repo = segs[page] === "_git" ? segs[page + 1] : undefined;
  if (segs[page] === "_git" && !repo) throw new AdoError(`No repository after _git in ${raw}`);
  const collection = segs.slice(0, at);
  const webBase = `${u.origin}${collection.length ? `/${collection.map(encodeURIComponent).join("/")}` : ""}`;
  return {
    baseUrl: (apiBase || webBase).replace(/\/+$/, ""),
    webBase,
    project,
    ...(repo === undefined ? {} : { repo }),
  };
}

interface PullRequestItem {
  pullRequestId?: number;
  isDraft?: boolean;
  repository?: { name?: string; project?: { name?: string } };
}

// A page of results, and how far to page before calling a scope too big to sweep in one go.
const PAGE = 100;
const MAX_PRS = 1000;

/**
 * The URLs of the active pull requests in `scope`, oldest first. Drafts are left out: their
 * authors have said they are not ready, and a review of one is spent before it is wanted.
 */
export async function discoverActivePrs(scope: DiscoveryScope): Promise<string[]> {
  const path = scope.repo
    ? `${scope.baseUrl}/${encodeURIComponent(scope.project)}/_apis/git/repositories/${encodeURIComponent(scope.repo)}/pullrequests`
    : `${scope.baseUrl}/${encodeURIComponent(scope.project)}/_apis/git/pullrequests`;
  const found: PullRequestItem[] = [];
  for (let skip = 0; skip < MAX_PRS; skip += PAGE) {
    const page = await adoGet<{ value?: PullRequestItem[] }>(path, {
      query: { "searchCriteria.status": "active", $top: PAGE, $skip: skip, "api-version": ADO_API_VERSION },
    });
    const items = page.value ?? [];
    found.push(...items);
    if (items.length < PAGE) break;
  }
  if (found.length >= MAX_PRS) log(`[WARN] --active: stopped at ${MAX_PRS} pull requests; narrow it to a repository`);
  const drafts = found.filter((p) => p.isDraft).length;
  const urls = found
    .filter((p) => !p.isDraft && typeof p.pullRequestId === "number" && p.repository?.name)
    .sort((a, b) => a.pullRequestId! - b.pullRequestId!)
    .map((p) => {
      const project = p.repository!.project?.name ?? scope.project;
      return `${scope.webBase}/${encodeURIComponent(project)}/_git/${encodeURIComponent(p.repository!.name!)}/pullrequest/${p.pullRequestId}`;
    });
  log(
    `--active: ${urls.length} active pull request${urls.length === 1 ? "" : "s"} in ${scope.project}${scope.repo ? `/${scope.repo}` : ""}` +
      (drafts > 0 ? ` (${drafts} draft${drafts === 1 ? "" : "s"} left out)` : ""),
  );
  return urls;
}
