// Offline review driver: build a review context from a local git branch, emit the finder
// prompt, and (given a findings file) run the real anchoring + consensus pipeline over it.
//
// Two phases so a review can be done without a reachable model endpoint:
//   prompt   — writes the exact prompt the finder would receive
//   anchor   — reads a findings JSON and reports where each comment would actually land
//
// The anchoring, dedupe and consensus code paths are the production ones; only the model
// call is substituted.
import * as fs from "node:fs";
import { buildLocalReviewContext } from "../git/intake";
import { anchorAndDedupe, finalize } from "../gates/aggregate";
import { buildFinderPrompt, FINDER_SYSTEM } from "../prompts/finder";
import { loadRules, renderRules, selectRules } from "../libs/rules";
import { parseJsonObject } from "../libs/json";
import { renderSummary } from "../publish/format";
import type { FinderOutput } from "../gates/finder";
import type { RawFinding } from "../libs/types";

function usage(): never {
  console.error(`Usage:
  tsx scripts/local-review.ts prompt <repo> <base> <head> [out.md]
  tsx scripts/local-review.ts anchor <repo> <base> <head> <findings.json> [model name]`);
  process.exit(1);
}

async function main() {
  const [mode, repo, base, head, arg5, arg6] = process.argv.slice(2);
  if (!mode || !repo || !base || !head) usage();

  const ctx = await buildLocalReviewContext({ repo, base, head });
  if (ctx.files.length === 0) {
    console.error("No changes to review");
    process.exit(1);
  }

  if (mode === "prompt") {
    const rules = selectRules(loadRules(), ctx.files.map((f) => f.path));
    const { text } = buildFinderPrompt({
      pr: ctx.pr,
      files: ctx.files,
      iterationId: 1,
      compareTo: 0,
      rules: renderRules(rules),
    });
    const full = `${FINDER_SYSTEM}\n\n${"=".repeat(78)}\n\n${text}`;
    if (arg5) {
      fs.writeFileSync(arg5, full);
      console.log(`Prompt written to ${arg5} (${full.length} chars, rules: ${rules.map((r) => r.name).join(", ")})`);
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

  const candidates = anchorAndDedupe([output], ctx.index);

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
