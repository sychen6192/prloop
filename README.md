# prloop — Automated PR Review for Azure DevOps

Reviews Azure DevOps pull requests with local or self-hosted models, on two axes: **does the
code work**, and **does it do what the work item asked for**.

Built for weak models. Everything that decides *where a comment goes* and *whether it is
posted* is deterministic TypeScript — the model's only job is to find a problem and quote the
offending line. It never gets control of the loop.

Design rationale and research basis: [PROPOSAL.md](./PROPOSAL.md).
Network / TLS / proxy problems: [docs/troubleshooting.md](./docs/troubleshooting.md).

---

## Architecture

One pass, four steps. No inner loop, no agentic wandering. The "loop" is the
outer one: re-run per PR iteration with `--since auto`.

```
Step 1  fetch PR changes            ADO REST → blob bytes → Myers diff        0 model calls
Step 2  ┌ static analysis           linters over PRR_WORKDIR                  0
        ├ requirement axis          work items vs diff                        1
        └ code axis                 N finders, same prompt, in parallel       N
Step 3  anchor → filter → skeptic    quote → line number, then refutation      M×R + 1
        → triage                    excluded/dismissed drop before the skeptic
Step 4  publish                     sticky summary + inline threads           0
```

`N` = finder models, `R` = `PRR_SKEPTIC_ROUNDS`, and `M` = anchored findings **that survive
the noise filter** — an excluded category or a previously dismissed finding costs no
verification tokens at all.
All model calls share one concurrency pool (`PRR_LLM_CONCURRENCY`, default 6) and retry once
on transient failures.

The requirement axis is not part of the step-2 barrier — its result is only needed at publish
time, and the gate is non-fatal, so it must not be able to hold the pipeline. Step 3 starts as
soon as the finders return.

### The model never emits a line number

Its output schema has no such field. Wrong-line comments are the reason this tool exists,
and MCP wrappers get them wrong structurally — no anchor validation, no iteration bookkeeping
(see azure-devops-mcp #793, #868).

1. The model returns a `quote`: a verbatim copy of the offending source.
2. The pipeline fetches that iteration's **raw blob bytes** by objectId — no local checkout,
   so no CRLF/BOM normalisation drift — and searches for the quote.
3. Duplicate matches are resolved by the model's own stated context, then by preferring lines
   this PR touched, then by preferring lines inside a hunk.
4. Not found, or still ambiguous → **the finding degrades into the summary. Never a guessed
   line.**

Free side effect: a quote that doesn't exist in the file is a hallucination, caught here.

### Two axes, run blind to each other

A PR can follow every convention while building the wrong thing. Ranking both axes together
lets three critical code findings crowd out "the requirement was never implemented", so they
get **separate comment budgets and separate summary sections**, and neither axis's model sees
the other's output.

- **Requirement axis** — pulls linked work items (walking one level up for acceptance
  criteria) and gives each criterion a verdict: `satisfied / missing / partial /
  misunderstood / not-verifiable`, plus out-of-scope changes. It reports *how* it failed, not
  a percentage — a percentage is not actionable.
- **Code axis** — 9 categories × 4 severities, severity from an ordered decision chain (key
  split: is there a workaround?) rather than adjectives.

### Precision comes from filtering, not from asking nicely

Telling a model to be careful measurably hurts recall. So the finder runs in **coverage
mode** — report everything, including low confidence — and three independent gates downstream
do the filtering:

1. **Anchoring** kills hallucinations.
2. **Skeptic** — a model from a *different family* is told to **refute** the finding, not
   assess it. A verifier asked "is this right?" agrees. It also **never sees the finder's
   reasoning**, only the claim and the code; shared reasoning creates an anchoring effect.
3. **Consensus** — an inline comment needs corroboration: two finders found it independently,
   or a skeptic actively cleared it. A lone unverified finding stays in the summary.

A fourth filter answers to the team rather than to the models: categories this repo does not
want (`PRR_EXCLUDE_CATEGORIES`) and findings a reviewer already closed as *wontFix* never
reach the skeptic. A human's decision outranks every gate above — corroboration cannot
re-open what a reviewer closed.

Three deliberate asymmetries:

| Stage | Asymmetry | Why |
| --- | --- | --- |
| Skeptic severity | may only **lower**, never raise | letting the verifier escalate hands back the agreement bias it exists to counter |
| Skeptic failure | **fails open** — finding survives | a broken verifier must not be able to delete real bugs |
| Anchor failure | **fails closed** — no inline comment | a wrong-line comment does more damage than a miss |

### Static analysis is tiered by tool character

Results are diff-filtered first (only changed lines), then split:

| Tier | Tools | Handling |
| --- | --- | --- |
| **Fact** | `tsc`, `mypy` | type errors are facts — comment directly, no model involved |
| **Triage** | `bandit`, `PMD`, `SpotBugs`, `ruff`, `eslint` | good recall, high FP — a model judges each in context |
| **Suppressed** | `checkstyle`, formatting | counted in the summary, never commented |

The tool supplies recall (it never forgets a pattern); the model supplies the context pattern
matching can't see. Empirically the strongest hybrid available (Semgrep FPs 560 → 64).

With `PRR_TRIAGE_MODEL` unset, triage-tier results are **dropped, not posted** — unjudged
high-FP output is noise.

---

## Setup

Needs Node 20+, an OpenAI-compatible endpoint (LiteLLM / vLLM / Ollama `/v1`), and ADO auth —
either a PAT with **Code (Read & Write)**, or just `az login`.

```bash
git clone <repo> prloop && cd prloop
npm install
cp .env.example .env
npm run check                                  # typecheck + offline selftest (count printed by the run)
npx tsx scripts/doctor.ts '<PR URL>' --smoke   # preflight + one live model call
```

Minimum `.env`:

```bash
PRR_ADO_PAT=...                            # or leave empty and use az login
PRR_LLM_BASE_URL=http://your-endpoint/v1
PRR_FINDER_MODELS=model-a,model-b          # different families
PRR_SKEPTIC_MODELS=model-c                 # different family again
```

⚠️ **One finder and no skeptic posts zero inline comments** — nothing can reach corroboration.
`doctor` warns about this.

⚠️ **`.env` never overrides a variable already exported in your shell.** That is deliberate
(CI injects real values), but it means `HTTPS_PROXY` in `.env` silently does nothing if your
shell has it. Use the `PRR_`-prefixed names, which always win.

## Run

`bin/prloop` is a wrapper that runs from any directory and hands corporate CA certificates
down to child processes (`az`, `git`, `opencode`), which read only the environment. Call it
by path, or put it on your `PATH` once:

```bash
export PATH="$PWD/bin:$PATH"     # or: ln -s "$PWD/bin/prloop" ~/.local/bin/prloop

prloop '<PR URL>' --dry-run      # compute everything, post nothing — do this first
prloop '<PR URL>'                # publish
prloop '<PR URL>' --since auto   # incremental: only commits since the last review
```

URL format: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`.
On-prem and `visualstudio.com` are derived from the URL itself, virtual directories included.

Exit codes: `0` clean · `2` unmet criteria or critical/high findings · `3` **review
incomplete** (a stage crashed — nothing blocking was found, but the check that would have
found it never ran) · `1` fatal.

`--since auto` reads the last reviewed iteration back out of prloop's own summary comment —
state lives on the PR, so a pipeline agent, your laptop and a cron box need no shared disk.

Without ADO credentials at all, review two git branches through the identical diff and
anchoring path:

```bash
npx tsx scripts/local-review.ts prompt <repo> <base> <head> [out.md]
npx tsx scripts/local-review.ts anchor <repo> <base> <head> <findings.json>
```

## What lands on the PR

- **One sticky summary**, updated in place, posted closed so it can't trip a
  "comments must be resolved" policy.
- **A few inline threads**, active, carrying `changeTrackingId` + `iterationContext` so ADO
  tracks their position across new commits.
- **No duplicates on re-run** — each comment embeds a finding fingerprint.
- **Stale threads auto-close** when their target code is gone. The criteria are narrow on
  purpose: wrongly closing a live issue is worse than leaving a stale comment.
- **Dismissals stick.** A finding closed as *wontFix*/*byDesign* is recorded per repo
  (`runs/<org>/<project>/<repo>/dismissals.jsonl`) and never posted again on any PR where
  the model produces the same quote (rewordings on the same PR are also caught by position
  overlap; a substantially reworded finding on a *different* PR can still reappear —
  fingerprints hash the quote). A thread merely marked *Closed* is treated as handled, not
  dismissed. After three dismissals in one category the summary suggests excluding it, and
  stops there: prloop never writes its own config.
- **Clean PR → one quiet line.** Style and formatting never get a comment; that's the linter's job.

Every run writes `runs/<org>/<project>/<repo>/pr-<id>/iter-<N>-<ts>/`: the exact prompts
(`finder-prompt.md`), each model's raw output (`finder-*-raw.txt`), per-finding skeptic
verdicts (`skeptic.json`), and the anchoring outcome for everything including what was
rejected and why (`findings.json`). Start there when a result looks wrong.

## Settings

Full list with explanations in [.env.example](./.env.example). The ones that change behaviour:

| Variable | Default | |
| --- | --- | --- |
| `PRR_FINDER_MODELS` | `qwen3-coder` | comma-separated; different families is the point |
| `PRR_SKEPTIC_MODELS` | — | empty = no verification runs |
| `PRR_SKEPTIC_ROUNDS` | `1` | 3 gives a majority vote worth the name |
| `PRR_MAX_SKEPTIC_FINDINGS` | `30` | fan-out ceiling; worst findings verified first, overflow logged |
| `PRR_ADO_CONCURRENCY` | `6` | parallel blob fetches during intake |
| `PRR_LLM_CONCURRENCY` | `6` | in-flight model calls across all stages; match your endpoint's batch size |
| `PRR_LLM_RETRIES` | `1` | retries on transient model failures (never on 4xx) |
| `PRR_LLM_MAX_TOKENS` | `8192` | **raise to 16384+ for thinking models** — reasoning is billed to this budget |
| `PRR_LLM_STREAM` | `1` | stream completions (SSE) so gateways with idle timeouts can't 504 a long generation; `0` = buffered single response |
| `PRR_LLM_EXTRA_BODY` | — | JSON object merged into every model request, for engine knobs prloop has no flag for (e.g. `{"chat_template_kwargs":{"enable_thinking":false}}` switches Qwen3 thinking off on vLLM); prloop's own fields win on conflict |
| `PRR_MIN_INLINE_SEVERITY` | `medium` | below this → summary only |
| `PRR_MAX_INLINE_COMMENTS` | `10` | code axis (requirement axis has its own budget of 3) |
| `PRR_EXCLUDE_CATEGORIES` | — | categories never reported (e.g. `performance,maintainability`); dropped before the skeptic spends tokens on them |
| `PRR_LEARN_FROM_DISMISSALS` | `1` | `0` = re-post findings humans dismissed as wontFix/byDesign |
| `PRR_REQUIRE_CORROBORATION` | `1` | `0` publishes unverified single-source findings |
| `PRR_WORKDIR` | — | checkout at the iteration's `sourceRefCommit`; unset = static analysis skips. Files whose content differs from the iteration under review are skipped, not analysed |
| `PRR_TRIAGE_MODEL` | — | unset = high-FP tool findings are dropped |
| `PRR_CA_CERTS` | — | CA bundle for TLS-intercepting networks (comma-separated) |
| `PRR_DRY_RUN` | — | `1` = compute, publish nothing |

**Thinking models** bill their chain of thought against `max_tokens`, so the default 8192 is
not enough: a measured finder call on a self-hosted `qwen3.6:27b` used 7.8k completion tokens
with ~24k characters of reasoning behind them. Overrun is reported as
`response truncated at the token limit`, not as unparseable output — those need different fixes.
When a model keeps burning the *entire* budget on reasoning no matter how high the limit, stop
raising it — reasoning length is random per call, and a runaway eats whatever it is given.
Point the finders at a non-thinking variant (finding + verbatim quoting doesn't need long
reasoning; verification is where it earns its cost), or switch thinking off at the engine:
`PRR_LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}` (vLLM / Qwen3).

**Single-GPU / one-model-at-a-time backends** (a plain Ollama host) need
`PRR_LLM_CONCURRENCY=1`. The finder fan-out otherwise interleaves requests for different
models and the backend thrashes, evicting and reloading between calls. At 1, each model is
loaded exactly once per run.

**Runner** — `PRR_RUNNER=openai` (default) talks HTTP directly and supports **guided
decoding**, where the engine enforces the JSON schema at the token level. That is what keeps
weak models emitting valid JSON. `opencode` reuses your existing provider config but **does
not forward `response_format`**, dropping schemas to prompt-level only. Run `npm run setup`
first to install its agent definition.

## Review rules

`rules/*.md` are plain editable markdown. Each declares a glob in frontmatter, and **only
rules matching a changed file enter the prompt** — no Java in the diff means Java rules never
load, so the rule set can grow without inflating every prompt.

```markdown
---
applyTo: "**/*.java"
---
# Java review rules
```

`_base.md` (all languages) carries the 12 code smells from *Refactoring* ch.3 under two
binding constraints: the repo's own conventions override the baseline, and every smell is a
judgment call capped at `medium` severity. That cap is the built-in guard against
over-reporting.

`PRR_RULES_DIR` points elsewhere.

## Development

```bash
npm run check              # typecheck + selftest
npx tsx scripts/demo.ts    # render comments from fake data, no ADO or model calls
```

`scripts/selftest.ts` is the regression net for anchoring — **run it after touching
`libs/diff.ts` or `anchoring/locate.ts`**. Its assertions map directly onto the causes of
"comment on the wrong line".

`fixtures/seeded-pr.ts` is a realistic 3-language PR with seeded defects, every expected line
verified against the real file with `grep -n`. It pins four boundaries: a duplicated line with
no context **must be ruled ambiguous rather than guessed**; the same duplicate with differing
`context_before` must resolve correctly each way; a quoted line that doesn't exist must be
blocked; and reformatted indentation must still match on the second pass.

Toy fixtures prove the algorithm runs. This one proves it lands on the right line in code that
looks real.

## Status

M1–M6 complete: REST + quote anchoring → requirement axis → multi-model adversarial
verification → rules + static analysis → incremental review and comment lifecycle →
dismissal learnings and category exclusions.
Runs end-to-end on real PRs.

MIT.
