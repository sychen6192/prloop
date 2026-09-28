# Improvement plan, round 2: what other reviewers know that prloop does not

Date: 2026-09-28
Status: **proposed** — nothing below is implemented. Items are numbered 1–24 so they cannot be
confused with the lettered items of the [2026-09-15 plan](./2026-09-15-improvement-plan.md),
which is fully shipped.

Method: three independent read-only sweeps, run in parallel.

1. **Open-source reviewers**, read from source and in-repo docs (cloned 2026-09-28): PR-Agent
   v0.46.0, Kodus AI v2.1.8, Anthropic's `code-review` plugin, PR-AF, reviewdog v0.21.2, Semgrep's
   diff scan, ast-grep 0.45, Danger JS, and the Azure DevOps review tasks on the marketplace.
2. **Industrial and commercial systems**: Uber uReview, ByteDance BitsAI-CR, Google
   AutoCommenter, Atlassian RovoDev, Kuaishou, the Beko/Qodo study, GitHub Copilot code review,
   Cursor Bugbot, Anthropic Claude Code Review, OpenAI Codex review, CodeRabbit, Greptile,
   Cloudflare, Alibaba OpenCodeReview, and the public review benchmarks.
3. **An architecture audit of this tree** at `4eb9985`, every problem tied to a file and line.

Then every external mechanism was mapped onto prloop and passed through two filters: the
invariants in `CLAUDE.md`, and the rejections in PROPOSAL §10 and the previous plan's §7. Every
defect in §2 was checked against the code by a second reader before it was written down; item 1
was also reproduced (§2). §9 says how far each external source could actually be read — the
egress proxy blocked most papers and vendor sites, so several numbers below come from search
extracts and are marked as such.

---

## 1. Where prloop stands

The comparison came back more favourable than expected. The strongest outside support for
prloop's architecture is Alibaba's OpenCodeReview (2026): deterministic file selection, bundling
and rule matching, comment positions computed outside the model, and a reflector that sees only
the diff. It reports beating Claude Code on the same model at about one ninth of the tokens —
with lower recall, by design. That is prloop's bet, made independently.

| Capability | prloop today | What others do | Verdict |
| --- | --- | --- | --- |
| Comment positions | quote → line, fails closed | PR-Agent `/review` and most ADO tasks let the model write line numbers; one ADO task hard-codes `changeTrackingId: 1` | **ahead**; keep |
| Independent generators + vote | N finders, seeded file order, corroboration gate | Cursor Bugbot v1: 8 passes over randomly ordered diffs, majority vote | **same idea**; keep |
| Verification | cross-family skeptic, refute-only, lowers only, fails open | Kodus verifier (same polarity), Claude's per-issue validators, PR-Agent self-reflection scores | **ahead** of the scoring approaches; keep |
| Requirements | per-criterion verdicts + dispute pass + branch-policy status | PR-Agent: one compliance label per ticket inside `/review` | **ahead** — but see item 3 |
| Context beyond the diff | 6 lines before, 3 after, 6 fixed convention files | PR-Agent names the enclosing function; BitsAI expands to the whole function; Kodus greps callers (4 per function, 15 files, 6,000 chars); Semgrep diffs against the base | **behind** — items 12–15 |
| Languages | 9 reviewable languages; C#, Go, Rust, PHP, C++ are not among them | every product above reviews any source language | **behind** — item 4 |
| Measuring usefulness | dismissal and kill rates, golden-set recall | Uber: % addressed, per-category suppression; BitsAI: Outdated Rate; AutoCommenter: per-rule suppression; RovoDev: "led to a code change" classifier | **behind** — items 8–11 |
| Learning from humans | wontFix/byDesign by fingerprint, reason kept, category hint after three | CodeRabbit/Bugbot learn rules from replies; Greptile matches dismissals by similarity | **deliberately behind** (PROPOSAL §10); item 8 is the next safe step |
| Deployment on ADO | CLI per PR, `--batch` over a hand-kept list | PR-Agent: build-validation pipeline or webhook; Copilot: native, on request | **behind** on packaging — item 20 |

**The competitive fact that changes priorities.** GitHub Copilot code review is in public preview
for Azure Repos (`MicrosoftDocs/azure-devops-docs`, `docs/repos/git/copilot-code-reviews.md`,
2026-09-24). Per that page it runs on request or at PR creation, on Microsoft-hosted or managed
pools, never approves or blocks, does not re-review new commits, stops at 100 changed files, and
reads `.github|.azuredevops/copilot-instructions.md` plus `instructions/*.instructions.md` with
`applyTo`, from the target branch. prloop's niche is exactly what that list leaves out: models
that never leave the network, a review on every iteration, acceptance-criteria verdicts, and a
status a branch policy can gate on. The plan protects that niche (items 3, 4, 20) and makes the
two tools cheap to run side by side (item 17).

---

## 2. Wave 0 — defects found by this sweep

These are not improvements. Each one makes prloop do less than it claims, and three of them are
silent.

**1. Any editor of a linked work item can stop `--since auto` from reviewing a push.** (S, security)
`readMarkers` takes the first `<!-- prloop:iteration=N -->` anywhere in the summary body
(`publish/markers.ts:142`), and the summary renders acceptance criteria and notes escaped only for
`|` and newlines (`publish/format.ts:187`, `:439`). `htmlToText` strips tags and *then* decodes
entities (`libs/html.ts:62-66`), so a criterion written as `&lt;!-- prloop:iteration=5 --&gt;`
arrives as a live marker ahead of the real one, which `publish.ts:416` appends at the end.
Reproduced: that criterion reads back as iteration 5 while the real marker says 3. The
authorship guard passes, because prloop itself posted the summary. Forging the next iteration's
number makes that push diff against itself, so it is never reviewed; SECURITY.md:55-57 says this
cannot happen. The same path is open to a model that quotes a marker in a claim. **Fix:** read
`iteration=` and `run=` only from the trailing marker block the publisher writes, and neutralise
`<!--` / `-->` in every untrusted string that reaches a comment body (criteria, notes, model
claims, evidence, fixes). Regression test: the reproduction above.

**2. Deduplication credits a different claim as agreement, and loses the second defect.** (S–M)
`sameIssue` merges findings that share a file and overlapping lines when they share a category
*or* the same quote (`gates/aggregate.ts:72-79`). `findingsAgree` then counts identical quotes,
or two spans of three lines or fewer sharing a changed line, as agreement regardless of what
the claims say (`:107-114`). `mergeInto` keeps the first claim and takes the higher severity and
confidence from the other finding whether or not they agree (`:139-146`). So "unused variable"
(low) and "SQL injection" (critical) quoting the same line become one critical "unused variable"
credited to both models: it passes the consensus gate and the injection claim is gone. **Fix:**
separate *same place* from *same claim*. Merge only when the claims agree; post disagreeing
findings on the same line as one thread listing both claims, each with its own severity and
sources; never import severity or confidence from a finding that does not agree. Re-score with
`scripts/evaluate.ts` before and after, because the change moves recall.

**3. On incremental runs the requirement axis judges one push as if it were the whole PR.** (M)
`buildReviewContext(ref, compareTo)` diffs the latest iteration against `compareTo`
(`ado/intake.ts:61`), and the requirement gate receives that same `ctx.files`
(`orchestrator.ts:287`). Nothing in `gates/requirement.ts` or `prompts/requirement.ts` knows a
`compareTo` exists, and `satisfied` evidence must anchor in that partial diff
(`gates/requirement.ts:399-417`). A criterion delivered two pushes ago is therefore `missing` or
`not-verifiable` now; `missing` survives the dispute pass because the refuter sees the same
partial diff, and `publish/status.ts:45-58` turns it into exit 2 and a failed status — a
branch policy blocks a PR for work it already contains. **Fix:** always give the requirement
axis the full-PR diff (`compareTo = 0`; blobs are content-addressed, so the second intake costs
no extra blob fetches if they are cached per run), budget it in tokens for `PRR_REQ_MODEL` rather than
characters (`prompts/requirement.ts:116`), and mark a criterion whose evidence would sit in an
omitted file `not-verifiable` with that reason. No test covers this axis on an incremental run
today; item 22's end-to-end net must.

**4. A PR in a language outside the list is reported as reviewed and clean.** (M, plus an S bug)
`REVIEWABLE` in `libs/lang.ts` holds Python, Java, Kotlin, TypeScript, TSX, JavaScript, JSX, SQL
and shell. An all-C# PR — the most common language in Azure DevOps shops — has "no reviewable
code changes" (`orchestrator.ts:222-265`): the requirement axis is skipped too, although it does
not depend on language at all, and the status reads `succeeded — Reviewed 0 files, no blockers`
(`publish/status.ts:72-75`). **Fix:** (a) the requirement axis runs whatever the language;
(b) finders review any text source file, with one language registry instead of `EXT_LANG` plus
`REVIEWABLE` plus `profiles/index.ts`; (c) changed code prloop could not review is a coverage gap
that reaches the status, never a green "0 files". `PRR_RULES_DIR` should add to the shipped rules
rather than replace them (`config.ts:737`). **Separate bug, S:** a prefix test marks every ruff
rule starting with `S` as `high` (`profiles/parsers.ts:107`), which catches the whole `SIM*`
(flake8-simplify) family, and `categoryForRule` files *any* tool's rule whose upper-cased id
starts with `S` under `security` (`gates/static.ts:808`) — eslint's `semi` and `strict`, PMD's
`SimplifyBooleanReturns`. Replace both with per-tool maps.

**5. Existing thread positions are probably read as originally posted.** (S; confirm on a live PR first)
`listThreads` does not pass `$iteration` (`ado/threads.ts:38-40`); the ADO REST reference
documents tracked positions only when `$iteration` / `$baseIteration` are given. Position dedupe
(`publish/publish.ts:118-158`) and the `line > file length` auto-close
(`publish/lifecycle.ts:205-221`) compare those original positions with the current file, so code
that merely moved can hide a new finding or close a live thread and record a false fix. The
content check the docstring at `lifecycle.ts:177-180` promises does not exist. **Fix:** request
positions tracked to the current iteration with a fallback, and add the content check.

**6. Two leaks and a stale security document.** (S)
Inline comments are not passed through `redactSecrets`; only the summary is
(`publish/format.ts:436`). The `opencode` runner starts in the prloop directory
(`models/opencode.ts:170`, `cwd = PRLOOP_ROOT`), next to `.env`, and relies on
`agents/prloop-reviewer.md` to deny every tool with nothing checking that at runtime.
SECURITY.md's "known limit" (line 78) predates `libs/redact.ts:47` stripping URL credentials.
**Fix:** redact inline bodies; run opencode from a temporary directory with a prloop-owned config
that denies all tools and refuse to start otherwise; refresh SECURITY.md. The 2026-09-15 plan's
deferred hygiene items (mode 0700 on `runs/`, `.npmrc` with `ignore-scripts`, SHA-pinned actions,
a first tag) are still open and still small; take them here.

**7. The diff header the models read has no path separator.** (S)
`renderUnifiedDiff` writes `` `--- a${path}` `` (`libs/diff.ts:231`), and intake strips ADO's
leading slash, so production prompts read `--- asrc/pay.ts`. The selftest passes a path with a
leading slash, a shape production never produces. A weak model that copies the header path into
`file` fails anchoring, which fails closed — a silent recall loss. **Fix:** `a/` and `b/`, and a
test with the production path shape.

---

## 3. Wave 1 — measure what comments lead to

Every industrial system that published results measures the same thing: whether a comment
changed the code. Uber reports >65% of comments addressed and suppresses low-value categories;
BitsAI-CR tracks an **Outdated Rate** (share of comments whose flagged range a later commit
modified) and adds or removes rules by it; AutoCommenter found that suppressing 17 non-actionable
rules beat threshold tuning (useful ratio 54% → 66% with developers); RovoDev trained a filter on
>50k comments labelled by whether they led to a code change (38.7% did, against 44.45% for human
comments). prloop measures dismissals and kills, which says what went wrong but not what went
right. PROPOSAL §12 already names "implementation rate" as the north star; nothing computes it.

**8. An addressed-rate ledger, and demotion proposals from it.** (S–M)
Record, per posted finding: category, language, rule or tool, finder model, skeptic verdicts,
severity, and one of three outcomes — *code changed* (a later iteration modified the anchored
lines while the thread was open: BitsAI's signal, computable from data `publish/lifecycle.ts`
already reads), *fixed/wontFix by a human* (today's only signal, `lifecycle.ts:320-338`), or
*ignored* at merge. Add ADO comment Likes (REST 7.1, unused today) as a positive signal.
`scripts/calibrate.ts` reports addressed rate per bucket and **proposes** demotions — "move
`maintainability` / `ruff:SIM` to summary-only in this repo" — for a human to apply, consistent
with PROPOSAL M6 (suggestions, never automatic rules). Guard against compliance fixes: Martian's
benchmark notes developers sometimes "fix" to silence a bot, so the report must show the rate
rising with severity, and treats an explicit dismissal as a stronger signal than silence.

**9. Stamp every run with what produced it.** (S)
`result.json` carries only the package version, `0.1.0` (`libs/artifacts.ts:21-28`). Add the
prloop commit and content hashes of the prompts, the loaded rules, the model set and the
effective config, and make calibrate and evaluate group by them. Without this, "did the prompt
change help?" is unanswerable.

**10. A replay bundle.** (M, opt-in)
`context.json` stores counts only (`orchestrator.ts:207-220`), so tuning the 0.3 claim-overlap
threshold (`gates/aggregate.ts:120`), the consensus rule, the severity bar or the comment cap
means paying for every model call again. Save the model outputs plus the file index each gate
needed, and add `scripts/replay.ts` to re-run anchoring through publish-rendering offline. Opt-in,
because it keeps source on disk (`runs/` is already mode-sensitive, item 6).

**11. A local end-to-end mode, and an external benchmark.** (M)
`runReview` already accepts a pluggable intake (`orchestrator.ts:47`), but
`scripts/local-review.ts` only builds prompts and matches quotes. Add a `review` mode (git diff,
real models, dry run) and run two public sets through it: **AACR-Bench** (200 PRs, 10 languages,
1,505 verified issues with line ranges) and **Martian Code Review Bench** (50 PRs, 173 golden
comments, includes Java via Keycloak). Match by path and line ±k first; use an LLM judge only
as a secondary signal — the Beko follow-up found judges agree with developers' fixed/wontFix
labels only 0.44–0.62 of the time. Take Kodus's discipline for noise: derive the pass floor from
two runs on the same commit, re-run below it, pin the judge. This is what finally answers
PROPOSAL §12's open question, "one finder or N, and what does the skeptic add, per weak model".

---

## 4. Wave 2 — more context and less noise, chosen by code

Every system that improved recall did it by giving the reviewer more than the diff. The ones
built for frontier models let the model fetch it (Copilot's agentic context gathering, Bugbot's
agentic rewrite, OpenAI's repo access). The ones that stayed deterministic — BitsAI, Kuaishou,
Kodus, OpenCodeReview — let *code* choose it. The second kind fits `CLAUDE.md`; the first stays
rejected (§7).

**12. Name the scope, and send small files whole.** (S)
Finders see 6 lines before and 3 after each change (`config.ts:791-792`) and no hint of the
enclosing function. PR-Agent puts the enclosing function's signature in each hunk header;
BitsAI expands hunks to the whole function, up to 4× the diff. Add a scope line per hunk from
per-language regexes over the raw blob (no new dependency; `ast-grep outline --json` is the
optional upgrade), and send a changed file whole when it fits the finder's budget. Lands with
item 7.

**13. One hop of context for `insufficient-context`, chosen by the pipeline.** (M; un-defers the
2026-09-15 plan's deferred item)
When a skeptic answers `insufficient-context`, take the identifiers in the anchored span, look up
their definitions and a few callers — first inside the PR's changed files, already in memory and
needing no worktree; then, if a worktree exists, with `git grep -w` under Kodus-style caps
(4 callers per function, 15 files, 6,000 characters) — fence the result as untrusted, and ask
that skeptic once more. It may still only lower severity, and a failed lookup changes nothing
(fails open). Why now: the deferral waited for `calibrate.ts` to show the unchecked rate, which it
now reports (`scripts/calibrate.ts:295-306`), and the in-memory half needs no change to the
worktree's lifetime (`orchestrator.ts:364`).

**14. Check simple claims in code before the skeptic.** (S–M)
Kodus lets a finding declare a `claimKind` — unused, undefined symbol, missing file, duplicate —
and settles it with one ripgrep or path check. For prloop: an optional finder field; one
`git grep -w` or path lookup; a contradicting result drops the finding with the evidence logged;
a lookup that cannot run keeps it (Kodus drops it; prloop must fail open). This removes the
commonest hallucination of a model that only sees a diff: "X is never used" when X is used in a
file it was not shown.

**15. Diff the fact tools against the base commit.** (M)
The static gate runs `tsc`/`mypy` project-wide and keeps only changed lines, so a caller the PR
broke in an unchanged file is dropped. Semgrep's diff scan runs HEAD and the merge base and
removes HEAD findings whose (rule, rename-aware path, matched text) already existed, counting
duplicates. Do the same for fact-tier tools: new-at-HEAD findings on changed lines post inline as
today; new-at-HEAD findings elsewhere go to the summary as "this PR broke". Doubles fact-tool
time, behind one `PRR_*` knob. Same item: close a *tool* thread only on evidence — the same tool
ran cleanly and no longer reports it (reviewdog's rule) — instead of on "the code moved", which
is right for model findings only.

**16. Deterministic noise filters, and a lane for pre-existing issues.** (S)
Drop or demote a finding whose line, or the line above, carries a suppression marker
(`eslint-disable`, `# noqa`, `# type: ignore`, `@SuppressWarnings`, `NOSONAR`, `# nosec`,
`//nolint`) — Anthropic's plugin treats these as false positives. A finding anchored entirely on
unchanged lines goes to a "pre-existing" summary section instead of inline (Claude Code Review's
Pre-existing tag; the Codex review prompt flags only bugs the change introduced; AutoCommenter
drops comments on unchanged lines). Offer PR-Agent's always-zero list (docstrings, type hints,
comments, unused imports) as `PRR_EXCLUDE_CATEGORIES` candidates once item 8's rates confirm it.

**17. Read the instruction files teams already write.** (S)
`CONVENTION_PATHS` is six fixed root files (`ado/conventions.ts:18-25`); PROPOSAL.md:289 says
`.cursor/rules/*.mdc` is read, and it is not. Add `.github/copilot-instructions.md`,
`.github|.azuredevops/instructions/*.instructions.md` routed through the existing `applyTo`
selector, `.cursor/rules/*.mdc`, and nested `AGENTS.md` / `CLAUDE.md` applied only to changed
files beneath them (the Anthropic plugin's scoping). Read at the target commit and fenced, as
today. One instruction set then drives both prloop and Copilot on the same repository.

**18. Risk tiers, and convergence on re-review.** (S–M)
Cloudflare picks a trivial, lite or full review from line count, file count and path
sensitivity; Copilot and Claude raise the bar after the first review and label newly found
problems in old code "previously missed". For prloop: derive N finders, R skeptic rounds and the
inline severity bar from diff size and a `PRR_*` list of sensitive globs, and on `--since auto`
iterations post only findings at or above the bar on lines the push touched, with anything else
new reported as "previously missed" in the summary.

---

## 5. Wave 3 — cost, latency, and running unattended

**19. Take the slow steps off the critical path.** (S)
The worktree fetch and setup command, up to ten minutes each, finish before any finder starts
(`orchestrator.ts:326-337`); triage waits for the skeptic (`:415`, `:454`); findings already
posted are verified again (`publish/publish.ts:337-340`) although the threads were read at the
start. Prepare the worktree inside the static branch; run skeptic and triage concurrently; pass
already-posted fingerprints into the skeptic's filter; move the chunk notice after the rules in
the finder prompt (`prompts/finder.ts:276-277`) so a vLLM server's prefix cache can share the
common start; record per-stage timings in `result.json`. Optional, measured by item 8 first:
skip verification for findings already below `PRR_MIN_INLINE_SEVERITY` (default `medium`,
`config.ts:928`), which can never become inline, and label them unverified in the summary.

**20. Package the unattended mode for Azure DevOps.** (M)
`--batch` takes a hand-kept list of URLs, runs strictly in sequence, and shares one environment
across repositories (`libs/batch.ts:16-19`, `:134`). Dismissal learning lives in `runs/` on one
machine (`libs/learnings.ts:11-16`), and a throwaway pipeline agent loses it every run. Add PR
discovery (active PRs of a repo or project through the REST API), per-repo overrides, a parallel
batch that splits the concurrency limit, a loud warning when `RUNS_DIR` is not persistent, a
lease re-check just before posting, and two pipeline YAML examples (build validation, and a
scheduled sweep). Fix README's cost formula (lines 23, 33, 69-72): the dispute pass is one
batched call and also covers `partial`. Optionally skip lines already carrying a Copilot thread.

**21. Suggested fixes that compile.** (M)
arXiv 2607.21997 finds an inline code suggestion the strongest predictor that a comment gets
adopted. Apply `suggested_fix` to the quoted span in the worktree and run the fact-tier tool on
the file; if it fails, drop the fix and keep the finding. ADO does not render GitHub's
`` ```suggestion `` block, so post the fix as an ordinary diff block.

---

## 6. Wave 4 — structure that makes the rest cheaper

**22. An end-to-end test net: a full run, then an incremental one.** (M; lands with wave 0)
The only `runReview` tests cover the merged-PR skip (`scripts/selftest-publish.ts:515-600`).
Items 2 and 3 survived because no test runs a normal review end to end. Script the model runner,
fake ADO with the existing `scripts/fakes/`, and assert the published threads, summary and status
for a first run and a `--since auto` run on the next iteration. Then split `scripts/selftest.ts`
(5,654 lines, 1,290 assertions, no way to run a subset) by module; the helper copied into all
seven nets becomes one module.

**23. Config as one declarative table; per-run state out of module globals.** (L, in steps)
`config.ts` names every setting twice (the registry at `:49-144`, then the readers), repeats one
parse-or-exit block nine times (`:485-782`) and holds domain types (`:976-1012`); per-run state
sits in module globals (`models/runner.ts:739`, `libs/log.ts:17`, `libs/artifacts.ts:134,276`,
`publish/lease.ts:53`); error kinds travel as text matched by regex (`models/runner.ts:647-657`).
Generate `KNOWN_KEYS`, the `.env.example` rows and the README table from one table that also
parses — which keeps `CLAUDE.md`'s "all four or none" rule true by construction — and pass a run
context object instead of globals. Update `CLAUDE.md`'s config wording in the same change.

**24. Put Azure DevOps behind a host interface.** (M–L)
`gates/requirement.ts:8`, three `publish/` modules and `orchestrator.ts:17-19` call ADO modules
directly; the `IntakeProvider` type at `libs/context.ts:68` is unused and out of date. A
`ReviewHost` interface with ADO as its only implementation gives items 10, 11 and 22 an in-memory
host for free, and makes GitHub or GitLab an adapter rather than a rewrite if that is ever
wanted. The hidden-marker bytes must not change; MCP stays rejected.

---

## 7. What this plan does not do

- **Agentic context gathering** (Copilot, Bugbot's rewrite, Kodus's finder agents, OpenHands,
  Codex with execution). Their gains are reported on frontier models; prloop is built for weak
  ones and for a loop no model controls. OpenCodeReview's result argues the deterministic route
  holds its own. Items 13–15 take the part that fits.
- **Embedding indexes and similarity-matched dismissals** (Greptile, CodeRabbit). PROPOSAL §10's
  reasons stand. Greptile's reported jump (19% → 55% addressed) comes from a secondary source
  only. Revisit once item 8 shows which dismissals repeat.
- **Fine-tuned checkers and trained filters** (BitsAI's LoRA rule checker, RovoDev's ModernBERT).
  They need labelled data at a scale a self-hosted tool does not have yet. Item 8 starts
  collecting exactly those labels.
- **Reproduction-based addressed rate** (Uber re-runs the reviewer 5× on the final commit). Five
  more reviews per PR is the wrong price for a metric; item 8's "code changed under an open
  thread" is the cheap version.
- **Resolving model findings by their absence** (PR-Agent's key issues). With non-deterministic
  finders, absence is not evidence. Only tool findings close that way (item 15).
- **An interactive bot** (commands and chat in PR comments). A different product; prloop is
  unattended, and replies already feed dismissal reasons.
- **Anything from the previous rejections**: browser UI, link sharing, walkthroughs,
  multi-round debate, LLM line numbers.

---

## 8. Order and risk

Wave 0 first, in this order: 1 (security, and it changes only where a marker is read), then
22's end-to-end net, then 2 and 3 against that net, then 4, 6, 7. Item 5 waits on one check
against a live PR. Wave 1 before wave 2, because wave 2 is the part that needs measuring: items
8, 9 and 11 are what say whether 12–18 helped. Waves 3 and 4 can run beside the others;
item 23 is the largest diff in the plan and should go in small steps.

**Changes what is posted or whether a merge is blocked:** 2 (fewer false corroborations, more
separate claims), 3 (fewer false failures), 4 (C#, Go and others start being reviewed, and an
unreviewable PR stops going green — an operator will see new comments and new "incomplete"
statuses), 16, 18. Each needs a CHANGELOG line written for the person whose merge it affects.
**Changes bytes on live PRs:** 1 (marker reading only; writing unchanged), 5.
**Pure additions:** 8–11, 12, 13, 14, 15, 17, 19–22, 24.

---

## 9. How far each source was read

Read in full from source or in-repo documentation: PR-Agent, Kodus, Anthropic's plugin and the
Claude Code Review documentation, PR-AF, reviewdog, Semgrep's diff scan, ast-grep, Danger JS, the
OpenAI Codex review prompt, Alibaba's OpenCodeReview repository, AACR-Bench, Martian's benchmark,
the Copilot code-review docs and changelogs, and the Azure DevOps documentation source.

Read only through search-engine extracts, because the proxy blocked the sites: the Uber,
BitsAI-CR, AutoCommenter, RovoDev, Kuaishou and Beko papers and posts, Cursor's and Cloudflare's
posts, and arXiv 2607.21997. Their mechanisms are credible; their numbers are the authors' own
and unreproduced here.

Vendor claims used for colour only: Graphite's "<3% false positives", Greptile's benchmark and its
19% → 55% figure, Anthropic's "<1% marked incorrect".

The mechanisms quoted from open-source tools carry their version: PR-Agent v0.46.0 (`32eb7a3`,
2026-09-27), Kodus v2.1.8 (`ae838a4`), Anthropic `plugins/code-review` (`7779afb`), reviewdog
v0.21.2, Semgrep `56e04ee`, Martian `e616e84`.

### Sources

- PR-Agent — <https://github.com/The-PR-Agent/pr-agent> (`docs/core-abilities/compression_strategy.md`, `pr_agent/algo/git_patch_processing.py`, `pr_agent/algo/inline_comment_dedup.py`, the Azure DevOps provider)
- Kodus AI — <https://github.com/kodustech/kodus-ai> (`claim-checker.ts`, `repo-slices.ts`, `evals/README.md`)
- Anthropic code-review plugin — <https://github.com/anthropics/claude-code/tree/main/plugins/code-review>; Claude Code Review — <https://code.claude.com/docs/en/code-review>
- reviewdog — <https://github.com/reviewdog/reviewdog>; Semgrep — <https://github.com/semgrep/semgrep>; ast-grep — <https://github.com/ast-grep/ast-grep>
- OpenAI Codex review prompt — <https://github.com/openai/codex> (`codex-rs/core/review_prompt.md`)
- Alibaba OpenCodeReview — <https://github.com/alibaba/open-code-review>; AACR-Bench — <https://github.com/alibaba/aacr-bench>
- Martian Code Review Bench — <https://github.com/withmartian/code-review-benchmark>
- Copilot code review for Azure Repos — <https://github.com/MicrosoftDocs/azure-devops-docs> (`docs/repos/git/copilot-code-reviews.md`)
- Uber uReview — <https://www.uber.com/blog/ureview/>
- BitsAI-CR — <https://arxiv.org/abs/2501.15134>; AutoCommenter — <https://arxiv.org/abs/2405.13565>; RovoDev — <https://arxiv.org/abs/2601.01129>; Kuaishou — <https://arxiv.org/abs/2505.17928>; Beko/Qodo — <https://arxiv.org/abs/2412.18531>
- Cursor Bugbot — <https://cursor.com/blog/building-bugbot>; Cloudflare — <https://blog.cloudflare.com/ai-code-review>
