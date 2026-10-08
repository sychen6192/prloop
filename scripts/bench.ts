// bench: run prloop over a public code-review benchmark, score it the way the benchmark does,
// and say how much of the score a re-run of the same commit would move.
//
// scripts/evaluate.ts scores a golden set written by hand for your own pull requests, which
// answers "did this change help on OUR PRs" and nothing else. PROPOSAL §12's open question —
// one finder or N, and what the skeptic adds, per weak model — needs hundreds of references
// labelled by somebody else, and two public sets have them: AACR-Bench (200 PRs, 10
// languages, every reference with a path and a line range) and Martian's Code Review Bench
// (50 PRs, 173 references, text only).
//
// Three rules, each from a way benchmark numbers mislead:
//
// - Location first. Where the benchmark gives a path and lines, a comment within ±k lines
//   (AACR's own rule, k = 1) is the primary match, and a model judge is a second, labelled
//   number. Judges agree with developers' fixed/wontFix labels only 0.44–0.62 of the time
//   (the Beko follow-up), and a score made of judge verdicts moves when the judge does.
// - Noise before signal. The same commit reviewed twice does not score the same, and a
//   difference smaller than that is not a difference. `run --repeat 2` measures it, and
//   `compare` will not call a change inside it — Kodus's discipline, which holds its nightly
//   to a floor calibrated from two runs on one commit and confirms a drop with a second run
//   before anyone is told.
// - Pin what scores. A judged score holds only under its judge model and judge prompt, so
//   `compare` refuses across judges, across line tolerances and across reference sets.
//
//   npx tsx scripts/bench.ts import aacr <positive_samples.json> <suite.json> [--sample N]
//   npx tsx scripts/bench.ts import martian <golden_comments dir> <suite.json> [--sample N]
//   npx tsx scripts/bench.ts run <suite.json> <out dir> [--repeat N] [--only id,id] [--repos dir]
//   npx tsx scripts/bench.ts score <suite.json> <out dir> [--k 1] [--judge <model>] [--json file]
//   npx tsx scripts/bench.ts compare <baseline score.json> <candidate score.json>
//
// `run` reviews each case with `local-review.ts review` — the production pipeline with the
// configured models, as a dry run — in its own process, against a clone fetched with git
// alone. One out dir holds one configuration: `run` stops rather than put a second prloop
// configuration (run stamp, libs/stamp.ts) beside the first.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FATAL_STREAK_LIMIT } from "../libs/batch";
import { normalizePath } from "../libs/fileindex";
import { parseJsonObject } from "../libs/json";
import { mulberry32, shuffle } from "../libs/prng";
import { run as exec } from "../libs/shell";
import { stampLabel, type RunStamp } from "../libs/stamp";
import type { ModelRunner } from "../libs/types";
import { buildJudgePrompt, JUDGE_SCHEMA, JUDGE_SYSTEM, type JudgeCandidate } from "../prompts/judge";
import {
  readRun,
  STAGE_FIX,
  STAGES,
  SUPPRESSION_RANK,
  type EvaluatedFinding,
  type RunArtifacts,
  type Stage,
} from "./evaluate";

// ─── The suite: one format for every benchmark ──────────────────────────────

export interface Reference {
  /** Unique within the suite: `<case id>#<n>`, n counting the dataset's own order from 1. */
  id: string;
  text: string;
  file?: string;
  /** 1-based and inclusive, as the benchmark gives them. */
  lines?: [number, number];
  /** AACR puts a few references on deleted lines; prloop only ever comments on the new side. */
  side?: "left" | "right";
  category?: string;
  severity?: string;
}

export interface BenchCase {
  id: string;
  /** Clone URL. A local path works too, which is what the selftest uses. */
  repo: string;
  /** The pull request number, when there is one: GitHub keeps its head at refs/pull/<n>/head. */
  pr?: number;
  /** A commit, or `<commit>^` for its parent. Absent until `run` recovers it from the pull request. */
  base?: string;
  head?: string;
  /** How base and head were found, once `run` has pinned them to commits. */
  resolvedBy?: string;
  /** Why this case cannot be run as it stands. `run` skips it and `score` names it. */
  unresolved?: string;
  language?: string;
  references: Reference[];
}

export interface BenchSuite {
  name: string;
  /** What it was imported from, for the report's first line. */
  source: string;
  cases: BenchCase[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const posInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const sha = (text: string | Buffer) => createHash("sha1").update(text).digest("hex");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const GITHUB_PR = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
const GITHUB_COMMIT = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/commit\/([0-9a-f]{7,40})\b/i;

function lineRange(from: unknown, to: unknown): [number, number] | undefined {
  const a = posInt(from) ?? posInt(to);
  const b = posInt(to) ?? posInt(from);
  if (a === undefined || b === undefined) return undefined;
  return a <= b ? [a, b] : [b, a];
}

/** A case id the suite has not used yet: two dataset entries for one pull request stay two cases. */
function claimId(used: Set<string>, id: string): string {
  let out = id;
  for (let n = 2; used.has(out); n++) out = `${id}~${n}`;
  used.add(out);
  return out;
}

/**
 * AACR-Bench's positive_samples.json: one record per pull request, every reference with a path
 * and a line range. `source_commit` is the base and `target_commit` the head — the benchmark's
 * own converter maps them that way (evaluation/converters/aacr_bench.py) — and the case id is
 * the one that converter derives, so a case can be found in either tool's output.
 */
export function fromAacr(records: unknown, source: string): BenchSuite {
  const cases: BenchCase[] = [];
  const used = new Set<string>();
  for (const r of Array.isArray(records) ? records : []) {
    if (!isObj(r)) continue;
    const m = GITHUB_PR.exec(str(r["githubPrUrl"]));
    const base = str(r["source_commit"]);
    const head = str(r["target_commit"]);
    if (!m || !base || !head) continue;
    const [, owner = "", name = "", pr = ""] = m;
    const id = claimId(used, `${owner}__${name}@${head.slice(0, 7)}`);
    const references: Reference[] = [];
    (Array.isArray(r["comments"]) ? r["comments"] : []).forEach((c, i) => {
      if (!isObj(c)) return;
      const text = str(c["note"]).trim();
      const file = normalizePath(str(c["path"]).trim());
      if (!text || !file) return;
      const lines = lineRange(c["from_line"], c["to_line"]);
      const side = str(c["side"]).trim().toLowerCase();
      references.push({
        id: `${id}#${i + 1}`,
        text,
        file,
        ...(lines ? { lines } : {}),
        ...(side === "left" || side === "right" ? { side } : {}),
        ...(str(c["category"]) ? { category: str(c["category"]) } : {}),
      });
    });
    if (references.length === 0) continue;
    cases.push({
      id,
      repo: `https://github.com/${owner}/${name}`,
      pr: Number(pr),
      base,
      head,
      ...(str(r["project_main_language"]) ? { language: str(r["project_main_language"]) } : {}),
      references,
    });
  }
  return { name: "aacr", source, cases };
}

/** Martian's repositories, by golden-comment file: the language each one stands for. */
const MARTIAN_LANGUAGE: Record<string, string> = {
  cal_dot_com: "TypeScript",
  discourse: "Ruby",
  grafana: "Go",
  keycloak: "Java",
  sentry: "Python",
};

/** The GitHub organisation holding the benchmark's re-creations of upstream pull requests. */
const MARTIAN_FORKS = "ai-code-review-evaluation";

/**
 * Martian's golden_comments/*.json: text references, no file and no line, so only a judge can
 * match them.
 *
 * Most entries name the upstream pull request. The rest name a re-creation in the benchmark's
 * own organisation, resolved through `original_url` where it has one: an upstream pull request
 * (the re-creation reproduces its base and head), or an upstream commit, whose re-creation's
 * base is the commit's parent — checked on discourse, where each re-creation's `-pre` branch is
 * exactly `<commit>^`. A re-creation with no original is left unresolved: which branch it was
 * opened against is recorded only by GitHub's API, and a guess would review the wrong diff.
 */
export function fromMartian(files: ReadonlyArray<{ name: string; entries: unknown }>, source: string): BenchSuite {
  const cases: BenchCase[] = [];
  const used = new Set<string>();
  for (const f of files) {
    const language = MARTIAN_LANGUAGE[f.name.replace(/\.json$/i, "")];
    for (const e of Array.isArray(f.entries) ? f.entries : []) {
      if (!isObj(e)) continue;
      const where = locateMartian(str(e["url"]), str(e["original_url"]));
      if (!where) continue;
      const id = claimId(used, where.id);
      const references: Reference[] = [];
      (Array.isArray(e["comments"]) ? e["comments"] : []).forEach((c, i) => {
        if (!isObj(c)) return;
        const text = str(c["comment"]).trim();
        if (!text) return;
        references.push({
          id: `${id}#${i + 1}`,
          text,
          ...(str(c["category"]) ? { category: str(c["category"]) } : {}),
          ...(str(c["severity"]) ? { severity: str(c["severity"]) } : {}),
        });
      });
      if (references.length === 0) continue;
      cases.push({ ...where.fields, id, ...(language ? { language } : {}), references });
    }
  }
  return { name: "martian", source, cases };
}

function locateMartian(url: string, original: string): { id: string; fields: Omit<BenchCase, "id" | "references"> } | undefined {
  const upstreamPr = (u: string) => {
    const m = GITHUB_PR.exec(u);
    if (!m || m[1]?.toLowerCase() === MARTIAN_FORKS) return undefined;
    const [, owner = "", name = "", pr = ""] = m;
    return { id: `${owner}__${name}#${pr}`, fields: { repo: `https://github.com/${owner}/${name}`, pr: Number(pr) } };
  };
  const byPr = upstreamPr(url) ?? upstreamPr(original);
  if (byPr) return byPr;
  const commit = GITHUB_COMMIT.exec(original);
  if (commit) {
    const [, owner = "", name = "", head = ""] = commit;
    return {
      id: `${owner}__${name}@${head.slice(0, 7)}`,
      fields: { repo: `https://github.com/${owner}/${name}`, base: `${head}^`, head },
    };
  }
  const fork = GITHUB_PR.exec(url);
  if (!fork) return undefined;
  const [, owner = "", name = "", pr = ""] = fork;
  return {
    id: `${owner}__${name}#${pr}`,
    fields: {
      repo: `https://github.com/${owner}/${name}`,
      pr: Number(pr),
      unresolved:
        "a benchmark re-creation with no original: the branch it was opened against is known only to GitHub's API — set base and head in the suite by hand",
    },
  };
}

/** A reproducible subset: the same N cases for the same seed, kept in the dataset's order. */
export function sampleSuite(suite: BenchSuite, n: number, seed: number): BenchSuite {
  if (n >= suite.cases.length) return suite;
  const chosen = new Set(shuffle(suite.cases.map((c) => c.id), mulberry32(seed)).slice(0, n));
  return {
    ...suite,
    source: `${suite.source}; ${n} of ${suite.cases.length} cases (seed ${seed})`,
    cases: suite.cases.filter((c) => chosen.has(c.id)),
  };
}

/**
 * What a score is a score OF: the cases and what each should find. Base and head are not in
 * it — `run` pins them after import, and each case's own key carries them instead, so a case
 * re-pinned to other commits is never paired with its old self.
 */
export function suiteHash(suite: BenchSuite): string {
  return sha(
    JSON.stringify(
      suite.cases.map((c) => [c.id, c.references.map((r) => [r.id, r.text, r.file ?? null, r.lines ?? null, r.side ?? null])]),
    ),
  ).slice(0, 12);
}

const caseKey = (c: BenchCase) => `${c.id}@${c.base ?? "?"}..${c.head ?? "?"}`;

function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function readSuite(file: string): BenchSuite {
  const v = readJsonFile<unknown>(file);
  if (!isObj(v) || !Array.isArray(v["cases"])) throw new Error(`${file} is not a bench suite (no "cases" list) — make one with \`bench.ts import\``);
  return v as unknown as BenchSuite;
}

// ─── Getting the code: git alone ─────────────────────────────────────────────

const CLONE_TIMEOUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10 * 60_000;

async function git(dir: string, args: string[], timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const res = await exec("git", ["-C", dir, ...args], timeoutMs);
  if (res.code !== 0) {
    const why = (res.stderr || res.stdout).trim().split("\n").pop() || `exit ${res.code}`;
    throw new Error(`git ${args.join(" ")}: ${why}`);
  }
  return res.stdout.trim();
}

const hasCommit = async (dir: string, rev: string) =>
  (await exec("git", ["-C", dir, "cat-file", "-e", `${rev}^{commit}`], 60_000)).code === 0;

const fetchInto = async (dir: string, what: string) =>
  (await exec("git", ["-C", dir, "fetch", "--quiet", "--filter=tree:0", "--no-tags", "origin", what], FETCH_TIMEOUT_MS)).code === 0;

/** A directory name for a repository: `owner__name.git`. */
export function repoSlug(repo: string): string {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(repo);
  const name = m ? `${m[1]}__${m[2]}` : path.basename(repo.replace(/[\\/]+$/, "")).replace(/\.git$/i, "");
  return `${(name || "repo").replace(/[^A-Za-z0-9._-]/g, "_")}.git`;
}

/**
 * A bare, treeless, single-branch clone: every commit of the default branch, and no tree or
 * blob until a diff asks for one. The benchmarks' repositories are large (sentry, grafana,
 * FreeCAD) and a review reads a few dozen files of each, so full clones of AACR's fifty would
 * run to tens of gigabytes; keycloak's is 14 MB this way. The commit graph it does keep is
 * what `git merge-base` needs to recover a pull request's base.
 */
export async function ensureClone(reposDir: string, repo: string): Promise<string> {
  const dir = path.join(reposDir, repoSlug(repo));
  if (fs.existsSync(path.join(dir, "HEAD"))) return dir;
  fs.mkdirSync(reposDir, { recursive: true });
  const res = await exec(
    "git",
    ["clone", "--quiet", "--bare", "--filter=tree:0", "--single-branch", "--no-tags", repo, dir],
    CLONE_TIMEOUT_MS,
  );
  if (res.code !== 0) throw new Error(`could not clone ${repo}: ${res.stderr.trim().split("\n").pop() ?? `exit ${res.code}`}`);
  return dir;
}

export interface Resolved {
  base: string;
  head: string;
  resolvedBy: string;
}

/**
 * Pins a case to two commits, fetching whatever the clone lacks.
 *
 * A pull request's base is not recorded in git: GitHub keeps the head at refs/pull/<n>/head
 * and the base branch only in its API, which a proxy may not let through (this was written
 * behind one that did not). The diff is recoverable anyway. GitHub shows a pull request as the
 * three-dot diff from the merge base, and while the head is not on the default branch —
 * squash- and rebase-merged pull requests, and every unmerged one — the merge base with the
 * default branch IS where it forked. When the head is on it, the pull request was merged with
 * a merge commit, whose first parent is the base branch as it stood when it merged.
 */
export async function resolveCase(dir: string, c: BenchCase): Promise<Resolved | { unresolved: string }> {
  if (c.unresolved) return { unresolved: c.unresolved };
  const how: string[] = [];

  let head: string;
  if (c.head) {
    if (!(await hasCommit(dir, c.head))) {
      // By id first: GitHub serves any commit reachable from a ref, and refs/pull/* are refs.
      if (!(await fetchInto(dir, c.head)) && c.pr !== undefined) await fetchInto(dir, `refs/pull/${c.pr}/head`);
      if (!(await hasCommit(dir, c.head))) return { unresolved: `the head ${c.head.slice(0, 12)} could not be fetched from ${c.repo}` };
    }
    head = await git(dir, ["rev-parse", `${c.head}^{commit}`]);
  } else if (c.pr !== undefined) {
    const ref = `refs/bench/pull/${c.pr}`;
    if (!(await fetchInto(dir, `+refs/pull/${c.pr}/head:${ref}`))) {
      return { unresolved: `refs/pull/${c.pr}/head could not be fetched from ${c.repo}` };
    }
    head = await git(dir, ["rev-parse", `${ref}^{commit}`]);
    how.push(`head from refs/pull/${c.pr}/head`);
  } else {
    return { unresolved: "no head commit, and no pull request to take one from" };
  }

  let base: string;
  if (c.base) {
    const commit = c.base.replace(/\^+$/, "");
    if (!(await hasCommit(dir, commit)) && !(await fetchInto(dir, commit))) {
      return { unresolved: `the base ${commit.slice(0, 12)} could not be fetched from ${c.repo}` };
    }
    const parsed = await git(dir, ["rev-parse", "--verify", "--quiet", `${c.base}^{commit}`]).catch(() => "");
    if (!parsed) return { unresolved: `${c.base} does not name a commit in ${c.repo}` };
    base = parsed;
    how.push(c.base.endsWith("^") ? "base = the head commit's parent" : "base from the dataset");
  } else {
    const branch = await git(dir, ["symbolic-ref", "--short", "HEAD"]).catch(() => "the default branch");
    const merged = (await exec("git", ["-C", dir, "merge-base", "--is-ancestor", head, "HEAD"], 60_000)).code === 0;
    if (!merged) {
      const fork = await git(dir, ["merge-base", "HEAD", head]).catch(() => "");
      if (!fork) return { unresolved: `the head shares no history with ${branch}` };
      base = fork;
      how.push(`base = merge base with ${branch}`);
    } else {
      const merges = await git(dir, ["rev-list", "--ancestry-path", "--merges", "--reverse", `${head}..HEAD`]);
      const merge = merges.split("\n")[0]?.trim();
      if (!merge) {
        return { unresolved: `the head is on ${branch} with no merge commit after it, so git cannot say where the pull request forked` };
      }
      base = await git(dir, ["rev-parse", `${merge}^1`]);
      how.push(`base = first parent of merge ${merge.slice(0, 12)}`);
    }
  }
  if (base === head) return { unresolved: "base and head are the same commit" };
  // Named, so a `git gc` cannot collect a commit that was fetched by id and is reachable from nothing.
  for (const commit of [base, head]) await git(dir, ["update-ref", `refs/bench/commits/${commit}`, commit]);
  return { base, head, resolvedBy: how.join("; ") };
}

// ─── Running the reviews ─────────────────────────────────────────────────────

const LOCAL_REVIEW = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-review.ts");

/** Where one run of one case writes, and is read back from. Numbered, so a repeat is never a timestamp race. */
export const runDirOf = (outDir: string, caseId: string, n: number) =>
  path.join(outDir, "runs", caseId.replace(/[^A-Za-z0-9._-]/g, "_"), `run-${n}`);

/** The iteration directory a finished local review left under a run directory. */
export function iterationDirOf(runDir: string): string | undefined {
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name.startsWith("iter-")) {
        // findings.json is written once the gates are done: a run that has none did not finish.
        if (fs.existsSync(path.join(p, "findings.json"))) return p;
        continue;
      }
      const found = depth > 0 ? walk(p, depth - 1) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  // <run dir>/local/local/<repo>/pr-0/iter-1-<ts>
  return walk(runDir, 5);
}

function stampOf(iterDir: string): string | undefined {
  const stamp = readJsonFile<Partial<RunStamp>>(path.join(iterDir, "stamp.json"));
  return stamp ? stampLabel(stamp) : undefined;
}

/**
 * One review, in a child process, for libs/batch.ts's reason: per-run state is module-global
 * in four places. Its output goes to console.log beside the run — a benchmark is hours of
 * review logs, and the one line per run printed here is what a person watching can read.
 */
function reviewOnce(repoDir: string, base: string, head: string, runDir: string): Promise<number> {
  fs.mkdirSync(runDir, { recursive: true });
  const out = fs.openSync(path.join(runDir, "console.log"), "w");
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, LOCAL_REVIEW, "review", repoDir, base, head], {
      // Static analysis runs in a worktree cut from ONE configured clone (PRR_WORKTREE_REPO) or
      // in one checkout (PRR_WORKDIR), and a benchmark spans fifty repositories: left on, every
      // file would be analysed in the wrong tree, skipped as stale, and every run marked
      // incomplete. Off, and recorded as off in every run's stamp.
      env: { ...process.env, PRR_RUNS_DIR: runDir, PRR_SKIP_STATIC: "1" },
      stdio: ["ignore", out, out],
    });
    child.on("error", () => resolve(1));
    // Killed by a signal: no code, and no review either.
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => fs.closeSync(out));
}

interface Manifest {
  suite: string;
  suiteHash: string;
  /** The run stamp every run in this directory was made under. */
  stamp?: string;
}

interface RunOptions {
  repeat: number;
  only?: ReadonlySet<string>;
  reposDir: string;
}

async function runCommand(suitePath: string, outDir: string, opts: RunOptions): Promise<number> {
  const suite = readSuite(suitePath);
  const hash = suiteHash(suite);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestFile = path.join(outDir, "bench.json");
  const manifest = readJsonFile<Manifest>(manifestFile) ?? { suite: suite.name, suiteHash: hash };
  if (manifest.suiteHash !== hash) {
    console.error(`${outDir} holds runs of another suite (${manifest.suite}, ${manifest.suiteHash}); use a new directory.`);
    return 1;
  }
  writeJson(manifestFile, manifest);

  const cases = suite.cases.filter((c) => !opts.only || opts.only.has(c.id));
  if (opts.only) {
    const unknown = [...opts.only].filter((id) => !suite.cases.some((c) => c.id === id));
    if (unknown.length > 0) {
      console.error(`--only names cases this suite does not have: ${unknown.join(", ")}`);
      return 1;
    }
  }
  let fatalStreak = 0;
  let pinned = 0;
  for (const [i, c] of cases.entries()) {
    const label = `[${i + 1}/${cases.length}] ${c.id}`;
    let repoDir: string;
    let resolved: Resolved | { unresolved: string };
    try {
      repoDir = c.unresolved ? "" : await ensureClone(opts.reposDir, c.repo);
      resolved = await resolveCase(repoDir, c);
    } catch (e) {
      resolved = { unresolved: msg(e) };
      repoDir = "";
    }
    if ("unresolved" in resolved) {
      console.log(`${label}: skipped — ${resolved.unresolved}`);
      continue;
    }
    if (c.base !== resolved.base || c.head !== resolved.head || c.resolvedBy !== resolved.resolvedBy) {
      // Pinned in the suite itself: a later push, a deleted branch or a default branch that
      // moved on cannot change what this case reviews, and every out dir reviews the same diff.
      if (c.base !== resolved.base || c.head !== resolved.head) pinned++;
      c.base = resolved.base;
      c.head = resolved.head;
      c.resolvedBy = resolved.resolvedBy;
      writeJson(suitePath, suite);
    }
    for (let n = 1; n <= opts.repeat; n++) {
      const runDir = runDirOf(outDir, c.id, n);
      // Finished before: `run` resumes where an interrupted one stopped.
      if (iterationDirOf(runDir)) continue;
      fs.rmSync(runDir, { recursive: true, force: true });
      const started = Date.now();
      const code = await reviewOnce(repoDir, resolved.base, resolved.head, runDir);
      const durationSec = Math.round((Date.now() - started) / 1000);
      writeJson(path.join(runDir, "bench-run.json"), { exitCode: code, durationSec, base: resolved.base, head: resolved.head });
      const iter = iterationDirOf(runDir);
      const stamp = iter ? stampOf(iter) : undefined;
      if (stamp && !manifest.stamp) {
        manifest.stamp = stamp;
        writeJson(manifestFile, manifest);
      } else if (stamp && stamp !== manifest.stamp) {
        fs.rmSync(runDir, { recursive: true, force: true });
        console.error(
          `\n${outDir} holds runs made under ${manifest.stamp}, and this one was made under ${stamp}. A score over ` +
            `both would average two configurations, so the run was removed: give this configuration its own directory.`,
        );
        return 1;
      }
      const inline = iter ? (readRun(iter)?.inline.length ?? 0) : undefined;
      console.log(
        `${label} run ${n}/${opts.repeat}: ` +
          (inline === undefined ? "no review" : `${inline} inline comment${inline === 1 ? "" : "s"}`) +
          `${code === 3 ? ", incomplete" : ""} (exit ${code}, ${durationSec}s)`,
      );
      fatalStreak = code === 1 ? fatalStreak + 1 : 0;
      if (fatalStreak >= FATAL_STREAK_LIMIT) {
        console.error(
          `\n${FATAL_STREAK_LIMIT} reviews in a row failed before producing one. That is a credential, an endpoint or ` +
            `a proxy, not these pull requests — stopping. The last one's output: ${path.join(runDir, "console.log")}`,
        );
        return 1;
      }
    }
  }
  if (pinned > 0) console.log(`\nPinned base and head of ${pinned} case${pinned === 1 ? "" : "s"} in ${suitePath}`);
  console.log(`\nScore it: npx tsx scripts/bench.ts score ${suitePath} ${outDir}`);
  return 0;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/** "line": a comment within ±k lines of the reference. "judged": one the judge says is the same issue. */
export type Metric = "line" | "judged";

/** Something the run said, at the furthest stage it reached. */
export interface Candidate {
  stage: Exclude<Stage, "not-found">;
  file: string;
  start?: number;
  end?: number;
  claim: string;
  sources: string[];
}

/** Everything a run said, published or not: the ladder needs the findings that fell short too. */
export function candidatesOf(run: RunArtifacts): Candidate[] {
  const out: Candidate[] = [];
  const add = (stage: Candidate["stage"], f: EvaluatedFinding) =>
    out.push({
      stage,
      file: f.file,
      ...(f.start === undefined ? {} : { start: f.start, end: f.end ?? f.start }),
      claim: f.claim ?? "",
      sources: f.sources,
    });
  for (const f of run.inline) add("inline", f);
  for (const f of run.belowBar) add((SUPPRESSION_RANK[f.suppressedBy ?? ""] ?? "no-corroboration") as Candidate["stage"], f);
  for (const f of run.refuted) add("refuted", f);
  for (const f of run.degraded) add("anchor-failed", f);
  return out;
}

/**
 * Whether a candidate is on a reference's lines, give or take k: overlapping, or at most k
 * lines apart — AACR's own rule (evaluation/judge.py, diff_location_is_same; k = 1 there).
 * A reference on deleted lines matches nothing, because prloop never comments on that side.
 */
export function onLines(c: Candidate, r: Reference, k: number): boolean {
  if (!r.file || !r.lines || r.side === "left" || c.start === undefined) return false;
  if (normalizePath(c.file) !== normalizePath(r.file)) return false;
  const end = c.end ?? c.start;
  const gap = c.start > r.lines[1] ? c.start - r.lines[1] : r.lines[0] > end ? r.lines[0] - end : 0;
  return gap <= k;
}

/**
 * The candidates a located reference is compared with: those on its lines, and — for the
 * ladder only — unanchored ones on its file, which have no line to compare. evaluate.ts draws
 * the same file-level line for anchor-failed, for the same reason.
 */
export function nearby(cands: readonly Candidate[], r: Reference, k: number): number[] {
  const out: number[] = [];
  cands.forEach((c, i) => {
    const sameFile = r.file !== undefined && r.side !== "left" && normalizePath(c.file) === normalizePath(r.file);
    if (onLines(c, r, k) || (c.stage === "anchor-failed" && sameFile)) out.push(i);
  });
  return out;
}

export interface RefOutcome {
  ref: string;
  /** "inline" is a hit. Anything else is how far the closest candidate got. */
  stage: Stage;
  /** The finders behind that candidate. */
  sources: string[];
}

/**
 * Files every reference under the furthest stage an unused candidate of its reached, one to
 * one, in the benchmark's order: a finding is credited to — or blamed for — at most one
 * reference. A hit ("inline") is AACR's own rule, so one comment on a busy hunk cannot score
 * three references at once. The misses follow it for the same reason: a finding cut by the
 * severity bar near three references would, with the bar lowered, be ONE comment, and one
 * unanchorable quote on a file with twelve references is one anchoring failure, not twelve.
 * The stage names the file to open (evaluate.ts's ladder), so an inflated one sends people
 * to the wrong file.
 */
export function matchRun(refs: readonly Reference[], cands: readonly Candidate[], matchesOf: (r: Reference) => number[]): RefOutcome[] {
  const used = new Set<number>();
  return refs.map((r) => {
    const best = matchesOf(r)
      .filter((i) => cands[i] !== undefined && !used.has(i))
      .sort((a, b) => STAGES.indexOf(cands[a]!.stage) - STAGES.indexOf(cands[b]!.stage) || a - b)[0];
    if (best === undefined) return { ref: r.id, stage: "not-found" as Stage, sources: [] };
    used.add(best);
    return { ref: r.id, stage: cands[best]!.stage, sources: cands[best]!.sources };
  });
}

export interface JudgeSetup {
  runner: ModelRunner;
  model: string;
  /** Verdicts already paid for, by prompt: re-scoring under the same judge costs nothing. */
  cache: Map<string, number[]>;
  calls: number;
}

/** The judge's own identity, beside its model: the system prompt, the prompt shape and the schema. */
export function judgePromptHash(): string {
  const sample = buildJudgePrompt({ text: "R", file: "f", lines: [1, 2] }, [{ file: "f", line: 1, claim: "C" }]);
  return sha(`${JUDGE_SYSTEM}\n\u0000\n${sample}\n\u0000\n${JSON.stringify(JUDGE_SCHEMA)}`).slice(0, 12);
}

/**
 * Which of `pool` (indexes into `cands`) the judge calls the same issue as `ref`. Throws on a
 * failed or unparseable call — a verdict that did not arrive is not "no match", and scoring it
 * as one would read an outage as a recall drop.
 */
export async function judgeRef(setup: JudgeSetup, ref: Reference, cands: readonly Candidate[], pool: readonly number[]): Promise<number[]> {
  if (pool.length === 0) return [];
  const shown: JudgeCandidate[] = pool.map((i) => {
    const c = cands[i]!;
    return { file: c.file, ...(c.start === undefined ? {} : { line: c.start }), claim: c.claim };
  });
  const user = buildJudgePrompt(
    { text: ref.text, ...(ref.file ? { file: ref.file } : {}), ...(ref.lines ? { lines: ref.lines } : {}) },
    shown,
  );
  const key = sha(`${setup.model}\n${judgePromptHash()}\n${user}`);
  let numbers = setup.cache.get(key);
  if (!numbers) {
    setup.calls++;
    const res = await setup.runner.chat({
      model: setup.model,
      system: JUDGE_SYSTEM,
      user,
      schema: JUDGE_SCHEMA,
      schemaName: "judge",
      temperature: 0,
    });
    if (res.error) throw new Error(`judge call failed: ${res.error}`);
    const parsed = parseJsonObject<{ same_issue?: unknown }>(res.text);
    if (!parsed.ok) throw new Error(`judge output unparseable: ${parsed.error}`);
    const list = parsed.value.same_issue;
    if (!Array.isArray(list)) throw new Error("judge output has no same_issue list");
    numbers = [...new Set(list.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= pool.length))];
    setup.cache.set(key, numbers);
  }
  return numbers.map((n) => pool[n - 1]!);
}

export interface RunScore {
  run: number;
  exitCode?: number;
  inline: number;
  /** Over the references that carry a file and lines. */
  line?: RefOutcome[];
  judged?: RefOutcome[];
  /** Why the judge could not score this run. Its judged numbers are left out, never counted as misses. */
  judgeError?: string;
  /** Findings the skeptic refuted, and how many of those were a reference's issue. */
  refuted: { total: number; onReference: number };
}

export async function scoreRun(
  c: BenchCase,
  run: RunArtifacts,
  n: number,
  k: number,
  setup?: JudgeSetup,
  exitCode?: number,
): Promise<RunScore> {
  const cands = candidatesOf(run);
  const located = c.references.filter((r) => r.file && r.lines);
  const windows = new Map(located.map((r) => [r.id, nearby(cands, r, k)]));
  const score: RunScore = {
    run: n,
    ...(exitCode === undefined ? {} : { exitCode }),
    inline: run.inline.length,
    refuted: { total: 0, onReference: 0 },
  };
  if (located.length > 0) score.line = matchRun(located, cands, (r) => windows.get(r.id) ?? []);

  let confirmed: Map<string, number[]> | undefined;
  if (setup) {
    try {
      // A located reference is judged against what is on its lines only — the judge refines a
      // location match and never overrides one. An unlocated one is judged against everything.
      const everything = cands.map((_, i) => i);
      const pairs = await Promise.all(
        c.references.map(async (r) => [r.id, await judgeRef(setup, r, cands, windows.get(r.id) ?? everything)] as const),
      );
      confirmed = new Map(pairs);
      score.judged = matchRun(c.references, cands, (r) => confirmed?.get(r.id) ?? []);
    } catch (e) {
      score.judgeError = msg(e);
    }
  }

  const refuted = cands.flatMap((cd, i) => (cd.stage === "refuted" ? [i] : []));
  const matched = new Set([...(confirmed ?? windows).values()].flat());
  score.refuted = { total: refuted.length, onReference: refuted.filter((i) => matched.has(i)).length };
  return score;
}

export interface CaseScore {
  id: string;
  /** id@base..head: only runs of the same commits are paired across two scores. */
  key: string;
  runs: RunScore[];
}

export interface ScoreFile {
  version: 1;
  suite: { name: string; hash: string };
  primary: Metric;
  k: number;
  judge?: { model: string; prompt: string };
  /** The run stamps behind the scored runs; more than one means the score mixes configurations. */
  stamps: string[];
  cases: CaseScore[];
  unscored: Array<{ id: string; reason: string }>;
  /** One line per reference, so `compare` can name what was lost without the suite. */
  labels: Record<string, string>;
}

export function referenceLabel(r: Reference): string {
  const where = r.file ? `${r.file}${r.lines ? `:${r.lines[0]}` : ""} — ` : "";
  const text = r.text.replace(/\s+/g, " ").trim();
  return `${where}${text.length > 90 ? `${text.slice(0, 90)}…` : text}`;
}

/** Per case, the metric's hits in each run that scored it. A run that did not score is absent, not zero. */
export interface CaseSeries {
  key: string;
  refs: number;
  hits: number[];
  /** Which references each run hit. */
  hitIds: string[][];
  inline: number[];
}

export function seriesOf(score: ScoreFile, metric: Metric): CaseSeries[] {
  const out: CaseSeries[] = [];
  for (const c of score.cases) {
    const scored = c.runs
      .map((r) => ({ outcomes: metric === "line" ? r.line : r.judged, inline: r.inline }))
      .filter((r): r is { outcomes: RefOutcome[]; inline: number } => r.outcomes !== undefined);
    if (scored.length === 0 || (scored[0]?.outcomes.length ?? 0) === 0) continue;
    const hitIds = scored.map((r) => r.outcomes.filter((o) => o.stage === "inline").map((o) => o.ref));
    out.push({
      key: c.key,
      refs: scored[0]!.outcomes.length,
      hits: hitIds.map((h) => h.length),
      hitIds,
      inline: scored.map((r) => r.inline),
    });
  }
  return out;
}

const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const sampleVariance = (xs: readonly number[]) => {
  const m = mean(xs);
  return xs.length < 2 ? 0 : xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};

/**
 * Run-to-run variance of hits, per reference: summed over the cases reviewed at least twice,
 * over their references. A case's hits vary roughly in proportion to how many references it
 * has, so this carries over to cases that were reviewed once. Undefined without a repeat.
 */
export function varianceRate(series: readonly CaseSeries[]): number | undefined {
  const repeated = series.filter((s) => s.hits.length >= 2);
  const refs = repeated.reduce((a, s) => a + s.refs, 0);
  return refs === 0 ? undefined : repeated.reduce((a, s) => a + sampleVariance(s.hits), 0) / refs;
}

export interface RecallSummary {
  cases: number;
  refs: number;
  /** Each case averaged over its runs, then pooled: the expected recall of one run. */
  recall: number;
  /** Recall of the n-th run over the cases it scored. */
  perRun: number[];
  /** Hit in at least one run. */
  anyRun: number;
  /** Credited comments over all inline comments. */
  precision: number;
  inline: number;
  /** One run's recall sd, from the spread between runs of the same commits; undefined without a repeat. */
  sd?: number;
}

export function summarize(series: readonly CaseSeries[]): RecallSummary {
  const refs = series.reduce((a, s) => a + s.refs, 0);
  const runs = Math.max(0, ...series.map((s) => s.hits.length));
  const perRun: number[] = [];
  for (let n = 0; n < runs; n++) {
    const with_ = series.filter((s) => s.hits.length > n);
    const denom = with_.reduce((a, s) => a + s.refs, 0);
    perRun.push(denom === 0 ? 0 : with_.reduce((a, s) => a + (s.hits[n] ?? 0), 0) / denom);
  }
  const hits = series.reduce((a, s) => a + s.hits.reduce((x, y) => x + y, 0), 0);
  const inline = series.reduce((a, s) => a + s.inline.reduce((x, y) => x + y, 0), 0);
  const rate = varianceRate(series);
  return {
    cases: series.length,
    refs,
    recall: refs === 0 ? 0 : series.reduce((a, s) => a + mean(s.hits), 0) / refs,
    perRun,
    anyRun: refs === 0 ? 0 : series.reduce((a, s) => a + new Set(s.hitIds.flat()).size, 0) / refs,
    precision: inline === 0 ? 0 : hits / inline,
    inline,
    ...(rate === undefined || refs === 0 ? {} : { sd: Math.sqrt(rate * refs) / refs }),
  };
}

// ─── Comparing two configurations ───────────────────────────────────────────

export interface Comparison {
  metric: Metric;
  cases: number;
  refs: number;
  baseline: number;
  candidate: number;
  delta: number;
  /** sd of the delta, from the repeats; undefined when neither side reviewed any case twice. */
  sd?: number;
  verdict: "better" | "worse" | "within noise" | "no noise estimate";
  runs: { baseline: number; candidate: number };
  /** References some baseline run hit and no candidate run did; and the reverse. */
  lost: string[];
  gained: string[];
}

const judgeLabel = (s: ScoreFile) => (s.judge ? `${s.judge.model} (prompt ${s.judge.prompt})` : "no judge");

/**
 * Baseline against candidate, over the cases both scored on the same commits.
 *
 * The bar is two standard deviations of the difference, and the deviation comes from repeats:
 * the baseline's when it has them — that is the floor being defended — and the candidate's
 * otherwise. Without any repeat there is no way to tell a change from a re-run, and the
 * comparison says so instead of printing a difference as if it meant something.
 */
export function compareScores(b: ScoreFile, c: ScoreFile): Comparison | { refused: string } {
  if (b.suite.hash !== c.suite.hash) {
    return { refused: `they score different suites (${b.suite.name} ${b.suite.hash}, ${c.suite.name} ${c.suite.hash})` };
  }
  if (b.primary !== c.primary) return { refused: `they use different metrics (${b.primary}, ${c.primary})` };
  if (b.k !== c.k) return { refused: `they use different line tolerances (k = ${b.k}, k = ${c.k})` };
  if (b.primary === "judged" && judgeLabel(b) !== judgeLabel(c)) {
    return {
      refused:
        `they were judged differently (${judgeLabel(b)}; ${judgeLabel(c)}), and a judged score holds only under its own ` +
        `judge. Score both with one --judge: cached verdicts make the part already judged free.`,
    };
  }
  const metric = b.primary;
  const base = new Map(seriesOf(b, metric).map((s) => [s.key, s]));
  const pairs = seriesOf(c, metric)
    .filter((s) => base.has(s.key))
    .map((s) => ({ b: base.get(s.key)!, c: s }));
  const refs = pairs.reduce((a, p) => a + p.b.refs, 0);
  const baseline = refs === 0 ? 0 : pairs.reduce((a, p) => a + mean(p.b.hits), 0) / refs;
  const candidate = refs === 0 ? 0 : pairs.reduce((a, p) => a + mean(p.c.hits), 0) / refs;
  const delta = candidate - baseline;
  const rate = varianceRate(pairs.map((p) => p.b)) ?? varianceRate(pairs.map((p) => p.c));
  const sd =
    rate === undefined || refs === 0
      ? undefined
      : Math.sqrt(pairs.reduce((a, p) => a + rate * p.b.refs * (1 / p.b.hits.length + 1 / p.c.hits.length), 0)) / refs;
  const verdict: Comparison["verdict"] =
    sd === undefined ? "no noise estimate" : delta < -2 * sd ? "worse" : delta > 2 * sd ? "better" : "within noise";
  const lost: string[] = [];
  const gained: string[] = [];
  for (const p of pairs) {
    const hb = new Set(p.b.hitIds.flat());
    const hc = new Set(p.c.hitIds.flat());
    for (const id of hb) if (!hc.has(id)) lost.push(id);
    for (const id of hc) if (!hb.has(id)) gained.push(id);
  }
  return {
    metric,
    cases: pairs.length,
    refs,
    baseline,
    candidate,
    delta,
    ...(sd === undefined ? {} : { sd }),
    verdict,
    runs: { baseline: Math.max(0, ...pairs.map((p) => p.b.hits.length)), candidate: Math.max(0, ...pairs.map((p) => p.c.hits.length)) },
    lost,
    gained,
  };
}

// ─── Output ─────────────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pts = (x: number) => `${(x * 100).toFixed(1)} pt`;
const share = (n: number, of: number) => (of > 0 ? pct(n / of) : "—");

function table(header: string[], rows: string[][], left: number[] = [0]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    "  " +
    cells
      .map((cell, i) => (left.includes(i) ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

const METRIC_NAME: Record<Metric, (s: ScoreFile) => string> = {
  line: (s) => `on the reference's lines (±${s.k})`,
  judged: (s) => `the same issue, judged by ${judgeLabel(s)}`,
};

function recallLines(s: ScoreFile, metric: Metric): string[] {
  const sum = summarize(seriesOf(s, metric));
  if (sum.cases === 0) return [`Recall, ${METRIC_NAME[metric](s)}: nothing scored`];
  const perRun = sum.perRun.length > 1 ? ` (${sum.perRun.map((r, i) => `run ${i + 1} ${pct(r)}`).join(", ")}; hit in any run ${pct(sum.anyRun)})` : "";
  const out = [
    `Recall, ${METRIC_NAME[metric](s)}: ${pct(sum.recall)} of ${sum.refs} references${perRun}`,
    `Precision: ${pct(sum.precision)} of ${sum.inline} inline comments were credited to a reference — the rest match none, which is not the same as wrong`,
  ];
  out.push(
    sum.sd === undefined
      ? "Noise: unmeasured — review every case at least twice (`run --repeat 2`) before reading a difference into this"
      : `Noise: one run's recall moves by ±${pts(sum.sd)} (1 sd) on a re-run of the same commits; a difference under ${pts(2 * sum.sd)} is indistinguishable from one`,
  );
  return out;
}

export function renderScore(suite: BenchSuite, s: ScoreFile): string {
  const refsById = new Map(suite.cases.flatMap((c) => c.references.map((r) => [r.id, r] as const)));
  const langOf = new Map(suite.cases.flatMap((c) => c.references.map((r) => [r.id, c.language ?? "(unknown)"] as const)));
  const runs = s.cases.flatMap((c) => c.runs);
  const out: string[] = [
    `prloop benchmark — ${suite.name} (${suite.source})`,
    "",
    `${s.cases.length} of ${suite.cases.length} cases scored, ${runs.length} run${runs.length === 1 ? "" : "s"}` +
      (runs.some((r) => r.exitCode === 3) ? `, ${runs.filter((r) => r.exitCode === 3).length} of them incomplete (exit 3)` : "") +
      `; configuration ${s.stamps.length === 0 ? "(unstamped)" : s.stamps.join(", ")}`,
  ];
  if (s.stamps.length > 1) out.push("WARNING: these runs were made under more than one configuration, and every number below mixes them.");
  const left = [...refsById.values()].filter((r) => r.side === "left").length;
  if (left > 0) out.push(`${left} reference${left === 1 ? " is" : "s are"} on deleted lines, where prloop never comments; counted as misses.`);
  out.push("", ...recallLines(s, s.primary));
  const secondary: Metric | undefined = s.primary === "line" && s.judge ? "judged" : undefined;
  if (secondary) out.push("", "Secondary, the judge on the same candidates:", ...recallLines(s, secondary).map((l) => `  ${l}`));
  const judgeErrors = runs.filter((r) => r.judgeError);
  if (judgeErrors.length > 0) {
    out.push(`${judgeErrors.length} run${judgeErrors.length === 1 ? "" : "s"} could not be judged and are left out of judged numbers: ${judgeErrors[0]?.judgeError}`);
  }

  const outcomes = runs.flatMap((r) => (s.primary === "line" ? r.line : r.judged) ?? []);
  if (outcomes.length > 0) {
    const byStage = new Map<Stage, number>();
    for (const o of outcomes) byStage.set(o.stage, (byStage.get(o.stage) ?? 0) + 1);
    out.push(
      "",
      `Where each reference stopped, over every run (${outcomes.length} reference-runs). The stage names the file to open:`,
      table(
        ["stage", "refs", "share", "what it means"],
        STAGES.map((st) => [st, String(byStage.get(st) ?? 0), share(byStage.get(st) ?? 0, outcomes.length), STAGE_FIX[st]]),
        [0, 3],
      ),
    );
    const groups = (keyOf: (id: string) => string) => {
      const g = new Map<string, { refs: number; hits: number }>();
      for (const o of outcomes) {
        const k = keyOf(o.ref);
        const e = g.get(k) ?? { refs: 0, hits: 0 };
        e.refs++;
        if (o.stage === "inline") e.hits++;
        g.set(k, e);
      }
      return [...g.entries()].sort((a, b) => b[1].refs - a[1].refs || a[0].localeCompare(b[0]));
    };
    const byCategory = groups((id) => refsById.get(id)?.category ?? "(none)");
    if (byCategory.length > 1) {
      out.push("", "By category:", table(["category", "reference-runs", "recall"], byCategory.map(([k, v]) => [k, String(v.refs), share(v.hits, v.refs)])));
    }
    const byLanguage = groups((id) => langOf.get(id) ?? "(unknown)");
    if (byLanguage.length > 1) {
      out.push("", "By language:", table(["language", "reference-runs", "recall"], byLanguage.map(([k, v]) => [k, String(v.refs), share(v.hits, v.refs)])));
    }
    // PROPOSAL §12's question, as numbers: what each finder contributed, and what only it found.
    const hitsBy = new Map<string, { all: number; only: number }>();
    for (const o of outcomes.filter((x) => x.stage === "inline")) {
      const sources = [...new Set(o.sources)];
      for (const m of sources) {
        const e = hitsBy.get(m) ?? { all: 0, only: 0 };
        e.all++;
        if (sources.length === 1) e.only++;
        hitsBy.set(m, e);
      }
    }
    if (hitsBy.size > 0) {
      out.push(
        "",
        "Hits per finder, and how many no other finder reported — what dropping that finder would cost:",
        table(["finder", "hits", "only this finder"], [...hitsBy.entries()].sort((a, b) => b[1].all - a[1].all).map(([m, v]) => [m, String(v.all), String(v.only)])),
      );
    }
  }
  const refuted = runs.reduce((a, r) => a + r.refuted.total, 0);
  if (refuted > 0) {
    const on = runs.reduce((a, r) => a + r.refuted.onReference, 0);
    out.push(
      "",
      `The skeptic refuted ${refuted} finding${refuted === 1 ? "" : "s"}: ${on} of them ${s.judge ? "were judged to be" : "sat on"} a reference's issue ` +
        `(what verification cost), ${refuted - on} matched no reference (what it most likely saved).`,
    );
  }
  if (s.unscored.length > 0) {
    out.push("", `Not scored (${s.unscored.length}):`, ...s.unscored.slice(0, 10).map((u) => `  ${u.id}: ${u.reason}`));
    if (s.unscored.length > 10) out.push(`  … and ${s.unscored.length - 10} more`);
  }
  return out.join("\n");
}

export function renderComparison(cmp: Comparison, b: ScoreFile): string {
  const out = [
    `${cmp.cases} case${cmp.cases === 1 ? "" : "s"}, ${cmp.refs} reference${cmp.refs === 1 ? "" : "s"} scored by both on the same commits — recall ${cmp.metric === "line" ? `on the lines (±${b.k})` : `judged by ${judgeLabel(b)}`}`,
    `  baseline  ${pct(cmp.baseline)}  (${cmp.runs.baseline} run${cmp.runs.baseline === 1 ? "" : "s"} per case)`,
    `  candidate ${pct(cmp.candidate)}  (${cmp.runs.candidate} run${cmp.runs.candidate === 1 ? "" : "s"} per case)`,
    `  change    ${cmp.delta >= 0 ? "+" : ""}${pts(cmp.delta)}${cmp.sd === undefined ? "" : `, against re-run noise of ±${pts(2 * cmp.sd)} (2 sd)`}`,
    "",
  ];
  switch (cmp.verdict) {
    case "no noise estimate":
      out.push(
        "No noise estimate: neither side reviewed any case twice, so this difference cannot be told from re-running",
        "the same commit. Review the baseline twice (`run --repeat 2`) and compare again.",
      );
      break;
    case "within noise":
      out.push("Within noise: no evidence either way.");
      break;
    case "worse":
      out.push(
        "Below the floor." +
          (cmp.runs.candidate < 2
            ? " Confirm before believing it: review the candidate again on the same commits (`run --repeat 2`) and compare — a drop one run shows and the next does not is noise."
            : ""),
      );
      break;
    case "better":
      out.push(
        "Above the noise." +
          (cmp.runs.candidate < 2 ? " One run can land there by chance too: `run --repeat 2` on the candidate before relying on it." : ""),
      );
      break;
  }
  const list = (title: string, ids: string[]) => {
    if (ids.length === 0) return;
    out.push("", `${title} (${ids.length}):`, ...ids.slice(0, 10).map((id) => `  ${id}  ${b.labels[id] ?? ""}`.trimEnd()));
    if (ids.length > 10) out.push(`  … and ${ids.length - 10} more`);
  };
  list("Hit by the baseline in some run and by the candidate in none", cmp.lost);
  list("Hit by the candidate in some run and by the baseline in none", cmp.gained);
  return out.join("\n");
}

// ─── Commands ───────────────────────────────────────────────────────────────

function importCommand(kind: string, input: string, out: string, sample?: number, seed = 1): number {
  let suite: BenchSuite;
  if (kind === "aacr") {
    const bytes = fs.readFileSync(input);
    suite = fromAacr(JSON.parse(bytes.toString("utf8")), `${path.basename(input)} sha1:${sha(bytes).slice(0, 12)}`);
  } else if (kind === "martian") {
    const files = fs.statSync(input).isDirectory()
      ? fs
          .readdirSync(input)
          .filter((n) => n.endsWith(".json"))
          .sort()
          .map((n) => path.join(input, n))
      : [input];
    const read = files.map((f) => ({ name: path.basename(f), bytes: fs.readFileSync(f) }));
    suite = fromMartian(
      read.map((r) => ({ name: r.name, entries: JSON.parse(r.bytes.toString("utf8")) as unknown })),
      `golden_comments, ${read.length} file${read.length === 1 ? "" : "s"} sha1:${sha(Buffer.concat(read.map((r) => r.bytes))).slice(0, 12)}`,
    );
  } else {
    return usage();
  }
  if (sample !== undefined) suite = sampleSuite(suite, sample, seed);
  if (suite.cases.length === 0) {
    console.error(`No cases found in ${input}: is it ${kind === "aacr" ? "AACR-Bench's positive_samples.json" : "Martian's golden_comments directory"}?`);
    return 1;
  }
  writeJson(out, suite);
  const refs = suite.cases.flatMap((c) => c.references);
  const located = refs.filter((r) => r.file && r.lines).length;
  const unresolved = suite.cases.filter((c) => c.unresolved);
  console.log(`${suite.cases.length} cases, ${refs.length} references (${located} with a file and lines) → ${out}`);
  if (located < refs.length) console.log(`References without a location can be matched only by a judge: score with --judge <model>.`);
  if (unresolved.length > 0) {
    console.log(`${unresolved.length} case${unresolved.length === 1 ? "" : "s"} cannot be run until base and head are set by hand:`);
    for (const c of unresolved) console.log(`  ${c.id}: ${c.unresolved}`);
  }
  return 0;
}

async function scoreCommand(suitePath: string, outDir: string, opts: { k: number; judge?: string; json?: string }): Promise<number> {
  const suite = readSuite(suitePath);
  const refs = suite.cases.flatMap((c) => c.references);
  const unlocated = refs.filter((r) => !r.file || !r.lines).length;
  const primary: Metric = unlocated === 0 ? "line" : "judged";
  if (primary === "judged" && !opts.judge) {
    console.error(`${unlocated} of ${refs.length} references in ${suite.name} carry no file and line, so only a judge can match them: pass --judge <model>.`);
    return 1;
  }
  const cacheFile = path.join(outDir, "judge-cache.json");
  let setup: JudgeSetup | undefined;
  if (opts.judge) {
    // Lazily: the runner reads the model endpoint's settings, which a line-only score never needs.
    const { createRunner } = await import("../models/runner");
    setup = {
      runner: await createRunner(),
      model: opts.judge,
      cache: new Map(Object.entries(readJsonFile<Record<string, number[]>>(cacheFile) ?? {})),
      calls: 0,
    };
  }
  const cases: CaseScore[] = [];
  const unscored: ScoreFile["unscored"] = [];
  const stamps = new Set<string>();
  const labels: Record<string, string> = {};
  for (const c of suite.cases) {
    for (const r of c.references) labels[r.id] = referenceLabel(r);
    if (c.unresolved) {
      unscored.push({ id: c.id, reason: c.unresolved });
      continue;
    }
    const runs: RunScore[] = [];
    let stale = 0;
    for (let n = 1; fs.existsSync(runDirOf(outDir, c.id, n)); n++) {
      const runDir = runDirOf(outDir, c.id, n);
      const iter = iterationDirOf(runDir);
      const artifacts = iter ? readRun(iter) : undefined;
      if (!iter || !artifacts) continue;
      const meta = readJsonFile<{ exitCode?: number; base?: string; head?: string }>(path.join(runDir, "bench-run.json"));
      if (meta && (meta.base !== c.base || meta.head !== c.head)) {
        stale++;
        continue;
      }
      if (artifacts.stamp) stamps.add(artifacts.stamp);
      runs.push(await scoreRun(c, artifacts, n, opts.k, setup, meta?.exitCode));
    }
    // After every case: an interrupted score keeps the verdicts it already paid for.
    if (setup) writeJson(cacheFile, Object.fromEntries(setup.cache));
    if (runs.length === 0) {
      const reason = stale > 0 ? `its ${stale} run(s) reviewed other commits than the suite now pins` : fs.existsSync(runDirOf(outDir, c.id, 1)) ? "no run finished" : "not run";
      unscored.push({ id: c.id, reason });
      continue;
    }
    cases.push({ id: c.id, key: caseKey(c), runs });
  }
  const score: ScoreFile = {
    version: 1,
    suite: { name: suite.name, hash: suiteHash(suite) },
    primary,
    k: opts.k,
    ...(setup ? { judge: { model: setup.model, prompt: judgePromptHash() } } : {}),
    stamps: [...stamps].sort(),
    cases,
    unscored,
    labels,
  };
  const file = opts.json ?? path.join(outDir, "score.json");
  writeJson(file, score);
  console.log(renderScore(suite, score));
  if (setup) console.log(`\n${setup.calls} judge call${setup.calls === 1 ? "" : "s"} made; the rest came from ${cacheFile}`);
  console.log(`\nScore written to ${file}. Compare two: npx tsx scripts/bench.ts compare <baseline score.json> <candidate score.json>`);
  return 0;
}

function compareCommand(baselineFile: string, candidateFile: string): number {
  const b = readJsonFile<ScoreFile>(baselineFile);
  const c = readJsonFile<ScoreFile>(candidateFile);
  if (!b?.cases || !c?.cases) {
    console.error(`Not a score file: ${!b?.cases ? baselineFile : candidateFile} (write one with \`bench.ts score\`)`);
    return 1;
  }
  const cmp = compareScores(b, c);
  if ("refused" in cmp) {
    console.error(`Not comparable: ${cmp.refused}`);
    return 1;
  }
  console.log(renderComparison(cmp, b));
  // A regression beyond the noise is the one outcome a pipeline should stop on.
  return cmp.verdict === "worse" ? 2 : 0;
}

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/bench.ts import aacr <positive_samples.json> <suite.json> [--sample N] [--seed S]
  npx tsx scripts/bench.ts import martian <golden_comments dir> <suite.json> [--sample N] [--seed S]
  npx tsx scripts/bench.ts run <suite.json> <out dir> [--repeat N] [--only id,id] [--repos dir]
  npx tsx scripts/bench.ts score <suite.json> <out dir> [--k 1] [--judge <model>] [--json file]
  npx tsx scripts/bench.ts compare <baseline score.json> <candidate score.json>`);
  process.exit(1);
}

function intFlag(v: string | undefined, name: string, min: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    console.error(`${name} takes a whole number of at least ${min}, not "${v}"`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) usage();
    argv.splice(i, 2);
    return v;
  };
  const cmd = argv[0];
  if (cmd === "import") {
    const sample = intFlag(flag("--sample"), "--sample", 1);
    const seed = intFlag(flag("--seed"), "--seed", 0) ?? 1;
    const [, kind, input, out] = argv;
    if (!kind || !input || !out) usage();
    return importCommand(kind, input, out, sample, seed);
  }
  if (cmd === "run") {
    const repeat = intFlag(flag("--repeat"), "--repeat", 1) ?? 1;
    const only = flag("--only");
    const repos = flag("--repos");
    const [, suite, out] = argv;
    if (!suite || !out) usage();
    return runCommand(suite, out, {
      repeat,
      ...(only ? { only: new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) } : {}),
      reposDir: repos ?? path.join(path.dirname(path.resolve(suite)), "repos"),
    });
  }
  if (cmd === "score") {
    const k = intFlag(flag("--k"), "--k", 0) ?? 1;
    const judge = flag("--judge");
    const json = flag("--json");
    const [, suite, out] = argv;
    if (!suite || !out) usage();
    return scoreCommand(suite, out, { k, ...(judge ? { judge } : {}), ...(json ? { json } : {}) });
  }
  if (cmd === "compare") {
    const [, baseline, candidate] = argv;
    if (!baseline || !candidate) usage();
    return compareCommand(baseline, candidate);
  }
  return usage();
}

// Imported by the selftest for the pure halves above, so the commands only run when this file
// is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`FATAL: ${msg(e)}`);
      process.exit(1);
    },
  );
}
