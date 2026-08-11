// Intake: turn a PR reference into the review context — file diffs with real line
// indexes, computed from the exact blob bytes of the iteration under review.
// Everything downstream (finder prompt, anchoring, publishing) reads from here.
import { ADO_CONCURRENCY } from "../config";
import { getBlob } from "./blobs";
import { getIterationChanges, getPrInfo, listIterations } from "./iterations";
import { buildHunks, diffLines } from "../libs/diff";
import { FileIndex, normalizePath } from "../libs/fileindex";
import { detectLanguage, isNoiseFile, isReviewable } from "../libs/lang";
import { log, logVerbose } from "../libs/log";
import type { ChangeEntry, FileDiff, Iteration, PrInfo, PrRef } from "../libs/types";

export interface ReviewContext {
  ref: PrRef;
  pr: PrInfo;
  iterations: Iteration[];
  // The iteration being reviewed (always the latest).
  iteration: Iteration;
  // 0 = full PR; >0 = incremental review since that iteration (M5).
  compareTo: number;
  files: FileDiff[];
  // Changed files we deliberately did not review (lockfiles, binaries, generated output).
  skipped: Array<{ path: string; reason: string }>;
  changeTrackingIds: Map<string, number>;
  // Built once here; the single resolver for foreign path strings (see CONTEXT.md).
  index: FileIndex;
}

async function buildFileDiff(ref: PrRef, entry: ChangeEntry): Promise<FileDiff> {
  const language = detectLanguage(entry.path);
  const base: Omit<FileDiff, "hunks" | "rightLines" | "leftLines" | "changedRightLines"> = {
    path: entry.path,
    originalPath: entry.originalPath,
    changeType: entry.changeType,
    binary: false,
    truncated: false,
    language,
  };

  const [right, left] = await Promise.all([
    getBlob(ref, entry.objectId),
    getBlob(ref, entry.originalObjectId),
  ]);

  if (right.binary || left.binary) {
    return { ...base, binary: true, hunks: [], rightLines: [], leftLines: [], changedRightLines: new Set() };
  }
  if (right.truncated || left.truncated) {
    return { ...base, truncated: true, hunks: [], rightLines: [], leftLines: [], changedRightLines: new Set() };
  }

  const edits = diffLines(left.lines, right.lines);
  const { hunks, changedRightLines } = buildHunks(left.lines, right.lines, edits);
  return {
    ...base,
    hunks,
    rightLines: right.lines,
    leftLines: left.lines,
    changedRightLines,
  };
}

export async function buildReviewContext(ref: PrRef, compareTo = 0): Promise<ReviewContext> {
  const [pr, iterations] = await Promise.all([getPrInfo(ref), listIterations(ref)]);
  if (iterations.length === 0) {
    throw new Error(`PR !${ref.prId} has no iterations; nothing to review`);
  }
  const iteration = iterations[iterations.length - 1]!;
  log(`PR !${ref.prId} "${pr.title}" ${pr.sourceBranch} → ${pr.targetBranch}, iteration ${iteration.id}`);

  // ADO reports paths with a leading slash. Canonicalize once, at intake, so FileDiff.path
  // (and every map keyed by it) carries one shape — no consumer re-strips.
  const entries = (await getIterationChanges(ref, iteration.id, compareTo)).map((e) => ({
    ...e,
    path: normalizePath(e.path),
    originalPath: e.originalPath === undefined ? undefined : normalizePath(e.originalPath),
  }));
  const skipped: Array<{ path: string; reason: string }> = [];
  const changeTrackingIds = new Map<string, number>();
  const targets: ChangeEntry[] = [];

  for (const e of entries) {
    if (e.changeTrackingId !== undefined) changeTrackingIds.set(e.path, e.changeTrackingId);
    if (isNoiseFile(e.path)) {
      skipped.push({ path: e.path, reason: "generated/lock/vendor" });
      continue;
    }
    if (!isReviewable(e.path)) {
      skipped.push({ path: e.path, reason: `non-code (${detectLanguage(e.path)})` });
      continue;
    }
    if (e.changeType === "delete") {
      skipped.push({ path: e.path, reason: "deleted" });
      continue;
    }
    targets.push(e);
  }

  log(`${entries.length} changed files: ${targets.length} under review, ${skipped.length} skipped`);

  const files: FileDiff[] = [];
  // Modest concurrency: two blob fetches per file, and ADO rate-limits aggressively.
  const CONCURRENCY = ADO_CONCURRENCY;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const built = await Promise.all(batch.map((e) => buildFileDiff(ref, e)));
    for (const fd of built) {
      if (fd.binary) {
        skipped.push({ path: fd.path, reason: "binary" });
        continue;
      }
      if (fd.truncated) {
        skipped.push({ path: fd.path, reason: "too large" });
        continue;
      }
      if (fd.hunks.length === 0) {
        skipped.push({ path: fd.path, reason: "no textual change" });
        continue;
      }
      files.push(fd);
      logVerbose(`  ${fd.path}: ${fd.hunks.length} hunks, ${fd.changedRightLines.size} changed lines`);
    }
  }

  return {
    ref,
    pr,
    iterations,
    iteration,
    compareTo,
    files,
    skipped,
    changeTrackingIds,
    index: new FileIndex(files),
  };
}
