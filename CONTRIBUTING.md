# Contributing

Read [CLAUDE.md](./CLAUDE.md) first — it is the map of the code, and its **load-bearing
invariants** section lists the things that are bugs when violated, not style preferences:
models never emit line numbers, the control loop is deterministic TypeScript, the skeptic's
asymmetries (lowers only, fails open) and anchoring's (fails closed), the two axes staying
blind to each other, config SSOT, one runtime dependency. They are not repeated here so that
there is one copy to keep true. [PROPOSAL.md](./PROPOSAL.md) §10 lists options already
rejected, with reasons.

## Before every commit

```bash
npm run check     # typecheck + both offline selftests
```

No test needs ADO credentials or a model endpoint; everything is offline. Three nets run, and
they fail for different reasons: `scripts/selftest.ts` is anchoring and the pipeline — if you
touched `libs/diff.ts` or `anchoring/locate.ts`, a failure there is a comment landing on the
wrong line in production; `scripts/selftest-stream.ts` is the SSE transport; and
`scripts/selftest-docs.ts` pins the claims the documentation makes about the code (an
undefined symbol in the README's model-call arithmetic, a Node version pinned in two places
that disagree, a link to a path that was renamed). A doc that has quietly stopped being true
is the one failure nothing else notices.

There is no build step. `tsx` runs the TypeScript directly and `tsc --noEmit` is typecheck
only, so nothing is compiled and nothing is published.

## Adding a knob: four places or none

Every setting is a `PRR_*` env var and lives in exactly four places:

1. read once in `config.ts` (nowhere else — a knob read elsewhere has no provenance, no
   `--config` row and no typo warning),
2. registered in `config.ts`'s `KNOWN_KEYS`,
3. documented in `.env.example`,
4. listed in the README settings table.

`scripts/selftest.ts` fails if any of the four is missing. Adding one and skipping the
registry produces a variable that silently does nothing and warns the user it is unknown.

## Comments

Comments explain **why** — the failure that motivated the code — not what the code does. Most
comments in this repo name a specific incident (a 504 from a gateway idle timeout, a key
echoed back inside a 401 body, a duplicate line anchored by guess). Match that.

Name failures precisely: transport errors, truncation, empty responses and unparseable output
are four different problems with four different fixes. Never collapse them into "failed".

## Running a review without ADO

Two git branches through the identical diff and anchoring path — no credentials, no PR:

```bash
npx tsx scripts/local-review.ts prompt <repo> <base> <head> [out.md]
npx tsx scripts/local-review.ts anchor <repo> <base> <head> <findings.json>
npx tsx scripts/demo.ts        # render comments from fake data, no network at all
```

`npx tsx scripts/doctor.ts '<PR URL>' --smoke` is the preflight when you *do* have an endpoint.

## When a review result is wrong

Start in `runs/<org>/<project>/<repo>/pr-<id>/iter-<N>-<ts>/`, not in the code. It holds the
exact prompts, each model's raw output (kept on failure too, which is when it matters), the
per-finding skeptic verdicts, and the anchoring outcome for everything — **including what was
rejected and why**. `run.log`, `calls.jsonl` (one line per model attempt) and `result.json`
make a run readable on its own. Bring those excerpts to the issue; the bug template asks for
them because the answer is almost always in there.

## Pull requests

Small and single-purpose. Say which invariant the change touches, if any, and paste the
`npm run check` counts. The PR template covers the rest.
