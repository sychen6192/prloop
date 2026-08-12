# prloop — guide for AI-assisted development

Automated PR review for Azure DevOps. Read README.md for the architecture; PROPOSAL.md for
the research basis. This file is the map for working on the code.

## Commands

```bash
npm run check        # typecheck + full offline selftest — run before every commit
npx tsx scripts/selftest.ts          # anchoring / pipeline regression net
npx tsx scripts/selftest-stream.ts   # SSE transport regression net
npx tsx scripts/demo.ts              # render comments from fake data, no network
```

Everything is offline-testable; no test needs ADO credentials or a model endpoint.

## Load-bearing invariants (violating these is a bug, not a style choice)

- **Models never emit line numbers.** They emit verbatim quotes; `anchoring/locate.ts`
  resolves quotes to lines against raw blob bytes. Anchor failure degrades to the summary —
  never a guessed line. Touching `libs/diff.ts` or `anchoring/locate.ts` requires running
  `scripts/selftest.ts`; its assertions map onto real wrong-line bugs.
- **The control loop is deterministic TypeScript** (`orchestrator.ts`). Models are consulted
  at fixed points and never decide control flow.
- **Asymmetries are deliberate**: the skeptic may only lower severity, never raise; skeptic
  failure fails OPEN (a dead verifier must not delete real bugs); anchoring failure fails
  CLOSED (a wrong-line comment is worse than a miss). Keep them.
- **Two axes stay blind to each other.** The requirement axis and code axis must not see
  each other's output, and their comment budgets stay separate.
- **Config is SSOT in `config.ts`** — every knob is a `PRR_*` env var defined there once,
  documented in `.env.example` and the README table. Add all three or none.
- **Every model call goes through `models/runner.ts`** (concurrency, retries, streaming,
  token accounting). Never call fetch directly for model traffic.

## Layout

| dir | role |
| --- | --- |
| `orchestrator.ts` | the one control flow: intake → gates → publish |
| `ado/` | Azure DevOps REST (auth, blobs, threads, work items, conventions) |
| `gates/` | finder, skeptic, requirement, static analysis, aggregation |
| `anchoring/` | quote → line resolution (the reason this tool exists) |
| `models/` | runner adapters (OpenAI-compatible HTTP, opencode CLI) + JSON schemas |
| `prompts/` | every prompt, one file per stage |
| `rules/` | reviewer rules as markdown with `applyTo` globs |
| `publish/` | comment rendering, dedup (fingerprint + position), lifecycle |
| `libs/` | diff, payload budgeting, rules loading, proxy/TLS, types (SSOT) |
| `scripts/` | selftests, doctor/probe/tlsfix diagnostics, local-review |

## Conventions

- Plain TypeScript, ESM, no framework; `undici` is the only runtime dependency — keep it
  that way unless there is a very strong reason.
- Comments explain *why* (the failure that motivated the code), not *what*.
- Failures are named precisely: transport errors, truncation, empty responses and
  unparseable output are different problems with different fixes — never collapse them.
- Artifacts of every run go to `runs/` (gitignored): prompts, raw model output, verdicts.
  When debugging a review result, start there, not in the code.
