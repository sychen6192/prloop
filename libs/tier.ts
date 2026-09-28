// How much review a change gets, from its size and what it touches (PRR_RISK_TIERS).
//
// Cloudflare's reviewer picks a trivial, lite or full review from the lines and files a change
// touches and how sensitive its paths are. The reason is the fixed part of every call: each
// finder and each verifier is sent the same system prompt, rules and repository conventions,
// and on a three-line version bump that is nearly all of what three finders and a verifier
// panel cost. A trivial change also gets a stricter inline bar — on a change that small, a
// medium-severity comment is more often noise than the reason the change exists.
//
// Pure: the sizes in, the decision out, so the thresholds are testable and the summary can
// say which tier a run took and why.
import {
  FINDER_MODELS,
  MIN_INLINE_SEVERITY,
  REQUIRE_CORROBORATION,
  RISK_TIERS,
  SENSITIVE_PATHS,
  SEVERITIES,
  SKEPTIC_MODELS,
  SKEPTIC_ROUNDS,
  severityRank,
  type Severity,
} from "../config";
import { anyPathMatches } from "./rules";
import type { FileDiff } from "./types";

export type TierName = "trivial" | "lite" | "full";

export interface RiskTier {
  name: TierName;
  /** What decided it, in words: the size of the change, or the sensitive path it touches. */
  reason: string;
  finders: string[];
  skepticRounds: number;
  minSeverity: Severity;
}

/** The largest change each lighter tier takes: changed lines (added + removed) and files. */
export const TIER_LIMITS = {
  trivial: { lines: 20, files: 3 },
  lite: { lines: 200, files: 15 },
} as const;

export interface TierSettings {
  enabled: boolean;
  sensitive: readonly string[];
  finders: readonly string[];
  skepticModels: readonly string[];
  skepticRounds: number;
  minSeverity: Severity;
  /** PRR_REQUIRE_CORROBORATION: whether a lone finding needs a second finder or a skeptic. */
  requireCorroboration: boolean;
}

export function riskTier(files: readonly FileDiff[], s: TierSettings): RiskTier {
  const full: RiskTier = {
    name: "full",
    reason: "",
    finders: [...s.finders],
    skepticRounds: s.skepticRounds,
    minSeverity: s.minSeverity,
  };
  if (!s.enabled) return { ...full, reason: "PRR_RISK_TIERS is off" };

  const lines = files.reduce((n, f) => n + f.changedRightLines.size + f.changedLeftLines.size, 0);
  const size = `${lines} changed line${lines === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}`;
  const paths = files.map((f) => f.path);
  const hit = s.sensitive.length > 0 ? paths.find((p) => anyPathMatches(s.sensitive, [p])) : undefined;
  if (hit !== undefined) return { ...full, reason: `${size}, and ${hit} matches PRR_SENSITIVE_PATHS` };

  const fits = (t: { lines: number; files: number }) => lines <= t.lines && files.length <= t.files;
  // With no verifier, a finding reaches a comment only when a second finder made it too; one
  // finder would then mean no comment can be posted at all, which is not a lighter review.
  const least = s.requireCorroboration && s.skepticModels.length === 0 ? 2 : 1;
  if (fits(TIER_LIMITS.trivial)) {
    const rank = severityRank(s.minSeverity);
    return {
      name: "trivial",
      reason: size,
      finders: s.finders.slice(0, least),
      skepticRounds: Math.min(s.skepticRounds, 1),
      // One step stricter, never past high: a trivial change still hears about a high.
      minSeverity: SEVERITIES[Math.min(rank, Math.max(severityRank("high"), rank - 1))]!,
    };
  }
  if (fits(TIER_LIMITS.lite)) {
    return { name: "lite", reason: size, finders: s.finders.slice(0, Math.max(2, least)), skepticRounds: s.skepticRounds, minSeverity: s.minSeverity };
  }
  return { ...full, reason: size };
}

/**
 * The tier for this run under the process's settings. On a `--since auto` run the files are
 * the push's, so a small follow-up push gets the lighter review: re-reviews converge instead of
 * re-running the whole panel over a two-line fix.
 */
export function runTier(files: readonly FileDiff[]): RiskTier {
  return riskTier(files, {
    enabled: RISK_TIERS,
    sensitive: SENSITIVE_PATHS,
    finders: FINDER_MODELS,
    skepticModels: SKEPTIC_MODELS,
    skepticRounds: SKEPTIC_ROUNDS,
    minSeverity: MIN_INLINE_SEVERITY,
    requireCorroboration: REQUIRE_CORROBORATION,
  });
}

/** One line for the summary and the log: the tier, why, and what it ran. */
export function describeTier(t: RiskTier): string {
  return (
    `${t.name} (${t.reason}): ${t.finders.length} finder${t.finders.length === 1 ? "" : "s"}, ` +
    `${t.skepticRounds} verifier round${t.skepticRounds === 1 ? "" : "s"}, inline comments at ${t.minSeverity} and above`
  );
}
