// calibrate: is the review getting better?
//
// Every knob in this pipeline — confidence, severity, corroboration, the skeptic roster —
// is set from a judgement about how often the models are wrong, and nothing in the tool
// ever measured that. The evidence was already on disk and unread: runs/ records what each
// run found and published, and dismissals.jsonl records what humans then rejected. This
// joins the two.
//
// Read-only, offline, and deliberately tolerant: it is pointed at directories written by
// older versions of prloop, half-written by a crashed run, or pruned by retention. A file
// it cannot read is counted and skipped — a diagnostic that dies on one bad artifact is
// useless exactly when things are going wrong.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNS_DIR } from "../config";
import { loadDismissals } from "../libs/learnings";

// ─── The pure half (exported for the selftest) ──────────────────────────────

/** One finding as it appears in a run's findings.json. */
export interface CalibrationFinding {
  fingerprint: string;
  category: string;
  confidence: number;
  // The finder models that produced it (AnchoredFinding.sources); a static tool counts as
  // a source too, which is why a "finder" here can be a tool name.
  sources: string[];
  // It reached an inline comment — the only findings a human ever got the chance to dismiss.
  published: boolean;
}

/** One verifier answer as it appears in a run's skeptic.json. */
export interface CalibrationVerdict {
  model: string;
  verdict: string;
  error: boolean;
}

export interface CalibrationInput {
  findings: CalibrationFinding[];
  verdicts: CalibrationVerdict[];
  // Fingerprints a human closed as wontFix/byDesign, from the repo's dismissals.jsonl.
  dismissed: Set<string>;
}

export interface Bucket {
  key: string;
  findings: number;
  published: number;
  dismissed: number;
  // dismissed / published, NOT dismissed / findings: only a published finding is ever put
  // in front of a human, so the wider denominator would report a bucket as accurate purely
  // because the corroboration gate kept it out of the PR.
  rate: number;
}

export interface SkepticStats {
  model: string;
  // Verdicts it actually returned; an errored call is counted separately and never as an
  // answer (the same rule the gate applies — a dead verifier neither kills nor clears).
  answered: number;
  refuted: number;
  unchecked: number;
  errors: number;
  killRate: number;
  uncheckedRate: number;
}

export interface CalibrationReport {
  findings: number;
  published: number;
  dismissed: number;
  // (iii): findings that were published inline and a human then dismissed. The headline
  // false-positive number.
  publishedDismissed: number;
  // Dismissals whose finding is in no run we can still read — usually retention pruned the
  // run. Reported so the totals above are never mistaken for the whole history.
  orphanDismissals: number;
  byConfidence: Bucket[];
  byCategory: Bucket[];
  byFinder: Bucket[];
  skeptics: SkepticStats[];
}

// Bucket floors, highest first. Coarse on purpose: the question is whether a finder's
// confidence carries any signal at all, and finer buckets on a few hundred findings only
// produce noise with decimal points.
const CONFIDENCE_FLOORS: Array<[number, string]> = [
  [0.9, "0.9-1.0"],
  [0.7, "0.7-0.9"],
  [0.5, "0.5-0.7"],
  [0, "<0.5"],
];

const confidenceBucket = (c: number) =>
  CONFIDENCE_FLOORS.find(([floor]) => c >= floor)?.[1] ?? CONFIDENCE_FLOORS[CONFIDENCE_FLOORS.length - 1]![1];

function tally(): { findings: number; published: number; dismissed: number } {
  return { findings: 0, published: 0, dismissed: 0 };
}

function toBuckets(m: Map<string, ReturnType<typeof tally>>, order?: string[]): Bucket[] {
  const rows = [...m.entries()].map(([key, t]) => ({
    key,
    ...t,
    rate: t.published > 0 ? t.dismissed / t.published : 0,
  }));
  if (order) return rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  // Biggest population first: a 100% dismissal rate over one finding is not the top line.
  return rows.sort((a, b) => b.findings - a.findings || a.key.localeCompare(b.key));
}

/**
 * Joins findings to dismissals. Exported for the selftest, which feeds it records directly
 * — the aggregation is the part with the arithmetic in it, and it must be testable without
 * a runs/ tree on disk.
 *
 * Findings are counted ONCE per fingerprint, not once per run. Every re-run of a PR
 * re-reports the same finding, so counting occurrences would weight a PR reviewed ten times
 * ten times as heavily as one reviewed once — and re-review frequency has nothing to do
 * with whether the finding was right.
 */
export function calibrate(input: CalibrationInput): CalibrationReport {
  const byFingerprint = new Map<string, CalibrationFinding>();
  for (const f of input.findings) {
    if (!f.fingerprint) continue;
    const prior = byFingerprint.get(f.fingerprint);
    // Published in ANY run counts as published: a finding held back by the cap on Tuesday
    // and commented on Wednesday was put in front of a human.
    if (prior) prior.published ||= f.published;
    else byFingerprint.set(f.fingerprint, { ...f });
  }

  const conf = new Map<string, ReturnType<typeof tally>>();
  const cat = new Map<string, ReturnType<typeof tally>>();
  const finder = new Map<string, ReturnType<typeof tally>>();
  const add = (m: Map<string, ReturnType<typeof tally>>, key: string, f: CalibrationFinding, dismissed: boolean) => {
    const t = m.get(key) ?? tally();
    t.findings++;
    if (f.published) t.published++;
    if (dismissed) t.dismissed++;
    m.set(key, t);
  };

  let published = 0;
  let dismissedCount = 0;
  let publishedDismissed = 0;
  for (const f of byFingerprint.values()) {
    const dismissed = input.dismissed.has(f.fingerprint);
    if (f.published) published++;
    if (dismissed) dismissedCount++;
    if (dismissed && f.published) publishedDismissed++;
    add(conf, confidenceBucket(f.confidence), f, dismissed);
    add(cat, f.category || "(none)", f, dismissed);
    // A finding found by two models is credit — and blame — for both.
    for (const s of f.sources.length > 0 ? f.sources : ["(unknown)"]) add(finder, s, f, dismissed);
  }

  const skeptics = new Map<string, SkepticStats>();
  for (const v of input.verdicts) {
    const model = v.model || "(unknown)";
    const s =
      skeptics.get(model) ??
      { model, answered: 0, refuted: 0, unchecked: 0, errors: 0, killRate: 0, uncheckedRate: 0 };
    if (v.error) s.errors++;
    else {
      s.answered++;
      if (v.verdict === "refuted") s.refuted++;
      else if (v.verdict === "insufficient-context") s.unchecked++;
    }
    skeptics.set(model, s);
  }
  for (const s of skeptics.values()) {
    s.killRate = s.answered > 0 ? s.refuted / s.answered : 0;
    s.uncheckedRate = s.answered > 0 ? s.unchecked / s.answered : 0;
  }

  let orphanDismissals = 0;
  for (const fp of input.dismissed) if (!byFingerprint.has(fp)) orphanDismissals++;

  return {
    findings: byFingerprint.size,
    published,
    dismissed: dismissedCount,
    publishedDismissed,
    orphanDismissals,
    byConfidence: toBuckets(conf, CONFIDENCE_FLOORS.map(([, k]) => k)),
    byCategory: toBuckets(cat),
    byFinder: toBuckets(finder),
    skeptics: [...skeptics.values()].sort((a, b) => b.answered - a.answered || a.model.localeCompare(b.model)),
  };
}

// ─── Reading runs/ ──────────────────────────────────────────────────────────

export interface ScanResult extends CalibrationInput {
  runs: number;
  // Files that exist but could not be used: unreadable, unparseable, or written by a prloop
  // whose shape we no longer recognise. Counted, never fatal.
  unusable: string[];
  repos: string[];
}

function findFiles(dir: string, name: string, depth: number, out: string[]): string[] {
  if (depth < 0) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, name, depth - 1, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function readFindings(file: string, into: CalibrationFinding[]): boolean {
  const v = readJson(file);
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const lists: Array<[unknown, boolean]> = [
    [o["inline"], true],
    [o["belowBar"], false],
    [o["degraded"], false],
  ];
  // A findings.json from a prloop that named its lists differently has nothing we can read;
  // say so rather than reporting it as a run with zero findings.
  if (!lists.some(([l]) => Array.isArray(l))) return false;
  for (const [list, published] of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const f = item as Record<string, unknown>;
      const fp = str(f["fingerprint"]);
      if (!fp) continue;
      into.push({
        fingerprint: fp,
        category: str(f["category"]),
        confidence: num(f["confidence"], 0),
        sources: Array.isArray(f["sources"]) ? f["sources"].filter((s): s is string => typeof s === "string") : [],
        published,
      });
    }
  }
  return true;
}

function readVerdicts(file: string, into: CalibrationVerdict[]): boolean {
  const v = readJson(file);
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const verdicts = (item as Record<string, unknown>)["verdicts"];
    if (!Array.isArray(verdicts)) continue;
    for (const raw of verdicts) {
      if (typeof raw !== "object" || raw === null) continue;
      const o = raw as Record<string, unknown>;
      // Runs from before the three-way verdict saved a boolean. Map it rather than dropping
      // a whole generation of artifacts on the floor.
      const legacy = typeof o["refuted"] === "boolean" ? (o["refuted"] ? "refuted" : "holds") : "";
      into.push({
        model: str(o["model"]),
        verdict: str(o["verdict"]) || legacy,
        error: typeof o["error"] === "string" && o["error"] !== "",
      });
    }
  }
  return true;
}

/** Walks a runs/ tree and reads every artifact it recognises. */
export function scanRuns(root: string): ScanResult {
  const findings: CalibrationFinding[] = [];
  const verdicts: CalibrationVerdict[] = [];
  const unusable: string[] = [];
  const dismissed = new Set<string>();
  const repos: string[] = [];

  // runs/<org>/<project>/<repo>/pr-N/iter-M/findings.json is 6 deep; the walk is bounded so
  // a stray symlink or a deep unrelated tree cannot turn a diagnostic into a disk scan.
  const findingFiles = findFiles(root, "findings.json", 6, []);
  let runs = 0;
  for (const f of findingFiles) {
    if (readFindings(f, findings)) runs++;
    else unusable.push(f);
  }
  for (const f of findFiles(root, "skeptic.json", 6, [])) {
    if (!readVerdicts(f, verdicts)) unusable.push(f);
  }

  // The learnings store sits at the repo root, above the PR directories.
  for (const store of findFiles(root, "dismissals.jsonl", 4, [])) {
    const rel = path.relative(root, path.dirname(store)).split(path.sep);
    repos.push(rel.join("/"));
    // Read through the store's own loader: it already tolerates corrupt lines and dedupes,
    // and a second parser here would drift from the one that writes it.
    const [org = "", project = "", repoId = ""] = rel.slice(-3);
    for (const d of loadDismissals({ baseUrl: "", org, project, repoId, prId: 0 }, root)) {
      dismissed.add(d.fingerprint);
    }
  }

  return { findings, verdicts, dismissed, runs, unusable, repos };
}

// ─── Output ─────────────────────────────────────────────────────────────────

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

function bucketTable(title: string, buckets: Bucket[]): string {
  if (buckets.length === 0) return `${title}\n  (nothing to report)`;
  return `${title}\n${table(
    ["", "findings", "published", "dismissed", "rate"],
    buckets.map((b) => [b.key, String(b.findings), String(b.published), String(b.dismissed), pct(b.rate)]),
  )}`;
}

export function renderReport(scan: ScanResult, report: CalibrationReport, root: string): string {
  const out: string[] = [
    `prloop calibration — ${root}`,
    "",
    `${plural(scan.runs, "run")} read across ${plural(scan.repos.length, "repository", "repositories")}` +
      (scan.unusable.length > 0 ? `, ${plural(scan.unusable.length, "artifact")} unreadable and skipped` : ""),
    `${plural(report.findings, "distinct finding")}, ${report.published} of them commented inline`,
    `${plural(report.publishedDismissed, "commented finding")} later dismissed by a human` +
      (report.published > 0 ? ` (${pct(report.publishedDismissed / report.published)} of what was published)` : ""),
  ];
  if (report.orphanDismissals > 0) {
    out.push(
      `${plural(report.orphanDismissals, "dismissal")} belong to findings no surviving run records ` +
        `(retention pruned the run) — they count in no rate below`,
    );
  }
  out.push(
    "",
    "Only published findings can be dismissed, so every rate below is dismissed/published.",
    "",
    bucketTable("Dismissal rate by finder confidence", report.byConfidence),
    "",
    bucketTable("Dismissal rate by category", report.byCategory),
    "",
    bucketTable("Dismissal rate by finder model", report.byFinder),
    "",
  );
  out.push(
    report.skeptics.length === 0
      ? "Skeptic verdicts\n  (no verification recorded)"
      : `Skeptic verdicts (per answer, not per finding)\n${table(
          ["model", "answered", "refuted", "kill rate", "unchecked", "unchecked rate", "errors"],
          report.skeptics.map((s) => [
            s.model,
            String(s.answered),
            String(s.refuted),
            pct(s.killRate),
            String(s.unchecked),
            pct(s.uncheckedRate),
            String(s.errors),
          ]),
        )}`,
  );
  return out.join("\n");
}

function main(): void {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const root = path.resolve(arg ?? RUNS_DIR);
  if (!fs.existsSync(root)) {
    console.log(`No runs directory at ${root} — nothing to calibrate against yet.`);
    console.log("Run a review first; every run writes its findings and verdicts there.");
    return;
  }
  const scan = scanRuns(root);
  if (scan.runs === 0) {
    console.log(`No readable run artifacts under ${root}.`);
    if (scan.unusable.length > 0) console.log(`${scan.unusable.length} files were unreadable or of an unknown shape.`);
    return;
  }
  console.log(renderReport(scan, calibrate(scan), root));
}

// Imported by the selftest for the pure aggregation above, so the walk and the printing
// only run when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
