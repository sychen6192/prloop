// PR metadata + iteration bookkeeping.
// Each push to the source branch creates a new iteration; $compareTo turns
// "changes in the whole PR" into "changes since the iteration I last reviewed".
import { adoGet, prBase, type AdoList } from "./client";
import type { ChangeEntry, ChangeType, Iteration, PrInfo, PrRef } from "../libs/types";

interface RawPr {
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  createdBy?: { displayName?: string };
  status?: string;
}

/**
 * A pull request ADO will refuse every write to, so there is nothing a review can leave on
 * it and no reason to buy one.
 *
 * `completed` only, and the narrowness is the evidence talking. It is the one rejection this
 * codebase has ever recorded — `ado/client.ts` quotes "the pull request is completed" as a
 * message seen in the field — whereas nothing in the tree has ever observed an abandoned PR
 * refusing a thread, abandonment is reversible from the same page, and the skip offers no way
 * back except `--dry-run`. Adding `abandoned` here on the assumption that it behaves the same
 * would be a guess wearing a fact's clothes; add it in its own commit once a rejected POST on
 * one has been seen, and paste the message into this docstring the way client.ts does.
 *
 * Lives beside getPrInfo rather than in the orchestrator because scripts/doctor.ts needs it
 * too, and doctor deliberately imports no gate, no publisher and no orchestrator: it is what
 * you run at 3am when something is broken, and a module-load failure anywhere in the pipeline
 * must not take the diagnostic down with it.
 */
export function terminalPrStatus(status: string): string | undefined {
  return status.toLowerCase() === "completed" ? "the pull request is completed" : undefined;
}

export async function getPrInfo(ref: PrRef): Promise<PrInfo> {
  const pr = await adoGet<RawPr>(prBase(ref));
  const short = (r?: string) => (r ?? "").replace(/^refs\/heads\//, "");
  return {
    title: pr.title ?? "",
    description: pr.description ?? "",
    sourceBranch: short(pr.sourceRefName),
    targetBranch: short(pr.targetRefName),
    createdBy: pr.createdBy?.displayName ?? "",
    status: pr.status ?? "",
  };
}

interface RawIteration {
  id?: number;
  sourceRefCommit?: { commitId?: string };
  targetRefCommit?: { commitId?: string };
  commonRefCommit?: { commitId?: string };
  createdDate?: string;
}

export async function listIterations(ref: PrRef): Promise<Iteration[]> {
  const res = await adoGet<AdoList<RawIteration>>(`${prBase(ref)}/iterations`);
  return (res.value ?? []).map((it) => ({
    id: it.id ?? 0,
    sourceRefCommit: it.sourceRefCommit?.commitId ?? "",
    targetRefCommit: it.targetRefCommit?.commitId ?? "",
    commonRefCommit: it.commonRefCommit?.commitId ?? "",
    createdDate: it.createdDate ?? "",
  }));
}

interface RawChangeEntry {
  changeTrackingId?: number;
  changeId?: number;
  changeType?: string;
  originalPath?: string;
  item?: {
    path?: string;
    objectId?: string;
    originalObjectId?: string;
    isFolder?: boolean;
    gitObjectType?: string;
  };
}

interface RawChanges {
  changeEntries?: RawChangeEntry[];
  nextSkip?: number;
  nextTop?: number;
}

function normalizeChangeType(raw: string | undefined): ChangeType {
  const t = (raw ?? "").toLowerCase();
  if (t.includes("delete")) return "delete";
  if (t.includes("rename")) return "rename";
  if (t.includes("add")) return "add";
  if (t.includes("edit")) return "edit";
  return "other";
}

/**
 * Files changed in `iterationId`. compareTo=0 (default) diffs against the merge base,
 * i.e. the full PR; compareTo=K yields only what changed since iteration K.
 */
export async function getIterationChanges(
  ref: PrRef,
  iterationId: number,
  compareTo = 0,
): Promise<ChangeEntry[]> {
  const out: ChangeEntry[] = [];
  const top = 2000; // API max
  let skip = 0;

  for (;;) {
    const res = await adoGet<RawChanges>(`${prBase(ref)}/iterations/${iterationId}/changes`, {
      query: { $compareTo: compareTo, $top: top, $skip: skip },
    });
    const entries = res.changeEntries ?? [];
    for (const e of entries) {
      const path = e.item?.path;
      if (!path) continue;
      if (e.item?.isFolder) continue;
      // Folders sometimes come through only as gitObjectType.
      if (e.item?.gitObjectType && e.item.gitObjectType.toLowerCase() === "tree") continue;
      out.push({
        path,
        originalPath: e.originalPath,
        changeType: normalizeChangeType(e.changeType),
        objectId: e.item?.objectId,
        originalObjectId: e.item?.originalObjectId,
        changeTrackingId: e.changeTrackingId,
        isFolder: false,
      });
    }
    if (entries.length < top || res.nextSkip === undefined) break;
    skip = res.nextSkip;
  }
  return out;
}
