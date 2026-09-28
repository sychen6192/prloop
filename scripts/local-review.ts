// Local review driver: build a review context from a local git branch instead of a pull
// request, and review it.
//
//   review   — the whole pipeline, real models included, as a dry run: nothing is posted,
//              because there is no pull request. The run directory under runs/ holds the
//              prompts, the verdicts and review.html, exactly as a PR run's would.
//   prompt   — writes the exact prompt the finder would receive, with no model call
//   anchor   — reads a findings JSON and reports where each comment would actually land
//
// The last two work without a reachable model endpoint. All three run the production code
// paths; `review` substitutes only where the code comes from (git, not ADO), where the
// repository's conventions come from (its own history) and where the criteria come from
// (a file, when one is given).
import * as fs from "node:fs";
import { buildLocalReviewContext, readLocalConventions } from "../git/intake";
import { anchorAndDedupe, finalize } from "../gates/aggregate";
import { FINDER_SEED } from "../config";
import { buildFinderPrompt, FINDER_SYSTEM } from "../prompts/finder";
import { newRunSeed, seedFor } from "../libs/prng";
import { loadRules, renderRules, ruleHeadings, selectRules } from "../libs/rules";
import { parseJsonObject } from "../libs/json";
import { renderSummary } from "../publish/format";
import type { FinderOutput } from "../gates/finder";
import type { RawFinding, WorkItem } from "../libs/types";
import { createRunner } from "../models/runner";
import { exitCodeFor, runReview } from "../orchestrator";

function usage(): never {
  console.error(`Usage:
  tsx scripts/local-review.ts review <repo> <base> <head> [--criteria <file.md>]
  tsx scripts/local-review.ts prompt <repo> <base> <head> [out.md]
  tsx scripts/local-review.ts anchor <repo> <base> <head> <findings.json> [model name]`);
  process.exit(1);
}

/** Acceptance criteria from a file, as the one work item a local branch is judged against. */
function localWorkItem(text: string): WorkItem {
  return {
    id: 1,
    title: "local acceptance criteria",
    type: "User Story",
    state: "Active",
    description: "",
    acceptanceCriteria: text.trim(),
    specSource: "acceptance-criteria",
    url: "",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    // A flag with nothing after it would otherwise review without the criteria and say
    // nothing: the requirement axis skips, and the run looks like one that had none to judge.
    if (v === undefined || v.startsWith("--")) usage();
    argv.splice(i, 2);
    return v;
  };
  const criteriaFile = flag("--criteria");
  const [mode, repo, base, head, arg5, arg6] = argv;
  if (!mode || !repo || !base || !head) usage();

  const ctx = await buildLocalReviewContext({ repo, base, head });
  if (ctx.files.length === 0 && mode !== "review") {
    console.error("No changes to review");
    process.exit(1);
  }

  if (mode === "review") {
    // A dry run by construction: there is no pull request to write to, and the run
    // directory is the review.
    process.env["PRR_DRY_RUN"] = "1";
    const criteria = criteriaFile ? fs.readFileSync(criteriaFile, "utf8") : undefined;
    const result = await runReview({
      ref: ctx.ref,
      runner: await createRunner(),
      compareTo: 0,
      intake: (_ref, _compareTo, o) => buildLocalReviewContext({ repo, base, head, ...(o?.text ? { text: true } : {}) }),
      conventions: (commit) => readLocalConventions(repo, commit),
      workItems: async () => ({ items: criteria ? [localWorkItem(criteria)] : [], inheritedFrom: [] }),
    });
    const { inline, belowBar, degraded } = result.agg;
    console.log(
      `\nReviewed ${result.ctx.files.length} files: ${inline.length} comments, ${belowBar.length} below the bar, ` +
        `${degraded.length} unanchored` +
        (result.req && !result.req.skipped ? `; ${result.req.criteria.length} criteria judged` : ""),
    );
    for (const f of inline) console.log(`  ${f.severity.padEnd(8)} ${f.file}:${f.anchor?.startLine}  ${f.claim}`);
    if (result.incomplete.length > 0) console.log(`Incomplete: ${result.incomplete.join("; ")}`);
    console.log(`\nThe whole run, on one screen: ${result.runDir}/review.html`);
    process.exit(exitCodeFor(result));
  }

  if (mode === "prompt") {
    const rules = selectRules(loadRules(), ctx.files.map((f) => f.path));
    // Same shape as a live run's finder 0: recap included, file order seeded. The seed is
    // printed so the exact prompt can be regenerated with PRR_FINDER_SEED.
    const runSeed = FINDER_SEED ?? newRunSeed();
    const { text } = buildFinderPrompt({
      pr: ctx.pr,
      files: ctx.files,
      iterationId: 1,
      compareTo: 0,
      rules: renderRules(rules),
      ruleHeadings: rules.map((r) => ({ name: r.name, headings: ruleHeadings(r.body) })),
      seed: seedFor(runSeed, 0),
    });
    const full = `${FINDER_SYSTEM}\n\n${"=".repeat(78)}\n\n${text}`;
    if (arg5) {
      fs.writeFileSync(arg5, full);
      console.log(`Prompt written to ${arg5} (${full.length} chars, rules: ${rules.map((r) => r.name).join(", ")}, run seed ${runSeed})`);
    } else {
      console.log(full);
    }
    return;
  }

  if (mode !== "anchor" || !arg5) usage();

  const parsed = parseJsonObject<{ findings?: RawFinding[] }>(fs.readFileSync(arg5, "utf8"));
  if (!parsed.ok) {
    console.error(`Cannot parse findings file: ${parsed.error}`);
    process.exit(1);
  }
  const findings = Array.isArray(parsed.value.findings) ? parsed.value.findings : [];
  const output: FinderOutput = {
    model: arg6 ?? "manual",
    findings,
    rejected: 0,
    raw: "",
  };

  const candidates = anchorAndDedupe([output], ctx.fileIndex);

  console.log(`\n${"=".repeat(78)}\nAnchor results (${findings.length} findings)\n${"=".repeat(78)}`);
  for (const f of candidates.merged) {
    console.log(`  [OK]       ${f.file}:${f.anchor?.startLine}  ${f.severity.padEnd(8)} ${f.claim}`);
  }
  for (const f of candidates.degraded) {
    console.log(`  [DEGRADED] ${f.file}  ${f.anchorFailure}  — ${f.claim}`);
  }

  // No skeptic available offline: treat every anchored finding as verified so the
  // consensus stage doesn't suppress everything for lack of corroboration.
  const survivors = candidates.merged.map((f) => ({ ...f, skepticVerdicts: 1, skepticRefuted: 0 }));
  const agg = finalize(candidates, survivors);

  console.log(`\n${"=".repeat(78)}\nSummary to be posted\n${"=".repeat(78)}`);
  console.log(
    renderSummary({
      ctx,
      agg,
      finderErrors: [],
      omittedFiles: [],
      appliedRules: selectRules(loadRules(), ctx.files.map((f) => f.path)).map((r) => r.name),
      durationSec: 0,
      runDir: "",
    }),
  );
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
