// Aggregation: anchor, dedupe, rank, cap. Zero LLM calls — every decision here is
// deterministic and auditable, which is what keeps the loop convergent.
import { createHash } from "node:crypto";
import {
  MAX_INLINE_COMMENTS,
  MIN_CONSENSUS_SOURCES,
  SKEPTIC_MODELS,
  MIN_INLINE_SEVERITY,
  REQUIRE_CORROBORATION,
  excludedCategories,
  severityRank,
} from "../config";
import { anchorFinding } from "../anchoring/locate";
import { normalizePath, type FileIndex } from "../libs/fileindex";
import { log } from "../libs/log";
import type { Anchor, AnchoredFinding, RawFinding } from "../libs/types";
import type { FinderOutput } from "./finder";

export interface AggregateResult {
  // Findings that anchored cleanly and passed the severity/cap filters — these get inline threads.
  inline: AnchoredFinding[];
  // Anchored but filtered out by severity or the comment cap; listed in the summary.
  belowBar: AnchoredFinding[];
  // Could not be anchored. Reported in the summary with the reason, never guessed inline.
  degraded: AnchoredFinding[];
  stats: {
    raw: number;
    afterDedupe: number;
    anchored: number;
    // Findings left after adversarial verification AND tool-finding merges — can exceed
    // `anchored` when static analysis contributed findings, so `anchored - survived` is
    // NOT the refutation count; use `refuted`.
    survived: number;
    // Findings the skeptic majority refuted (set by the orchestrator, which owns the
    // skeptic outcomes; 0 when verification didn't run).
    refuted: number;
    inline: number;
    byFailure: Record<string, number>;
    // Dropped before anchoring because their category is in PRR_EXCLUDE_CATEGORIES.
    excluded: number;
    // Suppressed because they match a finding a human previously dismissed.
    dismissed: number;
  };
}

// `f.file` is canonical here: anchorAndDedupe re-keys onto the resolved FileDiff.path
// (or normalizePath for findings that failed to resolve) before fingerprinting, so the
// model's spelling of a path cannot change a finding's identity between runs.
//
// The separators are written as escapes, never as raw bytes: this hash is the identity
// embedded in every posted comment and in dismissals.jsonl, and a raw U+0000 in the source
// made git treat the file as binary while any normalising editor would have silently
// rewritten every fingerprint. The selftest pins the hash of a fixed sample.
export function fingerprint(f: RawFinding): string {
  const normQuote = f.quote.replace(/\s+/g, " ").trim().toLowerCase();
  const normFile = f.file.toLowerCase();
  return createHash("sha1").update(`${normFile}\u0000${f.category}\u0000${normQuote}`).digest("hex").slice(0, 12);
}

const normQuote = (q: string) => q.replace(/\s+/g, " ").trim();

/**
 * Two findings are the same issue if they share a file and overlapping lines, and either
 * agree on category or quote the same code. The quote clause matters for weak models:
 * category labels are unstable across model families ("concurrency" vs a coerced
 * "correctness" for the same race), and requiring an exact category match would split the
 * very consensus the multi-finder setup exists to measure.
 *
 * Only called within one anchoring class — see anchorAndDedupe, which never compares an
 * anchored finding against an anchor-failed one.
 */
function sameIssue(a: AnchoredFinding, b: AnchoredFinding): boolean {
  if (a.file !== b.file) return false;
  const agree = a.category === b.category || normQuote(a.quote) === normQuote(b.quote);
  if (!agree) return false;
  if (!a.anchor || !b.anchor) return a.fingerprint === b.fingerprint;
  if (a.anchor.side !== b.anchor.side) return false;
  return a.anchor.startLine <= b.anchor.endLine && b.anchor.startLine <= a.anchor.endLine;
}

/** Claim vocabulary for the agreement check: lowercase words of three or more characters. */
function claimTokens(claim: string): Set<string> {
  return new Set(
    claim
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

/**
 * Whether two findings on the same lines are the same finding, as opposed to two findings
 * that happen to share a line. Exported for the selftest.
 *
 * sameIssue is deliberately loose — it is what dedupes, and a missed duplicate is two
 * comments on one line — but it also decided corroboration, and there loose is wrong: an
 * 8-line "this loop can race" and a 1-line "unused variable" in the same category
 * overlapped, merged, and the second model went into `sources` as having independently
 * found the race. The consensus gate then published one opinion as a consensus. Agreement
 * needs one of: the same quoted code; two tight spans (three lines or fewer) sharing a
 * line this PR changed — both models pointed at the same new code; or claims with enough
 * vocabulary in common (token Jaccard ≥ 0.3) to be about the same thing. `changedLines`
 * is the file's changedRightLines; without it the span rule cannot fire.
 */
export function findingsAgree(a: AnchoredFinding, b: AnchoredFinding, changedLines?: Set<number>): boolean {
  if (normQuote(a.quote) === normQuote(b.quote)) return true;
  if (a.anchor && b.anchor && a.anchor.side === "right" && b.anchor.side === "right" && changedLines) {
    const span = (x: Anchor) => x.endLine - x.startLine + 1;
    if (span(a.anchor) <= 3 && span(b.anchor) <= 3) {
      const from = Math.max(a.anchor.startLine, b.anchor.startLine);
      const to = Math.min(a.anchor.endLine, b.anchor.endLine);
      for (let l = from; l <= to; l++) if (changedLines.has(l)) return true;
    }
  }
  const ta = claimTokens(a.claim);
  const tb = claimTokens(b.claim);
  if (ta.size === 0 || tb.size === 0) return false;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both) >= 0.3;
}

/**
 * Folds `extra` into `target`. Whether `extra` counts as corroboration is the caller's
 * verdict (`agree`, from findingsAgree): a disagreeing source is remembered under
 * `overlapping` so the summary can say another model spoke about these lines, without it
 * ever satisfying the consensus gate.
 */
function mergeInto(target: AnchoredFinding, extra: AnchoredFinding, agree: boolean): void {
  for (const s of extra.sources) {
    if (target.sources.includes(s)) continue;
    if (agree) target.sources.push(s);
    else if (!target.overlapping?.includes(s)) (target.overlapping ??= []).push(s);
  }
  // Keep the more alarming assessment; consensus scoring in M3 refines this. Not from a
  // triage-tier tool, though: tool merges run AFTER the skeptic, and eslint rating every
  // error-level rule "high" re-escalated findings the verifier had just downgraded. Only a
  // fact-tier tool (tsc, mypy) measures anything a verifier's judgment should yield to.
  if (extra.tier !== "triage" && severityRank(extra.severity) < severityRank(target.severity)) {
    target.severity = extra.severity;
  }
  target.confidence = Math.max(target.confidence, extra.confidence);
  // Missing pieces are borrowed only from a source that agrees. A disagreeing finding's
  // evidence and fix describe a different defect, and attaching them to this claim posted
  // comments whose suggested code contradicted their own headline.
  if (!agree) return;
  if (!target.suggested_fix && extra.suggested_fix) target.suggested_fix = extra.suggested_fix;
  if (!target.evidence && extra.evidence) target.evidence = extra.evidence;
}

export interface AnchoredCandidates {
  // Anchored and deduped, ranked, but not yet verified or filtered.
  merged: AnchoredFinding[];
  degraded: AnchoredFinding[];
  rawCount: number;
  byFailure: Record<string, number>;
  // Dropped up front because their category is excluded by config.
  excluded: number;
}

/**
 * Phase 1: anchor every finding, then merge duplicates.
 *
 * Anchoring runs before dedup on purpose — it doubles as a hallucination filter, and a
 * hallucinated quote must not merge into (and thereby corroborate) a real finding.
 */
export function anchorAndDedupe(outputs: FinderOutput[], index: FileIndex): AnchoredCandidates {
  const byFailure: Record<string, number> = {};
  let rawCount = 0;

  // Excluded categories are dropped before anchoring, so no skeptic call is ever spent on
  // them. Dropped-with-a-count, not silently: the summary names the count and the config.
  const excludedCats = new Set(excludedCategories());
  let excluded = 0;

  const anchoredAll: AnchoredFinding[] = [];
  for (const out of outputs) {
    for (const f of out.findings) {
      rawCount++;
      if (excludedCats.has(f.category)) {
        excluded++;
        continue;
      }
      const res = anchorFinding(f, index);
      // Trust the resolved path over whatever the model wrote; a finding that failed to
      // resolve keeps the model's string, normalized once so dedupe and fingerprinting
      // never compare raw spellings.
      const file = res.file?.path ?? normalizePath(f.file);
      const af: AnchoredFinding = {
        ...f,
        file,
        sources: [out.model],
        fingerprint: fingerprint({ ...f, file }),
        anchor: res.anchor,
        anchorFailure: res.failure,
      };
      if (res.failure) {
        byFailure[res.failure] = (byFailure[res.failure] ?? 0) + 1;
        af.evidence = res.detail ? `${af.evidence ?? ""}\n(anchoring failed: ${res.detail})`.trim() : af.evidence;
      }
      anchoredAll.push(af);
    }
  }

  // Dedupe. Multiple models flagging the same line is signal, not duplication — merging
  // records every source so consensus scoring can use it. Every AGREEING source, that is:
  // a finding that merely overlaps is folded in (one comment per line) but recorded as
  // `overlapping`, not as corroboration.
  //
  // Anchored and anchor-failed findings are deduped in SEPARATE pools, never against each
  // other. Cross-merging is wrong in both directions: an anchor-failed duplicate processed
  // first would absorb the anchored one and destroy its anchor (order-dependent loss of an
  // inline comment), and processed second it would count toward consensus — an unverifiable
  // quote corroborating a verified one, which the anchoring-before-dedupe design forbids.
  const dedupe = (pool: AnchoredFinding[]): AnchoredFinding[] => {
    const out: AnchoredFinding[] = [];
    for (const f of pool) {
      const hit = out.find((m) => sameIssue(m, f));
      if (hit) mergeInto(hit, f, findingsAgree(hit, f, index.exact(hit.file)?.changedRightLines));
      else out.push(f);
    }
    return out;
  };
  const merged = dedupe(anchoredAll.filter((f) => f.anchor));
  const degraded = dedupe(anchoredAll.filter((f) => !f.anchor));
  const all = [...merged, ...degraded];

  // Rank: severity, then how many models independently found it, then confidence.
  merged.sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
    return b.confidence - a.confidence;
  });

  if (excluded > 0) {
    log(`anchoring: ${excluded} findings dropped, category excluded by config (${[...excludedCats].join(", ")})`);
  }
  log(`anchoring: raw ${rawCount} → ${all.length} after dedupe → ${merged.length} anchored`);
  const finderModels = new Set(outputs.filter((o) => o.findings.length > 0).map((o) => o.model));
  if (finderModels.size >= 2 && merged.every((f) => f.sources.length < MIN_CONSENSUS_SOURCES)) {
    log(
      `[WARN] ${finderModels.size} finders produced zero overlapping findings — the consensus ` +
        `gate contributed nothing this run, and every finding now depends solely on a skeptic. ` +
        `Models from the same family often diverge like this; try a different family`,
    );
  }
  if (degraded.length > 0) {
    log(
      `  ${degraded.length} could not be anchored (${Object.entries(byFailure)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ")}), degraded into the summary`,
    );
  }

  return { merged, degraded, rawCount, byFailure, excluded };
}

/**
 * Merges tool findings into the model survivors instead of concatenating them. mypy and a
 * finder model flagging the same unchecked None must be one comment, not two — and the
 * merge records the tool as an extra source, which is corroboration a deterministic tool
 * has earned. Only when they agree (findingsAgree): a tool that overlaps a model finding
 * with a different message saw a different problem. Absorbing it anyway would either count
 * it as corroboration of a claim it never made or, kept single-source, sink a real tsc
 * error into a summary line under someone else's claim — so it stays a finding of its own.
 */
export function mergeToolFindings(
  survivors: AnchoredFinding[],
  tools: AnchoredFinding[],
  // For the agreement check's changed-lines rule; tool findings sit on the diff's own paths.
  // Required, not optional: without it findingsAgree's changed-lines clause silently cannot
  // fire, so whether a tool finding merges or stands alone depended on whether a caller
  // remembered to pass an argument.
  index: FileIndex,
): AnchoredFinding[] {
  const out = [...survivors];
  for (const t of tools) {
    const hit = out.find((m) => sameIssue(m, t));
    if (hit && findingsAgree(hit, t, index.exact(hit.file)?.changedRightLines)) {
      mergeInto(hit, t, true);
      // A tool's sighting counts as an active clearing, like it does standalone.
      hit.skepticVerdicts = Math.max(hit.skepticVerdicts ?? 0, t.skepticVerdicts ?? 0);
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * Phase 2: decide what actually gets published.
 *
 * Corroboration first, then severity, then the cap. A finding that only one model raised and
 * that no skeptic examined is not published inline — with weak models, an unverified single
 * opinion is the main source of false positives. It still appears in the summary, so nothing
 * is silently dropped.
 */
export function finalize(
  candidates: AnchoredCandidates,
  survivors: AnchoredFinding[],
  // Fingerprints of findings a human previously dismissed (wontFix/byDesign), loaded from
  // the per-repo learnings store. Matching findings never go inline again.
  dismissed: Set<string> = new Set(),
  // How many findings the skeptic majority refuted (the orchestrator owns the outcomes).
  refuted = 0,
): AggregateResult {
  // Re-rank before the cap. The sort in anchorAndDedupe is stale by now: the skeptic may
  // have downgraded severities after it ran, and tool findings are appended at the tail
  // regardless of severity — without this, a critical tsc fact can be capped out by ten
  // mediums that outranked it only by arrival order.
  survivors = [...survivors].sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
    return b.confidence - a.confidence;
  });

  const corroborated: AnchoredFinding[] = [];
  const uncorroborated: AnchoredFinding[] = [];
  const previouslyDismissed: AnchoredFinding[] = [];

  for (const f of survivors) {
    // A human already said no to this exact finding. That decision outranks every other
    // gate — corroboration cannot re-open what a reviewer closed.
    if (dismissed.has(f.fingerprint)) {
      f.suppressedBy = "dismissed";
      previouslyDismissed.push(f);
      continue;
    }
    const multiSource = f.sources.length >= MIN_CONSENSUS_SOURCES;
    // A strict majority of the verifiers that answered must have CLEARED it. Two things
    // used to pass here that should not: a verifier answering "I could not check this"
    // (counted as a clearing, so a finding nobody had examined published as verified), and
    // an even split, which both survived the kill vote and cleared the corroboration gate
    // off the same verdicts. holds > refuted + unchecked is exactly holds*2 > answered.
    const clearedBySkeptic =
      (f.skepticVerdicts ?? 0) > (f.skepticRefuted ?? 0) + (f.skepticUnchecked ?? 0);
    if (!REQUIRE_CORROBORATION || multiSource || clearedBySkeptic) corroborated.push(f);
    else {
      f.suppressedBy = "no-corroboration";
      uncorroborated.push(f);
    }
  }

  const minRank = severityRank(MIN_INLINE_SEVERITY);
  const eligible = corroborated.filter((f) => severityRank(f.severity) <= minRank);
  const belowSeverity = corroborated.filter((f) => severityRank(f.severity) > minRank);
  for (const f of belowSeverity) f.suppressedBy = "severity";

  const inline = eligible.slice(0, MAX_INLINE_COMMENTS);
  const overCap = eligible.slice(MAX_INLINE_COMMENTS);
  for (const f of overCap) f.suppressedBy = "cap";

  log(
    `verdict: ${survivors.length} survived → ${corroborated.length} corroborated → ${inline.length} inline` +
      (uncorroborated.length > 0 ? ` (${uncorroborated.length} lack corroboration, summary only)` : "") +
      (previouslyDismissed.length > 0
        ? ` (${previouslyDismissed.length} match findings a reviewer dismissed, suppressed)`
        : ""),
  );
  // Distinguish "one model said it and a verifier disagreed or never ran" from "one model
  // said it and no verifier was configured". They look identical in the counts above, and
  // only the first is a fixable failure.
  const verifierDied = uncorroborated.filter(
    (f) => (f.skepticVerdicts ?? 0) === 0 && (f.skepticRefuted ?? 0) === 0 && (f.skepticUnchecked ?? 0) === 0,
  );
  if (verifierDied.length > 0 && SKEPTIC_MODELS.length > 0) {
    for (const f of verifierDied) {
      log(`  no corroboration: ${f.file}:${f.anchor?.startLine} — single source and its verifier returned nothing`);
    }
  }
  // A third case, and the one the new verdict exists to name: the verifiers answered, and
  // what they answered was "I cannot check this from what you showed me". Nothing is
  // broken — the claim is about code outside the snippet — so it must not be reported as a
  // dead verifier, which would send the reader to fix an endpoint that is working.
  const uncheckable = uncorroborated.filter((f) => (f.skepticUnchecked ?? 0) > 0 && (f.skepticVerdicts ?? 0) === 0);
  for (const f of uncheckable) {
    log(
      `  no corroboration: ${f.file}:${f.anchor?.startLine} — single source, and every verifier ` +
        `answered it could not check the claim from the code it was shown`,
    );
  }

  return {
    inline,
    belowBar: [...previouslyDismissed, ...uncorroborated, ...belowSeverity, ...overCap],
    degraded: candidates.degraded,
    stats: {
      raw: candidates.rawCount,
      afterDedupe: candidates.merged.length + candidates.degraded.length,
      anchored: candidates.merged.length,
      survived: survivors.length,
      refuted,
      inline: inline.length,
      byFailure: candidates.byFailure,
      excluded: candidates.excluded,
      dismissed: previouslyDismissed.length,
    },
  };
}
