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
2. **Skeptic** — first, a claim a search can settle is settled by one: a finder marks "X is
   never used", "X is not defined", "that file does not exist" or "X is defined twice", and
   `gates/claims.ts` looks it up in the PR's files and, with `git grep` at the commit, in the
   repository. Only a contradiction found drops a finding — the use, the definition, the file,
   recorded as a refutation with the line that proves it; a lookup that cannot run keeps it.
   Then a model from a *different family* is told to **refute** the finding, not
   assess it. A verifier asked "is this right?" agrees. It also **never sees the finder's
   reasoning**, only the claim and the code; shared reasoning creates an anchoring effect.
   Its verdict has three values, not two: `refuted` (which must quote the line that proves
   it, checked against the snippet the verifier was shown — an unevidenced refutation is
   discarded), `holds`, and `insufficient-context` for a claim about code it was not shown
   (another file, a caller, a deleted line). "I could not check this" is no longer reported
   as "I checked it and it holds" — and it gets one second reading: the pipeline, not the
   model, looks up the definitions and a few callers of the names on the accused lines (in
   the PR's files, then with `git grep` at the commit) and asks that verifier again, with the
   same powers and no more (`PRR_SKEPTIC_LOOKUP`). Each round uses a *different* model — rounds beyond the
   number of configured models are dropped, because re-sampling one model at temperature 0.2
   is not a second opinion — and a run whose skeptics all share a family with a finder says
   so, loudly, on every run.
3. **Consensus** — an inline comment needs corroboration: two finders found it independently,
   or a majority of the skeptics that answered actively **cleared** it. An even split clears
   nothing, and neither does a verdict of `insufficient-context`. A lone unverified finding
   stays in the summary. Each finder reads the same files in its own seeded order, so
   agreement on a finding is not agreement on where it sat in the prompt. Two finders agree
   only when they say the same thing — the same quoted code classified as the same kind of
   problem, or claims worded alike — never merely because they pointed at the same lines: two
   different claims about one line stay two findings, each verified and gated on its own.

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
child process gets the same treatment, and so does `PRR_WORKTREE_SETUP_CMD` — which is why
that command runs in a **non-login** shell: a login shell re-reads `~/.profile`, and a
profile that exports a key would hand back everything the scrub just dropped. It therefore
inherits prloop's own `PATH` and nothing else, exactly as the linters do, so a toolchain that
exists only inside `~/.profile` (nvm, pyenv, sdkman) needs its `PATH` exported in the
environment prloop itself starts from.

---

## Setup

Needs Node 22.19+, an OpenAI-compatible endpoint (LiteLLM / vLLM / Ollama `/v1`), and ADO auth —
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
Only the code axis narrows to the new push: acceptance criteria are met by the pull request as
a whole, so the requirement axis reads the whole PR on every run (an incremental run fetches
the files the push left alone as well) and comments inline only on lines the push changed.

**A run that did not review the push does not move that resume point.** If the finder stage
crashed, every finder failed, the skeptic stage crashed, the requirement axis errored, or a
comment came back with a 5xx, the summary keeps the previous iteration marker and the next
run reviews the same push again; the summary says so in its run notes. Deliberately narrow:
a crashed linter, one model out of three timing out, one finding whose verifier died, a 4xx
ADO will refuse identically next time, and files dropped for diff size all still advance it —
they are reported by exit `3`, not by re-reviewing. A run that has already lost files to
`PRR_MAX_DIFF_CHARS` also advances whatever else failed, because holding would widen the next
run's range and review less, not more.

**A diff that does not fit can be read in more than one request.** By default it is not: the
files past the budget are dropped from every finder's context and reported as a coverage gap,
so a large PR exits `3` telling you the part most likely to hold the defect was never read.
Set `PRR_FINDER_MAX_CHUNKS` above `1` and the packing continues into a second and third
request instead of stopping. Every finder reads every chunk, so "two finders agreed" still
means two models, and the corroboration gate is untouched; the split is decided by budget
alone and never by the per-finder seed, so a finding is compared against the same file in the
same part. Chunks are separate requests, not a conversation — each prompt says which part it
holds and tells the model not to reason about files it cannot see. The cost is linear and the
run says so before spending it.

### Unattended, over a list of PRs

Static analysis needs the code on disk. Point `PRR_WORKTREE_REPO` at a clone and prloop cuts
its own throwaway git worktree, detached at the iteration's own commit, then removes it:

```bash
git clone <repo> /repos/myrepo          # once

PRR_WORKTREE_REPO=/repos/myrepo
PRR_WORKTREE_SETUP_CMD='npm ci'         # a worktree has no node_modules and no venv
```

Then the whole daily job is one command, with no checkout to manage and nothing to edit per PR:

```bash
prloop --batch prs.txt --since auto
```

`--batch` reviews every URL in the file, one after another, and **exits with the worst outcome
in the list** — which is the one thing the loop it replaces cannot do:

```bash
while read -r url; do prloop "$url" --since auto || true; done < prs.txt   # the old way
```

That `|| true` is not laziness: without it the first PR with a blocking finding stops the
loop, so the only way to review the rest was to throw every exit code away. `--batch` prints a
table at the end — one line per PR with its exit code and what actually happened, read back
out of each run's own `result.json`, because the code alone cannot tell "clean" from "the PR
had already merged" — and then exits `1` > `2` > `3` > `0`, worst wins. The whole file is
validated first, so a typo on line 40 surfaces immediately rather than two hours in. Each PR
is a separate process (per-run state is module-global in four places) and they run one at a
time: the only throttle prloop has on a model endpoint is `PRR_LLM_CONCURRENCY`, which is per
process. If three pull requests in a row fail before producing a review, the rest are
abandoned — that is a credential, an endpoint or a proxy, not those pull requests, and the
remaining PRs would each pay a full retry budget to find that out.

**Two runs on one PR post everything twice.** A tick that runs long and the next one — or
your laptop beside the pipeline — both read the PR's existing comments before either has
written any, so both see the same set of already-said findings and both say all of them
again. So a run takes a **lease** on the pull request first: a timestamped marker inside
prloop's own summary comment, honoured by any other run for `PRR_RUN_LEASE_MS` (one hour by
default). A run that finds the PR held reviews nothing, spends nothing, and exits `0`; the
review is already happening. The lease is given back by the summary the run posts, so the
normal path costs no extra write, and an expired one is taken over with a warning naming the
knob — if reviews here legitimately run longer than the window, raise it. `0` turns it off.

This is not a mutex, and it is not sold as one: Azure DevOps has no compare-and-swap on a
comment body, so two runs starting in the same round trip can still both proceed (the claim
reads its own write back, which makes that window small). It also does nothing on a PR prloop
has never published to, because claiming would mean creating the summary comment before the
review that fills it — and two first runs racing would then leave two summary threads, which
is the `--since auto` wedge the lease exists to prevent. A dry run takes no lease at all.

A merged pull request can stay in `prs.txt`. prloop still fetches it and its diff, then stops
before the first model call: Azure DevOps refuses every write to a completed PR, so a review
of one used to be paid for in full and then fail comment by comment, exiting `3` on every tick
forever. It exits `0` now and says why. It still reads the PR's comments first — the window
right after a merge is when people work through a bot's comments in bulk, and those
dismissals and fixes are the richest the learning stores ever get. `--dry-run` reviews a
completed PR anyway, which is what makes a golden set of historical PRs (see
`scripts/evaluate.ts`) possible.

Prefer this to `PRR_WORKDIR` for anything unattended. `git checkout <branch>` lands on
whatever the branch points at **now**, which stops being the iteration under review the
moment the author pushes again — and a file whose content no longer matches is *skipped, not
analysed*, so a stale checkout quietly reviews less and says so in one warning line. A
worktree pinned to the commit cannot drift, leaves your own working copy alone, and several
can exist at once.

`PRR_WORKTREE_SETUP_CMD` matters more than it looks: `mypy` and `tsc` are fact-tier, posted
inline with no model in the loop, and against an uninstalled tree they report one error per
unresolvable import. Both name that case and discard their whole run rather than publish it
(see `environmentRules` in `profiles/index.ts`), so the failure is loud rather than wrong —
but you lose the tool. A failing setup command is a warning, never a failed review.

Without ADO credentials at all, review two git branches through the identical diff and
anchoring path:

```bash
npx tsx scripts/local-review.ts review <repo> <base> <head> [--criteria <file.md>]
npx tsx scripts/local-review.ts prompt <repo> <base> <head> [out.md]
npx tsx scripts/local-review.ts anchor <repo> <base> <head> <findings.json>
```

`review` is the whole pipeline — finders, skeptic, requirement axis, static analysis, the
gates — with your configured models, as a dry run: there is no pull request, so nothing is
posted, and the run directory (`review.html` included) is the review. The repository's
convention documents are read from its own history at `<base>`, and `--criteria` gives the
requirement axis a markdown file of acceptance criteria to judge the branch against; without
it that axis is skipped, as it is on a PR with no linked work item. `prompt` and `anchor` need
no model endpoint at all.

## What lands on the PR

- **One sticky summary**, updated in place, posted closed so it can't trip a
  "comments must be resolved" policy.
- **A few inline threads**, active, carrying `changeTrackingId` + `iterationContext` so ADO
  tracks their position across new commits.
- **No duplicates on re-run** — each comment embeds a finding fingerprint.
- **Stale threads auto-close** when their target code is gone. The criteria are narrow on
  purpose: wrongly closing a live issue is worse than leaving a stale comment. Each comment
  records a hash of the lines it was about, and "gone" means those lines appear nowhere in
  the file now — so code that merely moved keeps its comment open, and a comment's position
  for dedupe is where its code is now, not where it was posted. (Comments from before that
  marker close only when their line is past the end of the file.) A static-analysis comment
  is the exception, reviewdog's rule: it closes only when the same tool ran on that file this
  time and no longer reports it — a tool re-checks every run, so its silence after a skipped
  run or a broken toolchain is not evidence, and neither is its code having moved.
- **The summary says what became of the last run's comments** — how many this run closed
  because the code under them changed (dated from the `--since auto` resume point, which is
  what made them stale), how many a reviewer marked fixed, how many were dismissed, and how
  many are still waiting. Nothing settled yet, or a first run, prints no line at all.
- **Dismissals stick.** A finding closed as *wontFix*/*byDesign* is recorded per repo
  (`runs/<org>/<project>/<repo>/dismissals.jsonl`) and never posted again on any PR where
  the model produces the same quote (rewordings on the same PR are also caught by position
  overlap; a substantially reworded finding on a *different* PR can still reappear —
  fingerprints hash the quote). A thread merely marked *Closed* is treated as handled, not
  dismissed. After three dismissals in one category the summary suggests excluding it, and
  stops there: prloop never writes its own config. The reviewer's first reply in the thread is
  kept as the *reason*, and `scripts/calibrate.ts` groups by it — a dismissal rate says how
  often prloop is wrong, and only the reason says in what way. It is a reviewer's free text,
  so it is flattened, capped and redacted on the way into the store, and it reaches no prompt:
  nothing under `prompts/` can read that store at all, and the selftest pins it.
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
result looks wrong. `stamp.json` (also inside `result.json`) records what produced the run:
prloop's commit, whether its checkout had uncommitted changes, and short hashes of the
prompts, the loaded rules, the model fleet and the settings that shape a review.
`scripts/calibrate.ts` and `scripts/evaluate.ts` report per stamp whenever the runs they read
span more than one, so a prompt change is measured against the runs before it instead of
averaged into them.

`review.html` is the run on one screen: the diff, with every anchored finding sitting on the
line it is about, every finding below the bar shown greyed with the reason it was not
commented, and every finding that could not be anchored in its own list with the failure that
stopped it. One self-contained file — inline CSS, no script, nothing fetched — so it opens
from a build agent's disk as readily as from a laptop. It is what makes `--dry-run` a
preflight you can actually read, and what makes auditing a golden set (`scripts/evaluate.ts`)
tolerable by hand. `npx tsx scripts/demo.ts` writes one from synthetic data if you want to see
it without a PR.

`result.json` is written on **every** exit path, not just a clean one: a run that crashed
records what killed it under `fatal`, and one that reviewed nothing (a merged PR) records
`skippedReason`. All three carry an `identity` block — which pull request, which iteration,
what it compared against, dry-run or not, and the model fleet — so a digest over a list of
PRs can read the files without parsing directory names. A crash before intake has no run
directory yet, so it writes into `<pr>/fatal/` instead, along with a `run.log` replaying the
lines printed before then. Like `<pr>/skipped/`, that directory has a fixed name and is never
pruned: a week of auth failures must not evict the PR's last real review.

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
| `PRR_BOT_IDENTITY_IDS` | — | identity GUIDs, besides the current credential's, whose marker comments are prloop's own. Only needed when prloop's credential changed (laptop PAT → pipeline service account); without it the first run under the new identity re-reviews the PR from scratch and stops harvesting dismissals on the older threads |
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
| `PRR_SKEPTIC_LOOKUP` | `1` | a skeptic that answers "insufficient-context" is asked once more, shown the definitions and up to four callers of the names on the accused lines — from the PR's files, then `git grep` at the commit in `PRR_WORKTREE_REPO`. Chosen by the pipeline, fenced as the repository's text, capped at 15 files and 6,000 characters; a lookup that finds nothing or a call that fails keeps the first answer. `0` = off |
| `PRR_STRICT_COVERAGE` | `1` | files the finder never saw (over `PRR_MAX_DIFF_CHARS`, or too large to fetch) make the run incomplete (exit 3); `0` = a partial review can still exit 0 |
| `PRR_WORKDIR` | — | checkout at the iteration's `sourceRefCommit`; unset = static analysis skips. Files whose content differs from the iteration under review are skipped, not analysed. Tools execute the reviewed branch's code, with a secret-scrubbed environment |
| `PRR_WORKTREE_REPO` | — | a clone of the reviewed repo; prloop cuts its own throwaway worktree at the iteration's commit and removes it afterwards. Takes precedence over `PRR_WORKDIR` — prefer it for anything unattended |
| `PRR_WORKTREE_SETUP_CMD` | — | shell string run once in a fresh worktree before any linter (`npm ci`, `uv sync`); a worktree has no `node_modules` and no venv |
| `PRR_WORKTREE_SETUP_TIMEOUT_MS` | `600000` | deadline for that command |
| `PRR_TRIAGE_MODEL` | — | unset = high-FP tool findings are dropped |
| `PRR_CA_CERTS` | — | CA bundle for TLS-intercepting networks (comma-separated) |
| `PRR_DRY_RUN` | — | `1` = compute, publish nothing. Also the only way to review a **completed** PR: a live run over one skips before the first model call, because ADO refuses every write to it |
| `PRR_ADO_MAX_RETRIES` | `3` | **TOTAL** attempts per ADO request, first try included — `1` = never retry. Opposite sense to `PRR_LLM_RETRIES`; both names are published, so neither was renamed |
| `PRR_RUNS_KEEP` | `20` | iteration directories kept per PR under `runs/`, oldest deleted first; `0` = keep everything. Never touches `dismissals.jsonl` |
| `PRR_RUNS_MAX_AGE_DAYS` | `0` | also delete iteration directories older than this; `0` = no age limit |
| `PRR_SAVE_REPLAY` | — | `1` = also save `replay.json`, so `scripts/replay.ts` can re-run everything after the models offline. Keeps the reviewed source on disk |

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
| `PRR_OPENCODE_AGENT` | `prloop-reviewer` | agent prloop drives; whatever its name, prloop denies it every tool at run time |
| `PRR_OPENCODE_JSON` | `1` | `0` = drop `--format json` for builds without JSONL events; loses tracing |
| `PRR_AGENT_TIMEOUT_MS` | `900000` | wall clock for one opencode session |
| `PRR_RULES_DIR` | — | your team's rules as `.md` files with an `applyTo` glob, added to the shipped `rules/`; a file named like a shipped one replaces it |
| `PRR_MAX_DIFF_CHARS` | `240000` | ceiling on the diff sent to a finder, in characters of the diff alone; overflow makes the run incomplete |
| `PRR_FINDER_MAX_CHUNKS` | `1` | requests one finder may spend on a diff that does not fit; `1` = the overflow is never read. Every finder reads every chunk, so corroboration is unchanged — and the cost is linear |
| `PRR_CONTEXT_TOKENS` | `0` (off) | the model's context window in tokens. Set it and the diff is budgeted as `window − PRR_LLM_MAX_TOKENS − (system prompt + rules + conventions + PR description + inlined schema)`, so the backend never truncates a prompt mid-hunk and corrupts the quotes anchoring depends on. Token counts are an estimate (±20%) |
| `PRR_CONTEXT_TOKENS_BY_MODEL` | — | JSON `model → tokens`: a fleet of different families is also a fleet of different context sizes, and one number either wastes the largest or truncates the smallest |
| `PRR_HUNK_CONTEXT_BEFORE` | `6` | context lines before each hunk (asymmetric: what precedes a change means more) |
| `PRR_HUNK_CONTEXT_AFTER` | `3` | context lines after each hunk. Either way, a hunk whose function, method or class starts above the lines it shows names it after the `@@`, as `git diff` does |
| `PRR_MAX_FILE_BYTES` | `2000000` | bigger files are diffed, never sent whole |
| `PRR_WHOLE_FILE_MAX_LINES` | `300` | a changed file this short is shown to the finders whole, changes marked, when the request has room left after every selected file's hunks — it never pushes another file out. `0` = hunks only |
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
| `PRR_POST_STATUS` | — | `1` = also post a PR status (needs a branch policy to gate merges). Three states, matching the exit code: `failed` (2) · `error` (3, the review did not fully run) · `succeeded` (0) |
| `PRR_STATUS_GENRE` | `prloop` | genre of that status |
| `PRR_STATUS_NAME` | `ai-review` | name of that status |
| `PRR_RUN_LEASE_MS` | `3600000` | how long one run holds a PR before another may take it over; `0` = no lease |
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
not forward `response_format`**, dropping schemas to prompt-level only. prloop hands opencode
its own agent definition on every run — a primary agent with every tool denied, passed through
`OPENCODE_CONFIG_CONTENT` and an `opencode.json` in an empty temporary directory the run is
launched from — so `npm run setup` is optional, and a user or project config cannot give that
agent tools. If opencode still falls back to its default agent (which has tools), prloop kills
the run on the warning line and refuses its answer. Like every child process it receives a
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
`PRR_RULES_DIR` as rule files with an `applyTo` glob. They are added to the shipped rules,
not swapped for them — a C# rule pack does not cost you the base smells — and a file named
like a shipped one (`_base.md`, `java.md`) replaces that one.

Which files are reviewed at all is one table, `libs/lang.ts`: the code axis reads source in
the common languages (C#, Java, Kotlin, Python, TypeScript/JavaScript, Go, Rust, C/C++, PHP,
Ruby, Swift, Scala, SQL, shell, PowerShell, Terraform, Bicep, Dockerfiles and more), while
configuration, markup and documentation go to the requirement axis only — a criterion is
often met in a config file. A changed file of a type the table does not list is named in the
summary rather than silently dropped.

## Development

```bash
npm run check                 # typecheck + selftest
npx tsx scripts/demo.ts       # render comments from fake data, no ADO or model calls
npx tsx scripts/calibrate.ts  # is it getting better? joins runs/ to the dismissal store
npx tsx scripts/replay.ts <run dir>  # re-run a saved run after a threshold or code change
npx tsx scripts/bench.ts run <suite.json> <out dir>  # a public benchmark, reviewed and scored
```

`scripts/replay.ts` re-runs everything after the models — anchoring, dedupe, the skeptic's
saved verdicts, the corroboration and severity gates, the cap — over a run saved with
`PRR_SAVE_REPLAY=1`, under the current code and settings, and marks what is inline now that
was not in the run. Tuning `PRR_MIN_INLINE_SEVERITY`, the consensus rule or the dedupe
threshold no longer costs a model call per try: `PRR_MIN_INLINE_SEVERITY=high npx tsx
scripts/replay.ts runs/…/iter-3-…`. A candidate no saved verdict covers (dedupe now draws a
line the run did not) replays unverified, and the count is printed. The end-to-end net checks
that a replay reaches exactly the run's own comments.

`scripts/calibrate.ts` reads `runs/**/findings.json`, `runs/**/skeptic.json` and each repo's
`dismissals.jsonl` and prints the dismissal rate by finder confidence, by category and by
finder model; each skeptic model's kill rate and "could not check it" rate; and how many
published findings a human later dismissed — the tool's own false-positive rate. It is
read-only and offline, counts each finding once no matter how often the PR was re-reviewed,
and skips (counting) any artifact it cannot read, so an old or half-written `runs/` tree
still yields a report. Pass a directory to point it somewhere other than `PRR_RUNS_DIR`.

Each of those three tables also carries a **`fixed`** column and the headline an
**implementation rate**: of the findings that reached a comment, how many a human then marked
fixed. That is PROPOSAL §12's north star, and until now the only per-finding outcome prloop
kept was negative — so precision could only be estimated as one minus the dismissal rate,
which scores every comment nobody answered as a success. Threads prloop auto-closed because
the code they flagged changed under them are counted beside the rate, never inside it: that is
prloop's own inference, not a person's decision, and folding it in would let the tool grade
itself. They do count toward the **addressed rate** printed next to it — fixed, or the code
changed while the comment was open — which is how the industrial reviewers that publish
results (Uber's uReview, ByteDance's BitsAI-CR) steer. When a PR merges, prloop also records
what became of every comment still open (`ignored`) or closed without a verdict (`closed`),
and how many people liked each comment, so a category nobody ever answers no longer looks as
good as one that is always fixed. The record lives in
`runs/<org>/<project>/<repo>/outcomes.jsonl`, deliberately not in `dismissals.jsonl` —
everything in that file is suppressed on every future PR in the repo, and a finding somebody
fixed is the last thing to stop reporting.

From those outcomes calibrate adds a table by severity — the addressed rate should rise with
severity, and a `[CAUTION]` line says so when low-severity comments are addressed more than
critical ones, which reads as people fixing to make a bot go quiet — a table per static-analysis
rule, and **demotion proposals**: a category or rule with ten or more comments in one
repository, addressed at most 15% of the time and dismissed or ignored at least half of it,
is printed with the setting that would stop it. Proposals only; prloop never applies one.

Each of those three tables also carries a **`killed`** column: how many of that bucket's
findings the skeptic majority refuted. A refuted finding reaches no comment and appears in no
`findings.json`, so it is read out of `skeptic.json` and joined back in — without it a finder
whose output the verifier throws away looks exactly like one that found nothing to throw
away. Read `killed` against `findings` in the same row: that ratio, per finder and per
category, is what says whether a finder is earning the verification it costs. Runs written
before `skeptic.json` recorded a finding's identity still count toward the per-model verdict
table; they simply cannot be attributed to a finder or a category.

`scripts/evaluate.ts` answers the other half of PROPOSAL §12: not "did a human reject what we
published" but "did we publish what is actually there". Write a `golden.json` beside a PR's
iteration directories listing the defects you know it contains, and it scores the newest run
against them:

```json
{
  "defects": [{ "file": "src/pay.ts", "lines": [25, 25], "note": "gateway call inside the transaction" }],
  "mustNotFlag": [{ "file": "src/util.ts", "lines": [1, 80], "note": "reviewed clean" }]
}
```

The output is not one recall number, because a miss is not one event. Each defect is filed
under the furthest stage it reached — `inline`, `cap`, `severity`, `no-corroboration`,
`dismissed`, `refuted`, `anchor-failed`, `not-found` — and each of those names a different
file to open. A defect nothing mentioned is a finder-prompt or model problem; one whose quote
would not anchor is `anchoring/locate.ts`; one the skeptic killed is verification; one held
back for want of a second finder is the corroboration gate. "Recall 60%" hides which.

`mustNotFlag` is what makes precision measurable at all: a comment matching no listed defect
may be a false positive or a real bug the golden set does not know about, and nothing in the
artifacts can tell those apart. Only a comment inside a region a reviewer has declared clean
is a measured mistake; the rest are reported as unattributed and counted against nothing.

The per-finder table is the multi-model question in numbers. Run the same golden set with
`PRR_FINDER_MODELS=a` and then `a,b` into different `PRR_RUNS_DIR`s and compare.

`scripts/bench.ts` asks the same question of references somebody else labelled, at a scale a
hand-written golden set never reaches: [AACR-Bench](https://github.com/alibaba/aacr-bench)
(196 PRs in its published set, 10 languages, 1,506 references, each with a path and a line
range) and [Martian's Code Review Bench](https://github.com/withmartian/code-review-benchmark)
(50 PRs, 173 references, text only — Java through Keycloak). Keep everything under `runs/`,
which git ignores:

```bash
npx tsx scripts/bench.ts import aacr positive_samples.json runs/bench/aacr.json [--sample 30]
npx tsx scripts/bench.ts run runs/bench/aacr.json runs/bench/aacr-base --repeat 2
npx tsx scripts/bench.ts score runs/bench/aacr.json runs/bench/aacr-base [--judge <model>]
# change a prompt, a model or a setting, then into a NEW directory:
npx tsx scripts/bench.ts run runs/bench/aacr.json runs/bench/aacr-try
npx tsx scripts/bench.ts score runs/bench/aacr.json runs/bench/aacr-try
npx tsx scripts/bench.ts compare runs/bench/aacr-base/score.json runs/bench/aacr-try/score.json
```

`run` reviews every case with `local-review.ts review` in its own process — your models, as a
dry run, static analysis off — against a bare treeless clone under `runs/bench/repos/`,
fetched with git alone: every commit of the default branch and no file until a diff reads
one (keycloak's is 14 MB). A pull request's base is not recorded in git, so a case that names
only a pull request is pinned from it: its head from `refs/pull/<n>/head`, its base from the
merge base with the default branch, or the first parent of the merge commit when it was merged
with one. The commits are written back into the suite, so every later directory reviews the
same diff. `run` resumes where it stopped, and refuses to add a run made under another
configuration (another run stamp) to a directory: one directory, one configuration.

`score` matches the way AACR does — a comment within ±k lines of a reference (`--k`, default
`1`), each comment credited to at most one reference — and files every miss under the same
stages as `evaluate.ts`. `--judge <model>` adds a model's opinion of whether the comments on
those lines are the same issue, as a second, labelled number; Martian's references carry no
location, so there the judge is the only matcher and the score says so. Judges agree with
developers' own labels only 0.44–0.62 of the time, so a judged score holds only under its judge
model and prompt: both are recorded, verdicts are cached (re-scoring is free), and `compare`
refuses to set two judges against each other. `--repeat 2` measures the noise — how far recall
moves when the same commits are reviewed again — and `compare` calls a change better or worse
only past twice that, and exits `2` on a regression; with no repeat on either side it says the
difference cannot be told from a re-run. Two of Martian's fifty cases are re-creations whose
base only GitHub's API knows; they are listed as unresolved until you set `base` and `head` in
the suite by hand.

`scripts/selftest.ts` is the regression net for anchoring — **run it after touching
`libs/diff.ts` or `anchoring/locate.ts`** (`npx tsx scripts/selftest.ts anchoring` runs just
that area; the others are finder, skeptic, aggregate, requirement, static, rules, publish,
models, security, config and measure). Its assertions map directly onto the causes of
"comment on the wrong line".

`npm run check` runs it alongside the other nets: the SSE transport (`selftest-stream.ts`), the
HTTP model transport (`selftest-runner.ts`), what publishing writes to a PR
(`selftest-publish.ts`), ADO intake's edges (`selftest-ado.ts`), the CLI's argument grammar and
exit codes (`selftest-cli.ts`), one pull request reviewed twice end to end — a full review,
then `--since auto` on the next push — plus a local branch and a benchmark run, scored and
compared (`selftest-e2e.ts`), and the claims the documentation
makes about the code (`selftest-docs.ts`). The five that talk to a network drive the real code
against fake `node:http` servers in `scripts/fakes/` — no credentials, no endpoint, no fixed
ports.

`fixtures/seeded-pr.ts` is a realistic 3-language PR with seeded defects, every expected line
verified against the real file with `grep -n`. It pins four boundaries: a duplicated line with
no context **must be ruled ambiguous rather than guessed**; the same duplicate with differing
`context_before` must resolve correctly each way; a quoted line that doesn't exist must be
blocked; and reformatted indentation must still match on the second pass.

## Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) — invariants, the four places a new knob lives, and how to
run a review with no ADO credentials. [SECURITY.md](./SECURITY.md) covers what the tool handles
and how to report a vulnerability privately; [CHANGELOG.md](./CHANGELOG.md) is the history.
