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
  SHOW_CONFIG,
  SKEPTIC_MODELS,
  excludedCategories,
  isDryRun,
} from "./config";
import { parsePrUrl } from "./ado/client";
import { unmetCriteria } from "./gates/requirement";
import { resolveLastReviewedIteration } from "./publish/lifecycle";
import { configWarnings, renderConfigTable, wantsConfigDump } from "./libs/configreport";
import { banner, die, log } from "./libs/log";
import { createRunner } from "./models/runner";
import { runReview } from "./orchestrator";

function usage(): never {
  console.error(`Usage: prloop <PR URL> [options]

  <PR URL>              https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}

Options:
  --since <iteration>   review only changes after that iteration (incremental)
  --since auto          resume from the last reviewed iteration
  --dry-run             compute everything, post nothing
  --config              print every setting, its value and its source, then exit
  -h, --help            show this help

Exit codes: 0 clean | 2 blocking findings | 3 review incomplete (a stage failed) | 1 fatal

Env vars: see .env.example`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  // Checked before the URL is required: "which value is prloop actually using" is a
  // question you ask when a run went wrong, and it must not need a PR to answer.
  if (wantsConfigDump(args, SHOW_CONFIG)) {
    console.log(renderConfigTable());
    process.exit(0);
  }
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) usage();

  let compareTo = 0;
  let sinceAuto = false;
  const sinceIdx = args.indexOf("--since");
  if (sinceIdx >= 0) {
    const raw = args[sinceIdx + 1];
    if (raw === "auto") sinceAuto = true;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) die(`--since takes a non-negative integer or "auto", got: ${raw}`);
      compareTo = n;
    }
  }

  // The positional scan must skip --since's VALUE ("3" or "auto" doesn't start with "-"),
  // or `prloop --since 3 <URL>` parses "3" as the PR URL.
  const url = args.find((a, i) => !a.startsWith("-") && (sinceIdx < 0 || i !== sinceIdx + 1));
  if (!url) usage();
  if (args.includes("--dry-run")) process.env["PRR_DRY_RUN"] = "1";

  const ref = parsePrUrl(url);
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

  banner("Done");
  log(`Elapsed ${result.durationSec}s, artifacts: ${result.runDir}`);

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

  // Either axis can fail the run: an unimplemented requirement is as blocking as a bug.
  const highRisk = inline.filter((f) => f.severity === "critical" || f.severity === "high");
  if (highRisk.length > 0 || unmet.length > 0) process.exit(2);

  // A stage that crashed must not exit 0. "Nothing blocking was found" and "the check that
  // would have found it never ran" are different facts, and only one of them justifies a
  // green CI gate.
  if (result.incomplete.length > 0) {
    log(`[WARN] Review incomplete — ${result.incomplete.join("; ")}`);
    log("Exiting 3: no blocking findings, but the review did not fully run");
    process.exit(3);
  }
  process.exit(0);
}

main().catch((e) => {
  die(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
});
