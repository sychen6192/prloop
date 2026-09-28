// Azure DevOps as the ReviewHost (libs/host.ts): the REST modules beside this one, bound to
// one pull request. Nothing here decides anything; each member is the module that already
// did the job, so the host adds no behaviour of its own and the wire format stays theirs.
import type { ReviewHost } from "../libs/host";
import type { PrRef } from "../libs/types";
import { fetchRepoConventions } from "./conventions";
import { selfIdentityId } from "./identity";
import { buildReviewContext } from "./intake";
import { terminalPrStatus } from "./iterations";
import { postStatus } from "./statuses";
import { createThread, listThreads, setThreadStatus, updateComment } from "./threads";
import { getLinkedRequirements } from "./workitems";

export function adoHost(ref: PrRef): ReviewHost {
  return {
    ref,
    intake: (compareTo, opts) => buildReviewContext(ref, compareTo, opts),
    terminal: (pr) => terminalPrStatus(pr.status),
    conventions: (commit, changedPaths) => fetchRepoConventions(ref, commit, changedPaths),
    requirements: () => getLinkedRequirements(ref),
    threads: () => listThreads(ref),
    selfId: () => selfIdentityId(ref),
    createThread: (input) => createThread(ref, input),
    updateComment: (threadId, commentId, content) => updateComment(ref, threadId, commentId, content),
    setThreadStatus: (threadId, status) => setThreadStatus(ref, threadId, status),
    postStatus: (state, description, opts) => postStatus(ref, state, description, opts),
  };
}
