// An in-memory ReviewHost (libs/host.ts): a pull request as plain data, for tests about what
// the pipeline does with a host rather than about Azure DevOps's wire format. The bytes on the
// wire are scripts/fakes/ado.ts's job, and the nets that care about them keep using it; this
// one exists so a test that only needs "a pull request with these threads" does not need a
// server, a port and a PAT to get one.
//
// It keeps the host's side of the contract the way ADO does: a body is stored and handed back
// byte for byte, a thread's comments are written by the identity selfId() names, and a write
// to something that is not there is refused with a status, as a 404 would be.
//
// Test infrastructure: plain objects only.
import type { ReviewContext } from "../../libs/context";
import type { ConventionDoc } from "../../libs/conventions";
import type { CreateThreadInput, LinkedRequirements, ReviewHost, StatusState, Thread } from "../../libs/host";

export interface MemoryPr {
  ctx: ReviewContext;
  threads: Thread[];
  /** Who prloop writes as; undefined is a host that cannot say. */
  selfId?: string;
  requirements: LinkedRequirements;
  conventions: ConventionDoc[];
  statuses: Array<{ state: StatusState; description: string; iterationId?: number }>;
  /** Every write, in order: "create 1", "update 1/1", "status 1 fixed", "status succeeded". */
  writes: string[];
}

class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function memoryHost(pr: Partial<MemoryPr> & { ctx: ReviewContext }): { host: ReviewHost; pr: MemoryPr } {
  const state: MemoryPr = {
    threads: [],
    requirements: { items: [], inheritedFrom: [] },
    conventions: [],
    statuses: [],
    writes: [],
    ...pr,
  };
  let nextId = 1 + Math.max(0, ...state.threads.flatMap((t) => [t.id, ...(t.comments ?? []).map((c) => c.id)]));
  const thread = (id: number): Thread => {
    const t = state.threads.find((x) => x.id === id && !x.isDeleted);
    if (!t) throw new Refused(`no thread ${id}`, 404);
    return t;
  };

  const host: ReviewHost = {
    ref: state.ctx.ref,
    intake: async () => state.ctx,
    terminal: () => undefined,
    conventions: async () => state.conventions,
    requirements: async () => state.requirements,
    threads: async () => structuredClone(state.threads.filter((t) => !t.isDeleted)),
    selfId: async () => state.selfId,
    async createThread(input: CreateThreadInput) {
      const a = input.anchor;
      const start = a && { line: a.startLine, offset: a.startOffset };
      const end = a && { line: a.endLine, offset: a.endOffset };
      const created: Thread = {
        id: nextId++,
        status: input.status ?? "active",
        comments: [{ id: nextId++, content: input.content, commentType: "text", ...(state.selfId ? { author: { id: state.selfId } } : {}) }],
        ...(input.filePath && a
          ? {
              threadContext:
                a.side === "right"
                  ? { filePath: `/${input.filePath}`, rightFileStart: start!, rightFileEnd: end! }
                  : { filePath: `/${input.filePath}`, leftFileStart: start!, leftFileEnd: end! },
            }
          : {}),
      };
      state.threads.push(created);
      state.writes.push(`create ${created.id}`);
      return structuredClone(created);
    },
    async updateComment(threadId, commentId, content) {
      const c = thread(threadId).comments?.find((x) => x.id === commentId && !x.isDeleted);
      if (!c) throw new Refused(`no comment ${commentId} on thread ${threadId}`, 404);
      c.content = content;
      state.writes.push(`update ${threadId}/${commentId}`);
    },
    async setThreadStatus(threadId, status) {
      thread(threadId).status = status;
      state.writes.push(`status ${threadId} ${status}`);
    },
    async postStatus(st, description, opts) {
      state.statuses.push({ state: st, description, ...(opts?.iterationId === undefined ? {} : { iterationId: opts.iterationId }) });
      state.writes.push(`status ${st}`);
    },
  };
  return { host, pr: state };
}
