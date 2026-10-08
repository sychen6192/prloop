# prloop — guide for AI-assisted development

Automated PR review for Azure DevOps. Read README.md for the architecture; PROPOSAL.md for
the research basis. This file is the map for working on the code.

## Commands

```bash
npm run check        # typecheck + every offline selftest — run before every commit
npx tsx scripts/selftest.ts [area]   # anchoring / pipeline regression net (areas: scripts/selftest/)
npx tsx scripts/selftest-stream.ts   # SSE parsing and the failure taxonomy around it
npx tsx scripts/selftest-runner.ts   # HTTP model transport: retries, fallback, accounting
npx tsx scripts/selftest-publish.ts  # what publish() writes to the PR
npx tsx scripts/selftest-ado.ts      # ADO intake edges: paging, parent PBIs, conventions
npx tsx scripts/selftest-cli.ts      # argument grammar and exit codes
npx tsx scripts/selftest-e2e.ts      # one PR reviewed twice end to end, a local branch, a benchmark
npx tsx scripts/selftest-docs.ts     # claims the docs make about the code
npx tsx scripts/demo.ts              # render comments + review.html from fake data, no network
npx tsx scripts/calibrate.ts         # dismissal / kill rates from runs/ + dismissals.jsonl
npx tsx scripts/evaluate.ts          # golden-set recall: which stage lost each known defect
npx tsx scripts/replay.ts <run dir>  # re-run everything after the models, offline (PRR_SAVE_REPLAY=1 runs)
npx tsx scripts/bench.ts <import|run|score|compare>  # a public benchmark (AACR, Martian) end to end
```

Everything is offline-testable; no test needs ADO credentials or a model endpoint. The five
nets that exercise side effects drive the real code against fake servers built from `node:http`
in `scripts/fakes/` — test infrastructure, never a dependency. Every one of them binds port 0
and closes its server in a `finally`.

## Load-bearing invariants (violating these is a bug, not a style choice)

- **Models never emit line numbers.** They emit verbatim quotes; `anchoring/locate.ts`
  resolves quotes to lines against raw blob bytes. Anchor failure degrades to the summary —
  never a guessed line. Touching `libs/diff.ts` or `anchoring/locate.ts` requires running
  `scripts/selftest.ts` (at least `npx tsx scripts/selftest.ts anchoring`); its assertions
  map onto real wrong-line bugs.
- **The control loop is deterministic TypeScript** (`orchestrator.ts`). Models are consulted
  at fixed points and never decide control flow.
- **Asymmetries are deliberate**: the skeptic may only lower severity, never raise; skeptic
  failure fails OPEN (a dead verifier must not delete real bugs); anchoring failure fails
  CLOSED (a wrong-line comment is worse than a miss). Keep them.
- **Two axes stay blind to each other.** The requirement axis and code axis must not see
  each other's output, and their comment budgets stay separate.
- **The PR's own OpenSpec requirements never block.** They live in `RequirementResult.openspec`,
  which `unmetCriteria`, the status, the exit code and `incomplete` never read, and they are
  judged in a call blind to the work items. Nothing under `openspec/` is ever evidence.
- **Config is SSOT in `config.ts`** — every knob is a `PRR_*` env var read there once, by a
  reader that declares it (kind, section, description; `KNOWN_KEYS` is built from those
  declarations), and documented in `.env.example` and the README table. Add all three or none;
  `scripts/selftest.ts` fails on any of them missing. A knob read outside `config.ts` has no
  provenance, no `--config` row and no typo warning, so there are none. What a finding is —
  severities, categories — is not configuration and lives in `libs/taxonomy.ts`.
- **Every model call goes through `models/runner.ts`** (concurrency, retries, streaming,
  token accounting). Never call fetch directly for model traffic.
- **The pipeline reaches Azure DevOps only through a `ReviewHost`** (`libs/host.ts`):
  `orchestrator.ts`, `gates/`, `publish/` and the rest of the pipeline import nothing from
  `ado/`. A PR run gets `ado/host.ts`, a local review `git/host.ts`, a test the in-memory
  `scripts/fakes/host.ts`; `scripts/selftest-docs.ts` fails on an import that goes around it.
  The hidden markers are the host-independent part — a host stores a body and never rewrites it.

## Layout

| dir | role |
| --- | --- |
| `orchestrator.ts` | the one control flow: intake → gates → publish |
| `ado/` | Azure DevOps REST (auth, blobs, threads, work items, conventions), bound to one PR as a `ReviewHost` by `ado/host.ts` |
| `git/` | a local branch as a `ReviewHost` (intake from a working tree), and the throwaway worktree the static gate runs in |
| `gates/` | finder, skeptic, requirement, static analysis, aggregation |
| `anchoring/` | quote → line resolution (the reason this tool exists) |
| `models/` | runner adapters (OpenAI-compatible HTTP, opencode CLI) + JSON schemas |
| `prompts/` | every prompt, one file per stage |
| `rules/` | reviewer rules as markdown with `applyTo` globs |
| `publish/` | comment rendering, the hidden marker protocol, dedup (fingerprint + position), lifecycle |
| `libs/` | diff, payload budgeting, rules loading, OpenSpec spec deltas, proxy/TLS, CLI grammar, types, and the ReviewContext and ReviewHost contracts (SSOT) |
| `examples/` | Azure Pipelines YAML to start from: build validation, and a scheduled sweep with `--active` |
| `scripts/` | selftests (+ `fakes/`, and `selftest/`: one module per area plus the shared harness), doctor/probe/tlsfix diagnostics, local-review, evaluate/calibrate/replay/bench |

## Conventions

- Plain TypeScript, ESM, no framework; `undici` is the only runtime dependency — keep it
  that way unless there is a very strong reason.
- Comments explain *why* (the failure that motivated the code), not *what*.
- Failures are named precisely: transport errors, truncation, empty responses and
  unparseable output are different problems with different fixes — never collapse them.
- Artifacts of every run go to `runs/` (gitignored): prompts, raw model output, verdicts.
  When debugging a review result, start there, not in the code.
