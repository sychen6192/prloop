// A fake Azure DevOps REST API, so publish/ and ado/ can be driven end to end without a
// server, a PAT, or a repository.
//
// The routes are the ones prloop actually calls (ado/client.ts builds every URL off
// prBase/repoBase/orgBase), answered out of a mutable `state` a test sets up beforehand and
// inspects afterwards. What makes it worth having is the request LOG: "was the summary
// PATCHed or POSTed", "how many thread POSTs happened", "did the second page of changes get
// asked for with the skip the first page handed back" are all questions about the requests,
// not the responses, and none of them can be asked without a wire.
//
// Test infrastructure: node:http and plain objects only.
import type * as http from "node:http";
import { listen, readBody, sendJson, type FakeServer } from "./server";

export interface FakeComment {
  id: number;
  content?: string;
  isDeleted?: boolean;
  author?: { displayName?: string; id?: string };
}

export interface FakeThread {
  id: number;
  status?: string;
  comments?: FakeComment[];
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line?: number; offset?: number };
    rightFileEnd?: { line?: number; offset?: number };
  };
  isDeleted?: boolean;
}

/** One page of .../iterations/{id}/changes, as ADO shapes it. */
export interface ChangePage {
  changeEntries: Array<Record<string, unknown>>;
  /** The $skip the next request must send. Absent = this is the last page. */
  nextSkip?: number;
}

export interface FakeAdoState {
  pr: Record<string, unknown>;
  iterations: Array<Record<string, unknown>>;
  changePages: ChangePage[];
  threads: FakeThread[];
  /** Work item ids the PR links to (the dedicated /workitems endpoint, not the PR body). */
  workItemRefs: number[];
  /** id → the raw work item the wit API returns for it. */
  workItems: Record<number, Record<string, unknown>>;
  /** Repo path (ADO's shape, leading slash) → what GET /items answers with. */
  items: Record<string, { status?: number; body: string; contentType?: string }>;
  /** Blob object id → its bytes. */
  blobs: Record<string, string>;
  /**
   * Lets a test make one thread POST fail: return the status to reject it with, or
   * undefined to accept. A comment that cannot be posted is a first-class outcome
   * (PublishResult.failed), not an exception the run dies on.
   */
  rejectThreadPost?: (body: Record<string, unknown>) => number | undefined;
}

export interface AdoRequest {
  method: string;
  /** Pathname only; the query is parsed out separately. */
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface FakeAdo extends FakeServer {
  state: FakeAdoState;
  requests: AdoRequest[];
  /** Logged requests by method and a pattern on the path — how the assertions read best. */
  matching(method: string, pattern: RegExp): AdoRequest[];
  reset(): void;
}

const EMPTY_STATE = (): FakeAdoState => ({
  pr: { title: "PR", description: "", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", createdBy: { displayName: "Alice" }, status: "active" },
  iterations: [{ id: 1, sourceRefCommit: { commitId: "src1" }, targetRefCommit: { commitId: "tgt1" }, commonRefCommit: { commitId: "base1" }, createdDate: "2026-01-01T00:00:00Z" }],
  changePages: [{ changeEntries: [] }],
  threads: [],
  workItemRefs: [],
  workItems: {},
  items: {},
  blobs: {},
});

export async function fakeAdo(overrides: Partial<FakeAdoState> = {}): Promise<FakeAdo> {
  const state: FakeAdoState = { ...EMPTY_STATE(), ...overrides };
  const requests: AdoRequest[] = [];
  let nextThreadId = 5000;
  let nextCommentId = 900;

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const raw = await readBody(req);
    let body: Record<string, unknown> | undefined;
    if (raw) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    const method = req.method ?? "GET";
    requests.push({ method, path, query, body });

    // --- pull request itself ---------------------------------------------------------
    if (method === "GET" && /\/pullRequests\/\d+$/.test(path)) {
      return sendJson(res, 200, state.pr);
    }
    if (method === "GET" && /\/pullRequests\/\d+\/iterations$/.test(path)) {
      return sendJson(res, 200, { count: state.iterations.length, value: state.iterations });
    }
    // --- iteration changes, paged ----------------------------------------------------
    if (method === "GET" && /\/iterations\/\d+\/changes$/.test(path)) {
      const skip = Number(query["$skip"] ?? 0);
      // Keyed by the skip each page declares, so a client that ignores nextSkip and asks
      // again from 0 gets page one forever instead of silently "passing".
      let cursor = 0;
      for (const page of state.changePages) {
        if (cursor === skip) return sendJson(res, 200, page);
        if (page.nextSkip === undefined) break;
        cursor = page.nextSkip;
      }
      return sendJson(res, 200, { changeEntries: [] });
    }
    // --- threads ---------------------------------------------------------------------
    if (method === "GET" && /\/pullRequests\/\d+\/threads$/.test(path)) {
      return sendJson(res, 200, { count: state.threads.length, value: state.threads });
    }
    if (method === "POST" && /\/pullRequests\/\d+\/threads$/.test(path)) {
      const reject = state.rejectThreadPost?.(body ?? {});
      if (reject !== undefined) {
        return sendJson(res, reject, { message: "TF401019: the thread could not be created" });
      }
      const incoming = (body?.["comments"] as Array<{ content?: string }> | undefined) ?? [];
      const thread: FakeThread = {
        id: nextThreadId++,
        status: (body?.["status"] as string | undefined) ?? "active",
        comments: incoming.map((c) => ({ id: nextCommentId++, content: c.content ?? "" })),
        threadContext: body?.["threadContext"] as FakeThread["threadContext"],
      };
      state.threads.push(thread);
      return sendJson(res, 200, thread);
    }
    const commentPatch = /\/pullRequests\/\d+\/threads\/(\d+)\/comments\/(\d+)$/.exec(path);
    if (method === "PATCH" && commentPatch) {
      const thread = state.threads.find((t) => t.id === Number(commentPatch[1]));
      const comment = thread?.comments?.find((c) => c.id === Number(commentPatch[2]));
      if (!comment) return sendJson(res, 404, { message: "no such comment" });
      comment.content = (body?.["content"] as string | undefined) ?? comment.content;
      return sendJson(res, 200, comment);
    }
    const threadPatch = /\/pullRequests\/\d+\/threads\/(\d+)$/.exec(path);
    if (method === "PATCH" && threadPatch) {
      const thread = state.threads.find((t) => t.id === Number(threadPatch[1]));
      if (!thread) return sendJson(res, 404, { message: "no such thread" });
      thread.status = (body?.["status"] as string | undefined) ?? thread.status;
      return sendJson(res, 200, thread);
    }
    // --- status checks ---------------------------------------------------------------
    if (method === "POST" && /\/pullRequests\/\d+\/statuses$/.test(path)) {
      return sendJson(res, 200, { id: 1, ...(body ?? {}) });
    }
    // --- work items ------------------------------------------------------------------
    if (method === "GET" && /\/pullRequests\/\d+\/workitems$/.test(path)) {
      const value = state.workItemRefs.map((id) => ({ id: String(id), url: `/_apis/wit/workItems/${id}` }));
      return sendJson(res, 200, { count: value.length, value });
    }
    if (method === "GET" && /\/_apis\/wit\/workitems$/.test(path)) {
      const ids = (query["ids"] ?? "").split(",").map(Number).filter(Number.isInteger);
      const value = ids.map((id) => state.workItems[id]).filter((w): w is Record<string, unknown> => w !== undefined);
      return sendJson(res, 200, { count: value.length, value });
    }
    // --- blobs and items (conventions) -----------------------------------------------
    const blob = /\/blobs\/([0-9a-f]+)$/.exec(path);
    if (method === "GET" && blob) {
      const content = state.blobs[blob[1] ?? ""];
      if (content === undefined) return sendJson(res, 404, { message: "blob not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": Buffer.byteLength(content) });
      return void res.end(content);
    }
    if (method === "GET" && /\/items$/.test(path)) {
      const item = state.items[query["path"] ?? ""];
      if (item === undefined) {
        // The normal case by far: most repos document nothing, and only a 404 may be read
        // as "no such file" (ado/conventions.ts isFileMissing).
        return sendJson(res, 404, { message: "TF401174: the item does not exist" });
      }
      if (item.status !== undefined && item.status >= 400) {
        return sendJson(res, item.status, { message: "denied" });
      }
      res.writeHead(item.status ?? 200, {
        "Content-Type": item.contentType ?? "text/plain",
        "Content-Length": Buffer.byteLength(item.body),
      });
      return void res.end(item.body);
    }

    // Anything else is a route prloop is not supposed to call; say so instead of 404ing
    // vaguely, because a silent 404 reads like a legitimate "not found" to the caller.
    return sendJson(res, 501, { message: `fake ADO: unrouted ${method} ${path}` });
  };

  const server = await listen((req, res) => {
    void handler(req, res);
  });

  return {
    ...server,
    state,
    requests,
    matching: (method, pattern) => requests.filter((r) => r.method === method && pattern.test(r.path)),
    reset: () => {
      requests.length = 0;
    },
  };
}
