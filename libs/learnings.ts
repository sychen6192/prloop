// Learnings from human dismissals (CodeRabbit's "learnings", scoped down to what can be
// done deterministically — the pre-approved next step from PROPOSAL §10).
//
// A finding a reviewer closed as wontFix/byDesign is a decision. Re-posting the same
// finding on the next run — or on the next PR that carries the same code — re-litigates
// that decision, and is the fastest way to get a review bot switched off. So dismissals
// are persisted per repo and matched by fingerprint (file + category + normalized quote):
// narrow on purpose, because wrongly suppressing a real finding is worse than repeating
// a dismissed one.
//
// The store is an append-only JSONL under RUNS_DIR, next to the repo's run artifacts.
// This is weaker than prloop's usual "state lives on the PR" rule — a laptop and a cron
// box each accumulate their own store — but cross-PR memory has no home on any single PR,
// and a miss only costs one repeated comment, which the human dismisses again and the
// store learns. Within one PR, publish-time dedupe against the PR's own threads still
// works from any machine.
import * as fs from "node:fs";
import * as path from "node:path";
import { DISMISSAL_HINT_THRESHOLD, RUNS_DIR } from "../config";
import { logVerbose } from "./log";
import { redactSecrets } from "./redact";
import type { PrRef } from "./types";

export interface StoredDismissal {
  fingerprint: string;
  file: string;
  claim: string;
  // Parsed from the comment's category marker; absent on comments posted by older versions.
  category?: string;
  resolvedAs: string;
  /** What the reviewer said when they closed it, if anything (publish/lifecycle.ts). */
  reason?: string;
  prId: number;
  recordedAt: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export function learningsPath(ref: PrRef, root: string = RUNS_DIR): string {
  return path.join(root, safe(ref.org), safe(ref.project), safe(ref.repoId), "dismissals.jsonl");
}

export function loadDismissals(ref: PrRef, root: string = RUNS_DIR): StoredDismissal[] {
  const p = learningsPath(ref, root);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: StoredDismissal[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s) as StoredDismissal;
      // A corrupt line loses one record, never the store.
      if (typeof v?.fingerprint !== "string" || !v.fingerprint) continue;
      if (seen.has(v.fingerprint)) continue;
      seen.add(v.fingerprint);
      out.push(v);
    } catch {
      logVerbose(`learnings: skipping corrupt line in ${p}`);
    }
  }
  return out;
}

/**
 * Appends dismissals not yet in the store. Append-only with dedupe-on-read: a crash
 * mid-write loses at most the line being written, never rewrites history.
 * Returns how many were new.
 */
export function recordDismissals(
  ref: PrRef,
  records: Array<{ fingerprint: string; file: string; claim: string; category?: string; resolvedAs: string; reason?: string }>,
  root: string = RUNS_DIR,
): number {
  if (records.length === 0) return 0;
  const known = new Set(loadDismissals(ref, root).map((d) => d.fingerprint));
  const fresh = records.filter((r) => r.fingerprint && !known.has(r.fingerprint));
  if (fresh.length === 0) return 0;

  const p = learningsPath(ref, root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const now = new Date().toISOString();
  const lines = fresh
    .map((r) => JSON.stringify({ ...r, prId: ref.prId, recordedAt: now } satisfies StoredDismissal))
    .join("\n");
  // Redacted like every other artifact this process writes. This store was the one egress
  // that bypassed it — it appends its own bytes instead of going through libs/artifacts.ts —
  // and it now carries a reviewer's free text, which is exactly where somebody explains a
  // dismissal by pasting the credential the finding was about. The replacement is a plain
  // string in an already-escaped JSON value, so a redacted line still parses.
  fs.appendFileSync(p, `${redactSecrets(lines)}\n`);
  return fresh.length;
}

export function dismissedFingerprints(ref: PrRef, root: string = RUNS_DIR): Set<string> {
  return new Set(loadDismissals(ref, root).map((d) => d.fingerprint));
}

export interface CategoryHint {
  category: string;
  count: number;
}

/**
 * Categories the team keeps dismissing. Surfaced as a configuration suggestion in the
 * summary — never applied automatically, and never for categories already excluded.
 */
export function dismissedCategoryHints(
  stored: StoredDismissal[],
  alreadyExcluded: string[],
  threshold: number = DISMISSAL_HINT_THRESHOLD,
): CategoryHint[] {
  const counts = new Map<string, number>();
  for (const d of stored) {
    if (!d.category) continue;
    counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  }
  const excluded = new Set(alreadyExcluded);
  return [...counts.entries()]
    .filter(([cat, n]) => n >= threshold && !excluded.has(cat))
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
}
