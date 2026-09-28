#!/usr/bin/env -S npx tsx
// CLI entry: prloop <PR URL> [--since <iteration>] [--dry-run]
//
// Exit codes: 0 = reviewed, no high-risk findings; 2 = high-risk findings posted;
// 3 = review incomplete (a stage or the publish step failed); 1 = fatal (auth, network,
// bad arguments).
import {
  FINDER_MODELS,
  FINDING_CATEGORIES,
  LLM_BASE_URL,
  MIN_CONSENSUS_SOURCES,
  REQUIRE_CORROBORATION,
  REQ_MODEL,
  SHOW_CONFIG,
  SKEPTIC_MODELS,
  TRIAGE_MODEL,
  POST_STATUS,
  excludedCategories,
  isDryRun,
} from "./config";
import { parsePrUrl } from "./ado/client";
import { postStatus } from "./ado/statuses";
import { unmetCriteria } from "./gates/requirement";
import { claimRunLease, releaseRunLease, runId } from "./publish/lease";
import { resolveLastReviewedIteration } from "./publish/lifecycle";
import { buildResultSummary, createFatalRunDir, createSkipDir, currentRunDir, openRunDir } from "./libs/artifacts";
import { batchExitCode, forwardedArgs, readBatchList, renderBatchReport, runBatch } from "./libs/batch";
import { parseArgs } from "./libs/cli";
import { configWarnings, renderConfigTable } from "./libs/configreport";
import { banner, die, log } from "./libs/log";
import type { PrRef } from "./libs/types";
import { createRunner, tokenTotals } from "./models/runner";
import { exitCodeFor, runReview } from "./orchestrator";

const USAGE = `Usage: prloop <PR URL> [options]
       npm run prloop -- <PR URL> [options]     (any OS, including Windows)

  <PR URL>              https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}

Options:
  --since <iteration>   review only changes after that iteration (incremental)
  --since auto          resume from the last reviewed iteration
  --batch <file>        review every PR URL in the file, one per line (# comments allowed),
                        one after another; exits with the worst outcome in the list
  --dry-run             compute everything, post nothing
  --config              print every setting, its value and its source, then exit
  -h, --help            show this help

Exit codes: 0 clean | 2 blocking findings | 3 review incomplete (a stage failed) | 1 fatal

Env vars: see .env.example`;

/** Asked for help: that is a successful run, so stdout and exit 0. */
function help(): never {
  console.log(USAGE);
  process.exit(0);
}

/** Called wrong: stderr and a non-zero status, because a pipeline must notice. */
function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

/** Set once the PR URL parses, so every exit path can say which run this was. */
let fatalRef: PrRef | undefined;
const startedAt = new Date().toISOString();

/**
 * Who this run was, for result.json. Shared by all three exit paths — clean, skipped and
 * fatal — because the file is only useful across runs if it identifies itself: without this
 * a morning digest over a list of PRs had to parse directory names, or open context.json and
 * config.json beside it, to learn which pull request a result belonged to.
 */
function runIdentity(iteration?: number, compareTo?: number) {
  if (!fatalRef) return undefined;
  return {
    ref: fatalRef,
    ...(iteration === undefined ? {} : { iteration }),
    ...(compareTo === undefined ? {} : { compareTo }),
    dryRun: isDryRun(),
    // How a lease nobody released is traced back to the run that left it: the id in the
    // marker on the PR is this one, and it is on disk for every run the fleet made.
    runId: runId(),
    startedAt,
    models: {
      finders: FINDER_MODELS,
      skeptics: SKEPTIC_MODELS,
      ...(REQ_MODEL ? { req: REQ_MODEL } : {}),
      ...(TRIAGE_MODEL ? { triage: TRIAGE_MODEL } : {}),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const cli = parseArgs(args, SHOW_CONFIG);
  // Checked before the URL is required: "which value is prloop actually using" is a
  // question you ask when a run went wrong, and it must not need a PR to answer.
  if (cli.showConfig) {
    console.log(renderConfigTable());
    process.exit(0);
  }
  // --help is a request, not a mistake. Exiting 1 to stderr made `prloop --help` look like a
  // failure to every caller that checks a status code, CI smoke tests included.
  if (cli.help) help();
  if (args.length === 0) usage();
  if (cli.error) die(cli.error);

  // Before anything that needs a PR: a batch reviews a list of them, one child process each,
  // and this process only tallies the results (libs/batch.ts says why a child rather than a
  // loop in here). The whole file is validated first, so a typo on line 40 of a 60-line list
  // surfaces now rather than two hours in.
  if (cli.batch) {
    const urls = readBatchList(cli.batch);
    banner(`prloop: ${urls.length} pull requests from ${cli.batch}`);
    const started = Date.now();
    const outcomes = await runBatch(urls, forwardedArgs(args));
    const codes = outcomes.map((o) => o.exitCode).filter((c): c is number => c !== undefined);
    banner(`Done: ${outcomes.length} pull requests in ${Math.round((Date.now() - started) / 60000)}m`);
    console.log(renderBatchReport(outcomes));
    const exit = batchExitCode(codes);
    // The one thing the documented shell loop cannot do. `|| true` throws every exit code
    // away because without it the first blocking finding stops the loop; this reviews all of
    // them AND still reports the worst.
    log(`Exiting ${exit}: the worst outcome in the list`);
    process.exit(exit);
  }

  let compareTo = typeof cli.since === "number" ? cli.since : 0;
  const sinceAuto = cli.since === "auto";

  const url = cli.url;
  if (!url) usage();
  if (cli.dryRun) process.env["PRR_DRY_RUN"] = "1";

  const ref = parsePrUrl(url);
  // Kept where the fatal handler can reach it: a run that dies before publish() posts no
  // status at all, so whatever an earlier run left on the PR still stands — and on a re-run
  // of the same iteration that is quite possibly a green one gating the merge.
  fatalRef = ref;
  banner(`prloop: ${ref.org}/${ref.project}/${ref.repoId} PR !${ref.prId}`);
  // Said once, before anything is spent: an edit to .env that a shell export is quietly
  // discarding, and a setting name that configures nothing. Both used to be visible only to
  // someone who ran probe — which nobody does during a normal review.
  for (const w of configWarnings()) log(`[WARN] ${w.message}`);
  log(`Models: ${FINDER_MODELS.join(", ")} @ ${LLM_BASE_URL}`);
  if (isDryRun()) log("DRY RUN: no comments will be posted");
  if (REQUIRE_CORROBORATION && FINDER_MODELS.length < MIN_CONSENSUS_SOURCES && SKEPTIC_MODELS.length === 0) {
    log(
      "[WARN] corroboration gate is unsatisfiable: one finder, no skeptics — model findings " +
        "can NEVER become inline comments. Add a second finder or set PRR_SKEPTIC_MODELS " +
        "(or loosen with PRR_REQUIRE_CORROBORATION=0)",
    );
  }
  const excluded = excludedCategories();
  if (excluded.length > 0) {
    // A typo here would silently exclude nothing, so unknown names are called out.
    const known = new Set<string>(FINDING_CATEGORIES);
    const unknown = excluded.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      log(
        `[WARN] PRR_EXCLUDE_CATEGORIES contains unknown categories (${unknown.join(", ")}) — ` +
          `they exclude nothing. Valid: ${FINDING_CATEGORIES.join(", ")}`,
      );
    }
    if (excluded.includes("req-mismatch")) {
      log("[WARN] req-mismatch is produced by the requirement axis; use PRR_SKIP_REQUIREMENT=1 to turn that off");
    }
    log(`Excluded categories: ${excluded.join(", ")}`);
  }
  // Before `--since auto`, and long before the model budget: standing down has to be the
  // cheap path, or the lease costs more than the overlap it prevents. A dry run skips it
  // entirely — it writes nothing, so it cannot collide with anything, and taking a lease it
  // would then have to release is the opposite of "compute everything, post nothing".
  if (!isDryRun()) {
    const lease = await claimRunLease(ref);
    if (!lease.acquired) {
      const reason = lease.reason ?? "another run holds this pull request";
      log(`No review: ${reason}. Nothing was posted and no model call was made.`);
      // The same shape a merged PR produces, for the same reason: this tick correctly did
      // nothing, and a cron over a list of PRs must not redden because one of them was
      // already being reviewed.
      createSkipDir(ref).saveJson(
        "result.json",
        buildResultSummary({
          exitCode: 0,
          skippedReason: reason,
          identity: runIdentity(undefined, compareTo),
          incomplete: [],
          counts: { raw: 0, anchored: 0, survived: 0, inline: 0, degraded: 0 },
          tokens: tokenTotals(),
          durationSec: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
        }),
      );
      process.exit(0);
    }
  }

  if (sinceAuto) {
    const last = await resolveLastReviewedIteration(ref);
    if (last === undefined) log("--since auto: no prior review found, doing a full review");
    else {
      compareTo = last;
      log(`--since auto: resuming from iteration ${last}`);
    }
  }
  if (compareTo > 0) log(`Incremental mode: reviewing only changes after iteration ${compareTo}`);

  const result = await runReview({ ref, runner: await createRunner(), compareTo });

  // Here rather than in a `finally`, because every exit below is a process.exit() and those
  // do not run one. A normal review has already released it — publish() rewrites the summary
  // and the new body carries no marker — so on that path this costs one GET and no write.
  await releaseRunLease(ref);

  banner("Done");
  log(`Elapsed ${result.durationSec}s, artifacts: ${result.runDir}`);

  // Nothing below applies to a tick that reviewed nothing, and printing "0 inline comments"
  // over a merged PR reads as a clean review rather than an absent one.
  if (result.skippedReason) {
    log(`No review: ${result.skippedReason}. Re-run with --dry-run to review it anyway.`);
    openRunDir(result.runDir).saveJson(
      "result.json",
      buildResultSummary({
        exitCode: 0,
        skippedReason: result.skippedReason,
        identity: runIdentity(result.ctx.iteration.id, compareTo),
        incomplete: [],
        counts: { raw: 0, anchored: 0, survived: 0, inline: 0, degraded: 0 },
        tokens: tokenTotals(),
        durationSec: result.durationSec,
      }),
    );
    process.exit(0);
  }

  const unmet = result.req ? unmetCriteria(result.req) : [];
  if (result.req?.skipped) log(`Requirement axis: ${result.req.skipped}`);
  else if (result.req?.error) log(`Requirement axis: failed (${result.req.error})`);
  else if (result.req) {
    log(
      `Requirement axis: ${result.req.criteria.length} acceptance criteria, ${unmet.length} unmet` +
        (result.req.extras.length ? `, ${result.req.extras.length} out-of-scope changes` : ""),
    );
  }

  const { inline, degraded, belowBar } = result.agg;
  log(`Code axis: inline comments ${inline.length} | below threshold ${belowBar.length} | unanchored ${degraded.length}`);
  if (result.publishResult) {
    log(
      `Posted ${result.publishResult.posted.length} | already posted ${result.publishResult.alreadyPosted.length}` +
        (result.publishResult.failed.length ? ` | failed ${result.publishResult.failed.length}` : "") +
        (result.publishResult.resolved ? ` | auto-resolved ${result.publishResult.resolved}` : ""),
    );
  }

  // Either axis can fail the run, and a crashed stage is not a clean one; exitCodeFor owns
  // that policy (and the selftest pins it — importing this file would run the CLI).
  const exitCode = exitCodeFor(result);
  if (exitCode === 3) {
    log(`[WARN] Review incomplete — ${result.incomplete.join("; ")}`);
    log("Exiting 3: no blocking findings, but the review did not fully run");
  }

  // The last thing written, on every outcome: one file that answers "what did this run
  // actually do" — the exit code CI acted on included — without replaying the log or
  // opening five other artifacts. Reopened rather than passed down because the run
  // directory belongs to the orchestrator, and only this layer knows the exit code.
  openRunDir(result.runDir).saveJson(
    "result.json",
    buildResultSummary({
      exitCode,
      identity: runIdentity(result.ctx.iteration.id, compareTo),
      incomplete: result.incomplete,
      counts: {
        raw: result.agg.stats.raw,
        anchored: result.agg.stats.anchored,
        survived: result.agg.stats.survived,
        inline: result.agg.stats.inline,
        degraded: degraded.length,
      },
      tokens: tokenTotals(),
      durationSec: result.durationSec,
    }),
  );
  process.exit(exitCode);
}

main().catch(async (e) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  // A crash leaves the branch-policy status showing whatever the last run posted. Exit 1 is
  // invisible to a policy, so without this a run that died on its second iteration merges
  // behind the first one's green check. Best effort and never allowed to replace the real
  // error: if ADO is what just failed, this will fail too, and the fatal message is the one
  // worth keeping.
  // Released before anything else: the next tick of a cron should be able to retry
  // immediately, not wait out an hour of a lease held by a process that is already dead.
  if (fatalRef) await releaseRunLease(fatalRef).catch(() => undefined);

  if (POST_STATUS && fatalRef && !isDryRun()) {
    try {
      await postStatus(fatalRef, "error", `Review crashed: ${String(e instanceof Error ? e.message : e)}`);
    } catch (inner) {
      log(`[WARN] could not report the crash as a PR status: ${inner instanceof Error ? inner.message : String(inner)}`);
    }
  }

  // On a cron over a list of PRs, the ones that FAILED were the only ones leaving no artifact
  // at all: result.json was written after runReview returned, so a throw inside it left a run
  // directory holding findings and nothing saying the run had ended, and a throw before intake
  // left nothing on disk whatsoever — the auth and proxy lines existed only on a terminal
  // nobody was watching. Written into this run's own directory when it got one, so the
  // forensics sit beside the prompts that produced them.
  if (fatalRef) {
    try {
      const dir = currentRunDir();
      // tee on the fallback: attachLogSink replays the backlog, so the [WARN] lines printed
      // before intake land in run.log rather than being lost with the terminal.
      const run = dir ? openRunDir(dir) : createFatalRunDir(fatalRef);
      run.saveJson(
        "result.json",
        buildResultSummary({
          exitCode: 1,
          fatal: e instanceof Error ? e.message : String(e),
          identity: runIdentity(),
          incomplete: [],
          counts: { raw: 0, anchored: 0, survived: 0, inline: 0, degraded: 0 },
          tokens: tokenTotals(),
          durationSec: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
        }),
      );
      log(`artifacts: ${run.dir}`);
    } catch (inner) {
      log(`[WARN] could not record the failure: ${inner instanceof Error ? inner.message : String(inner)}`);
    }
  }
  die(msg);
});
