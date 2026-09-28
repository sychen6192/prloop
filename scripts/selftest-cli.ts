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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BATCH_CHILD_ENV,
  FATAL_STREAK_LIMIT,
  batchExitCode,
  childCommand,
  childEnv,
  describeResult,
  forwardedArgs,
  overridesFor,
  parseBatchList,
  parseRepoOverrides,
  readBatchList,
  renderBatchReport,
  runBatch,
} from "../libs/batch";
import { runsDirWarning } from "../libs/artifacts";
import { KNOWN_KEYS } from "../config";
import { parseArgs } from "../libs/cli";
import { exitCodeFor } from "../orchestrator";
import type { AnchoredFinding, CriterionCheck, ReqVerdict, RequirementResult } from "../libs/types";
import type { AggregateResult } from "../gates/aggregate";
import { check, eq, report, section } from "./selftest/harness";

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

section("--batch: review a list of pull requests and keep the exit codes");
{
  // The README's own daily job is `while read -r url; do prloop "$url" || true; done`, and
  // the `|| true` is not laziness: without it the first PR with a blocking finding stops the
  // loop, so the only way to review the rest is to throw every exit code away.
  eq("a file of URLs is a batch, not a PR argument", parseArgs(["--batch", "prs.txt"]).batch, "prs.txt");
  // The rule libs/cli.ts exists for, now applying to a second option: a file path does not
  // start with "-", so without skipping the value it is read as the positional PR URL.
  eq("...and the file is never mistaken for the URL", parseArgs(["--batch", "prs.txt"]).url, undefined);
  eq("...even beside --since", parseArgs(["--since", "3", "--batch", "prs.txt"]).url, undefined);
  eq("...while a real URL beside --since still parses", parseArgs(["--since", "3", URL_ARG]).url, URL_ARG);
  check("--batch with no file is an error", (parseArgs(["--batch"]).error ?? "").includes("--batch takes a file"), "");
  check("...as is --batch followed by another flag", (parseArgs(["--batch", "--dry-run"]).error ?? "").includes("--batch takes a file"), "");
  // Reviewing one PR and a list of them in the same process is not a thing, and the likelier
  // reading of the pair is a mistake.
  check("a URL and a batch together is an error", (parseArgs([URL_ARG, "--batch", "prs.txt"]).error ?? "").includes("do not also pass a URL"), "");

  // Every other flag is forwarded to every child, so `--batch prs.txt --since auto` means
  // what it reads as.
  eq("--batch and its file are not forwarded", forwardedArgs(["--batch", "prs.txt", "--since", "auto"]), ["--since", "auto"]);
  eq("...and nothing else is dropped", forwardedArgs(["--dry-run", "--batch", "p", "--since", "3"]), ["--dry-run", "--since", "3"]);

  // The list. A `#` inside a line is part of a URL, so only a line that STARTS with one is a
  // comment — truncating at an inline `#` would silently review a different pull request.
  const list = parseBatchList(`# nightly\n${URL_ARG}\n\n   \n${URL_ARG.replace("4821", "4822")}\n`);
  eq("comments and blank lines are skipped", list.urls.length, 2);
  eq("...and nothing is wrong with the file", list.errors, []);
  const bad = parseBatchList(`${URL_ARG}\nnot-a-url\n`);
  eq("a line that is not a PR URL is named with its line number", bad.errors.length, 1);
  check("...by line number", (bad.errors[0] ?? "").startsWith("line 2:"), bad.errors[0]);

  // Validated before the first child is spawned: a typo on line 40 of a 60-line list used to
  // surface two hours in, after everything above it had been reviewed and paid for.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-batch-"));
  try {
    const file = path.join(dir, "prs.txt");
    fs.writeFileSync(file, `${URL_ARG}\nnope\n`);
    let err = "";
    try {
      readBatchList(file);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    check("a bad line stops the batch before anything is reviewed", err.includes("nothing was reviewed") && err.includes("line 2"), err);
    fs.writeFileSync(file, "# only comments\n");
    let empty = "";
    try {
      readBatchList(file);
    } catch (e) {
      empty = e instanceof Error ? e.message : String(e);
    }
    check("...and so does a file with no pull requests in it", empty.includes("lists no pull requests"), empty);
    fs.writeFileSync(file, `${URL_ARG}\n`);
    eq("a good file reads back", readBatchList(file), [URL_ARG]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The batch's own status: the worst thing that happened to anything in it. 1 outranks
  // everything because it does not describe a pull request at all — prloop could not run.
  eq("all clean is clean", batchExitCode([0, 0, 0]), 0);
  eq("one blocking finding is blocking", batchExitCode([0, 2, 0]), 2);
  eq("one incomplete review is incomplete", batchExitCode([0, 3, 0]), 3);
  eq("blocking outranks incomplete, exactly as it does for one run", batchExitCode([3, 2]), 2);
  eq("...and a fatal outranks both", batchExitCode([2, 3, 1]), 1);
  eq("an empty batch is clean", batchExitCode([]), 0);

  // The exit code alone cannot say what happened: 0 covers both "clean" and "the PR had
  // already merged", and 3 names no stage. The child wrote all of it into result.json.
  eq("a merged PR is not silently reported as clean", describeResult({ skippedReason: "the pull request is completed" }, 0), "no review: the pull request is completed");
  eq("a crash reports what killed it", describeResult({ fatal: "HTTP 401: unauthorized" }, 1), "HTTP 401: unauthorized");
  eq("an incomplete review names a stage", describeResult({ incomplete: ["finder qwen (timeout)"], counts: { inline: 2 } }, 3), "2 inline comments, review incomplete: finder qwen (timeout)");
  eq("a clean run says so", describeResult({ incomplete: [], counts: { inline: 0 } }, 0), "clean");
  eq("...and a run whose artifact is missing falls back to the code", describeResult(undefined, 3), "exit 3 (no result.json found)");

  // prloop runs under tsx, whose loader lives in execArgv. Re-running `node loop.ts` without
  // it fails on the first TypeScript file.
  const cmd = childCommand(["a", "b"]);
  eq("a child is this same node", cmd.file, process.execPath);
  check("...with this same loader", process.execArgv.every((a) => cmd.args.includes(a)), cmd.args.join(" "));
  eq("...and the arguments last", cmd.args.slice(-2), ["a", "b"]);

  // End to end, with a child that is not prloop: the loop, the tally and the table are the
  // parts with the decisions in them, and they must be assertable without a review.
  const sh = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-child-"));
  try {
    const script = path.join(sh, "child.mjs");
    // Exits with the PR number, so the batch sees 1, 1, 1, ... and must stop.
    fs.writeFileSync(script, "process.exit(Number(process.argv[2].split('/').pop()));\n");
    const realArgv1 = process.argv[1] ?? "";
    process.argv[1] = script;
    try {
      // The child exits with the PR number, so a list of 1s is three fatals in a row.
      const base = "https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/";
      const urls = [1, 1, 1, 2, 2].map((n) => `${base}${n}`);
      const outcomes = await runBatch(urls, []);
      eq(`the batch stops after ${FATAL_STREAK_LIMIT} fatals in a row`, outcomes.filter((o) => o.exitCode === undefined).length, 2);
      eq("...and the ones it did run kept their codes", outcomes.slice(0, 3).map((o) => o.exitCode), [1, 1, 1]);
      eq("...while the rest say they were never attempted", outcomes[3]?.detail, "not attempted");
      const table = renderBatchReport(outcomes);
      check("the table has a row per pull request", table.split("\n").length === outcomes.length + 1, table);
      check("...and an unattempted one has no exit code to show", table.includes("—"), table);
    } finally {
      process.argv[1] = realArgv1;
    }
  } finally {
    fs.rmSync(sh, { recursive: true, force: true });
  }
}

section("--active, per-repository settings and parallel batches: the unattended mode");
{
  const PROJECT = "https://dev.azure.com/contoso/Shop";
  eq("--active takes a project or repository URL", parseArgs(["--active", PROJECT, "--since", "auto"]).active, PROJECT);
  eq("...which is never mistaken for a pull request URL", parseArgs(["--active", PROJECT]).url, undefined);
  check("...and must be given one", (parseArgs(["--active"]).error ?? "").includes("--active takes a project"), "");
  check("...not beside a URL", (parseArgs([URL_ARG, "--active", PROJECT]).error ?? "").includes("do not also pass a URL or --batch"), "");
  check("...nor beside --batch", (parseArgs(["--batch", "p.txt", "--active", PROJECT]).error ?? "").includes("do not also pass"), "");
  eq("--active and its URL are not forwarded to the children", forwardedArgs(["--active", PROJECT, "--since", "auto", "--dry-run"]), ["--since", "auto", "--dry-run"]);

  const known = new Set(KNOWN_KEYS.map((k) => k.name));
  const overrides = parseRepoOverrides(
    JSON.stringify({ "shop-api": { PRR_FINDER_MODELS: "a,b,c", PRR_MAX_INLINE_COMMENTS: 4 }, "Shop/Shop-Web": { PRR_RISK_TIERS: true } }),
    known,
  );
  const ref = (repoId: string) => ({ baseUrl: "", org: "contoso", project: "Shop", repoId, prId: 1 });
  eq("a repository's settings, numbers and booleans as the text a setting is", overridesFor(overrides, ref("shop-api")), { PRR_FINDER_MODELS: "a,b,c", PRR_MAX_INLINE_COMMENTS: "4" });
  eq("...matched as project/repo, without case", overridesFor(overrides, ref("shop-web")), { PRR_RISK_TIERS: "true" });
  eq("...and nothing for a repository not named", overridesFor(overrides, ref("billing")), {});
  const refused = (json: string) => {
    try {
      parseRepoOverrides(json, known);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  check("a misspelled setting is refused before anything runs", refused('{"a": {"PRR_FINDER_MODEL": "x"}}').includes("PRR_FINDER_MODEL is not a prloop setting"));
  check("...every problem at once", refused('{"a": {"PRR_X": "1", "PRR_Y": "2"}}').includes("PRR_Y"));
  check("the runs directory is not per repository: the batch reads each child's result there", refused('{"a": {"PRR_RUNS_DIR": "/x"}}').includes("cannot be set per repository"));
  check("...and a file that is not an object of objects is refused", refused("[1]").includes("must be a JSON object") && refused('{"a": 1}').includes("expected an object"));

  // Each child's share of the whole-process limits, never all of it.
  const env = childEnv({ PATH: "/bin" }, { PRR_FINDER_MODELS: "a" }, 3, { llm: 8, ado: 6 });
  eq("a child runs with its repository's settings", env["PRR_FINDER_MODELS"], "a");
  eq("...and a third of each limit, three at a time", [env["PRR_LLM_CONCURRENCY"], env["PRR_ADO_CONCURRENCY"]], ["2", "2"]);
  eq("...never less than one", childEnv({}, {}, 16, { llm: 8, ado: 6 })["PRR_LLM_CONCURRENCY"], "1");
  eq("...a repository's own limit shared the same way", childEnv({}, { PRR_LLM_CONCURRENCY: "12" }, 3, { llm: 8, ado: 6 })["PRR_LLM_CONCURRENCY"], "4");
  eq("...no cap stays no cap", childEnv({}, {}, 2, { llm: 0, ado: 6 })["PRR_LLM_CONCURRENCY"], undefined);
  eq("...and alone, a child gets the whole limit", childEnv({}, {}, 1, { llm: 8, ado: 6 })["PRR_LLM_CONCURRENCY"], undefined);
  eq("every child is marked as one", env[BATCH_CHILD_ENV], "1");

  // Side by side, end to end, with a child that is not prloop: it writes down what it ran with.
  const sh = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-parallel-"));
  try {
    const script = path.join(sh, "child.mjs");
    const seen = path.join(sh, "seen");
    fs.mkdirSync(seen);
    fs.writeFileSync(
      script,
      `import * as fs from "node:fs";\n` +
        `const id = process.argv[2].split("/").pop();\n` +
        `const start = Date.now();\n` +
        `console.log("reviewed " + id);\n` +
        `setTimeout(() => {\n` +
        `  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PRR_")));\n` +
        `  fs.writeFileSync(${JSON.stringify(seen)} + "/" + id, JSON.stringify({ env, start, end: Date.now() }));\n` +
        `  process.exit(0);\n` +
        `}, 500);\n`,
    );
    const realArgv1 = process.argv[1] ?? "";
    process.argv[1] = script;
    try {
      const base = "https://dev.azure.com/contoso/Shop/_git/";
      const urls = [`${base}shop-api/pullrequest/1`, `${base}shop-web/pullrequest/2`, `${base}shop-api/pullrequest/3`, `${base}shop-web/pullrequest/4`];
      const outcomes = await runBatch(urls, [], { parallel: 2, overrides, limits: { llm: 8, ado: 6 } });
      eq("every pull request of a parallel batch is reviewed", outcomes.map((o) => o.exitCode), [0, 0, 0, 0]);
      const ran = [1, 2, 3, 4].map(
        (n) => JSON.parse(fs.readFileSync(path.join(seen, String(n)), "utf8")) as { env: Record<string, string>; start: number; end: number },
      );
      eq("...each child with half of the model limit", ran.map((r) => r.env["PRR_LLM_CONCURRENCY"]), ["4", "4", "4", "4"]);
      eq("...and its own repository's settings", [ran[0]!.env["PRR_FINDER_MODELS"], ran[2]!.env["PRR_FINDER_MODELS"]], ["a,b,c", "a,b,c"]);
      check("...never another repository's", ran[1]!.env["PRR_FINDER_MODELS"] !== "a,b,c" && ran[3]!.env["PRR_FINDER_MODELS"] !== "a,b,c");
      check("...two at a time: the first two ran side by side", ran[0]!.start < ran[1]!.end && ran[1]!.start < ran[0]!.end, JSON.stringify(ran));
    } finally {
      process.argv[1] = realArgv1;
    }
  } finally {
    fs.rmSync(sh, { recursive: true, force: true });
  }

  // Where the dismissals live, and whether it outlives the job.
  const ws = process.platform === "win32" ? "C:\\agent\\_work\\1" : "/srv/agent/_work/1";
  eq("a run on a laptop is not warned about", runsDirWarning({}, process.platform === "win32" ? "C:\\prloop\\runs" : "/srv/prloop/runs"), undefined);
  check(
    "in a pipeline, the default runs directory inside the workspace is warned about",
    (runsDirWarning({ TF_BUILD: "True", AGENT_BUILDDIRECTORY: ws }, path.join(ws, "s", "prloop", "runs")) ?? "").includes("Azure Pipelines job's workspace"),
  );
  eq(
    "...but not one set on purpose, which the job restores and saves",
    runsDirWarning({ TF_BUILD: "True", AGENT_BUILDDIRECTORY: ws, PRR_RUNS_DIR: path.join(ws, "runs") }, path.join(ws, "runs")),
    undefined,
  );
  check("the temporary directory is warned about anywhere", (runsDirWarning({ PRR_RUNS_DIR: "x" }, path.join(os.tmpdir(), "runs")) ?? "").includes("temporary directory"));
}

report();
