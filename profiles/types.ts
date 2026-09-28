// Static-analysis profiles: which tools run for which language, and what to do with what
// they say.
//
// The tiering is the important part. Deterministic tools and LLMs are good at different
// things, and treating every tool finding the same way is how you get either noise or
// missed bugs:
//
//   fact     — the tool is authoritative and near-zero false positive (tsc, Error Prone,
//              mypy). Post it, don't ask a model to re-derive it.
//   triage   — the tool has real recall but a high false-positive rate (bandit, SpotBugs,
//              PMD). An LLM judges exploitability in context before anything is posted.
//   suppress — style and convention noise (checkstyle, most eslint stylistic rules). Never
//              becomes a comment; summarised as a count so it isn't silently dropped.
import type { Severity } from "../libs/taxonomy";

export type ToolTier = "fact" | "triage" | "suppress";

export type OutputFormat =
  | "sarif"
  | "ruff-json"
  | "eslint-json"
  | "checkstyle-xml"
  | "spotbugs-xml"
  | "mypy-json"
  | "tsc-text";

export interface ToolSpec {
  name: string;
  bin: string;
  /** Args for the tool. `files` are workdir-relative paths of the changed files. */
  args: (files: string[]) => string[];
  format: OutputFormat;
  tier: ToolTier;
  /** Only run when this path exists under the workdir (e.g. a compiled classes dir). */
  requires?: string;
  /**
   * Skip a resolved project when its `requires` file matches this. A Maven aggregator pom
   * declares `<packaging>pom</packaging>` and owns no sources: maven-pmd-plugin's
   * canGenerateReportInternal returns false for it, writes nothing, and exits 0 — which is
   * indistinguishable from a crash unless we know not to expect a report.
   */
  skipProjectWhen?: RegExp;
  /**
   * Rule ids that mean the tool's own environment is broken rather than the code. Seeing any
   * of them discards the entire run — a compiler that cannot resolve imports is not
   * reporting on this PR, and its other findings are artefacts of the same breakage.
   */
  environmentRules?: string[];
  /**
   * Backstop for the same decision, matched against the message. An id list cannot be
   * complete: TypeScript emits at least two codes for "cannot find module" and picks
   * between them by config, so a list assembled from one repo's output silently misses the
   * other. Only safe because the tool is invoked with a pinned locale.
   */
  environmentMessages?: RegExp;
  /** Tools that signal findings via a non-zero exit code shouldn't be treated as failures. */
  allowNonZeroExit?: boolean;
  /** Some tools write findings to stderr. */
  readStderr?: boolean;
  /**
   * Report path relative to the tool's working directory, for tools that write to disk
   * instead of stdout. Maven plugins all do: `pmd:pmd` writes target/pmd.xml and prints
   * only build chatter, so reading stdout yields nothing to parse.
   *
   * Deleted before the run — a report left over from a previous build would otherwise be
   * parsed as this run's output, which is the stale-analysis failure the workdir content
   * check exists to prevent.
   */
  outputFile?: string;
}

export interface Profile {
  language: string;
  /** File extensions this profile claims, drawn from libs/lang.ts. */
  extensions: readonly string[];
  tools: ToolSpec[];
  /** Rule ids that are always dropped, whatever tier the tool sits in. */
  ignoreRules?: string[];
}

/** One normalized finding from any tool, before diff filtering. */
export interface ToolFinding {
  tool: string;
  tier: ToolTier;
  ruleId: string;
  message: string;
  /** Workdir-relative path. */
  file: string;
  line: number;
  endLine?: number;
  severity: Severity;
  /** The tool's own severity string, kept for the report. */
  rawSeverity?: string;
  /**
   * The tool's own classification of the rule, where it has one: PMD's ruleset
   * ("Security"), SpotBugs' bug category ("MT_CORRECTNESS"). The category mapping reads it
   * before any guess from the rule id or the message.
   */
  group?: string;
  helpUri?: string;
}
