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
  type Severity,
} from "../config";
import { anchorFinding } from "../anchoring/locate";
import { normalizePath, type FileIndex } from "../libs/fileindex";
import { log } from "../libs/log";
import { suppressionMarker } from "../libs/suppression";
import type { Anchor, AnchoredFinding, FileDiff, RawFinding } from "../libs/types";
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
 * Two findings are about the same PLACE if they share a file and overlapping lines on the
 * same side. Place alone decides nothing: it is where the question "same finding?" gets
 * asked (findingsAgree), never its answer.
 *
 * Only called within one anchoring class — see anchorAndDedupe, which never compares an
 * anchored finding against an anchor-failed one. Anchor-failed findings have no lines, so
 * their place is their identity.
 */
function samePlace(a: AnchoredFinding, b: AnchoredFinding): boolean {
  if (a.file !== b.file) return false;
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

// Categories that describe the same kind of problem — broken behaviour — and that model
// families label inconsistently: the same race comes back "concurrency" from one and a
// coerced "correctness" from another. Outside this group a different label is a different
// problem: "unused variable" (leftover-code) and "SQL injection" (security) on one line are
// two findings.
const BEHAVIOUR: ReadonlySet<string> = new Set(["correctness", "concurrency", "reliability", "data-integrity"]);
const sameKind = (a: string, b: string) => a === b || (BEHAVIOUR.has(a) && BEHAVIOUR.has(b));

/**
 * Whether two findings in the same place are the same finding, as opposed to two findings
 * that happen to share a line. Exported for the selftest. It decides both what merges into
 * one comment and what counts as independent corroboration, so it asks about the CLAIM:
 * the same quoted code classified as the same kind of problem, or claims with enough
 * vocabulary in common (token Jaccard ≥ 0.3) to be about the same thing.
 *
 * Position used to be enough on its own — any identical quote, or two spans of three lines
 * or fewer sharing a changed line, agreed whatever the claims said. "Unused variable" (low)
 * and "SQL injection" (critical) quoting the same line then merged into one finding that
 * kept the first claim, took the critical severity, and listed both models as having found
 * it: it passed the consensus gate, and the injection was reported nowhere. Two claims about
 * one line are now two findings, each verified, gated and posted on its own.
 */
export function findingsAgree(a: AnchoredFinding, b: AnchoredFinding): boolean {
  if (normQuote(a.quote) === normQuote(b.quote) && sameKind(a.category, b.category)) return true;
  const ta = claimTokens(a.claim);
  const tb = claimTokens(b.claim);
  if (ta.size === 0 || tb.size === 0) return false;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both) >= 0.3;
}

/**
 * Folds `extra` into `target`: two sightings of the same finding (findingsAgree), so every
 * source counts as corroboration. Only ever called for agreeing findings — a finding with a
 * different claim stays a finding of its own, and the two only know of each other through
 * `overlapping`.
 */
function mergeInto(target: AnchoredFinding, extra: AnchoredFinding): void {
  for (const s of extra.sources) if (!target.sources.includes(s)) target.sources.push(s);
  // Keep the more alarming assessment of the same finding. Not from a triage-tier tool,
  // though: tool merges run AFTER the skeptic, and eslint rating every error-level rule
  // "high" re-escalated findings the verifier had just downgraded. Only a fact-tier tool
  // (tsc, mypy) measures anything a verifier's judgment should yield to.
  if (extra.tier !== "triage" && severityRank(extra.severity) < severityRank(target.severity)) {
    target.severity = extra.severity;
  }
  target.confidence = Math.max(target.confidence, extra.confidence);
  if (!target.suggested_fix && extra.suggested_fix) target.suggested_fix = extra.suggested_fix;
  if (!target.evidence && extra.evidence) target.evidence = extra.evidence;
  if (!target.claim_kind && extra.claim_kind && extra.claim_subject) {
    target.claim_kind = extra.claim_kind;
    target.claim_subject = extra.claim_subject;
  }
}

/**
 * Records, on both findings, that another model spoke about the same lines with a different
 * claim. Named so a reader knows the line was busy; never counted as corroboration.
 */
function noteOverlap(a: AnchoredFinding, b: AnchoredFinding): void {
  for (const [to, from] of [[a, b], [b, a]] as const) {
    for (const s of from.sources) {
      if (to.sources.includes(s) || to.overlapping?.includes(s)) continue;
      (to.overlapping ??= []).push(s);
    }
  }
}

/**
 * Whether an anchored span touches this change: a line the change added or removed on the
 * span's side, or — on the new side — a line directly beside a removal nothing replaced. A pure
 * removal has no line of its own in the new file, so a finding about it ("`x` can be null now
 * that the check is gone") can only quote a neighbour, and that neighbour is where the change is.
 */
function touchesChange(fd: FileDiff, a: Anchor): boolean {
  const changed = a.side === "right" ? fd.changedRightLines : fd.changedLeftLines;
  for (let l = a.startLine; l <= a.endLine; l++) if (changed.has(l)) return true;
  return a.side === "right" && removalNeighbours(fd).some((l) => l >= a.startLine && l <= a.endLine);
}

/** New-side lines directly above and below each run of removed lines with no `+` beside it. */
function removalNeighbours(fd: FileDiff): number[] {
  const out: number[] = [];
  for (const h of fd.hunks) {
    const body = h.body.split("\n");
    let right = h.rightStart;
    for (let i = 0; i < body.length; i++) {
      if (!body[i]!.startsWith("-")) {
        if (body[i]!.startsWith(" ") || body[i]!.startsWith("+")) right++;
        continue;
      }
      let j = i;
      while (body[j + 1]?.startsWith("-")) j++;
      if (!body[i - 1]?.startsWith("+") && !body[j + 1]?.startsWith("+")) {
        if (right > 1) out.push(right - 1);
        out.push(right);
      }
      i = j;
    }
  }
  return out;
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

  // Dedupe. Multiple models flagging the same finding is signal, not duplication — merging
  // records every source so consensus scoring can use it. The same FINDING, that is: a
  // finding with a different claim about the same lines stays separate, with its own
  // severity and sources, and the two are only noted as `overlapping` each other.
  //
  // Anchored and anchor-failed findings are deduped in SEPARATE pools, never against each
  // other. Cross-merging is wrong in both directions: an anchor-failed duplicate processed
  // first would absorb the anchored one and destroy its anchor (order-dependent loss of an
  // inline comment), and processed second it would count toward consensus — an unverifiable
  // quote corroborating a verified one, which the anchoring-before-dedupe design forbids.
  const dedupe = (pool: AnchoredFinding[]): AnchoredFinding[] => {
    const out: AnchoredFinding[] = [];
    for (const f of pool) {
      const near = out.filter((m) => samePlace(m, f));
      const twin = near.find((m) => findingsAgree(m, f));
      if (twin) {
        mergeInto(twin, f);
        continue;
      }
      for (const m of near) noteOverlap(m, f);
      out.push(f);
    }
    return out;
  };
  const merged = dedupe(anchoredAll.filter((f) => f.anchor));
  const degraded = dedupe(anchoredAll.filter((f) => !f.anchor));
  const all = [...merged, ...degraded];

  // What finalize needs to file a finding in one of its two lanes, read here where the file
  // is at hand: whether the anchored lines touch the change at all, and whether they carry a
  // marker silencing a check. Markers are read on the new side only — one on a line the change
  // removed silenced nothing that is still there.
  for (const f of merged) {
    const fd = index.exact(f.file);
    if (!fd || !f.anchor) continue;
    if (!touchesChange(fd, f.anchor)) f.untouched = true;
    const marker = f.anchor.side === "right" ? suppressionMarker(fd.rightLines, f.anchor.startLine, f.anchor.endLine) : undefined;
    if (marker) f.silencedBy = marker;
  }

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
export function mergeToolFindings(survivors: AnchoredFinding[], tools: AnchoredFinding[]): AnchoredFinding[] {
  const out = [...survivors];
  for (const t of tools) {
    const hit = out.find((m) => samePlace(m, t) && findingsAgree(m, t));
    if (hit) {
      mergeInto(hit, t);
      // A tool's sighting counts as an active clearing, like it does standalone.
      hit.skepticVerdicts = Math.max(hit.skepticVerdicts ?? 0, t.skepticVerdicts ?? 0);
      // A tool that reports the line in spite of its marker shows the marker is not about
      // this: `# noqa: E501` silences ruff's line length, not the type error mypy found there.
      delete hit.silencedBy;
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * On an incremental run, splits the findings filed as pre-existing — on lines this push did
 * not touch — by who wrote those lines: an earlier push of this pull request, when the whole
 * PR's diff (`whole`) changed them, or nobody in this PR. New side only: an incremental diff's
 * old side is the previous push, and its line numbers mean nothing in the whole PR's diff.
 */
export function markEarlierPushes(findings: readonly AnchoredFinding[], whole: FileIndex): void {
  for (const f of findings) {
    if (f.suppressedBy !== "pre-existing" || f.anchor?.side !== "right") continue;
    const fd = whole.exact(f.file);
    f.earlierPush = fd !== undefined && touchesChange(fd, f.anchor);
  }
}

/**
 * The lane a finding that earned a comment goes to instead, if any. A suppression marker is
 * the author's decision about the line, and Anthropic's review plugin counts findings the code
 * explicitly silences among its false positives; a finding on lines the change did not touch
 * is most often about code that was there before it — AutoCommenter drops comments on
 * unchanged lines, Claude Code Review tags them pre-existing. A marker silences a tool's
 * check, not every defect a line can hold, and a finding on an untouched line can still be one
 * the change caused, so a critical finding is posted wherever it is: at that severity, a
 * comment the author waves off costs less than a defect kept in a summary list. Tool findings
 * never enter a lane — a tool reads its own markers, and the static gate keeps changed lines
 * only.
 */
function laneOf(f: AnchoredFinding): "silenced" | "pre-existing" | undefined {
  if (f.tier !== undefined || f.severity === "critical") return undefined;
  if (f.silencedBy) return "silenced";
  if (f.untouched) return "pre-existing";
  return undefined;
}

/**
 * Phase 2: decide what actually gets published.
 *
 * Corroboration first, then severity, then the two lanes, then the cap. A finding that only
 * one model raised and that no skeptic examined is not published inline — with weak models, an
 * unverified single opinion is the main source of false positives. It still appears in the
 * summary, so nothing is silently dropped. The lanes come after the gates that judge a finding,
 * so the summary's pre-existing list holds only findings that earned a comment.
 */
export function finalize(
  candidates: AnchoredCandidates,
  survivors: AnchoredFinding[],
  // Fingerprints of findings a human previously dismissed (wontFix/byDesign), loaded from
  // the per-repo learnings store. Matching findings never go inline again.
  dismissed: Set<string> = new Set(),
  // How many findings the skeptic majority refuted (the orchestrator owns the outcomes).
  refuted = 0,
  // The inline bar: PRR_MIN_INLINE_SEVERITY, unless the run's risk tier set a stricter one.
  minSeverity: Severity = MIN_INLINE_SEVERITY,
  // Fingerprints already on the pull request. Their findings skipped the skeptic because an
  // earlier run verified and posted them, so they count as corroborated — or the summary
  // would call a finding with an open thread "single model, unverified".
  posted: ReadonlySet<string> = new Set(),
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
    if (!REQUIRE_CORROBORATION || multiSource || clearedBySkeptic || posted.has(f.fingerprint)) corroborated.push(f);
    else {
      f.suppressedBy = "no-corroboration";
      uncorroborated.push(f);
    }
  }

  const minRank = severityRank(minSeverity);
  const eligible = corroborated.filter((f) => severityRank(f.severity) <= minRank);
  const belowSeverity = corroborated.filter((f) => severityRank(f.severity) > minRank);
  for (const f of belowSeverity) f.suppressedBy = "severity";

  const silenced = eligible.filter((f) => laneOf(f) === "silenced");
  const preExisting = eligible.filter((f) => laneOf(f) === "pre-existing");
  const postable = eligible.filter((f) => laneOf(f) === undefined);
  for (const f of silenced) f.suppressedBy = "silenced";
  for (const f of preExisting) f.suppressedBy = "pre-existing";

  const inline = postable.slice(0, MAX_INLINE_COMMENTS);
  const overCap = postable.slice(MAX_INLINE_COMMENTS);
  for (const f of overCap) f.suppressedBy = "cap";

  log(
    `verdict: ${survivors.length} survived → ${corroborated.length} corroborated → ${inline.length} inline` +
      (uncorroborated.length > 0 ? ` (${uncorroborated.length} lack corroboration, summary only)` : "") +
      (previouslyDismissed.length > 0
        ? ` (${previouslyDismissed.length} match findings a reviewer dismissed, suppressed)`
        : "") +
      (preExisting.length > 0 ? ` (${preExisting.length} on lines the change did not touch, listed as pre-existing)` : "") +
      (silenced.length > 0 ? ` (${silenced.length} on lines carrying a suppression marker, summary only)` : ""),
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
    belowBar: [...previouslyDismissed, ...uncorroborated, ...belowSeverity, ...overCap, ...silenced, ...preExisting],
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
