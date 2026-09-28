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
import { loadOutcomes } from "../libs/outcomes";
import { stampLabel, type RunStamp } from "../libs/stamp";

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
  // What produced the run it came from (libs/stamp.ts stampLabel); absent on older runs.
  stamp?: string;
  severity?: string;
  // `tool:ruleId` for a static tool's finding; absent on a model's.
  rule?: string;
  // `org/project/repo`, from where the run sits under runs/: what a proposal is scoped to.
  repo?: string;
}

/** One verifier answer as it appears in a run's skeptic.json. */
export interface CalibrationVerdict {
  model: string;
  verdict: string;
  error: boolean;
  /** The answer to a second reading with looked-up code (PRR_SKEPTIC_LOOKUP). */
  secondLook?: boolean;
}

/**
 * One finding as the SKEPTIC saw it, from a run's skeptic.json.
 *
 * Separate from CalibrationFinding because the two files hold different populations, and
 * that difference is the whole reason this type exists: applyVerdicts drops a killed
 * finding before finalize runs, so findings.json never contains one. A refuted finding is
 * recorded here and nowhere else.
 *
 * Every field but `killed` is optional: runs written before the row carried a finding's
 * identity are still worth their verdict counts, and dropping a generation of artifacts to
 * gain a column would be the wrong trade for a diagnostic.
 */
export interface CalibrationOutcome {
  fingerprint?: string;
  category?: string;
  confidence?: number;
  sources?: string[];
  /** The skeptic majority refuted it, so it never reached finalize. */
  killed: boolean;
}

export interface CalibrationInput {
  findings: CalibrationFinding[];
  verdicts: CalibrationVerdict[];
  // Per-finding skeptic results. Optional so an older caller still type-checks; absent means
  // "no verification recorded", not "nothing was killed".
  outcomes?: CalibrationOutcome[];
  // Fingerprints a human closed as wontFix/byDesign, from the repo's dismissals.jsonl.
  dismissed: Set<string>;
  // What became of each published finding, from the repo's outcomes.jsonl, split by how
  // prloop knows. `fixed` is a human's statement; `autoClosed` is prloop's own inference
  // that the code it flagged changed under the open comment (BitsAI-CR's "outdated" signal);
  // `ignored` is a comment still open when the PR merged, `closed` one a human closed without
  // a verdict, and `liked` one somebody liked. The implementation rate counts only `fixed`;
  // the addressed rate adds `autoClosed`, and both are printed.
  actedOn?: {
    fixed: Set<string>;
    autoClosed: Set<string>;
    ignored?: Set<string>;
    closed?: Set<string>;
    liked?: Set<string>;
  };
  /**
   * What reviewers actually said when they dismissed something, one entry per dismissal that
   * carried a reply, from the same stores as `dismissed`. Kept apart from the fingerprint
   * set because it answers a different question: the set says how often the tool is wrong,
   * these say in what way.
   */
  dismissalReasons?: string[];
  /** Dismissals in those stores where the reviewer said nothing at all. */
  reasonlessDismissals?: number;
}

/** One thing reviewers keep saying when they reject a finding, and how often. */
export interface DismissalReason {
  reason: string;
  count: number;
}

export interface Bucket {
  key: string;
  findings: number;
  published: number;
  dismissed: number;
  // Findings in this bucket a human marked fixed after prloop commented on them.
  actedOn: number;
  // Findings in this bucket the skeptic majority refuted. Read against `findings` in the
  // same row: that is the share of this finder's (or this category's) output the verifier
  // threw away, which is the number that says whether a finder is pulling its weight and
  // the one nothing in the tool could answer before.
  killed: number;
  // The code changed under the open comment (auto-closed), still open at merge, and liked.
  codeChanged: number;
  ignored: number;
  liked: number;
  // (fixed + codeChanged) / published: what the comments led to, rather than only what was
  // rejected. The number every published industrial reviewer steers by.
  addressedRate: number;
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
  // Answers that were "insufficient-context" at first and were read again with looked-up
  // code, and how many of those second readings came back holding or refuting: what the
  // lookup bought. `unchecked` above counts final answers, after any second reading.
  readAgain: number;
  settled: number;
}

export interface CalibrationReport {
  findings: number;
  published: number;
  dismissed: number;
  // (iii): findings that were published inline and a human then dismissed. The headline
  // false-positive number.
  publishedDismissed: number;
  // Findings the skeptic majority refuted. The tool's own false-positive count, as opposed
  // to publishedDismissed, which is the share that got past it.
  killed: number;
  // Published findings a human then marked fixed: PROPOSAL §12's implementation rate, and
  // the only positive evidence the tool collects. Counted apart from autoClosed, which is
  // prloop's own inference that the flagged line went away rather than a person's decision.
  actedOn: number;
  autoClosed: number;
  // Dismissals whose finding is in no run we can still read — usually retention pruned the
  // run. Reported so the totals above are never mistaken for the whole history.
  orphanDismissals: number;
  /**
   * The reviewers' own words, most repeated first. A dismissal rate says how often prloop is
   * wrong; only this says in what way — "we dismiss a lot of performance findings" and "we
   * dismiss them because the quoted line is always in a test fixture" are different problems
   * with different fixes, and the second is the one that changes a prompt or a rule.
   */
  reasons: DismissalReason[];
  /** Dismissals whose reviewer left no reply. Usually most of them; worth knowing. */
  reasonless: number;
  byConfidence: Bucket[];
  byCategory: Bucket[];
  byFinder: Bucket[];
  // By what produced the run: a prompt or rule change is only measurable against the runs
  // before it if the two are kept apart.
  byStamp: Bucket[];
  bySeverity: Bucket[];
  // Static-tool findings only, by `tool:rule`.
  byRule: Bucket[];
  // Published findings that went nowhere: still open at merge.
  ignored: number;
  // The code changed under the open comment, plus the human fixes: the addressed count.
  addressed: number;
  /** Suggestions for a human to apply, never applied (PROPOSAL M6). */
  proposals: Proposal[];
  /**
   * Set when low-severity comments are addressed more often than critical and high ones. A
   * compliance signal as much as a quality one: people also "fix" to make a bot go quiet, and
   * the cheapest findings are the cheapest to silence.
   */
  inverted?: string;
  skeptics: SkepticStats[];
}

export interface Proposal {
  repo: string;
  /** What to demote: a category, or a tool's rule. */
  subject: string;
  kind: "category" | "rule";
  published: number;
  addressed: number;
  dismissed: number;
  ignored: number;
  /** One line a person can act on. */
  suggestion: string;
}

// A proposal needs enough comments behind it to be about the rule rather than about one PR,
// and a rate this low with most of the rest rejected or ignored: a category reviewers act on
// one time in ten, and push back on or walk past most of the time, is costing attention.
const PROPOSAL_MIN_PUBLISHED = 10;
const PROPOSAL_MAX_ADDRESSED = 0.15;
const PROPOSAL_MIN_REJECTED = 0.5;

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

function tally() {
  return { findings: 0, published: 0, dismissed: 0, actedOn: 0, killed: 0, codeChanged: 0, ignored: 0, liked: 0 };
}
type Tally = ReturnType<typeof tally>;

function toBuckets(m: Map<string, Tally>, order?: string[]): Bucket[] {
  const rows = [...m.entries()].map(([key, t]) => ({
    key,
    ...t,
    rate: t.published > 0 ? t.dismissed / t.published : 0,
    addressedRate: t.published > 0 ? (t.actedOn + t.codeChanged) / t.published : 0,
  }));
  if (order) return rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  // Biggest population first: a 100% dismissal rate over one finding is not the top line.
  return rows.sort((a, b) => b.findings - a.findings || a.key.localeCompare(b.key));
}

/**
 * Groups reviewers' replies by what they say.
 *
 * Case and trailing punctuation are folded together, and nothing else is: these are
 * sentences people typed, and any cleverer normalisation would merge two different reasons
 * and report a consensus nobody expressed. The first spelling seen is the one displayed, so
 * the report shows a reviewer's actual words rather than a lowercased reconstruction.
 */
export function groupReasons(reasons: readonly string[]): DismissalReason[] {
  const counts = new Map<string, { reason: string; count: number }>();
  for (const r of reasons) {
    const text = r.trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/[.!?\s]+$/, "");
    const prior = counts.get(key);
    if (prior) prior.count++;
    else counts.set(key, { reason: text, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
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

  // A refuted finding is in no findings.json anywhere, so it has to be carried in from the
  // skeptic's own record or it is counted nowhere — which is exactly the hole this is for:
  // every rate below was computed over the survivors alone, so a finder whose output the
  // skeptic threw away looked identical to one that produced nothing to throw away.
  //
  // Killed in ANY run sticks, like published: models do not reproduce a quote byte for byte
  // across runs, so a fingerprint that survived a later re-review is a different finding
  // text, not the verifier changing its mind.
  const killedFps = new Set<string>();
  for (const o of input.outcomes ?? []) {
    if (!o.fingerprint || !o.killed) continue;
    killedFps.add(o.fingerprint);
    if (byFingerprint.has(o.fingerprint)) continue;
    byFingerprint.set(o.fingerprint, {
      fingerprint: o.fingerprint,
      category: o.category ?? "",
      confidence: o.confidence ?? 0,
      sources: o.sources ?? [],
      // It never reached a comment, by construction: that is what being killed means.
      published: false,
    });
  }
  let killedCount = 0;
  let fixedCount = 0;
  let autoClosedCount = 0;

  const conf = new Map<string, Tally>();
  const cat = new Map<string, Tally>();
  const finder = new Map<string, Tally>();
  const stamp = new Map<string, Tally>();
  const severity = new Map<string, Tally>();
  const rule = new Map<string, Tally>();
  // Per repository, for the proposals: "exclude this category" is a decision about one
  // codebase's reviewers, and pooling repositories would propose it for all of them.
  const repoCat = new Map<string, Tally>();
  const repoRule = new Map<string, Tally>();
  type Fate = { dismissed: boolean; killed: boolean; fixed: boolean; changed: boolean; ignored: boolean; liked: boolean };
  const add = (m: Map<string, Tally>, key: string, f: CalibrationFinding, x: Fate) => {
    const t = m.get(key) ?? tally();
    t.findings++;
    if (f.published) t.published++;
    if (x.dismissed) t.dismissed++;
    if (x.killed) t.killed++;
    if (x.fixed) t.actedOn++;
    // Only a published finding had a comment for the code to change under, be walked past
    // at merge, or be liked.
    if (f.published && x.changed) t.codeChanged++;
    if (f.published && x.ignored) t.ignored++;
    if (f.published && x.liked) t.liked++;
    m.set(key, t);
  };

  let published = 0;
  let dismissedCount = 0;
  let publishedDismissed = 0;
  let ignoredCount = 0;
  for (const f of byFingerprint.values()) {
    const dismissed = input.dismissed.has(f.fingerprint);
    if (f.published) published++;
    if (dismissed) dismissedCount++;
    if (dismissed && f.published) publishedDismissed++;
    const killed = killedFps.has(f.fingerprint);
    if (killed) killedCount++;
    const fixed = input.actedOn?.fixed.has(f.fingerprint) ?? false;
    if (fixed) fixedCount++;
    const changed = input.actedOn?.autoClosed.has(f.fingerprint) ?? false;
    if (changed) autoClosedCount++;
    const ignored = input.actedOn?.ignored?.has(f.fingerprint) ?? false;
    if (ignored && f.published) ignoredCount++;
    const x: Fate = { dismissed, killed, fixed, changed, ignored, liked: input.actedOn?.liked?.has(f.fingerprint) ?? false };
    add(conf, confidenceBucket(f.confidence), f, x);
    add(cat, f.category || "(none)", f, x);
    // A finding found by two models is credit — and blame — for both.
    for (const s of f.sources.length > 0 ? f.sources : ["(unknown)"]) add(finder, s, f, x);
    // The configuration it was first seen under: a later run re-reporting it under a new
    // prompt did not produce it, it only failed to stop producing it.
    add(stamp, f.stamp ?? "(unstamped)", f, x);
    add(severity, f.severity || "(none)", f, x);
    if (f.rule) add(rule, f.rule, f, x);
    const repo = f.repo ?? "(unknown)";
    add(repoCat, `${repo}\u0000${f.category || "(none)"}`, f, x);
    if (f.rule) add(repoRule, `${repo}\u0000${f.rule}`, f, x);
  }

  const skeptics = new Map<string, SkepticStats>();
  for (const v of input.verdicts) {
    const model = v.model || "(unknown)";
    const s =
      skeptics.get(model) ??
      { model, answered: 0, refuted: 0, unchecked: 0, errors: 0, killRate: 0, uncheckedRate: 0, readAgain: 0, settled: 0 };
    if (v.error) s.errors++;
    else {
      s.answered++;
      if (v.verdict === "refuted") s.refuted++;
      else if (v.verdict === "insufficient-context") s.unchecked++;
      if (v.secondLook) {
        s.readAgain++;
        if (v.verdict !== "insufficient-context") s.settled++;
      }
    }
    skeptics.set(model, s);
  }
  for (const s of skeptics.values()) {
    s.killRate = s.answered > 0 ? s.refuted / s.answered : 0;
    s.uncheckedRate = s.answered > 0 ? s.unchecked / s.answered : 0;
  }

  let orphanDismissals = 0;
  for (const fp of input.dismissed) if (!byFingerprint.has(fp)) orphanDismissals++;

  const proposals: Proposal[] = [];
  const propose = (m: Map<string, Tally>, kind: Proposal["kind"]) => {
    for (const [key, t] of m) {
      const [repo = "", subject = ""] = key.split("\u0000");
      const addressed = t.actedOn + t.codeChanged;
      if (t.published < PROPOSAL_MIN_PUBLISHED) continue;
      if (addressed / t.published > PROPOSAL_MAX_ADDRESSED) continue;
      if ((t.dismissed + t.ignored) / t.published < PROPOSAL_MIN_REJECTED) continue;
      const [tool = "", ruleId = ""] = subject.split(":");
      proposals.push({
        repo,
        subject,
        kind,
        published: t.published,
        addressed,
        dismissed: t.dismissed,
        ignored: t.ignored,
        suggestion:
          kind === "category"
            ? `stop commenting on ${subject} findings where ${repo} is reviewed: PRR_EXCLUDE_CATEGORIES=${subject}`
            : `turn off ${ruleId || tool} in ${repo}'s own ${tool} configuration, or add it to the ${tool} profile's ignoreRules`,
      });
    }
  };
  propose(repoCat, "category");
  propose(repoRule, "rule");
  proposals.sort((a, b) => b.published - a.published || a.repo.localeCompare(b.repo) || a.subject.localeCompare(b.subject));

  // The compliance check: addressed rates should rise with severity. When the cheapest
  // findings are acted on more than the most serious ones, some of that "addressing" is
  // people making the bot go quiet, and the rate is not measuring usefulness.
  const sev = toBuckets(severity, ["critical", "high", "medium", "low", "(none)"]);
  const rateOf = (keys: string[]) => {
    const rows = sev.filter((b) => keys.includes(b.key));
    const pub = rows.reduce((n, b) => n + b.published, 0);
    return pub >= PROPOSAL_MIN_PUBLISHED ? rows.reduce((n, b) => n + b.actedOn + b.codeChanged, 0) / pub : undefined;
  };
  const serious = rateOf(["critical", "high"]);
  const minor = rateOf(["low"]);
  const inverted =
    serious !== undefined && minor !== undefined && minor > serious
      ? `low-severity comments were addressed more often (${(minor * 100).toFixed(1)}%) than critical and high ones (${(serious * 100).toFixed(1)}%) — read the addressed rates as partly compliance`
      : undefined;

  return {
    findings: byFingerprint.size,
    published,
    killed: killedCount,
    actedOn: fixedCount,
    autoClosed: autoClosedCount,
    dismissed: dismissedCount,
    publishedDismissed,
    orphanDismissals,
    reasons: groupReasons(input.dismissalReasons ?? []),
    reasonless: input.reasonlessDismissals ?? 0,
    byConfidence: toBuckets(conf, CONFIDENCE_FLOORS.map(([, k]) => k)),
    byCategory: toBuckets(cat),
    byFinder: toBuckets(finder),
    byStamp: toBuckets(stamp),
    bySeverity: sev,
    byRule: toBuckets(rule),
    ignored: ignoredCount,
    addressed: fixedCount + autoClosedCount,
    proposals,
    ...(inverted === undefined ? {} : { inverted }),
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

function readFindings(file: string, into: CalibrationFinding[], root: string): boolean {
  const stampFile = readJson(path.join(path.dirname(file), "stamp.json"));
  // runs/<org>/<project>/<repo>/pr-N/iter-M/findings.json: the repository is three levels up.
  const parts = path.relative(root, file).split(path.sep);
  const repo = parts.length >= 6 ? parts.slice(0, 3).join("/") : undefined;
  const stamp = typeof stampFile === "object" && stampFile !== null ? stampLabel(stampFile as Partial<RunStamp>) : undefined;
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
        ...(stamp === undefined ? {} : { stamp }),
        ...(typeof f["severity"] === "string" ? { severity: f["severity"] } : {}),
        ...(typeof f["rule"] === "string" ? { rule: f["rule"] } : {}),
        ...(repo === undefined ? {} : { repo }),
      });
    }
  }
  return true;
}

/**
 * One pass over a run's skeptic.json, filling both views of it: `verdicts` is one row per
 * ANSWER (what each verifier said), `outcomes` one row per FINDING (what the majority did
 * with it). Kept as one reader because they come from the same rows and a second parser
 * would drift from this one.
 */
function readVerdicts(file: string, into: CalibrationVerdict[], outcomes: CalibrationOutcome[]): boolean {
  const v = readJson(file);
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    // Every field but `killed` is absent on runs written before the row carried the
    // finding's identity. Such a row still contributes its verdicts; it simply cannot be
    // attributed to a finder or a category, which is the honest answer for it.
    const fp = str(row["fingerprint"]);
    outcomes.push({
      killed: row["killed"] === true,
      ...(fp ? { fingerprint: fp } : {}),
      ...(typeof row["category"] === "string" ? { category: row["category"] } : {}),
      ...(typeof row["confidence"] === "number" ? { confidence: row["confidence"] } : {}),
      ...(Array.isArray(row["sources"])
        ? { sources: row["sources"].filter((x): x is string => typeof x === "string") }
        : {}),
    });
    const verdicts = row["verdicts"];
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
        ...(typeof o["secondLook"] === "object" && o["secondLook"] !== null ? { secondLook: true } : {}),
      });
    }
  }
  return true;
}

/** Walks a runs/ tree and reads every artifact it recognises. */
export function scanRuns(root: string): ScanResult {
  const findings: CalibrationFinding[] = [];
  const verdicts: CalibrationVerdict[] = [];
  const outcomes: CalibrationOutcome[] = [];
  const unusable: string[] = [];
  const dismissed = new Set<string>();
  const dismissalReasons: string[] = [];
  let reasonlessDismissals = 0;
  const actedOn = {
    fixed: new Set<string>(),
    autoClosed: new Set<string>(),
    ignored: new Set<string>(),
    closed: new Set<string>(),
    liked: new Set<string>(),
  };
  const repos: string[] = [];

  // runs/<org>/<project>/<repo>/pr-N/iter-M/findings.json is 6 deep; the walk is bounded so
  // a stray symlink or a deep unrelated tree cannot turn a diagnostic into a disk scan.
  const findingFiles = findFiles(root, "findings.json", 6, []);
  let runs = 0;
  for (const f of findingFiles) {
    if (readFindings(f, findings, root)) runs++;
    else unusable.push(f);
  }
  for (const f of findFiles(root, "skeptic.json", 6, [])) {
    if (!readVerdicts(f, verdicts, outcomes)) unusable.push(f);
  }

  // The learnings store sits at the repo root, above the PR directories.
  for (const store of findFiles(root, "dismissals.jsonl", 4, [])) {
    const rel = path.relative(root, path.dirname(store)).split(path.sep);
    repos.push(rel.join("/"));
    // Read through the store's own loader: it already tolerates corrupt lines and dedupes,
    // and a second parser here would drift from the one that writes it.
    const [org = "", project = "", repoId = ""] = rel.slice(-3);
    const ref = { baseUrl: "", org, project, repoId, prId: 0 };
    for (const d of loadDismissals(ref, root)) {
      dismissed.add(d.fingerprint);
      if (d.reason) dismissalReasons.push(d.reason);
      else reasonlessDismissals++;
    }
    // Its own store, read through its own loader for the same reason: both tolerate corrupt
    // lines and dedupe first-wins, and a second parser here would drift from the writer.
    for (const o of loadOutcomes(ref, root)) {
      const into =
        o.outcome === "auto-closed" ? actedOn.autoClosed
          : o.outcome === "ignored" ? actedOn.ignored
            : o.outcome === "closed" ? actedOn.closed
              : actedOn.fixed;
      into.add(o.fingerprint);
      if ((o.likes ?? 0) > 0) actedOn.liked.add(o.fingerprint);
    }
  }

  return { findings, verdicts, outcomes, dismissed, dismissalReasons, reasonlessDismissals, actedOn, runs, unusable, repos };
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
    ["", "findings", "killed", "published", "fixed", "changed", "dismissed", "ignored", "liked", "dismissed%", "addressed%"],
    buckets.map((b) => [
      b.key,
      String(b.findings),
      String(b.killed),
      String(b.published),
      String(b.actedOn),
      String(b.codeChanged),
      String(b.dismissed),
      String(b.ignored),
      String(b.liked),
      pct(b.rate),
      pct(b.addressedRate),
    ]),
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
    // The tool's own catch, next to the one it missed. Both are false-positive counts; the
    // difference is who paid for it, the verifier or the reviewer.
    `${plural(report.killed, "finding")} refuted by the skeptic before anyone saw ${report.killed === 1 ? "it" : "them"}` +
      (report.findings > 0 ? ` (${pct(report.killed / report.findings)} of everything found)` : ""),
    // PROPOSAL §12's north star, and the first positive number the tool has ever had. The
    // auto-closed count is kept beside it rather than inside it: prloop closing a thread
    // because the flagged line went away is its own inference, not a person's decision.
    `${plural(report.actedOn, "commented finding")} a human then marked fixed` +
      (report.published > 0 ? ` — implementation rate ${pct(report.actedOn / report.published)}` : "") +
      (report.autoClosed > 0 ? `, plus ${report.autoClosed} whose code changed under the open comment` : ""),
    // What the comments led to, the way Uber and BitsAI-CR count it: acted on by a person, or
    // the flagged code changed while the comment was open.
    `addressed rate ${report.published > 0 ? pct(report.addressed / report.published) : "—"} ` +
      `(fixed, or the code changed under the comment); ${plural(report.ignored, "comment")} still open when the PR merged`,
  ];
  if (report.inverted) out.push(`[CAUTION] ${report.inverted}`);
  if (report.orphanDismissals > 0) {
    out.push(
      `${plural(report.orphanDismissals, "dismissal")} belong to findings no surviving run records ` +
        `(retention pruned the run) — they count in no rate below`,
    );
  }
  out.push(
    "",
    "Only a published finding can be dismissed, fixed, changed under, ignored or liked, so",
    "both rates below are over `published`: dismissed% = dismissed/published, addressed% =",
    "(fixed + changed)/published.",
    "`killed` is the skeptic's share of the same population — read it against `findings` in",
    "the same row, and remember a killed finding was never published and so can never be",
    "dismissed. A finder whose killed count approaches its findings count is paying for",
    "verification it is not earning.",
    "",
    bucketTable("By finder confidence", report.byConfidence),
    "",
    bucketTable("By category", report.byCategory),
    "",
    bucketTable("By finder model", report.byFinder),
    "",
  );
  out.push(bucketTable("By severity — addressed% should rise with severity", report.bySeverity), "");
  if (report.byRule.length > 0) out.push(bucketTable("Static-analysis rules", report.byRule), "");
  // Proposals, never actions: PROPOSAL M6. A person reads the numbers and decides.
  out.push(
    report.proposals.length === 0
      ? `Demotion proposals\n  (none: no category or rule has ${PROPOSAL_MIN_PUBLISHED}+ comments in one repository with this few addressed)`
      : `Demotion proposals — suggestions for a person to apply, never applied by prloop\n${table(
          ["repository", "subject", "published", "addressed", "dismissed", "ignored"],
          report.proposals.map((p) => [p.repo, p.subject, String(p.published), String(p.addressed), String(p.dismissed), String(p.ignored)]),
        )}\n${report.proposals.map((p) => `  → ${p.suggestion}`).join("\n")}`,
    "",
  );
  // Only when there is a comparison to make: one configuration is the ordinary case.
  if (report.byStamp.length > 1) {
    out.push(
      bucketTable("By configuration — commit, then prompts · rules · models · settings hashes", report.byStamp),
      "",
    );
  }
  const totalReasons = report.reasons.reduce((n, r) => n + r.count, 0);
  if (totalReasons > 0 || report.reasonless > 0) {
    out.push(
      totalReasons === 0
        ? `Why reviewers said no\n  (none of the ${report.reasonless} dismissals came with a reply)`
        : `Why reviewers said no (${totalReasons} of ${totalReasons + report.reasonless} dismissals came with a reply)\n${table(
            ["reason", "count"],
            report.reasons.slice(0, 10).map((r) => [r.reason.slice(0, 96), String(r.count)]),
          )}`,
      "",
    );
  }
  out.push(
    report.skeptics.length === 0
      ? "Skeptic verdicts\n  (no verification recorded)"
      : `Skeptic verdicts (per answer, not per finding)\n${table(
          ["model", "answered", "refuted", "kill rate", "unchecked", "unchecked rate", "read again", "settled", "errors"],
          report.skeptics.map((s) => [
            s.model,
            String(s.answered),
            String(s.refuted),
            pct(s.killRate),
            String(s.unchecked),
            pct(s.uncheckedRate),
            String(s.readAgain),
            String(s.settled),
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
