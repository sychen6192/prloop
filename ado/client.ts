// Azure DevOps REST client. Deliberately not the MCP: we need iteration bookkeeping,
// raw blob bytes and validated thread anchors, none of which the MCP provides
// (azure-devops-mcp #793 / #868 — see PROPOSAL §2).
import { ADO_API_VERSION, ADO_BASE_URL, ADO_MAX_RETRIES, ADO_TIMEOUT_MS } from "../config";
import { logVerbose } from "../libs/log";
import { redactSecrets } from "../libs/redact";
import type { PrRef } from "../libs/types";
import { authHeader } from "./auth";
import { USER_AGENT, dispatcherFor } from "../libs/proxy";

export class AdoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "AdoError";
  }
}

/**
 * The quotable part of a rejected ADO response, for the error message itself.
 *
 * ADO answers with JSON whose `message` says WHY ("TF401232: the thread context is not
 * valid", "the pull request is completed"); the status line alone left a rejected thread
 * POST as an unexplained "400 Bad Request" because `body` was captured on the error and
 * never surfaced. Redacted and capped: error bodies have echoed credentials before, and a
 * message is a line, not a page.
 */
export function adoErrorDetail(body: string): string {
  let text = "";
  try {
    const parsed: unknown = JSON.parse(body);
    const message = (parsed as { message?: unknown } | null)?.message;
    if (typeof message === "string") text = message;
  } catch {
    // A sign-in page or a proxy's HTML error page carries nothing worth quoting; plain text does.
    if (!/^\s*</.test(body)) text = body;
  }
  text = redactSecrets(text.replace(/\s+/g, " ").trim());
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * Parses the PR URL people copy out of the browser.
 *
 * The collection base is taken from the URL itself rather than rebuilt from a configured
 * host, because "everything before /{project}/_git/" is the one rule that holds across
 * every deployment shape:
 *
 *   https://dev.azure.com/{org}/{proj}/_git/{repo}/pullrequest/{id}
 *   https://{org}.visualstudio.com/{proj}/_git/{repo}/pullrequest/{id}
 *   https://tfs.corp.com/tfs/{collection}/{proj}/_git/{repo}/pullrequest/{id}   ← on-prem
 *   https://ado.corp.com/{collection}/{proj}/_git/{repo}/pullrequest/{id}       ← on-prem
 *
 * Rebuilding it from a host + the first path segment silently produced a wrong base on
 * on-prem servers (the virtual-directory prefix was dropped and the collection was mistaken
 * for the org), which surfaced far downstream as an unexplained connection error.
 */
export function parsePrUrl(raw: string): PrRef {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AdoError(`Cannot parse PR URL: ${raw}`);
  }
  const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const gitIdx = segs.indexOf("_git");
  const prIdx = segs.findIndex((s) => s.toLowerCase() === "pullrequest");
  if (gitIdx < 0 || prIdx < 0 || prIdx !== gitIdx + 2) {
    throw new AdoError(
      `Bad PR URL. Expected .../{project}/_git/{repo}/pullrequest/{id}, got: ${raw}`,
    );
  }
  const prId = Number(segs[prIdx + 1]);
  if (!Number.isInteger(prId) || prId <= 0) {
    throw new AdoError(`Invalid PR id in PR URL: ${segs[prIdx + 1]}`);
  }

  const repoId = segs[gitIdx + 1]!;
  const project = segs[gitIdx - 1];
  if (!project) throw new AdoError(`PR URL is missing the project segment: ${raw}`);

  // Path segments before the project: the collection, plus any virtual directory on-prem.
  // Empty on {org}.visualstudio.com, where the org lives in the hostname.
  const collectionSegs = segs.slice(0, gitIdx - 1);
  const derived =
    `${u.origin}${collectionSegs.length ? `/${collectionSegs.map(encodeURIComponent).join("/")}` : ""}`;

  // An explicit override wins, for the rare deployment whose API host differs from the
  // browser host (a reverse proxy in front of the web UI, typically).
  const baseUrl = (ADO_BASE_URL || derived).replace(/\/+$/, "");

  const org = collectionSegs[collectionSegs.length - 1] ?? u.hostname.split(".")[0] ?? "";
  return { baseUrl, org, project, repoId, prId };
}

/** The collection base — everything the REST paths hang off. */
export function orgBase(ref: PrRef): string {
  return ref.baseUrl;
}

export function repoBase(ref: PrRef): string {
  return `${ref.baseUrl}/${encodeURIComponent(ref.project)}/_apis/git/repositories/${encodeURIComponent(ref.repoId)}`;
}

export function prBase(ref: PrRef): string {
  return `${repoBase(ref)}/pullRequests/${ref.prId}`;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  // Blobs come back as bytes, not JSON.
  raw?: boolean;
  accept?: string;
  apiVersion?: string;
}

/**
 * Performs the request and reads the FULL body inside the timeout + retry envelope.
 *
 * Returning a Response and letting callers stream the body later would put the body read
 * outside both protections: a connection reset at 80% of a blob would kill the run with
 * zero retries, and a stalled body would be bounded by nothing at all (undici's own timers
 * are deliberately disabled in libs/proxy.ts).
 */
async function request(url: string, opts: RequestOpts = {}): Promise<Buffer> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  if (!u.searchParams.has("api-version")) {
    u.searchParams.set("api-version", opts.apiVersion ?? ADO_API_VERSION);
  }

  const headers: Record<string, string> = {
    Authorization: await authHeader(),
    Accept: opts.accept ?? "application/json",
    "User-Agent": USER_AGENT,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  // Retrying a POST that timed out or lost its socket after the request was written can
  // apply it twice — a duplicated comment thread, and a duplicated *summary* thread breaks
  // --since auto (which trusts the first marker it finds). So POSTs retry only on 429,
  // where the server has told us the request was rejected without being applied.
  const method = opts.method ?? "GET";
  const idempotent = method === "GET" || method === "PUT" || method === "PATCH";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= ADO_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ADO_TIMEOUT_MS);
    try {
      const res = await fetch(u, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
        // Node's fetch ignores HTTP(S)_PROXY; the dispatcher is how a proxy gets used at all.
        dispatcher: dispatcherFor(u.toString()),
      } as RequestInit);

      // A PAT that lacks scope gets a 203 + sign-in HTML page rather than a 401.
      if (res.status === 203) {
        throw new AdoError(
          "Azure DevOps returned 203 (sign-in page): PAT invalid or missing scope (needs Code Read & Write)",
          203,
        );
      }
      if (res.status === 429 || (res.status >= 500 && idempotent)) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        if (attempt < ADO_MAX_RETRIES) {
          // Drain the rejected body, or the keep-alive socket stays occupied until GC and
          // a rate-limited run slowly starves its own connection pool.
          await res.body?.cancel().catch(() => {});
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
          logVerbose(`ADO ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${ADO_MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const detail = adoErrorDetail(body);
        throw new AdoError(
          `ADO ${method} ${u.pathname} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
          res.status,
          redactSecrets(body.slice(0, 2000)),
        );
      }
      // Body read happens here, while the abort timer is still armed.
      const buf = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      return buf;
    } catch (e) {
      lastErr = e;
      // AdoError with a status is a real API rejection: don't retry it.
      if (e instanceof AdoError && e.status !== undefined && e.status < 500 && e.status !== 429) {
        throw e;
      }
      // A network-level failure on a POST is ambiguous — the request may already have been
      // applied. Duplicating a thread is worse than reporting the failure.
      if (!idempotent) break;
      if (attempt >= ADO_MAX_RETRIES) break;
      const waitMs = 500 * 2 ** (attempt - 1);
      logVerbose(`ADO request threw (${String(e)}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr instanceof AdoError) throw lastErr;
  throw new AdoError(`Connection to ${u.origin} failed: ${redactSecrets(diagnose(lastErr))}`);
}

/**
 * Turns a fetch-level failure into something actionable. These are almost always
 * environmental rather than API problems, and on-prem hits every one of them.
 */
function diagnose(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? "";
  const all = `${msg} ${code}`;

  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|unable to verify|self-signed/i.test(all)) {
    return (
      `TLS certificate could not be verified (${code || "cert"}). Node does not trust internal CAs by default. ` +
      `Fix: export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem and rerun`
    );
  }
  if (/ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/i.test(all)) {
    return "TLS certificate hostname does not match the URL. Use the hostname the certificate was issued for";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) {
    return "DNS cannot resolve this host. Check the URL, and that this machine reaches the intranet (VPN?)";
  }
  if (/403/.test(all) && /proxy|CONNECT|tunnel/i.test(all)) {
    return (
      "Proxy refused the request. If git reaches the same host, the proxy is likely filtering by User-Agent — " +
      `prloop sends "${USER_AGENT}"; override with PRR_USER_AGENT`
    );
  }
  if (/ECONNREFUSED/i.test(all)) {
    return (
      "Connection refused. If this machine only reaches the internet through a corporate proxy, set HTTPS_PROXY " +
      "(prloop uses it automatically; Node's built-in fetch does not read it)"
    );
  }
  if (/ETIMEDOUT|ECONNRESET|UND_ERR_CONNECT_TIMEOUT/i.test(all)) {
    return "Connection timeout. Usually a firewall, or a proxy is required (set HTTPS_PROXY)";
  }
  if (/aborted|AbortError/i.test(all)) return `Request timeout (${ADO_TIMEOUT_MS}ms). Raise PRR_ADO_TIMEOUT_MS`;
  return msg;
}

export async function adoGet<T>(url: string, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<T> {
  const buf = await request(url, { ...opts, method: "GET" });
  return JSON.parse(buf.toString("utf8")) as T;
}

// Blob content must be read as bytes: decoding through a local checkout or a
// text-mode read would normalize CRLF/BOM and shift every anchor after it.
export async function adoGetBytes(url: string, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<Buffer> {
  return request(url, { ...opts, method: "GET" });
}

export async function adoPost<T>(url: string, body: unknown, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<T> {
  const buf = await request(url, { ...opts, method: "POST", body });
  return JSON.parse(buf.toString("utf8")) as T;
}

export async function adoPatch<T>(url: string, body: unknown, opts: Omit<RequestOpts, "method" | "body"> = {}): Promise<T> {
  const buf = await request(url, { ...opts, method: "PATCH", body });
  return JSON.parse(buf.toString("utf8")) as T;
}

export interface AdoList<T> {
  count: number;
  value: T[];
}
