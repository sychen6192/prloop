# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: semver, pre-1.0 —
the public interface is the `PRR_*` settings and the CLI, and both can still change.

## [Unreleased]

The 0.1.0 line of development. Nothing has been tagged yet, so there is no release date to
give: the range below is commit dates from `git log` — first commit 2026-07-29, latest
2026-09-08.

### Added

- Two-axis review: a **code axis** (N finder models over the diff, same prompt, in parallel)
  and a **requirement axis** (linked work items and acceptance criteria, walking one level up),
  run blind to each other with separate comment budgets.
- Quote-based line anchoring: models emit verbatim quotes, `anchoring/locate.ts` resolves them
  against the iteration's raw blob bytes, and an unresolvable quote degrades into the summary
  instead of becoming a guessed line.
- Adversarial verification: a skeptic from a different family is told to refute a finding, not
  assess it, over `PRR_SKEPTIC_ROUNDS` rounds with a different model each round.
- Dispute pass over the requirement axis's own accusations, plus anchoring of the evidence
  quote behind every `satisfied` verdict.
- Static analysis tiered by tool character — facts (`tsc`, `mypy`) commented directly,
  high-FP tools model-triaged, formatting suppressed — diff-filtered to changed lines.
- Language rule packs as editable markdown with `applyTo` globs: base code smells, Java,
  Python, TypeScript / Node server / Playwright. The reviewed repository's own convention
  documents are fetched at the iteration's commit and injected ahead of them.
- Comment lifecycle on the PR: one sticky summary updated in place, fingerprint dedup,
  stale-thread auto-close, and dismissal learning (`wontFix` / `byDesign` recorded per repo,
  with a category-exclusion hint after three).
- Incremental review (`--since auto`), reading the last reviewed iteration back out of prloop's
  own summary comment so no shared disk is needed.
- SSE streaming for model calls (`PRR_LLM_STREAM`), with a stall timeout, so a gateway's idle
  timeout stops turning a long generation into a 504.
- Portable reasoning control: `PRR_REASONING` translated per dialect (`reasoning_effort` /
  `thinking.budget_tokens` / `enable_thinking` / `think`), with per-model overrides
  (`PRR_REASONING_BY_MODEL`, `PRR_LLM_EXTRA_BODY_BY_MODEL`, `PRR_CONTEXT_TOKENS_BY_MODEL`,
  `PRR_LLM_TEMPERATURE_BY_MODEL`) for a mixed fleet.
- Corporate-network survival kit: `PRR_CA_CERTS` applied in-process, `PRR_`-prefixed proxy
  variables that `.env` can actually override, an honest User-Agent, and the `doctor`, `probe`
  and `tlsfix` diagnostics.
- Per-run artifacts under `runs/<org>/<project>/<repo>/pr-<id>/iter-<N>-<ts>/`: prompts, raw
  model output, skeptic verdicts, anchoring outcomes, `run.log`, `calls.jsonl`, `result.json`,
  and `config.json` recording where every setting's value came from.
- `prloop --config` / `PRR_SHOW_CONFIG`: every setting, its value, and its source.
- Offline selftests for anchoring, the pipeline, the SSE transport, the HTTP model transport,
  publishing, ADO intake, and the CLI's argument grammar and exit codes — the last four driven
  against fake OpenAI-compatible and Azure DevOps servers (`scripts/fakes/`, `node:http` and
  plain objects) so the side-effecting paths are covered, not just their pure helpers.
  `scripts/demo.ts` and `scripts/local-review.ts` run without ADO credentials or a model endpoint.

### Changed

- Guided decoding is used where the backend enforces it; where it does not, the JSON schema is
  inlined into the prompt instead (`PRR_LLM_STRUCTURED=0`).
- Output schemas carry no value constraints — backends disagree on the JSON Schema dialect and
  a `minimum` keyword was an HTTP 400 on every call.
- Base rules stopped suppressing findings: the code axis keeps every defect category in scope,
  and the recall-first stance moved the filtering downstream to the gates.
- Exit codes tell the truth: `3` for an incomplete review (a crashed stage, or files the finder
  never saw with `PRR_STRICT_COVERAGE` on) rather than a green `0`.
- The pipeline, not the model, owns the criteria list, so the requirement axis's denominator
  stops moving between runs.

### Fixed

- Findings lost to a reshaped quote, and a payload budget that counted the wrong thing.
- `insufficient-context` no longer counts as verification — "I could not check this" was being
  reported as "I checked it and it holds".
- Anchoring no longer guesses `side` on added files.
- Foreign paths resolved once through a `FileIndex` built at intake, and thread paths served
  from it.
- Static analysis: each tool runs in the project it belongs to, availability is decided once
  rather than per project, SpotBugs output is parsed as SpotBugs, Maven report goals are
  skipped in aggregator modules, a tool whose own toolchain is broken has its run discarded,
  and linters never run over a `PRR_WORKDIR` that is not the code under review.
- Raw control characters inside JSON string literals are repaired instead of failing the parse.
- Truncated and reasoning-only completions are named as themselves, not as unparseable output.
- Token accounting no longer loses the usage of a completion that arrived but was unusable. A
  truncated response is the most expensive failure there is — the endpoint billed a full
  budget for it — and it was the one call that reported nothing, so a retrying run looked
  cheaper than it was and a truncated one looked free.
- The opencode runner works on Windows, receives its prompt over stdin rather than argv, and
  has its whole process tree killed on timeout.
- Certificate handling: a leaf certificate is no longer exported as if it were a CA, the missing
  intermediate is fetched via AIA, and the `ca` option's replace-not-append semantics are
  respected.
- Runs no longer lost to a 400, a silent stream, or an empty artifacts directory; leaked
  processes, unbounded `runs/` growth and misleading diagnoses fixed on the operational edges.

### Security

- Secrets are redacted where text leaves the process — log lines, `runs/` artifacts, error
  messages and the summary comment posted on the PR. The leak that motivated it: gateways that
  echo the presented credential inside a 401 body.
- Static analysis tools and the `opencode` child process run with a secret-scrubbed environment;
  `PRR_WORKDIR` is the PR author's branch, and its lint hooks are their code.
