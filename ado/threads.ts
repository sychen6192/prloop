// PR comment threads.
//
// The thread payload is where "comments land on the wrong line" is won or lost. ADO stores
// whatever you send without validating it against file content, so we send only anchors the
// pipeline computed, and always send them complete:
//   - both start and end positions (half-specified spans have broken the ADO UI: mcp #793)
//   - offsets starting at 1 (the docs say 0, every working example uses 1)
//   - changeTrackingId, which the docs require for PRs with iteration support
//   - iterationContext, so the thread is pinned to the iteration we actually reviewed
import { adoGet, adoPatch, adoPost, prBase, type AdoList } from "./client";
import { normalizePath } from "../libs/fileindex";
import type { CreateThreadInput, Thread, ThreadStatus } from "../libs/host";
import type { PrRef } from "../libs/types";

export async function listThreads(ref: PrRef): Promise<Thread[]> {
  const res = await adoGet<AdoList<Thread>>(`${prBase(ref)}/threads`);
  return (res.value ?? []).filter((t) => !t.isDeleted);
}

export async function createThread(ref: PrRef, input: CreateThreadInput): Promise<Thread> {
  const body: Record<string, unknown> = {
    comments: [
      {
        parentCommentId: 0,
        content: input.content,
        commentType: "text",
      },
    ],
    status: input.status ?? "active",
  };

  if (input.filePath && input.anchor) {
    const a = input.anchor;
    const start = { line: a.startLine, offset: a.startOffset };
    const end = { line: a.endLine, offset: a.endOffset };
    // The pipeline's paths are canonical (no leading slash); ADO's native shape carries
    // one. The translation lives at this write edge, mirroring the strip at the read edge.
    const filePath = `/${normalizePath(input.filePath)}`;
    body["threadContext"] =
      a.side === "right"
        ? { filePath, rightFileStart: start, rightFileEnd: end }
        : { filePath, leftFileStart: start, leftFileEnd: end };

    if (input.iterationId !== undefined) {
      body["pullRequestThreadContext"] = {
        ...(input.changeTrackingId !== undefined ? { changeTrackingId: input.changeTrackingId } : {}),
        iterationContext: {
          firstComparingIteration: input.firstComparingIteration ?? 1,
          secondComparingIteration: input.iterationId,
        },
      };
    }
  }

  return adoPost<Thread>(`${prBase(ref)}/threads`, body);
}

/** Edits an existing comment in place — how the sticky summary stays one comment across runs. */
export async function updateComment(
  ref: PrRef,
  threadId: number,
  commentId: number,
  content: string,
): Promise<void> {
  await adoPatch(`${prBase(ref)}/threads/${threadId}/comments/${commentId}`, { content });
}

export async function setThreadStatus(ref: PrRef, threadId: number, status: ThreadStatus): Promise<void> {
  await adoPatch(`${prBase(ref)}/threads/${threadId}`, { status });
}
