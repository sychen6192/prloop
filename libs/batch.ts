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
// SEQUENTIAL, with no concurrency option. The only throttle prloop has on a model endpoint is
// PRR_LLM_CONCURRENCY, which is per process; N children at once multiply it by N, silently,
// past whatever the endpoint was sized for. A shell loop is sequential too, so this is no
// slower than what it replaces — it just keeps the exit codes.
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { parsePrUrl } from "../ado/client";
import { latestResult } from "./artifacts";
import { log } from "./log";
import type { PrRef } from "./types";

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

/** Everything the caller passed except `--batch` and its value, forwarded to every child. */
export function forwardedArgs(argv: readonly string[]): string[] {
  const i = argv.indexOf("--batch");
  return i < 0 ? [...argv] : [...argv.slice(0, i), ...argv.slice(i + 2)];
}

async function runOne(url: string, forward: readonly string[]): Promise<number> {
  const { file, args } = childCommand([url, ...forward]);
  return new Promise<number>((resolve) => {
    // Inherited, not captured: a batch of thirty reviews is hours of output, and buffering it
    // to print at the end means an operator watching a cron sees nothing until it finishes —
    // and a run that hangs shows nothing at all.
    const child = spawn(file, args, { stdio: "inherit" });
    child.on("error", (e) => {
      log(`[FAIL] could not start a review of ${url}: ${e.message}`);
      resolve(1);
    });
    // A child killed by a signal has no code; it did not complete a review, which is exit 1.
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function runBatch(urls: readonly string[], forward: readonly string[]): Promise<BatchOutcome[]> {
  const out: BatchOutcome[] = [];
  let fatalStreak = 0;
  for (const [i, url] of urls.entries()) {
    const ref = parsePrUrl(url);
    if (fatalStreak >= FATAL_STREAK_LIMIT) {
      out.push({ url, ref, detail: "not attempted", durationSec: 0 });
      continue;
    }
    const startedAt = Date.now();
    log(`\n[${i + 1}/${urls.length}] ${url}`);
    const exitCode = await runOne(url, forward);
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    // The exit code alone cannot say what happened: 0 covers both "clean" and "the PR had
    // already merged", and 3 names no stage. The child wrote all of it down (libs/artifacts.ts).
    const detail = describeResult(latestResult(ref, startedAt), exitCode);
    out.push({ url, ref, exitCode, detail, durationSec });
    fatalStreak = exitCode === 1 ? fatalStreak + 1 : 0;
    if (fatalStreak >= FATAL_STREAK_LIMIT && i + 1 < urls.length) {
      log(
        `\n[FAIL] ${FATAL_STREAK_LIMIT} pull requests in a row failed before producing a review. ` +
          `That is a credential, an endpoint or a proxy, not these pull requests — abandoning the ` +
          `remaining ${urls.length - i - 1} rather than paying their retry budgets too`,
      );
    }
  }
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
