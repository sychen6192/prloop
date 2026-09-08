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
        ├ requirement axis          work items vs diff, then a dispute pass   1 + A
        │                           over its own accusations
        └ code axis                 N finders, same prompt, in parallel       N
Step 3  anchor → filter → skeptic   quote → line number, then refutation      M×R + T
        → triage                    excluded/dismissed drop before the skeptic
Step 4  publish                     sticky summary + inline threads           0
```

`N` = finder models · `R` = `PRR_SKEPTIC_ROUNDS` · `M` = anchored findings **that survive the
noise filter** (exclusions and prior dismissals cost no verification tokens) · `A` = criteria
the requirement axis accused of being `missing` or `misunderstood`, each disputed once ·
`T` = triage batches, ten tool findings each. All model calls share one concurrency pool
(`PRR_LLM_CONCURRENCY`) and retry on transient failures.

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

  It gets **its own verification**, deliberately narrower than the code axis's. The two
  verdicts that accuse the author — `missing` and `misunderstood` — are refutable claims about
  the diff, so each gets one attempt from the first skeptic model: one round, not a majority
  vote, because every call here re-reads the finder-sized diff and is priced like an extra
  finder. A refutation never flips a verdict to `satisfied`; it demotes it to
  `not-verifiable` with the refuter's evidence, taking the accusation out of the unmet count
  while leaving the disagreement visible. `satisfied` — the one verdict that closes a
  criterion — is held to the same quote contract as a code finding: its evidence quote is
  anchored in the diff, and a quote that isn't there is demoted too. Same asymmetries as the
  code skeptic: only downward, and fails open.
- **Code axis** — 8 categories × 4 severities (`req-mismatch`, the ninth, belongs to the
  requirement axis), severity from an ordered decision chain (key split: is there a
  workaround?) rather than adjectives.

### Precision comes from filtering, not from asking nicely

Telling a model to be careful measurably hurts recall. So the finder runs in **coverage
mode** — report everything, including low confidence — and three independent gates downstream
do the filtering:

1. **Anchoring** kills hallucinations.
2. **Skeptic** — a model from a *different family* is told to **refute** the finding, not
   assess it. A verifier asked "is this right?" agrees. It also **never sees the finder's
   reasoning**, only the claim and the code; shared reasoning creates an anchoring effect.
   Its verdict has three values, not two: `refuted` (which must quote the line that proves
   it, checked against the snippet the verifier was shown — an unevidenced refutation is
   discarded), `holds`, and `insufficient-context` for a claim about code it was not shown
   (another file, a caller, a deleted line). "I could not check this" is no longer reported
   as "I checked it and it holds". Each round uses a *different* model — rounds beyond the
   number of configured models are dropped, because re-sampling one model at temperature 0.2
   is not a second opinion — and a run whose skeptics all share a family with a finder says
   so, loudly, on every run.
3. **Consensus** — an inline comment needs corroboration: two finders found it independently,
   or a majority of the skeptics that answered actively **cleared** it. An even split clears
   nothing, and neither does a verdict of `insufficient-context`. A lone unverified finding
   stays in the summary. Each finder reads the same files in its own seeded order, so
   agreement on a finding is not agreement on where it sat in the prompt.

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

`PRR_WORKDIR` is a checkout of the PR's **source branch**, and the tools execute that
branch's code: an eslint config, a Maven plugin or a lint hook is a program the PR author
wrote. The tools therefore run with a **secret-scrubbed environment** — every variable whose
name looks like a credential (`*_PAT`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`,
`*_ACCESS_KEY`, `*_PRIVATE_KEY`, `SYSTEM_ACCESSTOKEN`, prloop's own PAT and LLM key) is
dropped, and everything else (`PATH`, `JAVA_HOME`, `M2_HOME`, `npm_config_*`, proxies, CA
paths) passes through, because build tools legitimately need it. The `opencode` runner's
child process gets the same treatment.

---

## Setup

Needs Node 20+, an OpenAI-compatible endpoint (LiteLLM / vLLM / Ollama `/v1`), and ADO auth —
either a PAT with **Code (Read & Write) + Work Items (Read)** (the requirement axis reads the
linked work item, and a Code-only PAT fails there), or just `az login`.

**Not on npm.** Clone it and run it in place — there is no build step: `tsx` executes the
TypeScript directly and `tsc --noEmit` is typecheck-only, so nothing is ever compiled or
published. `npm ci` (dev dependencies included) is what installs `tsx`.

```bash
git clone <repo> prloop && cd prloop
npm ci
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
shell has it. Use the `PRR_`-prefixed names, which always win. Every run now warns about a
`.env` line a shell export is discarding, and about a `PRR_` name prloop does not read;
`prloop --config` prints every setting with its value and where that value came from.

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

The wrapper is bash, so on **Windows** (and anywhere else without it) use the npm script,
which runs the same entry point through the repo's own `tsx` — from the prloop directory:

```powershell
npm run prloop -- "<PR URL>" --dry-run
npm run prloop -- "<PR URL>" --since auto
```

The `--` is required: without it npm swallows the arguments. `prloop --help` prints this
usage to stdout and exits 0. Both paths need `npm ci` (dev dependencies included) to have
run in the prloop directory — `npm ci --omit=dev` removes `tsx` and neither can start.

prloop's own requests trust `PRR_CA_CERTS` either way (`libs/tls.ts` applies it in process).
The bash wrapper additionally exports it as `NODE_EXTRA_CA_CERTS` for child processes; on the
npm path, set that yourself if `az`, `git` or `opencode` need the corporate CA.

URL format: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`.
On-prem and `visualstudio.com` are derived from the URL itself, virtual directories included.

Exit codes: `0` clean · `2` unmet criteria or critical/high findings · `3` **review
incomplete** (a stage crashed, or the finder never saw part of the diff and
`PRR_STRICT_COVERAGE` is on — nothing blocking was found, but the check that would have
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

Every run writes `runs/<org>/<project>/<repo>/pr-<id>/iter-<N>-<ts>/`: the settings the run
actually used and where each came from (`config.json`), the exact prompts
(`finder-prompt.md` is finder 0's; `finder-<i>-<model>-prompt.md` is each finder's own, since
every finder reads the files in its own seeded order), each model's raw output
(`finder-*-raw.txt`, `requirement-raw.txt`, `triage-raw.txt` — kept on failure too, which is
when it matters), the run seed and per-finder seeds (`finder-outputs.json`), per-finding
skeptic verdicts with what each verifier actually said (`skeptic.json`), and the anchoring
outcome for everything including what was rejected and why (`findings.json`). Three files
make a run readable on its own: `run.log` (every log line, including the ones printed before
the directory existed), `calls.jsonl` (one line per model *attempt* — stage, model, retry
number, duration, tokens, error), and `result.json` (the outcome: exit code, what was
incomplete, the counts down the funnel, tokens, duration, version). Start there when a
result looks wrong.

## Settings

Full list with explanations in [.env.example](./.env.example). The ones that change behaviour:

| Variable | Default | |
| --- | --- | --- |
| `PRR_FINDER_MODELS` | `qwen3-coder` | comma-separated; different families is the point |
| `PRR_SKEPTIC_MODELS` | — | empty = no verification runs |
| `PRR_SKEPTIC_ROUNDS` | `1` | 3 gives a majority vote worth the name; capped at the number of distinct `PRR_SKEPTIC_MODELS` |
| `PRR_MAX_SKEPTIC_FINDINGS` | `30` | fan-out ceiling; worst findings verified first, overflow logged |
| `PRR_SKEPTIC_MAX_TOKENS` | `4096` | output budget per verdict; a truncated verdict fails open and costs the finding its corroboration |
| `PRR_ADO_CONCURRENCY` | `6` | parallel blob fetches during intake |
| `PRR_LLM_CONCURRENCY` | `6` | in-flight model calls across all stages; match your endpoint's batch size. `0` = no cap |
| `PRR_LLM_RETRIES` | `1` | **EXTRA** attempts on transient model failures — `1` = up to two calls, `0` = never retry (never on 4xx) |
| `PRR_LLM_MAX_TOKENS` | `8192` | **raise to 16384+ for thinking models** — reasoning is billed to this budget |
| `PRR_LLM_STREAM` | `1` | stream completions (SSE) so a gateway's idle timeout can't 504 a long generation; `0` = buffered |
| `PRR_LLM_EXTRA_BODY` | — | JSON object merged into every model request — engine knobs prloop has no flag for; prloop's own fields win on conflict |
| `PRR_LLM_EXTRA_BODY_BY_MODEL` | — | per-model override map ({} = send none): run a mixed fleet, e.g. thinking disabled globally but re-enabled for one deep finder and the skeptic |
| `PRR_REASONING` | — | how much thinking to ask for: `none` \| `low` \| `medium` \| `high`. Unset sends nothing and leaves the backend's default alone. Translated per dialect (`reasoning_effort` / `thinking.budget_tokens` / `enable_thinking` / `think`) |
| `PRR_REASONING_BY_MODEL` | — | JSON `model → level`: no thinking on the finders that only quote code back, deep thinking on the skeptic. Precedence: `PRR_LLM_EXTRA_BODY` > this > `PRR_REASONING` |
| `PRR_FINDER_PROMPT_SUFFIX_BY_MODEL` | — | JSON `model → text` appended to that finder's system prompt: a per-family stance (self-censoring and over-reporting families need opposite nudges) without forking the prompt |
| `PRR_FINDER_SEED` | random per run | seed for the per-finder file-order shuffle; set it to replay a run exactly (the seed a run used is in `finder-outputs.json`) |
| `PRR_MIN_INLINE_SEVERITY` | `medium` | below this → summary only |
| `PRR_MAX_INLINE_COMMENTS` | `10` | code axis (requirement axis has its own budget of 3) |
| `PRR_MAX_EXTRAS` | `5` | cap on reported out-of-scope changes; the model ranks, the gate slices |
| `PRR_EXCLUDE_CATEGORIES` | — | categories never reported (e.g. `performance,maintainability`) |
| `PRR_LEARN_FROM_DISMISSALS` | `1` | `0` = re-post findings humans dismissed as wontFix/byDesign |
| `PRR_REQUIRE_CORROBORATION` | `1` | `0` publishes unverified single-source findings |
| `PRR_STRICT_COVERAGE` | `1` | files the finder never saw (over `PRR_MAX_DIFF_CHARS`, or too large to fetch) make the run incomplete (exit 3); `0` = a partial review can still exit 0 |
| `PRR_WORKDIR` | — | checkout at the iteration's `sourceRefCommit`; unset = static analysis skips. Files whose content differs from the iteration under review are skipped, not analysed. Tools execute the reviewed branch's code, with a secret-scrubbed environment |
| `PRR_TRIAGE_MODEL` | — | unset = high-FP tool findings are dropped |
| `PRR_CA_CERTS` | — | CA bundle for TLS-intercepting networks (comma-separated) |
| `PRR_DRY_RUN` | — | `1` = compute, publish nothing |
| `PRR_ADO_MAX_RETRIES` | `3` | **TOTAL** attempts per ADO request, first try included — `1` = never retry. Opposite sense to `PRR_LLM_RETRIES`; both names are published, so neither was renamed |
| `PRR_RUNS_KEEP` | `20` | iteration directories kept per PR under `runs/`, oldest deleted first; `0` = keep everything. Never touches `dismissals.jsonl` |
| `PRR_RUNS_MAX_AGE_DAYS` | `0` | also delete iteration directories older than this; `0` = no age limit |

Everything else prloop reads. `prloop --config` prints this same list with the value each
one currently has and where it came from (`shell` / `.env` / `default`), which is the fast
answer to "why did editing `.env` change nothing".

| Variable | Default | |
| --- | --- | --- |
| `PRR_ADO_PAT` | — | PAT with Code (Read & Write); empty = `az login`. Never logged or saved |
| `PRR_AUTH_MODE` | `auto` | `auto` \| `pat` \| `azcli` |
| `PRR_AZ_BIN` | `az` | az CLI executable, when it is not on `PATH` |
| `PRR_ADO_BASE_URL` | — | only when the API host differs from the browser host |
| `PRR_ADO_API_VERSION` | `7.1` | on-prem: Server 2019→5.0, 2020→6.0, 2022→7.0 |
| `PRR_ADO_TIMEOUT_MS` | `60000` | per-request deadline for ADO REST calls |
| `PRR_ADO_MAX_RETRIES` | `3` | attempts for a transient ADO failure |
| `PRR_LLM_BASE_URL` | `http://localhost:4000/v1` | OpenAI-compatible endpoint |
| `PRR_LLM_API_KEY` | `dummy` | key for that endpoint. Never logged or saved |
| `PRR_REQ_MODEL` | first finder | requirement axis model; set it when acceptance criteria need a stronger one |
| `PRR_LLM_TIMEOUT_MS` | `900000` | deadline for one model call, first byte to last |
| `PRR_LLM_STALL_TIMEOUT_MS` | `120000` | abort a *stream* that goes silent this long (every chunk resets it). Without it, an engine that dies without closing the socket costs the full deadline — twice, with the retry. `0` = disabled |
| `PRR_LLM_TEMPERATURE` | `0.2` | low on purpose: review is not a creative task. `none` omits the field, for backends that reject it |
| `PRR_LLM_TEMPERATURE_BY_MODEL` | — | JSON `model → number \| "none"` |
| `PRR_LLM_API_FLAVOR` | `auto` | dialect for the reasoning translation: `auto` \| `openai` \| `anthropic` \| `qwen` \| `ollama`. `auto` infers per model from the name |
| `PRR_LLM_STRUCTURED` | `1` | `0` = don't send `response_format`; the schema is inlined into the prompt instead |
| `PRR_RUNNER` | `openai` | `openai` \| `opencode` |
| `PRR_OPENCODE_BIN` | `opencode` | opencode executable |
| `PRR_OPENCODE_AGENT` | `prloop-reviewer` | agent definition prloop drives (installed by `npm run setup`) |
| `PRR_OPENCODE_JSON` | `1` | `0` = drop `--format json` for builds without JSONL events; loses tracing |
| `PRR_AGENT_TIMEOUT_MS` | `900000` | wall clock for one opencode session |
| `PRR_RULES_DIR` | `rules/` | your team's rules as `.md` files with an `applyTo` glob |
| `PRR_MAX_DIFF_CHARS` | `240000` | ceiling on the diff sent to a finder, in characters of the diff alone; overflow makes the run incomplete |
| `PRR_CONTEXT_TOKENS` | `0` (off) | the model's context window in tokens. Set it and the diff is budgeted as `window − PRR_LLM_MAX_TOKENS − (system prompt + rules + conventions + PR description + inlined schema)`, so the backend never truncates a prompt mid-hunk and corrupts the quotes anchoring depends on. Token counts are an estimate (±20%) |
| `PRR_CONTEXT_TOKENS_BY_MODEL` | — | JSON `model → tokens`: a fleet of different families is also a fleet of different context sizes, and one number either wastes the largest or truncates the smallest |
| `PRR_HUNK_CONTEXT_BEFORE` | `6` | context lines before each hunk (asymmetric: what precedes a change means more) |
| `PRR_HUNK_CONTEXT_AFTER` | `3` | context lines after each hunk |
| `PRR_MAX_FILE_BYTES` | `2000000` | bigger files are diffed, never sent whole |
| `PRR_SKEPTIC_CONTEXT_LINES` | `25` | source lines around the finding; a skeptic that needs the whole file is guessing |
| `PRR_SKEPTIC_TIMEOUT_MS` | `180000` | tighter than a finder's, and separate: a skeptic timeout fails open |
| `PRR_MIN_CONSENSUS_SOURCES` | `2` | independent finders needed to publish without a skeptic |
| `PRR_SKIP_STATIC` | — | `1` = skip static analysis |
| `PRR_STATIC_TIMEOUT_MS` | `300000` | deadline for one linter invocation |
| `PRR_TRIAGE_CONTEXT_LINES` | `12` | source lines shown to the triage model |
| `PRR_MAX_TRIAGE_ITEMS` | `40` | a PR tripping 200 lint rules has a lint config problem, not a review problem |
| `PRR_SKIP_REQUIREMENT` | — | `1` = skip the requirement axis |
| `PRR_DISMISSAL_HINT_THRESHOLD` | `3` | dismissals in one category before the summary suggests excluding it |
| `PRR_MAX_INLINE_REQ_COMMENTS` | `3` | requirement-axis budget, separate so code findings cannot crowd it out |
| `PRR_POST_STATUS` | — | `1` = also post a PR status (needs a branch policy to gate merges) |
| `PRR_STATUS_GENRE` | `prloop` | genre of that status |
| `PRR_STATUS_NAME` | `ai-review` | name of that status |
| `PRR_HTTPS_PROXY` | — | overrides `HTTPS_PROXY` from the shell (Node's fetch reads neither by itself) |
| `PRR_HTTP_PROXY` | — | overrides `HTTP_PROXY` from the shell |
| `PRR_NO_PROXY` | — | hosts that bypass the proxy; `host:port` entries match on port |
| `PRR_USER_AGENT` | `prloop/<version>` | for proxies that filter CONNECT by User-Agent |
| `PRR_QUIET` | — | `1` = drop the verbose log lines |
| `PRR_RUNS_DIR` | `runs/` | artifacts root |
| `PRR_SHOW_CONFIG` | — | `1` = print the settings table and exit, same as `--config` (for pipelines) |

**Thinking models** outgrow the default 8192-token budget: a measured finder call on a
self-hosted `qwen3.6:27b` used 7.8k completion tokens with ~24k characters of reasoning
behind them. Overrun is reported as `response truncated at the token limit`, not as
unparseable output — those need different fixes.

**Runaway reasoning** is the failure a bigger limit can't fix: reasoning length is random per
call, and a model that burns the *entire* budget, however high, eats whatever it is given.
Point the finders at a non-thinking variant (finding + verbatim quoting doesn't need
long reasoning; verification is where it earns its cost), or turn thinking off with
`PRR_REASONING=none` — `PRR_REASONING_BY_MODEL={"qwen3-coder":"none","claude-sonnet":"medium"}`
is the mixed-fleet version.

**Reasoning is one setting, four spellings.** `PRR_REASONING` is translated per dialect:
`reasoning_effort` (OpenAI), `thinking.budget_tokens` scaled off `PRR_LLM_MAX_TOKENS`
(Anthropic), `chat_template_kwargs.enable_thinking` (Qwen), `think` (Ollama) — with `none`
omitting the field where a backend has no way to say it. `PRR_LLM_API_FLAVOR` picks the
dialect; `auto` reads it off each model's name, which is what a LiteLLM proxy fronting
several vendors needs. **Temperature is part of that trap**: Anthropic extended thinking
accepts only `temperature: 1` (prloop forces it, and says so once), newer Anthropic models
and OpenAI reasoning models reject the field entirely — that is what `PRR_LLM_TEMPERATURE=none`
is for. `PRR_LLM_EXTRA_BODY` still wins over all of it, temperature included: it is the
escape hatch for anything this vocabulary cannot say.

**Single-GPU / one-model-at-a-time backends** (a plain Ollama host) need
`PRR_LLM_CONCURRENCY=1`. The finder fan-out otherwise interleaves requests for different
models and the backend thrashes, evicting and reloading between calls. At 1, each model is
loaded exactly once per run.

**Runner** — `PRR_RUNNER=openai` (default) talks HTTP directly and supports **guided
decoding**, where the engine enforces the JSON schema at the token level. That is what keeps
weak models emitting valid JSON. `opencode` reuses your existing provider config but **does
not forward `response_format`**, dropping schemas to prompt-level only. Run `npm run setup`
first to install its agent definition. Like every child process it receives a
secret-scrubbed environment (see static analysis), so its provider keys must live in
opencode's own auth store (`opencode auth login`), not in `*_API_KEY` variables.

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

The reviewed repository's own convention documents (`CONTRIBUTING.md`, `CODING_STANDARDS.md`,
`docs/` variants, `CLAUDE.md`, `AGENTS.md`) are fetched automatically at the iteration's
commit and injected ahead of the rules — that is what makes "conventions override the
baseline" enforceable rather than aspirational. Standards that live anywhere else go in
`PRR_RULES_DIR` as rule files with an `applyTo` glob.

## Development

```bash
npm run check                 # typecheck + selftest
npx tsx scripts/demo.ts       # render comments from fake data, no ADO or model calls
npx tsx scripts/calibrate.ts  # is it getting better? joins runs/ to the dismissal store
```

`scripts/calibrate.ts` reads `runs/**/findings.json`, `runs/**/skeptic.json` and each repo's
`dismissals.jsonl` and prints the dismissal rate by finder confidence, by category and by
finder model; each skeptic model's kill rate and "could not check it" rate; and how many
published findings a human later dismissed — the tool's own false-positive rate. It is
read-only and offline, counts each finding once no matter how often the PR was re-reviewed,
and skips (counting) any artifact it cannot read, so an old or half-written `runs/` tree
still yields a report. Pass a directory to point it somewhere other than `PRR_RUNS_DIR`.

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

## Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) — invariants, the four places a new knob lives, and how to
run a review with no ADO credentials. [SECURITY.md](./SECURITY.md) covers what the tool handles
and how to report a vulnerability privately; [CHANGELOG.md](./CHANGELOG.md) is the history.

MIT.
