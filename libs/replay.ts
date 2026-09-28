// A run's model answers and the code they were about, saved so everything after the models —
// anchoring, dedupe, the gates, the comments — can run again offline (scripts/replay.ts).
//
// context.json stores counts, not lines, so nothing on disk could reconstruct a run. Tuning
// the claim-overlap threshold, the consensus rule, the severity bar or the comment cap meant
// paying for every model call again, and so it was mostly not done. The model calls are the
// expensive, non-deterministic half; the rest is deterministic TypeScript that only needs
// its inputs back.
//
// Opt-in (PRR_SAVE_REPLAY): it keeps the reviewed source on disk in one more file.
import { anchorAndDedupe, finalize, mergeToolFindings, type AggregateResult } from "../gates/aggregate";
import type { FinderOutput } from "../gates/finder";
import { applyVerdicts, type SkepticOutcome, type Verdict } from "../gates/skeptic";
import { FileIndex } from "./fileindex";
import type { AnchoredFinding, FileDiff, RawFinding } from "./types";
import { runTier } from "./tier";

export const REPLAY_VERSION = 1;

type StoredFile = Omit<FileDiff, "changedRightLines" | "changedLeftLines"> & {
  changedRightLines: number[];
  changedLeftLines: number[];
};

export interface ReplayBundle {
  version: typeof REPLAY_VERSION;
  files: StoredFile[];
  finders: Array<{ model: string; findings: RawFinding[]; error?: string }>;
  /** Every skeptic verdict, keyed by the fingerprint of the finding it was about. */
  verdicts: Array<{ fingerprint: string; killed: boolean; verdicts: Verdict[] }>;
  /** Static-analysis findings after triage: already anchored, as tools report lines. */
  tools: AnchoredFinding[];
  /** Fingerprints a human had dismissed when the run happened (the learnings store). */
  dismissed: string[];
  /** Fingerprints already on the pull request, whose findings skipped the skeptic. */
  posted?: string[];
}

export function toReplayBundle(input: {
  files: FileDiff[];
  outputs: FinderOutput[];
  outcomes: SkepticOutcome[];
  tools: AnchoredFinding[];
  dismissed: Iterable<string>;
  posted?: Iterable<string>;
}): ReplayBundle {
  return {
    version: REPLAY_VERSION,
    files: input.files.map((f) => ({ ...f, changedRightLines: [...f.changedRightLines], changedLeftLines: [...f.changedLeftLines] })),
    finders: input.outputs.map((o) => ({ model: o.model, findings: o.findings, ...(o.error ? { error: o.error } : {}) })),
    verdicts: input.outcomes.map((o) => ({ fingerprint: o.finding.fingerprint, killed: o.killed, verdicts: o.verdicts })),
    tools: input.tools,
    dismissed: [...input.dismissed],
    posted: [...(input.posted ?? [])],
  };
}

export interface ReplayResult {
  agg: AggregateResult;
  /** Candidates whose fingerprint no saved verdict covers: dedupe changed, so they are new. */
  unverified: number;
}

/**
 * Re-runs everything after the models over a saved bundle, under the CURRENT code and
 * settings — which is the point: change a threshold or a gate, replay, compare.
 *
 * Verdicts attach by fingerprint. A candidate the saved run never showed a skeptic (dedupe
 * now draws the line elsewhere, so the merged finding is a new one) replays unverified, and
 * the count says how many: a replay that silently treated them as cleared would flatter the
 * change being tested.
 */
export function replay(bundle: ReplayBundle): ReplayResult {
  if (bundle.version !== REPLAY_VERSION) throw new Error(`replay.json is version ${String(bundle.version)}, this prloop reads ${REPLAY_VERSION}`);
  const files: FileDiff[] = bundle.files.map((f) => ({
    ...f,
    changedRightLines: new Set(f.changedRightLines),
    changedLeftLines: new Set(f.changedLeftLines),
  }));
  const index = new FileIndex(files);
  const outputs: FinderOutput[] = bundle.finders.map((f) => ({
    model: f.model,
    findings: f.findings,
    rejected: 0,
    raw: "",
    ...(f.error ? { error: f.error } : {}),
  }));
  const candidates = anchorAndDedupe(outputs, index);
  const dismissed = new Set(bundle.dismissed);
  const posted = new Set(bundle.posted ?? []);
  const saved = new Map(bundle.verdicts.map((v) => [v.fingerprint, v]));
  let unverified = 0;
  const fresh = candidates.merged.filter((f) => !dismissed.has(f.fingerprint) && !posted.has(f.fingerprint));
  const outcomes: SkepticOutcome[] = fresh.map((finding) => {
    const v = saved.get(finding.fingerprint);
    if (!v) unverified++;
    return { finding, verdicts: v?.verdicts ?? [], killed: v?.killed ?? false };
  });
  const survivors = applyVerdicts(outcomes);
  const knownDismissed = candidates.merged.filter((f) => dismissed.has(f.fingerprint));
  const knownPosted = candidates.merged.filter((f) => !dismissed.has(f.fingerprint) && posted.has(f.fingerprint));
  const agg = finalize(
    candidates,
    mergeToolFindings([...survivors, ...knownDismissed, ...knownPosted], bundle.tools),
    dismissed,
    outcomes.filter((o) => o.killed).length,
    // The bar a live run over these files would use now, risk tier included.
    runTier(files).minSeverity,
    posted,
  );
  return { agg, unverified };
}
