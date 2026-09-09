// Offline self-test for the two decisions the CLI makes on its own: what the arguments
// meant, and what the review result means as an exit status.
//
// Neither could be tested before. Importing loop.ts RUNS it — `main().catch()` sits at module
// scope — so the only reachable assertion about the entry point was spawning `--help` and
// reading stdout. Both halves are now pure functions (libs/cli.ts, orchestrator.exitCodeFor)
// and loop.ts calls them; main() is otherwise unchanged.
//
// What they are worth: `prloop --since 3 <URL>` used to be one careless edit away from
// parsing "3" as the PR URL, and the exit status is the only part of a run that CI reads —
// a review that could not finish must not answer a gate with the same 0 as a clean one.
import { parseArgs } from "../libs/cli";
import { exitCodeFor } from "../orchestrator";
import type { AnchoredFinding, CriterionCheck, ReqVerdict, RequirementResult } from "../libs/types";
import type { AggregateResult } from "../gates/aggregate";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

function section(t: string) {
  console.log(`\n${t}`);
}

const URL_ARG = "https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4821";

section("argument grammar: the PR URL survives every flag order");
{
  const plain = parseArgs([URL_ARG]);
  eq("a bare URL is the URL", plain.url, URL_ARG);
  eq("...with no --since", plain.since, undefined);
  eq("...and no dry run", plain.dryRun, false);

  // The subtle one: "3" and "auto" do not start with "-", so the positional scan has to skip
  // --since's value explicitly. Without that, this parses "3" as the PR URL and the run dies
  // on an unparseable URL instead of doing what was asked.
  eq("flags first: the URL is still found", parseArgs(["--since", "3", URL_ARG]).url, URL_ARG);
  eq("...and --since's value is not mistaken for it", parseArgs(["--since", "3", URL_ARG]).since, 3);
  eq("flags last", parseArgs([URL_ARG, "--since", "3"]).url, URL_ARG);
  eq("flags either side", parseArgs(["--dry-run", URL_ARG, "--since", "7"]).url, URL_ARG);
  eq("...with the iteration read off correctly", parseArgs(["--dry-run", URL_ARG, "--since", "7"]).since, 7);
  eq("the auto value is not a number", parseArgs(["--since", "auto", URL_ARG]).since, "auto");
  eq("...and does not swallow the URL either", parseArgs(["--since", "auto", URL_ARG]).url, URL_ARG);
  eq("--since 0 is the full PR, not a missing value", parseArgs([URL_ARG, "--since", "0"]).since, 0);

  eq("--dry-run is picked up wherever it sits", parseArgs(["--dry-run", URL_ARG]).dryRun, true);
  eq("...and is off unless asked for", parseArgs([URL_ARG]).dryRun, false);
  check("--help is a request, not an error", parseArgs(["--help"]).help && parseArgs(["-h"]).help);
  check("...and is not implied by anything else", !parseArgs([URL_ARG, "--dry-run"]).help);
  check("--config is recognised without a URL", parseArgs(["--config"]).showConfig);
  check("...as is PRR_SHOW_CONFIG, passed in rather than read here", parseArgs([], true).showConfig);
  check("...and neither fires on an ordinary run", !parseArgs([URL_ARG, "--dry-run"]).showConfig);
}

section("argument grammar: what is refused, and refused without exiting");
{
  // parseArgs never exits or prints. Which mistakes are fatal is main()'s decision — that
  // separation is the only reason any of this is testable at all.
  const bad = parseArgs([URL_ARG, "--since", "three"]);
  check("a non-numeric --since is an error", (bad.error ?? "").includes("--since takes"), bad.error);
  eq("...and yields no iteration to review from", bad.since, undefined);
  check("...while the URL is still parsed, so the message can be about --since alone", bad.url === URL_ARG);
  check("a negative --since is an error", (parseArgs([URL_ARG, "--since", "-2"]).error ?? "").includes("--since takes"));
  check("a fractional --since is an error", (parseArgs([URL_ARG, "--since", "1.5"]).error ?? "").includes("--since takes"));
  check("--since with nothing after it is an error, not a silent full review",
    (parseArgs([URL_ARG, "--since"]).error ?? "").includes("--since takes"));
  eq("no arguments at all yields no URL", parseArgs([]).url, undefined);
  eq("...and flags alone still yield no URL", parseArgs(["--dry-run"]).url, undefined);
  eq("a valid invocation carries no error", parseArgs([URL_ARG, "--since", "auto"]).error, undefined);
}

section("exit status: the only part of a run that CI reads");
{
  const agg = (inline: AnchoredFinding[]): AggregateResult => ({
    inline,
    belowBar: [],
    degraded: [],
    stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: inline.length, byFailure: {}, excluded: 0, dismissed: 0 },
  });
  const f = (severity: AnchoredFinding["severity"]): AnchoredFinding => ({
    category: "correctness",
    severity,
    confidence: 0.9,
    file: "src/app.ts",
    quote: "q",
    claim: "c",
    sources: ["m"],
    fingerprint: `fp-${severity}`,
  });
  const req = (...verdicts: ReqVerdict[]): RequirementResult => ({
    workItems: [],
    criteria: verdicts.map((verdict, i): CriterionCheck => ({ workItemId: 1, criterion: `c${i}`, verdict, note: "" })),
    extras: [],
  });

  eq("a clean run exits 0", exitCodeFor({ agg: agg([]), incomplete: [] }), 0);
  eq("a high finding exits 2", exitCodeFor({ agg: agg([f("high")]), incomplete: [] }), 2);
  eq("...so does a critical one", exitCodeFor({ agg: agg([f("critical")]), incomplete: [] }), 2);
  eq("a medium finding does not block", exitCodeFor({ agg: agg([f("medium")]), incomplete: [] }), 0);
  eq("...nor a low one", exitCodeFor({ agg: agg([f("low")]), incomplete: [] }), 0);

  // An unimplemented requirement is as blocking as a bug: the requirement axis exists
  // because a PR that compiles cleanly and does the wrong thing is the expensive failure.
  eq("an unmet criterion exits 2 with no code findings at all",
    exitCodeFor({ agg: agg([]), req: req("missing"), incomplete: [] }), 2);
  eq("...partial counts too", exitCodeFor({ agg: agg([]), req: req("partial"), incomplete: [] }), 2);
  eq("...and misunderstood", exitCodeFor({ agg: agg([]), req: req("misunderstood"), incomplete: [] }), 2);
  eq("satisfied criteria do not", exitCodeFor({ agg: agg([]), req: req("satisfied"), incomplete: [] }), 0);
  // Scope, not a failure: criteria a work item asks for that this PR never owed. Counting
  // them failed the build over work nobody in this PR was asked to do.
  eq("not-this-pr is scope information, not a blocker",
    exitCodeFor({ agg: agg([]), req: req("not-this-pr"), incomplete: [] }), 0);
  eq("...and neither is not-verifiable",
    exitCodeFor({ agg: agg([]), req: req("not-verifiable"), incomplete: [] }), 0);

  // The whole reason 3 exists: "nothing blocking was found" and "the check that would have
  // found it never ran" must not answer a CI gate with the same status.
  eq("a crashed stage exits 3 even with a spotless finding list",
    exitCodeFor({ agg: agg([]), incomplete: ["skeptic stage (boom)"] }), 3);
  eq("...and even with a satisfied requirement axis",
    exitCodeFor({ agg: agg([]), req: req("satisfied"), incomplete: ["finder m (timeout (900s))"] }), 3);
  eq("...and comments that failed to post are incompleteness too",
    exitCodeFor({ agg: agg([f("low")]), incomplete: ["1 comments failed to post"] }), 3);

  // When both are true, 2 wins: it is the stronger statement, and the incomplete stages are
  // named in the log either way.
  eq("a blocking finding outranks incompleteness",
    exitCodeFor({ agg: agg([f("critical")]), incomplete: ["static gate (crashed)"] }), 2);
  eq("...as does an unmet criterion",
    exitCodeFor({ agg: agg([]), req: req("missing"), incomplete: ["static gate (crashed)"] }), 2);

  // A run with no requirement axis at all (skipped by config) is not a failed one.
  eq("an absent requirement result is not an unmet criterion", exitCodeFor({ agg: agg([]), incomplete: [] }), 0);
  eq("...nor is a skipped axis",
    exitCodeFor({ agg: agg([]), req: { workItems: [], criteria: [], extras: [], skipped: "no linked work item" }, incomplete: [] }), 0);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
