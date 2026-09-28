// `--batch`: one prloop run per pull request in a file, and one exit code for the lot.
//
// The README's own daily job is `while read -r url; do prloop "$url" --since auto || true;
// done < prs.txt`, and the `|| true` is not laziness — without it the first PR with a
// blocking finding stops the loop, so the only way to review the rest is to throw every exit
// code away. A cron that discards the one signal the tool produces is a cron nobody reads.
//
// One CHILD PROCESS per pull request, not an in-process loop, and that is a constraint rather
// than a preference: per-run state is module-global in four places — token totals in
// models/runner.ts, the clock and the log sink in libs/log.ts, the call sink in
// libs/artifacts.ts, and PRR_DRY_RUN, which the CLI exports into process.env. A second review
// in the same process would inherit the first one's token count, write into the first one's
// run directory and log under the first one's clock. Making all four per-run is a much larger
// change than this one, and it would buy nothing a child process does not already give.
//
// Sequential unless PRR_BATCH_PARALLEL says otherwise, and then never at N times the endpoint's
// size. The only throttles prloop has are PRR_LLM_CONCURRENCY and PRR_ADO_CONCURRENCY, and
// both are per process: N children at the full limit would multiply them by N, silently, past
// whatever the endpoint was sized for. So each child is handed its share of each limit.
//
// A child's settings are the parent's, plus what PRR_REPO_OVERRIDES says for its repository:
// the child reads its configuration when it starts, which is what makes per-repository
// settings free here and impossible inside one process.
import * as fs from "node:fs";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { parsePrUrl } from "../ado/client";
import { latestResult } from "./artifacts";
import { log } from "./log";
import type { PrRef } from "./types";

/** Set in every child's environment, so a warning the parent already gave is not repeated per child. */
export const BATCH_CHILD_ENV = "PRLOOP_BATCH_CHILD";

// Settings a repository may not override: the batch reads each child's result.json out of
// the runs directory, so a child writing somewhere else would be reported as having written
// nothing.
const NOT_PER_REPO = new Set(["PRR_RUNS_DIR"]);

/**
 * PRR_REPO_OVERRIDES: a JSON object of repository → { PRR_… setting: value }. The repository
 * is its name or `project/repo`, compared without case. Every problem is collected and thrown
 * together, before anything is reviewed — a misspelled setting in a nightly sweep would
 * otherwise configure nothing, silently, for every pull request of that repository.
 */
export function parseRepoOverrides(text: string, known: ReadonlySet<string>): Map<string, Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`PRR_REPO_OVERRIDES is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('PRR_REPO_OVERRIDES must be a JSON object: {"repository": {"PRR_SETTING": "value"}}');
  }
  const out = new Map<string, Record<string, string>>();
  const problems: string[] = [];
  for (const [repo, settings] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      problems.push(`${repo}: expected an object of PRR_ settings`);
      continue;
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (!known.has(key)) problems.push(`${repo}: ${key} is not a prloop setting`);
      else if (NOT_PER_REPO.has(key)) problems.push(`${repo}: ${key} cannot be set per repository`);
      else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") env[key] = String(value);
      else problems.push(`${repo}: ${key} must be a string, a number or a boolean`);
    }
    out.set(repo.toLowerCase(), env);
  }
  if (problems.length > 0) throw new Error(`PRR_REPO_OVERRIDES: ${problems.join("; ")}`);
  return out;
}

/** The settings for one pull request's repository: `project/repo` wins over the bare name. */
export function overridesFor(overrides: ReadonlyMap<string, Record<string, string>>, ref: PrRef): Record<string, string> {
  return overrides.get(`${ref.project}/${ref.repoId}`.toLowerCase()) ?? overrides.get(ref.repoId.toLowerCase()) ?? {};
}

export interface BatchOptions {
  /** How many pull requests run at once. */
  parallel?: number;
  overrides?: ReadonlyMap<string, Record<string, string>>;
  /** The whole-process limits a child gets a share of: PRR_LLM_CONCURRENCY and PRR_ADO_CONCURRENCY. */
  limits?: { llm: number; ado: number };
}

/**
 * One child's environment: the parent's, the repository's overrides, and its share of each
 * concurrency limit. A share is at least one; a limit of 0 (no cap) stays 0.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  parallel: number,
  limits: { llm: number; ado: number },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...overrides, [BATCH_CHILD_ENV]: "1" };
  if (parallel > 1) {
    const share = (key: string, limit: number) => {
      const own = Number(overrides[key] ?? limit);
      if (Number.isFinite(own) && own > 0) env[key] = String(Math.max(1, Math.floor(own / parallel)));
    };
    share("PRR_LLM_CONCURRENCY", limits.llm);
    share("PRR_ADO_CONCURRENCY", limits.ado);
  }
  return env;
}

export interface BatchList {
  urls: string[];
  /** Lines that are not a pull request URL, worded with their line number. */
  errors: string[];
}

/**
 * The file, as lines.
 *
 * Every URL is validated here, before the first child is spawned. A typo on line 40 of a
 * 60-line list used to surface two hours in, after everything above it had been reviewed and
 * paid for.
 *
 * No inline comments: a `#` inside a line is part of the URL (a fragment), and a rule that
 * truncated at one would silently review the wrong pull request. A line that STARTS with `#`
 * is a comment, which is the form every list of this kind already uses.
 */
export function parseBatchList(text: string): BatchList {
  const urls: string[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      parsePrUrl(line);
      urls.push(line);
    } catch (e) {
      errors.push(`line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return { urls, errors };
}

/**
 * The batch's own exit status: the worst thing that happened to any pull request in it.
 *
 * 1 outranks everything because it does not describe a pull request at all — it means prloop
 * could not run, and a bad credential or an unreachable endpoint is more urgent than a PR
 * with findings in it. Below that the single-run precedence is kept exactly (publish/status.ts):
 * blocking findings outrank an incomplete review, because 2 is the stronger statement and the
 * incomplete runs are named in the table either way.
 */
export function batchExitCode(codes: readonly number[]): number {
  for (const worst of [1, 2, 3]) if (codes.includes(worst)) return worst;
  return 0;
}

/**
 * Consecutive fatal exits after which the rest of the list is abandoned.
 *
 * Three in a row is not a pull request problem: the credential is wrong, the endpoint is
 * down, or the proxy is refusing CONNECT, and every remaining PR will fail identically after
 * paying its full retry budget first. Deliberately not a knob — an operator has no basis for
 * choosing a different number, and the failure it prevents (a dead endpoint burning an hour
 * of retries across sixty PRs) has no legitimate version worth configuring.
 */
export const FATAL_STREAK_LIMIT = 3;

export interface BatchOutcome {
  url: string;
  ref: PrRef;
  /** The child's exit status, or undefined when it was never attempted. */
  exitCode?: number;
  /** One line saying what happened, from the child's own result.json where it wrote one. */
  detail: string;
  durationSec: number;
}

/** What a child said about itself, read out of the result.json its run left behind. */
export function describeResult(result: Record<string, unknown> | undefined, exitCode: number): string {
  if (!result) return exitCode === 0 ? "clean" : `exit ${exitCode} (no result.json found)`;
  const fatal = result["fatal"];
  if (typeof fatal === "string") return fatal;
  const skipped = result["skippedReason"];
  if (typeof skipped === "string") return `no review: ${skipped}`;
  const incomplete = Array.isArray(result["incomplete"]) ? (result["incomplete"] as string[]) : [];
  const counts = (result["counts"] ?? {}) as { inline?: number };
  const found = typeof counts.inline === "number" ? counts.inline : 0;
  const headline = found > 0 ? `${found} inline comment${found === 1 ? "" : "s"}` : "clean";
  // The first reason, not the count: "review incomplete (2 reasons)" sends a reader to the
  // log, and the first one is the one that names a stage.
  return incomplete.length > 0 ? `${headline}, review incomplete: ${incomplete[0]}` : headline;
}

/**
 * How to re-invoke this exact prloop as a child.
 *
 * execArgv, not just execPath: prloop runs under tsx, whose loader lives in execArgv. Re-running
 * `node loop.ts` without it fails on the first TypeScript file, and hard-coding a `tsx` binary
 * would pick a different one than the one the parent is running under.
 */
export function childCommand(argv: readonly string[]): { file: string; args: string[] } {
  return { file: process.execPath, args: [...process.execArgv, process.argv[1] ?? "", ...argv] };
}

/** Everything the caller passed except `--batch` / `--active` and their values, forwarded to every child. */
export function forwardedArgs(argv: readonly string[]): string[] {
  const out = [...argv];
  for (const flag of ["--batch", "--active"]) {
    const i = out.indexOf(flag);
    if (i >= 0) out.splice(i, 2);
  }
  return out;
}

async function runOne(url: string, forward: readonly string[], env: NodeJS.ProcessEnv, prefix?: string): Promise<number> {
  const { file, args } = childCommand([url, ...forward]);
  return new Promise<number>((resolve) => {
    // Streamed, not captured: a batch of thirty reviews is hours of output, and buffering it
    // to print at the end means an operator watching a cron sees nothing until it finishes —
    // and a run that hangs shows nothing at all. Alone, a child writes straight to ours; beside
    // others, every line it writes is prefixed with its pull request, or the logs of three
    // reviews would interleave past reading.
    const child = spawn(file, args, { stdio: prefix === undefined ? "inherit" : ["ignore", "pipe", "pipe"], env });
    if (prefix !== undefined) {
      for (const [stream, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
        if (stream) readline.createInterface({ input: stream }).on("line", (line) => to.write(`${prefix} ${line}\n`));
      }
    }
    child.on("error", (e) => {
      log(`[FAIL] could not start a review of ${url}: ${e.message}`);
      resolve(1);
    });
    // A child killed by a signal has no code; it did not complete a review, which is exit 1.
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function runBatch(urls: readonly string[], forward: readonly string[], opts: BatchOptions = {}): Promise<BatchOutcome[]> {
  const parallel = Math.max(1, Math.min(opts.parallel ?? 1, urls.length));
  const out: BatchOutcome[] = urls.map((url) => ({ url, ref: parsePrUrl(url), detail: "not attempted", durationSec: 0 }));
  let next = 0;
  let fatalStreak = 0;
  let abandoned = false;
  const worker = async (): Promise<void> => {
    while (!abandoned && next < urls.length) {
      const i = next++;
      const { url, ref } = out[i]!;
      const startedAt = Date.now();
      log(`\n[${i + 1}/${urls.length}] ${url}`);
      const env = childEnv(process.env, overridesFor(opts.overrides ?? new Map(), ref), parallel, opts.limits ?? { llm: 0, ado: 0 });
      const exitCode = await runOne(url, forward, env, parallel > 1 ? `[${i + 1}/${urls.length} !${ref.prId}]` : undefined);
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      // The exit code alone cannot say what happened: 0 covers both "clean" and "the PR had
      // already merged", and 3 names no stage. The child wrote all of it down (libs/artifacts.ts).
      const detail = describeResult(latestResult(ref, startedAt), exitCode);
      out[i] = { url, ref, exitCode, detail, durationSec };
      // Counted in the order children finish: side by side, "in a row" means one after
      // another to come back, and three fatal ones still say the credential is wrong.
      fatalStreak = exitCode === 1 ? fatalStreak + 1 : 0;
      if (fatalStreak >= FATAL_STREAK_LIMIT && !abandoned) {
        abandoned = true;
        if (next < urls.length) {
          log(
            `\n[FAIL] ${FATAL_STREAK_LIMIT} pull requests in a row failed before producing a review. ` +
              `That is a credential, an endpoint or a proxy, not these pull requests — abandoning the ` +
              `remaining ${urls.length - next} rather than paying their retry budgets too`,
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
}

/** The end-of-run table. One line per pull request, and the columns line up. */
export function renderBatchReport(outcomes: readonly BatchOutcome[]): string {
  const rows = outcomes.map((o) => [
    o.exitCode === undefined ? "—" : String(o.exitCode),
    `${o.ref.org}/${o.ref.project}/${o.ref.repoId} !${o.ref.prId}`,
    o.exitCode === undefined ? o.detail : `${o.detail} (${o.durationSec}s)`,
  ]);
  const header = ["exit", "pull request", "result"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => (i === 0 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/** Reads the list, or throws with the line numbers that are wrong. */
export function readBatchList(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`--batch could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { urls, errors } = parseBatchList(text);
  if (errors.length > 0) {
    throw new Error(
      `--batch: ${file} has ${errors.length} line${errors.length === 1 ? "" : "s"} that ${errors.length === 1 ? "is" : "are"} ` +
        `not a pull request URL, so nothing was reviewed:\n  ${errors.join("\n  ")}`,
    );
  }
  if (urls.length === 0) throw new Error(`--batch: ${file} lists no pull requests`);
  return urls;
}
