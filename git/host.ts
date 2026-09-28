// A local branch as the ReviewHost (libs/host.ts): the change is `base...head` in a working
// tree, the conventions come from the repository's own history and the criteria from a file
// when one is given — and there is no discussion at all. Nothing was ever posted there, so
// nothing is already said, nothing was dismissed and there is no resume point; every write is
// refused, because there is nowhere to write it. A local review runs as a dry run, so
// publish() never asks.
import type { ReviewHost } from "../libs/host";
import type { WorkItem } from "../libs/types";
import { buildLocalReviewContext, localRef, readLocalConventions } from "./intake";

export interface LocalHostOptions {
  repo: string;
  base: string;
  head: string;
  /** Acceptance criteria to judge the branch against, as markdown. */
  criteria?: string;
}

/** Acceptance criteria from a file, as the one work item a local branch is judged against. */
function localWorkItem(text: string): WorkItem {
  return {
    id: 1,
    title: "local acceptance criteria",
    type: "User Story",
    state: "Active",
    description: "",
    acceptanceCriteria: text.trim(),
    specSource: "acceptance-criteria",
    url: "",
  };
}

export function localHost(opts: LocalHostOptions): ReviewHost {
  const { repo, base, head, criteria } = opts;
  const refuse = async (): Promise<never> => {
    throw new Error("a local review has no pull request to write to");
  };
  return {
    ref: localRef(repo),
    // A branch has no iterations to compare, so compareTo is always the whole of it.
    intake: (_compareTo, o) => buildLocalReviewContext({ repo, base, head, ...(o?.text ? { text: true } : {}) }),
    terminal: () => undefined,
    conventions: (commit, changedPaths) => readLocalConventions(repo, commit, changedPaths),
    requirements: async () => ({ items: criteria ? [localWorkItem(criteria)] : [], inheritedFrom: [] }),
    threads: async () => [],
    selfId: async () => undefined,
    createThread: refuse,
    updateComment: refuse,
    setThreadStatus: refuse,
    postStatus: refuse,
  };
}
