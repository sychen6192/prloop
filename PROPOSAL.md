# prloop — Multi-Model Adversarial PR Review Pipeline Proposal

> Draft v1. Based on three lines of investigation: the architecture of the most popular PR review
> projects on GitHub, 2026 industry best practice, and Azure DevOps REST API mechanics; and
> inheriting the design philosophy of a loop engineering tool already validated in production
> (below: "the prior tool" — a unit test generation pipeline built on the same deterministic
> orchestrator approach).

## 1. Position

A pipeline that runs automated review on Azure DevOps PRs: first verify the PR satisfies the Work
Item requirements, then produce high-precision findings by having multiple open-source models
compete against each other. Line anchoring is computed deterministically by this tool; no line
number reported by an LLM or MCP is trusted. Control flow is 100% TypeScript; the LLM judges, it
does not decide.

Supported languages: Python, Java, Next.js/React (TypeScript).

## 2. Pain Points → Countermeasures

| Pain point | Countermeasure | Basis |
| --- | --- | --- |
| Self-hosted open-source models lack single-model precision | Multi-model: parallel independent finders + cross-family skeptic veto + consensus vote. No multi-round debate | NeurIPS 2025 *Debate or Vote*: nearly all of debate's gain comes from the vote; heterogeneous model mixes hit MMLU 88.2% vs 79.0% single-model; MoA with pure open-source models beats GPT-4o (AlpacaEval 65.1 vs 57.5) |
| Evaluation criteria hard to define per language | Layer it: objective standards go to per-language static tools (ruff/spotbugs/eslint…) as the baseline, the LLM only reviews the semantic layer tools can't reach; rubric split into per-language profile config | CodeRabbit's three-tier net (57 linters feeding the LLM); IRIS/Datadog show LLM triage cuts static analysis false positives by 88% |
| azure-mcp frequently gets line numbers wrong, comments land off | Never post comments through MCP. The model must quote a source snippet; the pipeline re-locates the line number in the iteration blob's raw bytes; quote not found → fail-closed downgrade to summary, never guess a line number | azure-devops-mcp #793 (bad threadContext broke the ADO UI), #868 (MCP can't fetch line content, so the model can only invent line numbers) — structural, not a bug |
| Need to read the reqs first to confirm they're met | The pipeline's first LLM stage is the Requirement Gate: pull the PR's linked Work Items (including `Microsoft.VSTS.Common.AcceptanceCriteria`), compare each criterion against the diff, produce a requirement coverage matrix | ADO PR work items API + PR-Agent's "ticket compliance" approach |
| Everything currently comes from azure-mcp | Move the data path to direct ADO REST (four API groups: iterations / threads / statuses / work items); keep azure-mcp for interactive human queries, the pipeline doesn't depend on it | azure-mcp's design philosophy is thin wrapper — no iteration bookkeeping, no anchor validation; you can't build a serious bot on it |

## 3. What Was Taken From Each Project

- **The prior tool (validated in production)**: single deterministic orchestrator, verification never
  outsourced, injection over discovery, state in artifacts, fail-closed parse, startup guard, runner
  adapter. All inherited — this is the framework's skeleton.
- **PR-Agent (12.3k★)**: token-budgeted diff compression (additions before deletions, sorted by
  language, hard truncation), sticky comment updated in place, self-reflection second-pass scoring to
  filter suggestions, incremental review.
- **CodeRabbit**: a judge model reviews the evidence for each finding before publishing ("grep found
  nothing" is not evidence of a bug), a cheap model compresses large inputs first, linter results fed
  into LLM context, resolve-then-approve comment lifecycle.
- **Ellipsis (architecture public)**: parallel comment generators → dedup → hallucination filtering via
  Evidence → confidence threshold → line-number correction, a multi-layer filter pipeline; evidence
  (code quotes) is the core currency of filtering.
- **reviewdog (9.5k★)**: diff filter (keep only linter findings on changed lines), dedup against
  existing comments by fingerprint, SARIF normalization.
- **claude-code-security-review (5.7k★)**: two-stage generate → separate FP-filter pass, plus a
  configurable list of false positive exclusion categories.
- **Refute-or-Promote (arXiv 2604.19049)**: kill mandate (the verifier's job is to *destroy* a finding,
  not agree with it), cold-start (the verifier gets the claim only, not the finder's reasoning, to
  prevent anchoring, p=0.008), cross-model critics killing errors a whole model family missed. The full
  pipeline kills ~79% of candidate findings.

## 4. Architecture Overview (Control Flow)

```
Trigger: ADO Service Hook (git.pullrequest.created/updated) or CLI "prloop <PR URL>"
        │
        ▼
intake ────── ADO REST: PR info, iterations, last reviewed iteration, changeEntries,
        │     left/right blob raw bytes, linked Work Items (with acceptance criteria)
        │     → build unified diff + line index locally (SSOT, shared by all later stages)
        ▼
orchestrator.ts ←── the only loop controller (deterministic, inherited from the prior tool)
        │
        │  A) Requirement Gate (LLM): each acceptance criterion × diff → coverage matrix
        │  B) Deterministic Gates (script): run per-language profile
        │     ruff/mypy/bandit｜checkstyle/spotbugs/error-prone/PMD｜eslint/tsc
        │     → SARIF normalization → diff filter (changed lines only) → split:
        │     fact tier (type/compile errors) published directly; high-FP tiers go to LLM triage
        │  C) Finder (multi-model parallel, N≥3 heterogeneous models × randomized file order):
        │     "report every issue including low-confidence ones, filtering is downstream's job";
        │     enforced JSON schema (vLLM guided decoding), every finding carries quote + evidence
        │  D) Skeptic (adversarial verification, cross model family, cold-start context):
        │     kill mandate — try to refute each finding; empirical checks where feasible
        │     (does the patch apply, does the referenced symbol exist)
        │  E) Aggregate (pure code, zero LLM):
        │     locate line from quote → dedup by (file, anchored line, category) →
        │     consensus scoring (independent finder count × skeptic survival) → severity tiers →
        │     comment cap → no-comment gate (clean means quiet)
        ▼
publish ───── ADO REST threads API: sticky summary (updated in place, with the coverage matrix)
        │     + a few inline threads (self-computed rightFileStart/End + changeTrackingId
        │     + iterationContext) + PR Status API (attachable to branch policy as a merge gate)
        ▼
state ─────── runs/<org>/<repo>/<PR>/iter-N/ — all artifacts written to disk;
              finding fingerprints dedup across pushes; the next push reviews only
              the increment from iterations $compareTo=<last>
```

## 5. Three Core Designs

### 5.1 Line Anchoring: quote-based re-anchoring (cures off-target comments)

The root problem: the ADO threads API wants a 1-based absolute line number in that iteration's file
version, while the LLM sees a diff and naturally returns hunk-relative lines or GitHub-style positions;
azure-mcp validates nothing, accepts them as-is, and the UI goes crooked (it once crashed an entire PR
page, #793).

The fix — line numbers are never decided by the LLM, at any point:

1. The finder's JSON schema has **no line number field**, only `quote` (an exact quote of that source
   line, with one line of `context_before/after` each side for disambiguation).
2. The aggregate stage searches for the quote in the **right-side blob raw bytes** fetched during intake
   (by objectId, no local checkout, avoiding CRLF/BOM normalization differences) → absolute line number.
3. Publishing sends the full `threadContext.rightFileStart/End` (offset 1, both start and end),
   `pullRequestThreadContext.changeTrackingId` (from changeEntries; required for iteration-supporting
   PRs), and `iterationContext {firstComparingIteration: 1, secondComparingIteration: N}`.
4. Quote not found, or multiple hits with no way to disambiguate → **fail-closed**: the finding drops
   into the "unlocatable" section of the summary comment. Never guess a line number for an inline.
5. Findings on deleted lines anchor to `leftFileStart/End` (left = target version), not the right side.

Side-effect bonus: the quote doubles as the evidence for Ellipsis-style hallucination filtering (quoting
code that doesn't exist = hallucination, killed on sight) and as the key for cross-model finding matching.

### 5.2 Multi-Model Adversary: parallel voting, no debate

The research is consistent: **multi-round debate isn't worth it; heterogeneity is the active ingredient.**
So the architecture is:

- **Finder × N (N=3 up)**: independent, parallel, same diff+context, randomized file order (Cursor BugBot's
  approach). The prompt runs in coverage mode: "report everything, including uncertain findings, with a
  confidence" — filtering is downstream, which avoids newer models over-complying with "only report the
  serious ones" and hurting recall.
- **Skeptic (different model family)**: tries to refute each finding using cold-start context (claim +
  relevant code only, no finder reasoning). Successful refutation kills it.
- **Consensus verdict (pure code)**: `score = severity × independent find count × skeptic survival`.
  Default threshold: ≥2 finders independently, or 1 finder plus explicit skeptic confirmation, to earn an
  inline.
- Structured output is enforced at the engine layer by **vLLM guided decoding (xgrammar) / Ollama format** —
  a weak model's whole capability budget goes into judgment instead of format compliance. This is exactly
  what makes a weak-model ensemble viable.

Model configuration (routed uniformly through a LiteLLM proxy; the pipeline core has zero SDK dependencies):

| Role | Suggestion | Notes |
| --- | --- | --- |
| Finder A | Qwen3-Coder family (a 27B-class dense model suffices) | Recall workhorse |
| Finder B/C | Pick two of Devstral Small 24B / GLM-4.5-Air / gpt-oss-20b | The point is **different families** |
| Skeptic | gpt-oss-120b or a DeepSeek-R1 distill (needs long reasoning) | The kill mandate needs reasoning depth |
| Triage (optional) | A cheap fast model like Qwen3-30B-A3B | Pre-classify hunk risk on big PRs, compress input |

Single-GPU deployment reality (the prior tool already hit this): the models don't all need to be resident
at once — the pipeline is batch. Run all finders → unload → load the skeptic; swapping between stages is
acceptable. With enough VRAM, one 27B (Q4) plus one 20B-class can both stay resident; across multiple
machines, LiteLLM just fans out. The runner adapter keeps these deployment differences out of the core.

### 5.3 Per-Language Evaluation Criteria: layering + profiles

Don't try to write one huge rubric per language for the LLM to score against (the prior tool already
proved weak models follow long rubrics unreliably). Use three layers instead, each with a different job:

1. **Fact layer (zero LLM)**: output from `tsc --noEmit`, error-prone, and mypy is fact — use it as a gate
   or publish it directly; a failed compile short-circuits the whole LLM review (saves money and noise).
2. **Triage layer (LLM reviewing tools)**: findings from high-false-positive tools like bandit, spotbugs,
   and PMD get exploitability judged by the LLM against the diff context (empirical: Semgrep false
   positives 560→64). Style rules from checkstyle/eslint never get per-item comments — either CI blocks
   them or they're summarized in one line.
3. **Semantic layer (the LLM's home turf)**: only what tools can't catch — logic, concurrency, API misuse,
   React hooks dependency correctness, server/client component boundaries, hydration, Java resource leaks
   and transaction boundaries. The finder prompt explicitly attaches "here's what the linters already
   cover, don't repeat it".

One profile file per language (`profiles/python.ts` etc.) defines: which tools with which parameters,
SARIF mapping, which rules belong to the triage layer, the semantic layer's review focus list, severity
mapping. Adding a language = adding a profile, core untouched.

## 6. Two-Axis Review: Requirement Axis and Code Axis

### 6.1 Why split the axes (and deliberately never merge them)

A PR can pass one axis and fail the other: **follow every convention but build the wrong thing** (code
axis passes, requirement axis fails), or **build the right thing while violating project conventions**
(requirement axis passes, code axis fails). Ranked together, one axis buries the other — especially under
a comment cap: one "the requirement isn't done" finding gets squeezed out by three critical code issues,
and vice versa.

Therefore: **the two axes are produced independently, get independent comment quotas, appear in separate
summary sections, and are never re-ranked across axes.**

### 6.2 Requirement Axis (Requirement Gate)

1. `GET .../pullRequests/{id}/workitems` for the ResourceRefs (note: `workItemRefs` on the PR object is
   not auto-populated; this dedicated API is mandatory).
2. Fetch Work Item fields (`$expand=relations`): `Microsoft.VSTS.Common.AcceptanceCriteria` on the
   PBI/User Story (HTML, needs converting to plain text); if the PR hangs off a Task, walk one level up
   via `System.LinkTypes.Hierarchy-Reverse` to find the parent carrying the AC; for Bugs, take `ReproSteps`.
3. The LLM compares each AC against the diff. **The verdict describes the way it failed, not the degree of
   coverage** — the latter only says how much got done, the former gives actionable direction. Three failure
   modes (superpowers' Missing/Extra/Misunderstood and the Spec axis of the mattpocock code-review skill
   independently converged on the same set):

   | verdict | Meaning |
   | --- | --- |
   | `satisfied` | Done, with corresponding evidence findable in the diff |
   | `missing` | Not done at all |
   | `partial` | Partly done, with a clear gap |
   | `misunderstood` | Done, but in the wrong direction — solved the wrong problem, or satisfied it the wrong way |
   | `not-verifiable` | Can't be judged from the diff (needs config or an external system, say) |

   Reported separately: **`extra` (scope creep)** — changes no AC asked for and that aren't necessary
   refactoring.
4. Results occupy their own block at the top of the sticky summary; `missing` / `misunderstood` can be
   configured to set PR Status `failed` → attached to a branch policy, a real merge gate (cleaner than a
   -10 vote; for bot votes, prefer -5 "waiting for author" or no vote).
5. Behavior when no linked Work Item exists is configurable: warn only (default) or gate the PR.

### 6.3 Code Axis

The category/severity system from §7 plus the multi-model adversary from §5.2. Runs completely
independently of the requirement axis; neither axis knows the other's result — which prevents "the
requirement was met" being used to lower the severity of a code problem, and vice versa.

## 7. Review Dimensions: Categories, Severity, Rules Layer

### 7.1 Why not the prior tool's scoring system

The prior tool reviewed "the overall quality of one test file", where a weighted six-dimension score is
meaningful. PR review reviews "a set of specific defects", and "this PR scores 7 for readability" gives a
reviewer no actionable direction. So prloop uses **category + severity + confidence**, not scoring. This
matches the industry: none of the commercial tools surveyed score a PR overall. The one exception is
PR-Agent's `score` 0-100, which is for reporting and affects no decision.

### 7.2 Category (9 of them)

Built on the six categories CodeRabbit converged on (the most complete naming set in the survey), plus
three kept separate:

| category | Why it stands alone |
| --- | --- |
| correctness / security / reliability / data-integrity / performance / maintainability | The industry-consensus six, mapping directly onto developers' mental models |
| **concurrency** | Others fold it into reliability, but concurrency is the most common and hardest-to-test defect class in Java services — it deserves its own review lens rather than being diluted |
| **leftover-code** | Only Graphite names this category (debug output, commented-out code, leftover TODOs), and its adoption rate is consistently among the highest |
| **req-mismatch** | Used by M2: the change doesn't satisfy the linked Work Item |

### 7.3 Severity (4 levels, defined by decision order)

Severity can't just be adjectives — weak models mark everything high. Use an **ordered decision chain**
instead, drawn from the five discriminating factors common to all four severity definitions
(Bugzilla / Mozilla / Atlassian / Microsoft): is there a workaround, is there data loss or a security
issue, how broad is the impact, does it block others, is it purely cosmetic.

1. Data loss/corruption, exploitable security hole, service outage → **critical**
2. Functionality breaks with **no workaround**, or this code can't be trusted until fixed → **high**
3. Functionality breaks but **there is a workaround**, or it only fails on specific paths → **medium**
4. None of the above → **low**

"Is there a workaround" is the most decisive of the five factors, and the one all four definitions use.

Also adopted, one rule from superpowers' `task-reviewer-prompt.md`:
**the author's explanation does not lower severity.** "This is intentional" or "YAGNI" in a PR
description are claims, not evidence — judge on the facts of the code. This matters especially in LLM
review: models are easily talked around by a PR description.

### 7.4 Rules Layer (M4): the answer to per-language evaluation criteria

Don't write one big rubric and expect the model to remember every language's rules (the prior tool already
proved weak models follow long rubrics unreliably). Instead, **mount by glob and inject only relevant
rules**:

```
rules/
  _base.md                    # shared across languages: Fowler's 12 code smells
  python.md                   # applyTo: **/*.py
  java.md                     # applyTo: **/*.java
  nextjs.md                   # applyTo: **/*.{tsx,jsx}, app/**
  <team>/payment.md           # applyTo: services/payment/**
```

`_base.md` holds the 12 code smells from chapter 3 of *Refactoring* (Mysterious Name, Duplicated Code,
Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change,
Speculative Generality, Message Chains, Middle Man, Refused Bequest), each written as "what it is → how to
fix it". Two binding constraints come with the set, neither optional:

- **The repo's own conventions always override the baseline** — the baseline may not object to a pattern
  the project's docs endorse
- **Every smell is a judgment call, not a hard violation** — reported as "possible Feature Envy"

The second is the built-in guard against over-reporting: code smells are heuristics by nature, and
enforcing them as rules generates a lot of noise.

Each rule file's frontmatter carries `applyTo` (glob), `severity_min`, and `categories`; the loop decides
which files to inject from the paths changed in this PR, and **rules for languages untouched by the change
never enter the prompt at all**. This solves three things at once: the prompt doesn't bloat, rules can be
edited directly by a team lead without touching code, and adding a language = adding a file.

Rule content uses the four-part format Graphite validated: **rule → bad example → good example → why**.
Research shows rules without contrasting examples work markedly worse.

**Compatible with existing convention files**: automatically reads existing `CLAUDE.md`, `AGENTS.md`, and
`.cursor/rules/*.mdc` from the repo as extra rule sources. CodeRabbit, Kodus, and GitHub Copilot code
review (from 2026-07) all support this set of files, so a team writes rules once and uses them across
tools — no rewriting for prloop. The closest precedent is `supabase/supabase`'s `.coderabbit.yaml`, which
feeds Claude Code's `SKILL.md` straight to the reviewer as glob-scoped review rules.

The initial content of each language's rules can be transcribed from existing high-quality sources (all
with verifiable rule IDs):

- **Python**: ruff's `B006` mutable default, `B023` loop variable closure, `RUF006` fire-and-forget task,
  `SIM115` opening a file without a context manager, `ASYNC2xx` blocking calls inside async,
  `PLW1641` `__eq__` without `__hash__`, `TRY400` should use `logging.exception`
- **Java**: SpotBugs' `AT_*` (non-atomic compound operations on ConcurrentHashMap), `VO_VOLATILE_INCREMENT`,
  `STCAL_*` (static SimpleDateFormat), `OBL_*` (unfulfilled resource obligation); Sonar's
  `java:S6809` (`@Transactional` self-invocation), `java:S3655` (`Optional.get()` without checking),
  `java:S3959` (stream reuse); plus Spring `@Transactional` not rolling back on checked exceptions by
  default, `readOnly=true` silently discarding changes, and transactions not propagating under `@Async`
- **Next.js/React**: Server Actions must re-verify authorization themselves (page-level checks don't extend
  into them, and a Server Action can be POSTed directly), `'use client'` in a layout/barrel pulls the whole
  subtree into the client bundle, the seven causes of hydration mismatch, the 12 situations where
  `useEffect` shouldn't be used, Next 16's new `"use cache"` / `cacheLife` / `updateTag` model

**Note**: duplicate keys in `Collectors.toMap` and shared mutable state in parallel streams have **no rule
at all** in either Sonar or Error Prone — exactly the gap the LLM semantic layer should fill, and the rule
files must cover them explicitly.

### 7.5 Findings Schema (SSOT, shared by all stages)

```jsonc
{
  "category": "correctness|concurrency|security|reliability|...",  // the nine in §7.2
  "severity": "critical|high|medium|low",
  "confidence": 0.0,           // finder self-assessed; aggregate uses it as a weight hint only
  "file": "/src/foo/bar.py",
  "quote": "exact source line(s)",   // no line number field — the line number is aggregate's job
  "context_before": "...", "context_after": "...",
  "side": "right|left",             // left = targets deleted code
  "claim": "one-sentence description of the defect",
  "evidence": "why this is a real problem (may point at a linter finding id / AC item)",
  "suggested_fix": "optional; if given, aggregate verifies the patch applies before attaching it",
  "boundary_owner": "current|external"  // external is excluded from convergence checks, prevents oscillation
}
```

## 8. Project Structure (one size up from the prior tool, same philosophy)

> **Historical.** This is the tree as designed, kept as the design record. It is not the
> current one — several files here were never written under these names, and others were
> split since. `CLAUDE.md`'s layout table and the repository itself are the live answer.

```
prloop/
  loop.ts                 # entry: argument validation, startup guard, runs/ creation
  orchestrator.ts         # the only loop controller (deterministic)
  config.ts               # SSOT: all thresholds and parameters, overridable via PRR_* env
  ado/                    # Azure DevOps integration layer (all direct REST)
    client.ts             #   auth (PAT / pipeline AccessToken), retries
    iterations.ts         #   iteration bookkeeping, $compareTo increments, changeEntries
    blobs.ts              #   raw bytes by objectId, local unified diff
    threads.ts            #   thread CRUD, fingerprint dedup, sticky summary
    statuses.ts           #   PR Status API (merge gate)
    workitems.ts          #   PR→WI→AC fetching (including one level up)
  anchoring/
    locate.ts             #   quote → absolute line number (disambiguation, fail-closed downgrade)
  gates/
    requirement.ts        #   A) requirement coverage matrix
    static.ts             #   B) run profile tools + SARIF normalization + diff filter
    finder.ts             #   C) parallel multi-model finder
    skeptic.ts            #   D) adversarial verification (cold-start + kill mandate)
    aggregate.ts          #   E) dedup/vote/severity/cap/no-comment gate (zero LLM)
  profiles/
    python.ts  java.ts  nextjs.ts   # language profiles (tools, triage rules, review focus)
  models/
    runner.ts             #   ModelRunner interface (LiteLLM/Ollama/vLLM adapters)
    schemas.ts            #   findings/verdict JSON schema (engine-enforced)
  prompts/                # prompt templates per role (rubric injected by the loop, not discovered)
  libs/                   # log, shell, guard, types, fingerprint
  runs/                   # artifacts: every PR, every iteration, all on disk, reproducible and auditable
```

## 9. Design Principles (all seven from the prior tool, plus four new)

8. **Line-number sovereignty belongs to the pipeline**: for anything that becomes a file coordinate, the
   LLM may only supply a quote; the anchoring layer computes the coordinate deterministically. Can't
   compute it → downgrade. Never guess.
9. **Coverage first, filtering last**: the finder does no self-review (it hurts recall); precision comes
   entirely from skeptic + consensus vote + no-comment gate.
10. **Heterogeneity first**: keep finder/skeptic across model families wherever possible; several models
    from one family are worth far less than two from different families (correlated errors survive).
11. **Quiet is a feature**: a clean PR just updates the summary to say "no high-confidence issues";
    comment cap defaults to 10; style issues never go inline.

## 10. Rejected Options (to prevent re-proposal)

- **Multi-round LLM debate**: empirically the gain ≈ plain voting, at several times the token cost, with
  conformity cascade risk. Use parallel independence + single-round adversarial verification.
- **Posting comments / fetching diffs through azure-mcp**: MCP is a thin wrapper — no anchor validation,
  no iteration bookkeeping, (older versions) no line content; crooked line numbers are the structural
  consequence. The pipeline talks to REST directly.
- **Letting the LLM report line numbers (even asked to read them from the diff)**: hunk-relative vs
  absolute confusion can't be cured by prompting; quote-based anchoring also solves hallucination
  filtering and cross-model matching — three birds, one stone.
- **Prebuilt embeddings index (RAG)**: stale after every commit, and similarity retrieves code that
  *looks like* rather than *structurally depends on* the target (CodeRabbit explicitly dropped it).
  Context comes from diff + one dependency hop (tree-sitter/LSP); reassess hybrid retrieval if the need
  appears.
- **LLM orchestrator / agent deciding retries on its own**: rejected by the prior tool, reasons unchanged.
- **A binary zero-defect review gate**: LLM judges almost never return an empty issue list, so it
  oscillates; use finding tiers + thresholds instead.
- **Bot vote -10 to block merge**: crude and fights the policy; use PR Status + branch policy.
- **Per-repo learned memory (CodeRabbit learnings style) from day one**: log dismissals to disk first
  (fingerprint + disposition), build exclusion rules once enough accumulate. Don't cover the system in
  advance.

## 11. Phased Delivery

- ✅ **M1 (usable skeleton)**: intake (direct REST + local diff + line index) → single-model finder →
  quote anchoring → sticky summary + inline threads. Solves "crooked line numbers" and "no MCP" first.
- ✅ **M2 (requirement gate)**: Work Item → AC coverage matrix → top of summary + PR Status.
- ✅ **M3 (adversary and voting)**: parallel multi-finder + skeptic + consensus verdict + no-comment gate.
- ✅ **M4 (rules layer + static tools layer)**: §7.4's glob-scoped rule files, auto-loading existing
  convention files (CLAUDE.md / AGENTS.md / .cursor/rules); three-language profiles, SARIF normalization,
  diff filter, LLM triage.
- ✅ **M5 (increments and lifecycle)**: iterations $compareTo incremental review, fingerprint dedup across
  pushes, auto-resolving threads (close when the flagged code is fixed), dismissal logging.
- ✅ **M6 (learnings + exclusions)**: the "acted on later" half of §10's dismissal logging — a per-repo
  dismissal store suppresses re-posting what a human closed as wontFix/byDesign (by fingerprint, plus
  position dedupe against dismissed threads), and `PRR_EXCLUDE_CATEGORIES` drops unwanted categories
  before verification spends tokens on them (claude-code-security-review's exclusion-list pattern).
  Accumulated dismissals in one category produce a config *suggestion* in the summary, never an
  automatic rule.

Every milestone runs end-to-end (posts correctly anchored comments on a real PR). Not horizontal layering.

## 12. How to Evaluate (avoiding "it feels better")

- **Offline**: pick 30-50 historical PRs that later produced a real bug that got fixed as a golden set
  (the Entelligence method); keep known-clean PRs for a false positive audit. Metrics: precision / recall /
  comments per PR. The multi-model vs single-model difference gets verified numerically here.
- **Online**: implementation rate (comment actually acted on), dismissal rate, repeat-comment rate,
  no-comment rate. North star: adoption rate of high-confidence comments.
- Industry calibration: the strongest commercial tools reach only ~45-47% F1, and single-pass F1 is ~19% —
  so targeting "≥60% of posted comments adopted, clean PRs stay quiet" is more realistic than chasing recall.

## 13. Key References

PR-Agent diff compression/self-reflection (docs/core-abilities) · CodeRabbit pipeline (The AI Engineer) ·
Ellipsis filter pipeline (nsbradford.com) · reviewdog diff filter · Refute-or-Promote
(arXiv 2604.19049) · Debate-or-Vote (NeurIPS 2025) · Mixture-of-Agents (arXiv
2406.04692) · IRIS / Datadog SAST triage · ADO REST 7.1 (pull-request-threads /
iterations / statuses / work-items) · azure-devops-mcp issues #793 #868 ·
vLLM structured outputs
