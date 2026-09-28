// evaluate: did the pipeline report the defects we know are there, and where did it lose
// the ones it did not?
//
// PROPOSAL §12 has asked for this since the first draft — a golden set of PRs with known
// defects, scored for precision and recall, so that "multi-model beats single-model" and
// "this threshold is better than that one" are measurements rather than arguments. Nothing
// implemented it. fixtures/seeded-pr.ts pins ANCHORING (does a quote land on line 25), which
// is a different question from whether the review reports the bug on line 25 at all, and
// scripts/calibrate.ts needs live PRs and humans to say anything.
//
// The evidence was already on disk. Every run writes what each stage did with every finding;
// all that was missing was ground truth to join it to, and the arithmetic below.
//
// What this answers that nothing else can: a defect the review missed is not one event, it
// is one of five, and the fix for each is in a different file. A defect no finder mentioned
// is a prompt or a model problem (prompts/finder.ts). One whose quote would not anchor is
// anchoring's (anchoring/locate.ts). One the skeptic killed is a verification problem
// (prompts/skeptic.ts, PRR_SKEPTIC_CONTEXT_LINES). One held back for want of a second
// finder is the corroboration gate (PRR_MIN_CONSENSUS_SOURCES). One cut by the cap is
// PRR_MAX_INLINE_COMMENTS. Reporting them as one number — "recall 60%" — hides which knob to
// turn.
//
// Read-only and offline, like calibrate.ts, and tolerant in the same way: a run it cannot
// read is counted and skipped, never fatal.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNS_DIR } from "../config";
import { normalizePath } from "../libs/fileindex";

// ─── The pure half (exported for the selftest) ──────────────────────────────

/**
 * How far a known defect got through the pipeline, furthest first.
 *
 * The ladder is built only from artifacts that carry a LINE. A finder's raw output does not:
 * the whole design is that models emit quotes and never line numbers, so "did any finder
 * mention this line" is a question finder-outputs.json structurally cannot answer. It does
 * not need to — a quote that could not be placed is exactly what `degraded` records, so
 * `anchor-failed` and `not-found` are already distinguishable without it.
 */
export const STAGES = [
  "inline",
  "cap",
  "severity",
  "no-corroboration",
  "dismissed",
  "refuted",
  "anchor-failed",
  "not-found",
] as const;
export type Stage = (typeof STAGES)[number];

/** Where each stage's fix lives, printed beside the count so a number implies an action. */
export const STAGE_FIX: Record<Stage, string> = {
  inline: "reported on the line",
  cap: "cut by PRR_MAX_INLINE_COMMENTS",
  severity: "below PRR_MIN_INLINE_SEVERITY",
  "no-corroboration": "one finder only — add a finder, or a skeptic to clear it",
  dismissed: "a human dismissed this finding before; the golden entry may be wrong",
  refuted: "the skeptic killed it — prompts/skeptic.ts, PRR_SKEPTIC_CONTEXT_LINES",
  "anchor-failed": "quoted, but the quote would not anchor — anchoring/locate.ts",
  "not-found": "no finder reported it — prompts/finder.ts, the model, or the diff budget",
};

export interface Region {
  file: string;
  /** 1-based, inclusive, as the anchors are. */
  lines: [number, number];
  note?: string;
}

export interface GoldenDefect extends Region {
  /** Optional: when set, a finding of another category still counts as finding the line. */
  category?: string;
}

export interface GoldenSet {
  defects: GoldenDefect[];
  /**
   * Regions a reviewer has confirmed clean. Without these, precision cannot be computed at
   * all: an inline comment that matches no golden defect may be a false positive or a real
   * bug the golden set does not know about, and nothing in the artifacts can tell them
   * apart. Declaring a region clean is what makes a comment there a measured mistake.
   */
  mustNotFlag?: Region[];
}

/** One finding as this evaluator needs it, flattened from findings.json or skeptic.json. */
export interface EvaluatedFinding {
  file: string;
  /** Absent on a degraded finding: not anchoring is what makes it degraded. */
  start?: number;
  end?: number;
  sources: string[];
  category?: string;
  /** From findings.json belowBar: which publish gate stopped it. */
  suppressedBy?: string;
  /** From findings.json degraded: why the quote would not resolve to a line. */
  anchorFailure?: string;
}

export interface RunArtifacts {
  inline: EvaluatedFinding[];
  belowBar: EvaluatedFinding[];
  degraded: EvaluatedFinding[];
  /** Findings the skeptic majority refuted; they appear in no findings.json at all. */
  refuted: EvaluatedFinding[];
}

export interface DefectOutcome {
  defect: GoldenDefect;
  stage: Stage;
  /** The suppression reason or anchor failure behind the stage, when there is one. */
  detail?: string;
  /** Finder models that produced the matching finding. Empty when nothing matched. */
  sources: string[];
}

export interface RunEvaluation {
  outcomes: DefectOutcome[];
  /** Inline comments matching a golden defect. */
  hits: number;
  /** Defects something reported, at any stage past not-found and anchor-failed. */
  found: number;
  inlineTotal: number;
  /** Inline comments inside a region the golden set declares clean. Measured mistakes. */
  falsePositives: EvaluatedFinding[];
  /** Inline comments matching neither a defect nor a clean region. Unknown, not wrong. */
  unattributed: EvaluatedFinding[];
}

const sameFile = (a: string, b: string) => normalizePath(a) === normalizePath(b);

function overlaps(f: EvaluatedFinding, r: Region): boolean {
  if (!sameFile(f.file, r.file)) return false;
  if (f.start === undefined) return false;
  return f.start <= r.lines[1] && (f.end ?? f.start) >= r.lines[0];
}

/** Rank within belowBar: closest to having been published first. */
const SUPPRESSION_RANK: Record<string, Stage> = {
  cap: "cap",
  severity: "severity",
  "no-corroboration": "no-corroboration",
  dismissed: "dismissed",
};

/**
 * Scores one run against one golden set.
 *
 * Furthest stage wins, and that is the whole definition: a defect two finders reported, one
 * of whose findings the skeptic killed while the other reached a comment, was FOUND — the
 * kill is a fact about one finding, not about the defect.
 */
export function evaluateRun(golden: GoldenSet, run: RunArtifacts): RunEvaluation {
  const outcomes: DefectOutcome[] = [];
  const matchedInline = new Set<EvaluatedFinding>();

  for (const defect of golden.defects) {
    const hit = run.inline.find((f) => overlaps(f, defect));
    if (hit) {
      matchedInline.add(hit);
      outcomes.push({ defect, stage: "inline", sources: hit.sources });
      continue;
    }
    // Anchored and past the skeptic, then stopped by a publish gate. Ranked so that a
    // defect reported twice is filed under the gate it got closest to passing.
    const below = run.belowBar
      .filter((f) => overlaps(f, defect))
      .sort(
        (a, b) =>
          STAGES.indexOf(SUPPRESSION_RANK[a.suppressedBy ?? ""] ?? "not-found") -
          STAGES.indexOf(SUPPRESSION_RANK[b.suppressedBy ?? ""] ?? "not-found"),
      )[0];
    if (below) {
      outcomes.push({
        defect,
        stage: SUPPRESSION_RANK[below.suppressedBy ?? ""] ?? "no-corroboration",
        ...(below.suppressedBy ? { detail: below.suppressedBy } : {}),
        sources: below.sources,
      });
      continue;
    }
    const killed = run.refuted.find((f) => overlaps(f, defect));
    if (killed) {
      outcomes.push({ defect, stage: "refuted", sources: killed.sources });
      continue;
    }
    // Degraded findings carry no line — that is what degraded means — so this can only match
    // on the file. Deliberately loose: the claim it supports is "something on this file was
    // quoted and the quote would not resolve", which is true at file granularity and is the
    // one that points at anchoring/locate.ts.
    const unanchored = run.degraded.find((f) => sameFile(f.file, defect.file));
    if (unanchored) {
      outcomes.push({
        defect,
        stage: "anchor-failed",
        ...(unanchored.anchorFailure ? { detail: unanchored.anchorFailure } : {}),
        sources: unanchored.sources,
      });
      continue;
    }
    outcomes.push({ defect, stage: "not-found", sources: [] });
  }

  const clean = golden.mustNotFlag ?? [];
  const falsePositives: EvaluatedFinding[] = [];
  const unattributed: EvaluatedFinding[] = [];
  for (const f of run.inline) {
    if (matchedInline.has(f)) continue;
    if (golden.defects.some((d) => overlaps(f, d))) continue;
    if (clean.some((r) => overlaps(f, r))) falsePositives.push(f);
    else unattributed.push(f);
  }

  const reached = new Set<Stage>(["inline", "cap", "severity", "no-corroboration", "dismissed", "refuted"]);
  return {
    outcomes,
    hits: outcomes.filter((o) => o.stage === "inline").length,
    found: outcomes.filter((o) => reached.has(o.stage)).length,
    inlineTotal: run.inline.length,
    falsePositives,
    unattributed,
  };
}

export interface Totals {
  prs: number;
  defects: number;
  byStage: Record<Stage, number>;
  inlineTotal: number;
  falsePositives: number;
  unattributed: number;
  /** Finder model → defects it contributed to finding, at any stage. */
  byFinder: Map<string, number>;
}

/** Sums per-PR evaluations. Separate from evaluateRun so both halves stay testable. */
export function totalsOf(evaluations: RunEvaluation[]): Totals {
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  const byFinder = new Map<string, number>();
  let defects = 0;
  let inlineTotal = 0;
  let falsePositives = 0;
  let unattributed = 0;
  for (const e of evaluations) {
    defects += e.outcomes.length;
    inlineTotal += e.inlineTotal;
    falsePositives += e.falsePositives.length;
    unattributed += e.unattributed.length;
    for (const o of e.outcomes) {
      byStage[o.stage]++;
      // Credit every finder that contributed, the same way calibrate blames every one of
      // them: two models finding one defect is the ensemble doing its job, and counting it
      // for one would make a fleet look worse than its best member.
      for (const s of new Set(o.sources)) byFinder.set(s, (byFinder.get(s) ?? 0) + 1);
    }
  }
  return { prs: evaluations.length, defects, byStage, inlineTotal, falsePositives, unattributed, byFinder };
}

// ─── Reading runs/ ──────────────────────────────────────────────────────────

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function toFinding(v: unknown): EvaluatedFinding | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const file = str(o["file"]);
  if (!file) return undefined;
  const anchor = (o["anchor"] ?? {}) as Record<string, unknown>;
  const start = num(anchor["startLine"]) ?? num(o["line"]);
  const end = num(anchor["endLine"]) ?? start;
  return {
    file,
    ...(start === undefined ? {} : { start, end }),
    sources: strs(o["sources"]),
    ...(typeof o["category"] === "string" ? { category: o["category"] } : {}),
    ...(typeof o["suppressedBy"] === "string" ? { suppressedBy: o["suppressedBy"] } : {}),
    ...(typeof o["anchorFailure"] === "string" ? { anchorFailure: o["anchorFailure"] } : {}),
  };
}

const list = (v: unknown): EvaluatedFinding[] =>
  Array.isArray(v) ? v.map(toFinding).filter((f): f is EvaluatedFinding => f !== undefined) : [];

/** findings.json + skeptic.json from one iteration directory. */
export function readRun(dir: string): RunArtifacts | undefined {
  const found = readJson(path.join(dir, "findings.json"));
  if (typeof found !== "object" || found === null) return undefined;
  const f = found as Record<string, unknown>;
  const skeptic = readJson(path.join(dir, "skeptic.json"));
  const refuted = Array.isArray(skeptic)
    ? list(skeptic.filter((r) => typeof r === "object" && r !== null && (r as Record<string, unknown>)["killed"] === true))
    : [];
  return { inline: list(f["inline"]), belowBar: list(f["belowBar"]), degraded: list(f["degraded"]), refuted };
}

export interface ScanResult {
  evaluations: RunEvaluation[];
  /** PR directories that carry a golden.json, for the report's denominator. */
  golden: string[];
  /** golden.json files that could not be read, or whose PR has no readable run. */
  unusable: string[];
}

function goldenOf(v: unknown): GoldenSet | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const region = (x: unknown): Region | undefined => {
    if (typeof x !== "object" || x === null) return undefined;
    const r = x as Record<string, unknown>;
    const file = str(r["file"]);
    const lines = Array.isArray(r["lines"]) ? r["lines"] : [];
    const a = num(lines[0]);
    const b = num(lines[1]) ?? a;
    if (!file || a === undefined || b === undefined) return undefined;
    return { file, lines: [a, b], ...(typeof r["note"] === "string" ? { note: r["note"] } : {}) };
  };
  const defects = (Array.isArray(o["defects"]) ? o["defects"] : [])
    .map((d) => {
      const r = region(d);
      if (!r) return undefined;
      const cat = typeof (d as Record<string, unknown>)["category"] === "string"
        ? { category: (d as Record<string, unknown>)["category"] as string }
        : {};
      return { ...r, ...cat };
    })
    .filter((d): d is GoldenDefect => d !== undefined);
  if (defects.length === 0) return undefined;
  const clean = (Array.isArray(o["mustNotFlag"]) ? o["mustNotFlag"] : [])
    .map(region)
    .filter((r): r is Region => r !== undefined);
  return { defects, ...(clean.length > 0 ? { mustNotFlag: clean } : {}) };
}

function findGolden(dir: string, depth: number, out: string[]): string[] {
  if (depth < 0) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findGolden(p, depth - 1, out);
    else if (e.isFile() && e.name === "golden.json") out.push(p);
  }
  return out;
}

/** The most recent iteration directory under a PR: the run whose answer we are scoring. */
export function newestIteration(prDir: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(prDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const iters = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("iter-"))
    .map((e) => ({ name: e.name, at: fs.statSync(path.join(prDir, e.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return iters[0] ? path.join(prDir, iters[0].name) : undefined;
}

export function scanGolden(root: string): ScanResult {
  const evaluations: RunEvaluation[] = [];
  const golden: string[] = [];
  const unusable: string[] = [];
  // runs/<org>/<project>/<repo>/pr-N/golden.json is 5 deep.
  for (const file of findGolden(root, 5, [])) {
    const set = goldenOf(readJson(file));
    if (!set) {
      unusable.push(file);
      continue;
    }
    golden.push(file);
    const prDir = path.dirname(file);
    const iter = newestIteration(prDir);
    const run = iter ? readRun(iter) : undefined;
    if (!run) {
      unusable.push(prDir);
      continue;
    }
    evaluations.push(evaluateRun(set, run));
  }
  return { evaluations, golden, unusable };
}

// ─── Output ─────────────────────────────────────────────────────────────────

const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "—");

/** Numbers read right-aligned, prose reads left-aligned; `left` names the prose columns. */
function table(header: string[], rows: string[][], left: number[] = [0]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    "  " +
    cells
      .map((c, i) => (left.includes(i) ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

export function renderReport(scan: ScanResult, t: Totals, root: string): string {
  const out: string[] = [
    `prloop golden-set evaluation — ${root}`,
    "",
    `${t.prs} pull request${t.prs === 1 ? "" : "s"} scored against ${t.defects} known defect${t.defects === 1 ? "" : "s"}` +
      (scan.unusable.length > 0 ? `, ${scan.unusable.length} skipped as unreadable` : ""),
    `${t.byStage.inline} reported on the line — recall ${pct(t.byStage.inline, t.defects)}`,
    // Three separate facts, because they point at three different files. "Recall 25%" on its
    // own cannot tell a prompt problem from an anchoring one.
    `${t.defects - t.byStage["not-found"] - t.byStage["anchor-failed"]} were located and judged, ` +
      `${t.byStage["anchor-failed"]} quoted but not placeable, ` +
      `${t.byStage["not-found"]} nothing mentioned at all`,
    "",
    "Where each defect stopped. The stage names the file to open, not just the loss:",
    table(
      ["stage", "defects", "share", "what it means"],
      STAGES.map((s) => [s, String(t.byStage[s]), pct(t.byStage[s], t.defects), STAGE_FIX[s]]),
      [0, 3],
    ),
    "",
  ];

  // Precision is not hits/inline: a comment matching no golden defect may be a real bug the
  // golden set does not list. Only a comment inside a region a reviewer declared clean is a
  // measured mistake, which is what mustNotFlag is for — and saying so is the difference
  // between a number and a guess.
  out.push(
    `${t.inlineTotal} inline comment${t.inlineTotal === 1 ? "" : "s"} posted, ` +
      `${(t.inlineTotal / Math.max(1, t.prs)).toFixed(1)} per PR`,
    `${t.falsePositives} landed in a region the golden set calls clean — measured false positives` +
      (t.inlineTotal > 0 ? ` (${pct(t.falsePositives, t.inlineTotal)} of comments)` : ""),
    `${t.unattributed} matched neither a known defect nor a clean region: unknown, not wrong. ` +
      `Precision is only as complete as mustNotFlag.`,
    "",
  );

  const finders = [...t.byFinder.entries()].sort((a, b) => b[1] - a[1]);
  out.push(
    finders.length === 0
      ? "Per-finder recall\n  (no finding was attributed to a model)"
      : `Defects each finder contributed to, at any stage. Compare a one-model run against a\n` +
          `two-model run over the same golden set: this is PROPOSAL §12's multi-model question.\n` +
          table(
            ["finder", "defects", "of known"],
            finders.map(([m, n]) => [m, String(n), pct(n, t.defects)]),
          ),
  );
  return out.join("\n");
}

function main(): void {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const root = path.resolve(arg ?? RUNS_DIR);
  if (!fs.existsSync(root)) {
    console.log(`No runs directory at ${root} — nothing to evaluate.`);
    return;
  }
  const scan = scanGolden(root);
  if (scan.golden.length === 0) {
    console.log(`No golden.json under ${root}.`);
    console.log("Write one next to a PR's iteration directories (runs/<org>/<project>/<repo>/pr-<id>/golden.json)");
    console.log('listing the defects you know are there: {"defects":[{"file":"src/a.ts","lines":[25,25],"note":"..."}]}');
    console.log("Add mustNotFlag regions a reviewer has confirmed clean, or precision cannot be measured.");
    return;
  }
  console.log(renderReport(scan, totalsOf(scan.evaluations), root));
}

// Imported by the selftest for the pure halves above, so the walk and the printing only run
// when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
