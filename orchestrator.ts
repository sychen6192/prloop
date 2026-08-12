// The single deterministic control flow. Models are called at exactly one point (the finder
// stage); every other decision — what to review, where a finding lives, what gets posted —
// is made by code here (design principle: the loop never hands control to a model).
import { LEARN_FROM_DISMISSALS, SKIP_REQUIREMENT, SKIP_STATIC, excludedCategories, isDryRun } from "./config";
import { buildReviewContext, type ReviewContext } from "./ado/intake";
import { fetchRepoConventions } from "./ado/conventions";
import { renderConventions } from "./libs/rules";
import { anchorAndDedupe, finalize, mergeToolFindings, type AggregateResult } from "./gates/aggregate";
import { runFinders } from "./gates/finder";
import { runRequirementGate, toRequirementFindings } from "./gates/requirement";
import { applyVerdicts, runSkeptic } from "./gates/skeptic";
import { runStaticGate, triageAndConvert, type StaticResult } from "./gates/static";
import { createRunDir } from "./libs/artifacts";
import { tokenTotals } from "./models/runner";
import { dismissedCategoryHints, loadDismissals } from "./libs/learnings";
import { banner, log } from "./libs/log";
import type { AnchoredFinding, ModelRunner, PrRef, RequirementResult } from "./libs/types";
import { publish, type PublishResult } from "./publish/publish";

export interface ReviewRunOptions {
  ref: PrRef;
  runner: ModelRunner;
  compareTo: number;
}

export interface ReviewRunResult {
  ctx: ReviewContext;
  agg: AggregateResult;
  req?: RequirementResult;
  reqFindings: AnchoredFinding[];
  publishResult?: PublishResult;
  runDir: string;
  durationSec: number;
  /**
   * Stages that failed outright. A crashed gate must not be reported as a clean gate:
   * without this, a requirement axis that died and a requirement axis that passed produce
   * the same exit code, and a CI check goes green on an unverified PR.
   */
  incomplete: string[];
}

export async function runReview(opts: ReviewRunOptions): Promise<ReviewRunResult> {
  const started = Date.now();

  banner("Step 1/4: fetch PR changes");
  const ctx = await buildReviewContext(opts.ref, opts.compareTo);
  const run = createRunDir(opts.ref, ctx.iteration.id);
  log(`artifacts: ${run.dir}`);

  run.saveJson("context.json", {
    ref: opts.ref,
    pr: ctx.pr,
    iteration: ctx.iteration,
    compareTo: ctx.compareTo,
    files: ctx.files.map((f) => ({
      path: f.path,
      changeType: f.changeType,
      language: f.language,
      hunks: f.hunks.length,
      changedLines: f.changedRightLines.size,
    })),
    skipped: ctx.skipped,
  });

  if (ctx.files.length === 0) {
    // Still publish: the sticky summary is what carries the iteration marker forward and
    // what resolves stale threads. Skipping it wedged `--since auto` forever on a
    // docs-only push, and left threads open whose code the push had deleted.
    log("No reviewable code changes — publishing summary only");
    const agg: AggregateResult = {
      inline: [],
      belowBar: [],
      degraded: [],
      stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: 0, byFailure: {}, excluded: 0, dismissed: 0 },
    };
    const durationSec = Math.round((Date.now() - started) / 1000);
    const publishResult = await publish(
      opts.ref,
      { requirement: [], code: [] },
      {
        ctx,
        agg,
        req: { workItems: [], criteria: [], extras: [], skipped: "no reviewable code changes" },
        finderErrors: [],
        omittedFiles: [],
        appliedRules: [],
        staticResult: {
          facts: [],
          needsTriage: [],
          suppressedCount: 0,
          ranTools: [],
          skipped: [],
          staleFiles: [],
          unresolved: 0,
          skippedReason: "no reviewable code changes",
        },
        dismissalHints: [],
        durationSec,
        runDir: run.dir,
      },
    );
    const incomplete: string[] = [];
    if (publishResult.summaryThreadId === undefined && !isDryRun()) {
      incomplete.push("summary comment failed to post");
    }
    return { ctx, agg, reqFindings: [], publishResult, runDir: run.dir, durationSec, incomplete };
  }

  // The two axes run concurrently and blind to each other: neither model sees the other's
  // output, so "the code is clean" can't excuse a missing requirement, or vice versa.
  banner("Step 2/4: static analysis, requirement axis and code axis");

  // The requirement axis is deliberately NOT part of the barrier below. Its output is only
  // needed at publish time, and the gate is non-fatal by design — so letting it hold the
  // pipeline is all cost and no benefit. On a real run its model call ran 300s past the
  // finders and step 3 sat idle the whole time; with a long timeout that idle window is the
  // full timeout. It runs in the background and is collected just before publishing.
  const reqPromise = (
    SKIP_REQUIREMENT
      ? Promise.resolve<Awaited<ReturnType<typeof runRequirementGate>>>({
          result: {
            workItems: [],
            criteria: [],
            extras: [],
            skipped: "requirement check skipped by config",
          },
        })
      : runRequirementGate({ ref: opts.ref, pr: ctx.pr, files: ctx.files, runner: opts.runner })
  ).catch((e): Awaited<ReturnType<typeof runRequirementGate>> => {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[FAIL] requirement axis threw: ${msg}`);
    return { result: { workItems: [], criteria: [], extras: [], error: msg } };
  });

  // The reviewed repo's own convention docs, fetched at the iteration's commit so the
  // rules' "repo conventions override the baseline" clause has real text to fire on
  // instead of the model's memory of a file it was never shown. Non-fatal: most repos
  // have none, and a failed fetch costs the finder its context bonus, not the run.
  const conventions = renderConventions(
    await fetchRepoConventions(opts.ref, ctx.iteration.sourceRefCommit).catch((e) => {
      log(`[WARN] could not fetch repo convention docs: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }),
  );

  // Stages that threw outright (vs returning their own error fields); reported as
  // incomplete so the run exits 3 instead of pretending the stage passed.
  const stageFailures: string[] = [];
  const [staticResult, finderOut] = await Promise.all([
    (SKIP_STATIC
      ? Promise.resolve<StaticResult>({
          facts: [],
          needsTriage: [],
          suppressedCount: 0,
          ranTools: [],
          skipped: [],
          staleFiles: [],
          unresolved: 0,
          skippedReason: "static analysis skipped by config",
        })
      : runStaticGate(ctx.files, ctx.fileIndex, ctx.iteration.sourceRefCommit)
    ).catch((e): StaticResult => {
      stageFailures.push(`static gate (${e instanceof Error ? e.message : String(e)})`);
      return { facts: [], needsTriage: [], suppressedCount: 0, ranTools: [], skipped: [], staleFiles: [], unresolved: 0, skippedReason: "crashed" };
    }),
    runFinders(opts.runner, {
      pr: ctx.pr,
      files: ctx.files,
      iterationId: ctx.iteration.id,
      compareTo: ctx.compareTo,
      conventions,
    }).catch((e): Awaited<ReturnType<typeof runFinders>> => {
      stageFailures.push(`finder stage (${e instanceof Error ? e.message : String(e)})`);
      return { outputs: [], prompt: "", omitted: [], rules: [] };
    }),
  ]);

  if (staticResult.skippedReason) log(`Static analysis: ${staticResult.skippedReason}`);
  run.saveJson("static.json", staticResult);

  const { outputs, prompt, omitted, rules } = finderOut;
  run.save("finder-prompt.md", prompt);
  outputs.forEach((o, i) => {
    run.save(`finder-${i}-${o.model.replace(/[^\w.-]/g, "_")}-raw.txt`, o.raw || `(error: ${o.error ?? "no output"})`);
  });
  run.saveJson("finder-outputs.json", outputs.map((o) => ({ ...o, raw: undefined })));

  banner("Step 3/4: anchor, adversarial verification and verdicts");
  const candidates = anchorAndDedupe(outputs, ctx.fileIndex);

  // Learnings: findings a human already dismissed (on this PR or a previous one) skip the
  // skeptic — no verification budget is spent re-litigating a closed decision — and are
  // suppressed by finalize below. Loaded once; also feeds the config hints in the summary.
  const storedDismissals = LEARN_FROM_DISMISSALS ? loadDismissals(opts.ref) : [];
  const dismissedFps = new Set(storedDismissals.map((d) => d.fingerprint));
  const freshCandidates = candidates.merged.filter((f) => !dismissedFps.has(f.fingerprint));
  const knownDismissed = candidates.merged.filter((f) => dismissedFps.has(f.fingerprint));

  // Adversarial verification. The finder ran in coverage mode and is expected to
  // over-report; this is the stage that does the killing. A skeptic stage that throws must
  // degrade to "nothing verified" (recorded as incomplete below), not abort a run that has
  // already paid for its finder calls.
  const outcomes = await runSkeptic(opts.runner, freshCandidates, ctx.files).catch(
    (e): import("./gates/skeptic").SkepticOutcome[] => {
      stageFailures.push(`skeptic stage (${e instanceof Error ? e.message : String(e)})`);
      return freshCandidates.map((f) => ({ finding: f, verdicts: [], killed: false }));
    },
  );
  const survivors = applyVerdicts(outcomes);
  run.saveJson(
    "skeptic.json",
    outcomes.map((o) => ({
      file: o.finding.file,
      line: o.finding.anchor?.startLine,
      claim: o.finding.claim,
      killed: o.killed,
      verdicts: o.verdicts,
      // The prompt is the audit trail for a wrong refutation — without it, a killed real
      // finding cannot be debugged.
      prompt: o.prompt,
    })),
  );

  // Tool findings join the code axis after triage. They carry real line numbers, so they
  // skip anchoring, and a deterministic tool counts as its own corroboration.
  const toolOut = await triageAndConvert(opts.runner, staticResult, ctx.fileIndex).catch((e) => {
    stageFailures.push(`triage stage (${e instanceof Error ? e.message : String(e)})`);
    return { findings: [], triaged: 0, dropped: 0, excluded: 0 };
  });
  run.saveJson("static-findings.json", toolOut);

  // knownDismissed re-enters here so finalize can route it into the summary with its
  // suppression reason — a suppressed finding must stay visible, never vanish.
  const agg = finalize(
    candidates,
    mergeToolFindings([...survivors, ...knownDismissed], toolOut.findings),
    dismissedFps,
    outcomes.filter((o) => o.killed).length,
  );

  // Collect the requirement axis now — everything that could run without it has run.
  const reqOut = await reqPromise;
  const req = reqOut.result;
  if (reqOut.prompt) run.save("requirement-prompt.md", reqOut.prompt);
  if (reqOut.raw) run.save("requirement-raw.txt", reqOut.raw);
  run.saveJson("requirement.json", req);

  const reqFindings = toRequirementFindings(req, ctx.fileIndex);
  // Attach the tracking id ADO needs for each thread to survive future pushes.
  for (const f of [...agg.inline, ...reqFindings]) {
    f.changeTrackingId = ctx.changeTrackingIds.get(f.file);
  }
  run.saveJson("requirement-findings.json", reqFindings);
  run.saveJson("findings.json", {
    inline: agg.inline,
    belowBar: agg.belowBar,
    degraded: agg.degraded,
    stats: agg.stats,
  });

  banner("Step 4/4: post comments");
  const durationSec = Math.round((Date.now() - started) / 1000);
  const finderErrors = outputs
    .filter((o) => o.error)
    .map((o) => ({ model: o.model, error: o.error! }));

  const publishResult = await publish(
    opts.ref,
    { requirement: reqFindings, code: agg.inline },
    {
      ctx,
      agg,
      req,
      finderErrors,
      omittedFiles: omitted,
      appliedRules: rules,
      staticResult,
      dismissalHints: dismissedCategoryHints(storedDismissals, excludedCategories()),
      durationSec,
      runDir: run.dir,
    },
  );
  const tokens = tokenTotals();
  log(`model usage: ${tokens.calls} calls, ${tokens.promptTokens} in / ${tokens.completionTokens} out tokens`);
  run.saveJson("publish.json", {
    summaryThreadId: publishResult.summaryThreadId,
    posted: publishResult.posted.map((f) => ({ fp: f.fingerprint, file: f.file, line: f.anchor?.startLine })),
    alreadyPosted: publishResult.alreadyPosted.map((f) => f.fingerprint),
    failed: publishResult.failed.map((x) => ({ fp: x.finding.fingerprint, error: x.error })),
    resolved: publishResult.resolved,
    dismissals: publishResult.dismissals,
    tokenUsage: tokens,
  });

  const incomplete: string[] = [...stageFailures];
  if (req.error) incomplete.push(`requirement axis (${req.error})`);
  for (const e of finderErrors) incomplete.push(`finder ${e.model} (${e.error})`);
  const deadSkeptics = outcomes.reduce(
    (n, o) => n + (o.verdicts.length > 0 && o.verdicts.every((v) => v.error) ? 1 : 0),
    0,
  );
  if (deadSkeptics > 0) incomplete.push(`${deadSkeptics} findings whose verifier failed`);
  // A run that computed findings and could not post them must not look like a clean PR.
  if (publishResult.failed.length > 0) {
    incomplete.push(`${publishResult.failed.length} comments failed to post`);
  }
  if (publishResult.summaryThreadId === undefined && !isDryRun()) {
    incomplete.push("summary comment failed to post");
  }

  return { ctx, agg, req, reqFindings, publishResult, runDir: run.dir, durationSec, incomplete };
}
