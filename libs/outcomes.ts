// What happened to a finding after it was published — the positive half of the record.
//
// PROPOSAL §12 names implementation rate, "the comment was actually acted on", as the online
// north star. Nothing measured it. The only per-finding outcome prloop persisted was
// negative: libs/learnings.ts keeps the ones a reviewer closed as wontFix/byDesign, and a
// thread a human set to `fixed` was read by nothing at all. So precision could only ever be
// estimated as one minus the dismissal rate, which counts every comment nobody answered as a
// success — and on a review bot, silence is the most common response there is.
//
// A SEPARATE file from dismissals.jsonl, and that separation is load-bearing rather than
// tidiness: loadDismissals suppresses every fingerprint in its file, on every future PR in
// the repository. A finding a human fixed is the opposite of one to stop reporting, and one
// misplaced line would turn the record of the tool working into a reason to stop looking.
//
// Nothing here reaches a prompt. This is the "log dispositions to disk first, build rules
// later" step PROPOSAL §10 pre-approved when it rejected learned memory on day one.
import * as fs from "node:fs";
import * as path from "node:path";
import { RUNS_DIR } from "../config";
import { logVerbose } from "./log";
import type { PrRef } from "./types";

export interface StoredOutcome {
  fingerprint: string;
  file: string;
  /** Parsed from the comment's category marker; absent on comments from older versions. */
  category?: string;
  /**
   * `fixed` — a human set the thread to fixed. A statement.
   * `auto-closed` — prloop closed it because the line it pointed at was gone. An inference,
   *   and a narrow one (publish/lifecycle.ts findStaleThreads), so it is kept apart rather
   *   than folded into the headline rate.
   */
  outcome: "fixed" | "auto-closed";
  prId: number;
  recordedAt: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export function outcomesPath(ref: PrRef, root: string = RUNS_DIR): string {
  return path.join(root, safe(ref.org), safe(ref.project), safe(ref.repoId), "outcomes.jsonl");
}

/**
 * Every recorded outcome, one per fingerprint, FIRST record winning.
 *
 * First-wins is the guard that keeps the two kinds apart over time. prloop's auto-close
 * PATCHes the same `fixed` status a human sets and leaves no comment behind, so a thread
 * prloop closed on Tuesday is indistinguishable from a human fix when Wednesday's run reads
 * it. Having already recorded it as `auto-closed`, Wednesday cannot re-file it as a human's
 * decision. Within a single run the question does not arise: publish() takes one thread
 * snapshot before it closes anything, so what it closes is still `active` in what it reads.
 */
export function loadOutcomes(ref: PrRef, root: string = RUNS_DIR): StoredOutcome[] {
  let raw: string;
  try {
    raw = fs.readFileSync(outcomesPath(ref, root), "utf8");
  } catch {
    return [];
  }
  const out: StoredOutcome[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s) as StoredOutcome;
      // A corrupt line loses one record, never the store.
      if (typeof v?.fingerprint !== "string" || !v.fingerprint) continue;
      if (seen.has(v.fingerprint)) continue;
      seen.add(v.fingerprint);
      out.push(v);
    } catch {
      logVerbose(`outcomes: skipping corrupt line in ${outcomesPath(ref, root)}`);
    }
  }
  return out;
}

/**
 * Appends outcomes not yet in the store. Append-only with dedupe-on-read, like the dismissal
 * store: a crash mid-write loses at most the line being written and never rewrites history.
 * Returns how many were new.
 */
export function recordOutcomes(
  ref: PrRef,
  records: Array<{ fingerprint: string; file: string; category?: string; outcome: StoredOutcome["outcome"] }>,
  root: string = RUNS_DIR,
): number {
  if (records.length === 0) return 0;
  const known = new Set(loadOutcomes(ref, root).map((o) => o.fingerprint));
  const fresh: typeof records = [];
  for (const r of records) {
    if (!r.fingerprint || known.has(r.fingerprint)) continue;
    known.add(r.fingerprint);
    fresh.push(r);
  }
  if (fresh.length === 0) return 0;

  const p = outcomesPath(ref, root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const now = new Date().toISOString();
  const lines = fresh
    .map((r) => JSON.stringify({ ...r, prId: ref.prId, recordedAt: now } satisfies StoredOutcome))
    .join("\n");
  fs.appendFileSync(p, `${lines}\n`);
  return fresh.length;
}
