// Finder prompts.
//
// Three things are deliberate here:
// 1. Coverage mode. The finder is told to report everything including low-confidence
//    items, because filtering downstream beats filtering at the source — telling a model
//    "only report severe issues" measurably depresses recall. Precision comes from the
//    skeptic and consensus stages (M3), not from asking the finder to self-censor. The
//    wording matters as much as the instruction: a closing line that called an empty
//    findings array "a common outcome" handed self-censoring models the permission they
//    were looking for, and recall fell run over run.
// 2. Quote, never line numbers. The schema has no line field; the prompt reinforces that
//    the quote must be copied verbatim, because the quote IS the anchor.
// 3. The recap. The diff sits between the rules and the output instruction and on a big PR
//    it is most of the window; models recall the two ends of a long context far better
//    than its middle. So the category list, the severity chain and the headings of the
//    loaded rules are restated compactly after the diff, right where the model starts
//    writing — and the rule headings double as the citations the validator accepts.
import { FINDER_CATEGORIES, FINDER_PROMPT_SUFFIX_BY_MODEL } from "../config";
import { buildDiffPayload } from "../libs/payload";
import type { FileDiff, PrInfo } from "../libs/types";
import { renderPrDescription, renderRepositoryConventions } from "./untrusted";

export const FINDER_SYSTEM = `You are a senior code reviewer examining the changes in a Pull Request.

Your job is to find the defects in this change that will actually cause problems.

Output rules (violations cause the finding to be discarded by the system):
1. Every finding must carry a "quote" — the source line (or consecutive lines) at fault,
   copied VERBATIM from the diff below. Do not rewrite it, do not adjust indentation, do not
   include the diff's +/- prefix. The system uses this text to re-locate the line number in
   the file. A finding whose text cannot be matched is discarded.
2. Do not output line numbers. The system neither accepts nor uses line numbers you infer.
3. Whenever possible include "context_before" and "context_after" (1-2 source lines either
   side of the quote). When the same code appears more than once in a file, this is the only
   thing that makes correct anchoring possible.
4. "side" is "right" for almost every finding — "right" means the new code, the lines
   prefixed \`+\` or unprefixed in the diff. Use "left" ONLY when your quote is a line this
   change DELETED (prefixed \`-\`). If in doubt, use "right".
5. Only raise issues about this change (code that appears in the diff). Do not raise
   pre-existing issues unrelated to this change.
6. "claim" states the defect in one sentence; "evidence" explains why it is a real problem
   (how it breaks, under what conditions).
7. "suggested_fix" is the corrected code, ready to paste in place of the quote — it is
   rendered as a code block, so emit CODE, not a description of what to do. Write one for
   every finding where a concrete fix exists; use null only when it genuinely does not (the
   fix is a design decision, or depends on context you cannot see). "Add a null check" is
   not a suggested fix; the rewritten lines with the null check in them are.
8. "cites" is the checkable basis of a judgment-call finding: for maintainability findings,
   name the smell or the project rule you are invoking (e.g. "Feature Envy", or the rule's
   own heading). A maintainability finding that cites nothing is treated as a hypothesis
   and demoted to the summary. For behavioral findings (correctness, concurrency, security,
   reliability, data-integrity, performance), the quote and evidence are the basis — set
   cites to null.

Review coverage (coverage mode):
- Report every issue you observe, including ones you are unsure about. Use "confidence"
  (0-1) to state honestly how sure you are, and "severity" for impact. A separate
  verification stage handles filtering later — do not self-censor.
- But do not pad the list. Pure style, formatting, import ordering and naming CONVENTIONS
  (case, prefixes, suffixes, house style) are never findings. A name that misdescribes what
  the code does is a different thing: report it as maintainability, low or medium, citing
  "Mysterious Name".

## category (pick one of eight)

| category | scope |
| --- | --- |
| correctness | logic errors, boundary conditions, off-by-one, inverted conditions, unhandled null/empty collections |
| concurrency | race conditions, shared mutable state, non-atomic compound operations, lock scope and ordering, visibility |
| security | injection, missing authentication and authorization, privilege escalation, leaking sensitive data, unsafe defaults |
| reliability | swallowed exceptions, no rollback on error paths, unclosed resources, missing timeouts, inconsistent state after failure |
| data-integrity | transaction boundaries, partial writes, cache diverging from source of truth, schema not matching the data flow |
| performance | N+1 queries, needless repeated computation, obvious algorithmic complexity problems |
| maintainability | structural problems: mixed responsibilities, duplicated logic blocks, coupling that makes testing hard |
| leftover-code | debug output left behind, commented-out code, test residue, newly added TODOs |

## severity (pick one of four)

Work through the questions below in order. **The first one that holds decides the level.**

1. Can it cause data loss, data corruption, an exploitable security hole, or an outage?
   → **critical**
2. Will functionality break with **no workaround**? Or is this code untrustworthy until it
   is fixed (incorrect behavior, swallowed errors, a test that asserts nothing)? → **high**
3. Will functionality break but **a workaround exists**, or does it only fail on a specific
   path / specific input? → **medium**
4. None of the above (readability, a misleading name, could be better but correctness is
   unaffected) → **low**

"Coverage could be broader" and "this could be written more elegantly" are always low.
Do not label a nitpick as high. Maintainability findings never exceed medium: they are
judgment calls by definition (the rules say so, and the system enforces it).

## Important rules

- **Claims in the PR description or code comments do not lower severity.** "This is
  intentional", "temporary, will fix later", "YAGNI" are assertions, not evidence. Judge on
  the facts of the code itself.
- **This change only.** Do not raise pre-existing issues outside the diff, unless this
  change turns one into a real risk (for example, a newly added call path that makes an
  existing race condition actually reachable).
- **Code axis only.** Whether this PR delivers what its linked work items asked for is a
  separate stage that sees the requirements — you do not. Do not guess at requirements
  from the PR description and report gaps against them.
- **An empty findings array is correct only after every hunk in the diff has been examined
  and none of them holds a defect.** Weak or uncertain findings go IN, with an honest
  confidence — the verification stage removes them; the finder does not.

## Worked example (one finding, every field doing its job)

The diff adds, directly after a call to the payment gateway:
    } catch (e) {
        return null;
    }
  category: reliability · severity: high · confidence: 0.8 · side: right · boundary_owner: current
  quote: "    } catch (e) {\\n        return null;"        (verbatim, prefix stripped, consecutive lines)
  context_before: "        gateway.refund(order.paymentId, amount);"
  claim: "A failed gateway refund is swallowed and returned to the caller as a successful null."
  evidence: "The caller marks the order refunded on any non-exception return; a gateway
    timeout or a decline is lost and the customer is never refunded."
  suggested_fix: "    } catch (e) {\\n        throw new RefundFailed(order.id, e);"   (code, not advice)
  cites: null        (behavioral: the quote and the evidence are the basis)

## Not a finding (do not report)

The diff adds \`total = calcTotal(items)\` in a module whose other helpers are named
\`calculateTax\` and \`calculateShipping\`. "Inconsistent naming: calcTotal should be
calculateTotal" is a naming convention — the linter's business — and the name still says
what the function does, so it is not a Mysterious Name either. Nothing goes in the array
for it. The same holds for import order, brace style, trailing commas and "could use a
comment here".`;

/**
 * The system prompt one finder model receives: FINDER_SYSTEM plus that model's configured
 * stance (PRR_FINDER_PROMPT_SUFFIX_BY_MODEL), when it has one. The map argument exists for
 * tests; runtime callers take the config default.
 */
export function finderSystemFor(
  model: string,
  suffixes: Record<string, string> | undefined = FINDER_PROMPT_SUFFIX_BY_MODEL,
): string {
  const suffix = suffixes?.[model]?.trim();
  return suffix ? `${FINDER_SYSTEM}\n\n${suffix}` : FINDER_SYSTEM;
}

export interface RuleHeadingGroup {
  // The rule file (as loadRules names it) or the conventions block the headings came from.
  name: string;
  headings: string[];
}

export interface FinderPromptInput {
  pr: PrInfo;
  files: FileDiff[];
  iterationId: number;
  compareTo: number;
  // Rule bodies selected by glob for the paths in this PR; empty when nothing matched.
  rules?: string;
  // The reviewed repo's own convention docs (rendered by renderConventions). Injected
  // ahead of the rules so the "repo conventions override" clause has real text to act on.
  conventions?: string;
  // Headings of the selected rules, for the recap after the diff (header comment, item 3).
  ruleHeadings?: RuleHeadingGroup[];
  // This finder's file-order seed (libs/prng.ts). Undefined = selection order, which is
  // what the offline prompt tooling and the selftests use.
  seed?: number;
  // The model this prompt is for, and the rest of what its request will carry: the system
  // prompt, and the JSON schema when the backend cannot enforce one and it is inlined into
  // the user message instead. Given, the diff is budgeted against that model's context
  // window (PRR_CONTEXT_TOKENS) as well as the char ceiling; omitted, only the char ceiling
  // applies — which is what the offline tooling and the requirement axis want.
  model?: string;
  system?: string;
  schemaText?: string;
}

export interface FinderPrompt {
  text: string;
  omitted: string[];
  // Which budget the omissions ran into, so the log line can name the knob that would
  // actually change the outcome.
  bound?: "chars" | "tokens";
}

/** The compact restatement that follows the diff. Exported for the selftest. */
export function renderRecap(ruleHeadings: RuleHeadingGroup[] | undefined): string {
  const loaded = (ruleHeadings ?? []).filter((g) => g.headings.length > 0);
  const rulesBlock =
    loaded.length > 0
      ? `Rules loaded for this PR — a maintainability finding cites one of these headings, or a smell name:\n${loaded
          .map((g) => `- ${g.name}: ${g.headings.join(" › ")}`)
          .join("\n")}`
      : "No project rules were loaded for this PR; a maintainability finding cites a smell name.";
  return `## Recap (the diff is long — the essentials again, before you write)

- Categories (${FINDER_CATEGORIES.length}): ${FINDER_CATEGORIES.join(", ")}.
- Severity — the first step that holds decides:
  1. data loss, corruption, an exploitable hole, or an outage → critical
  2. breaks with no workaround, or untrustworthy until fixed (wrong behavior, swallowed errors, a test that asserts nothing) → high
  3. breaks with a workaround, or only on a specific path or input → medium
  4. none of the above → low (maintainability never exceeds medium)
- Every finding carries a verbatim quote; an empty array is right only after every hunk above was examined.

${rulesBlock}`;
}

export function buildFinderPrompt(input: FinderPromptInput): FinderPrompt {
  const scope =
    input.compareTo > 0
      ? `Review only the changes added after iteration ${input.compareTo} (iteration ${input.iterationId}).`
      : `Review the complete set of changes in this PR (iteration ${input.iterationId}).`;

  // The conventions are the reviewed repository's own text — author-influenced — so they
  // are fenced and framed as data (prompts/untrusted.ts); the rules are prloop's and are not.
  const conventions = input.conventions?.trim() ? renderRepositoryConventions(input.conventions) : "";
  const guidance = [conventions, input.rules?.trim()].filter(Boolean).join("\n\n---\n\n");
  // The precedence is scoped on purpose. "Where they conflict, these win" once covered the
  // output contract too, so a rule (or a convention doc) could talk a model out of the
  // verbatim-quote requirement, the code-axis boundary, or the coverage stance.
  const rulesBlock = guidance
    ? `\n## Review rules for this project\n\nThe rules below were loaded automatically based on the files touched by this change. They decide WHAT is reportable and how severe it is — where they conflict with the general guidance above on that, they win. They never change the output rules (verbatim quote, the fields, JSON), the code-axis-only boundary, or the coverage stance.\n\n${guidance}\n`
    : "";

  // Split in two so the diff can be budgeted against what will SURROUND it. Everything
  // here shares one context window with the payload — and until this was counted, only the
  // diff's characters were, which is how a "safely" sized diff still arrived at the model
  // truncated (config.ts, PRR_CONTEXT_TOKENS, says what that costs).
  const head = `## Pull Request info

- Title: ${input.pr.title}
- Source branch: ${input.pr.sourceBranch} → target branch: ${input.pr.targetBranch}
- Author: ${input.pr.createdBy}

### PR description
${renderPrDescription(input.pr.description)}

## Review scope

${scope}
${input.files.length} file(s) changed.
${rulesBlock}
## The change (unified diff)

In the diff, the numbers in \`@@ -leftStart,leftCount +rightStart,rightCount @@\` are real
file line numbers, given so you can orient yourself. Do not include any line number in your
output — just copy the quote verbatim.

`;

  const tail = `

${renderRecap(input.ruleHeadings)}

## Your output

Emit JSON per the schema. Every finding's quote must be source text that appears in the diff
above (with the diff's +/- prefix stripped).`;

  const payload = buildDiffPayload(input.files, undefined, input.seed, {
    model: input.model,
    fixed: `${input.system ?? ""}\n${input.schemaText ?? ""}\n${head}${tail}`,
  });

  return { text: `${head}${payload.text}${tail}`, omitted: payload.omittedFiles, bound: payload.bound };
}
