// Comment lifecycle across pushes.
//
// Two jobs:
//   1. Work out which iteration we last reviewed, so a re-run only looks at new commits.
//   2. Resolve threads whose code has since changed — the named failure mode in every
//      review-bot comparison is "repeats comments the author already addressed", and its
//      mirror image is leaving stale threads open until a human closes them by hand.
//
// State lives in the PR itself (a marker inside our own summary comment), not on disk:
// the tool is meant to be runnable from a pipeline agent, a laptop, or a cron box without
// them sharing a filesystem.
import { BOT_MARKER } from "../config";
import { listThreads, setThreadStatus, type Thread } from "../ado/threads";
import type { FileIndex } from "../libs/fileindex";
import { log, logVerbose } from "../libs/log";
import type { PrRef } from "../libs/types";

const ITERATION_MARKER = /<!-- prloop:iteration=(\d+) -->/;
export const iterationMarker = (id: number) => `<!-- prloop:iteration=${id} -->`;

/** The iteration recorded by our last run, read back from the sticky summary. */
export function lastReviewedIteration(threads: Thread[]): number | undefined {
  for (const t of threads) {
    for (const c of t.comments ?? []) {
      if (c.isDeleted || !(c.content ?? "").includes(BOT_MARKER)) continue;
      const m = ITERATION_MARKER.exec(c.content ?? "");
      if (m?.[1]) return Number(m[1]);
    }
  }
  return undefined;
}

export async function resolveLastReviewedIteration(ref: PrRef): Promise<number | undefined> {
  try {
    return lastReviewedIteration(await listThreads(ref));
  } catch (e) {
    logVerbose(`Could not read last reviewed iteration: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

export interface StaleThread {
  threadId: number;
  file: string;
  line: number;
  reason: string;
}

/**
 * Threads of ours whose anchored code no longer exists in the current iteration.
 *
 * The test is deliberately narrow: the thread must be one of ours, still active, anchored
 * to a file we have in hand, and the line it points at must no longer contain what it
 * originally flagged. Anything less certain is left alone — wrongly resolving a live issue
 * is worse than leaving a stale thread for a human to close.
 */
export function findStaleThreads(threads: Thread[], index: FileIndex): StaleThread[] {
  const stale: StaleThread[] = [];
  for (const t of threads) {
    if (t.status !== "active") continue;
    const first = t.comments?.find((c) => !c.isDeleted);
    if (!first || !(first.content ?? "").includes(BOT_MARKER)) continue;
    // The summary thread has no file context and is never resolved this way.
    const ctx = t.threadContext;
    if (!ctx?.filePath || !ctx.rightFileStart?.line) continue;

    // Thread paths are FULL paths from a prior iteration, in ADO's own shape; the index
    // resolves them (exact, or the rename trail via originalPath — a thread created on the
    // old name must still find the renamed file).
    const fd = index.resolvePrior(ctx.filePath);
    // File untouched in this iteration → the flagged code is unchanged → leave it open.
    if (!fd) continue;

    const line = ctx.rightFileStart.line;
    // ADO re-anchors tracked threads onto each new iteration. If the tracked line now sits
    // outside the file, or the line is no longer one this PR touches while the file itself
    // was rewritten, the original code is gone.
    if (line > fd.rightLines.length) {
      stale.push({ threadId: t.id, file: ctx.filePath, line, reason: "line is past the end of the file" });
    }
  }
  return stale;
}

export async function resolveStaleThreads(ref: PrRef, stale: StaleThread[]): Promise<number> {
  let resolved = 0;
  for (const s of stale) {
    try {
      await setThreadStatus(ref, s.threadId, "fixed");
      resolved++;
      logVerbose(`  Closed thread ${s.threadId} (${s.file}:${s.line}): ${s.reason}`);
    } catch (e) {
      logVerbose(`  Could not close thread ${s.threadId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (resolved > 0) log(`Auto-closed ${resolved} comments whose code has changed`);
  return resolved;
}

export interface DismissalRecord {
  fingerprint: string;
  file: string;
  claim: string;
  // From the comment's category marker; absent on comments posted by older versions.
  category?: string;
  resolvedAs: string;
}

/**
 * Findings a human closed without our help. These are the raw material for future
 * exclusion rules — a finding class the team keeps dismissing is a finding class we should
 * stop reporting. Recorded now, acted on later: building exclusion rules from a handful of
 * dismissals would overfit.
 */
export function collectDismissals(threads: Thread[]): DismissalRecord[] {
  const out: DismissalRecord[] = [];
  const fpRe = /<!-- prloop:fp=([0-9a-f]+) -->/;
  const catRe = /<!-- prloop:cat=([a-z-]+) -->/;
  for (const t of threads) {
    // wontFix/byDesign only. In the ADO UI "Closed" routinely means "handled", not
    // "wrong finding" — recording it as a dismissal would suppress a real finding class
    // forever, across PRs, because someone once fixed an instance and closed the thread.
    const dismissed = t.status === "wontFix" || t.status === "byDesign";
    if (!dismissed) continue;
    const c = t.comments?.find((x) => !x.isDeleted && (x.content ?? "").includes(BOT_MARKER));
    if (!c) continue;
    const fp = fpRe.exec(c.content ?? "")?.[1];
    if (!fp) continue; // the summary comment carries no fingerprint
    out.push({
      fingerprint: fp,
      file: t.threadContext?.filePath ?? "",
      claim: (c.content ?? "").split("\n").find((l) => l && !l.startsWith("<") && !l.startsWith("**")) ?? "",
      category: catRe.exec(c.content ?? "")?.[1],
      resolvedAs: t.status ?? "",
    });
  }
  return out;
}
