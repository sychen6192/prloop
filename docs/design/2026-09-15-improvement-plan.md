# Improvement plan

Date: 2026-09-15
Status: **implemented** — every item in waves 0 to 3 shipped; see the CHANGELOG for what each
one actually turned into. The text below is kept as written, including the scopes that were
amended during implementation and the two items whose design changed materially once the code
was in front of us (N's `fatal/` directory is fixed rather than timestamped, because a
directory repeated failure writes to must not compete for the retention budget; C split
identity checking by consequence, because `ado/auth.ts` allows three legitimate credential
identities on one pull request). A plan rewritten to match what was built records nothing.

Method: four independent read-only sweeps of the tree (operational robustness, review quality,
operator experience, security), then one concrete design per candidate, then two adversarial
reviewers per design told to refute it. Every problem statement below was verified against the
code before it was designed. The refutation pass completed for A, B, D and E only; the rest are
marked accordingly, because a design nobody attacked is a design nobody checked.

The trigger for the sweep was a comparison against
[plannotator](https://github.com/backnotprop/plannotator). That comparison produced exactly one
item (Q). Everything else came out of the sweeps. §7 says what was rejected and why.

---

## 1. What is actually broken

Four defects, all verified by reading the code. Three of them are silent: the tool reports
success while doing less than it claims.

**The `--since auto` watermark advances after a review that did not happen.**
`publish/publish.ts:202-204` appends `iterationMarker(ctx.iteration.id)` unconditionally, and
`updateComment` at line 209 replaces the whole comment body, so the previous marker is gone.
`orchestrator.ts:419-434` assembles the `incomplete` list only *after* `publish()` has returned,
so publish cannot know the run was incomplete. A finder outage on one cron tick therefore drops
that push from review permanently, while the CLI honestly exits 3. Nothing is wrong on disk. The
PR is simply never reviewed for those commits.

**The merge gate goes green on an unverified PR.**
`publish/publish.ts:223-243` decides the branch-policy status from unmet criteria and high-risk
findings only. `ado/statuses.ts:7` declares `error` in `StatusState` and nothing in the repository
ever sends it. A run whose finder fleet died posts `succeeded — Reviewed N files, no blockers`.
PROPOSAL §10 rejected the bot vote specifically in favour of this status, so this is the one
artifact a branch policy gates on, and it lies.

**The hidden-marker protocol trusts a substring.**
`publish/markers.ts:88-89` sets `ours` from `body.includes(BOT_MARKER)` anywhere in the body.
`ado/threads.ts:19` parses `author` and nothing reads it. prloop has no way to learn its own
Azure DevOps identity — there is no `connectionData` call anywhere. So anyone who can comment on
the PR can forge prloop's state. A comment carrying `<!-- prloop --><!-- prloop:iteration=9999 -->`
makes `--since auto` resume from 9999 and review an empty diff, and takes over the summary thread
so the real summary never posts. A forged `wontFix` thread with a copied `fp=` writes into
`dismissals.jsonl` and suppresses that fingerprint on every future PR in the repository. A bare
forged `<!-- prloop -->` thread has no `cat=` marker, which `coveredByThread` reads as blocking
*both* axes. Separately, `renderFindingComment` embeds model-written `claim`, `evidence` and
`suggested_fix` verbatim, so a model that quotes a source line containing a marker string can turn
an inline thread into the summary thread on the next run. SECURITY.md does not mention the
protocol at all.

**The credential scrub does not survive the worktree setup command.**
`git/worktree.ts:118-121` runs `PRR_WORKTREE_SETUP_CMD` as `sh -lc`. `run()` passes
`scrubbedEnv()` (`libs/shell.ts:114`), but a login shell re-sources `/etc/profile` and
`~/.profile`, which is exactly where operators export `OPENAI_API_KEY`, `GITHUB_TOKEN` and
`AZURE_DEVOPS_EXT_PAT`. Every scrubbed name comes back before the PR branch's own `npm ci` or
`mvn install` runs. The comment directly above, at lines 114-116, claims the command gets the
scrubbed environment. The linters call `run(spec.bin, ...)` with no shell
(`gates/static.ts:306`) and do keep the scrub, so the setup step is the only leak. Windows already
uses `cmd.exe /d /s /c`, which reads no profile.

---

## 2. What is missing rather than broken

**The precision mechanism cannot be measured.** `orchestrator.ts:325-338` writes `skeptic.json`
rows carrying file, line, claim, killed, verdicts and prompt — no fingerprint, category, severity,
confidence or sources. `applyVerdicts` drops killed findings before `finalize`, so a refuted
finding appears in none of `inline`, `belowBar` or `degraded`. `calibrate.ts` can therefore report
kill rate per skeptic model and nothing else. Which finder gets refuted most, which category dies
most, whether finder confidence predicts a kill: all unanswerable, and the `byFinder` bucket
silently counts a finder's killed findings as if they never existed.

**Only negative outcomes are recorded.** PROPOSAL §12 names implementation rate as the online
north star. `collectDismissals` keeps `wontFix`/`byDesign` only; `resolveStaleThreads` returns a
bare count; a thread a human set to `fixed` is ignored everywhere. Precision estimated as
one minus the dismissal rate therefore counts every comment nobody answered as a success.

**PROPOSAL §12's offline evaluation has no tooling.** `fixtures/seeded-pr.ts` pins
`EXPECTED_ANCHORS`, which are anchoring vectors, not a statement of which defects the pipeline
ought to report. Every run already writes what recall attribution needs — `finder-outputs.json`,
`skeptic.json`, `findings.json` with `suppressedBy` and `anchorFailure` — but nothing joins them
to ground truth. So changing `findingsAgree`'s 0.3 Jaccard threshold, `MIN_CONSENSUS_SOURCES` or
`PRR_SKEPTIC_CONTEXT_LINES` cannot be shown to help or hurt, and the multi- versus single-model
question the whole architecture rests on has never been answered numerically.

**Recall on a large PR is zero for the files that fall off the budget.** `libs/payload.ts:147-171`
drops whole files into `omittedFiles`. Because files sort by added lines with tests last, the
omission is systematic, not random. The only remedy today is a bigger context window, which a
self-hosted fleet often cannot provide.

**Author-controlled text is fenced inconsistently.** `prompts/untrusted.ts` fences the PR
description and the repository conventions. In the same file that fences the description at
`prompts/requirement.ts:143`, the work item title, description and every acceptance criterion are
interpolated raw at lines 123-131 — and the author chooses which work item to link. The PR title
is raw at `prompts/finder.ts:230`. `prompts/triage.ts:80` pastes the linter message raw, and for
fact-tier tools that message becomes the posted comment's `claim` with no model and no sanitiser
in the loop (`gates/static.ts:763`), so a lint rule in the reviewed branch can put arbitrary
markdown — or a marker string — onto the PR under prloop's name.

---

## 3. Wave 0 — the defects

Ship these first and separately. Two of them change what lands on a live pull request.

### D. Non-login shell for the setup command

`sh -lc` → `sh -c`. Three characters, plus the rewritten comment at `git/worktree.ts:114-116`,
which is the only false claim in the tree (README:136-143 and SECURITY.md:29-33 scope the scrub
to the static tools and the opencode runner, so documenting the setup command is an addition, not
a correction).

Both reviewers confirmed the leak and could not break the fix, and both rejected the scaffolding
around it. Drop `describeSetupFailure`: exit 127 is the shell's not-found status for any command
in the line, including one missing from the reviewed branch, so the proposed message diagnoses
PATH when the fault is in the PR author's tree — the precise collapsing of distinct failures that
CLAUDE.md forbids. The Windows branch describes a login shell that cannot exist on a path this
change does not touch. The claim that profile banners pollute the warning line is false: they go
to stdout, and `worktree.ts` only ever reads `setup.stderr`.

Test: two pure `planSetupShell` assertions (which catch `'-lc'`, `["-l","c"]` and an appended
`-l`, where a source grep would not), plus one leak probe. The probe must print its evidence from
inside, before `cleanup()` removes the worktree — `scripts/selftest.ts:2582` already shows the
idiom. Make the control spawn a `skip` gate, not a `check`: a box whose `/bin/sh` does not read
`~/.profile` is not a box with a bug.

Scoped this way it is S. Migration risk is genuinely narrow: prloop itself runs through node, so
whatever PATH launched it already carries node and npm. The real break is a cron or systemd unit
with a minimal PATH whose non-node toolchain lived only in the profile.

### A. Hold the watermark when the push was not reviewed

Both reviewers agreed with the direction and both found the trigger set drawn wrong at each end.
The amended rule is an explicit allowlist of the stages that *produce* the review, built from
named sources rather than from the `stageFailures` array, so a future stage cannot silently join
it: finder stage crash, every finder erroring, skeptic stage crash, requirement axis error.

Excluded, with the reason stated in the same comment:

- **Static and triage crashes.** `orchestrator.ts:229-230` already says a missing linter is not a
  missing review, and such a crash is deterministic over the same code — it recurs identically,
  which is verbatim the argument for excluding coverage gaps.
- **Partial fleet degradation and per-finding dead verifiers.** One 429 on one verdict out of
  forty would hold the entire watermark. On the cron documented at README:239 that silently
  degrades `--since auto` toward full-PR review on a large fraction of runs, at full finder cost.
- **Posting failures, unless transport-class.** `ado/client.ts:265-267` refuses to retry any
  status below 500 that is not 429, so a 4xx such as `TF401232` is permanent and reproduces
  byte-for-byte; the failed finding left no thread, so nothing dedupes it either. Holding on it
  pins the watermark on that iteration forever — the exact wedge coverage gaps are excluded to
  avoid. Keep the status on the `failed` entry (publish.ts:189 currently stringifies the error and
  throws it away) and hold only when at least one failure is `undefined`, `>= 500` or 429.

**Bound the hold.** Holding widens the next run's compare range, which grows the diff, which
eventually trips `PRR_MAX_DIFF_CHARS` and produces coverage gaps — which by design do not hold.
So an unbounded hold ends with the run that finally advances being the one that reviewed the
least. Never hold more than one iteration back, or carry a hold count in the marker and advance
after a small threshold with the reason in the summary.

**Simpler mechanics than designed.** Pass `incomplete` as a fourth parameter to `publish()`
rather than making it a required `SummaryInput` field: the three sibling fields there are
deliberately optional with a documented "absent means no posting happened" reading, and making
this one required drags in six more `renderSummary` literals across `demo.ts`, `local-review.ts`
and `selftest.ts`. Take the prior watermark from the comment being replaced by hoisting
`findSummaryThread` above the body construction, not from `lastReviewedIteration(threads)`, which
scans every thread by a different predicate and can leave two threads carrying divergent
watermarks. Make `PublishResult.watermark` optional and leave it absent on a dry run, so
`publish.json` records "no decision taken" rather than "advanced, to nothing".

With those two simplifications this is S, not M.

### B. Status `error` on an incomplete review

Depends on A's `incomplete` plumbing. Both reviewers agreed the premise and the direction, and
both rejected the proposed test as a tautology over the wrong surface.

The structural fix is to stop assembling the decision's input twice. Have `publish()` compute its
publish-side gaps once, unconditionally, and return them as `PublishResult.gaps`; the orchestrator
pushes those instead of recomputing. Then the status and the exit code see one array by
construction, not by convention that every future edit has to remember.

Put the real assertion in `selftest-publish.ts` against the fake Azure DevOps: capture the state
that reached the wire and compare it to `exitCodeFor` over the array publish actually used. That
fails today — a critical-free, finder-crashed run posts `succeeded` while `exitCodeFor` says 3 —
and passes after, which is what a regression test is for.

Three more things the design left open:

- `postStatus`'s own failure is swallowed at `publish.ts:242-244`. A gate that was never updated
  is a named failure, not a log line: set `statusPostFailed` and let the exit code carry it.
- A run that throws before `publish()` posts no status at all, so an earlier `succeeded` on the
  same iteration still stands. Post `pending` right after intake yields the iteration id, or post
  `error` from `main().catch`.
- ADO cuts the description at 400 characters and finder errors carry up to 500 characters of
  gateway body, with redaction expanding rather than shrinking. Put the reason count in the
  prefix, where truncation cannot reach it.

`docs/troubleshooting.md:211-215` needs amending in the same commit: it currently tells operators
to raise `PRR_MAX_DIFF_CHARS` for a big PR and, two lines earlier, to gate merges on this status,
without mentioning that after this change those are the same PR. Consider feeding stage and
publish failures to the status unconditionally while letting coverage gaps keep riding
`PRR_STRICT_COVERAGE`, so a diff-size budget does not become a merge blocker on upgrade day.

### C. Bind the marker protocol to authorship and position

*No adversarial pass ran on this design. Treat the scoping below as the starting point for one.*

Two independent hardenings. The **position** half is cheap and has no migration risk: recognise
markers only in a run at the very start of the body. prloop has always written them first, so no
live thread is orphaned, and it closes the model-echoed-marker hole in `renderFindingComment` on
its own. Ship it even if the other half slips.

The **authorship** half needs splitting by consequence, which the design did not do. `ado/auth.ts`
prefers a PAT and falls back to `az login`, so the same PR can legitimately carry prloop threads
from three identities: the pipeline's build service token, a developer's PAT, and `az login`. A
blanket `author.id === selfId` check would make the pipeline fail to recognise threads a laptop
run posted, re-post every finding as new and lose the watermark on every run. The design's own
migration note reaches the same conclusion by a different route and answers it with a
`PRR_BOT_IDENTITY_IDS` allowlist.

Split it instead:

- **Identity required** for `lastReviewedIteration` and `collectDismissals`. Forging the first
  stops the PR being reviewed at all; forging the second poisons every future PR in the
  repository. Not recognising a thread there costs a full review or a missing dismissal record,
  both safe directions.
- **Marker only** for `postedFingerprints` and `postedPositions`. Forging those costs one missing
  comment. Requiring identity there would cause cross-identity duplicate posts, which is worse.

`selfIdentityId(ref)` belongs next to `getPrInfo` in `ado/iterations.ts` rather than in a module
the diagnostics cannot import cheaply. Where `connectionData` is unavailable, fall back to
marker-only with one loud warning, so the degradation is named rather than silent. Document the
protocol and its trust rule in SECURITY.md, which does not currently mention it.

---

## 4. Wave 1 — make the thing measurable

This is the wave that changes what can be argued about. Today every threshold in `gates/` was set
by judgment and none of them can be defended with a number.

**H. Give `skeptic.json` a finding identity.** Carry `fingerprint`, `category`, `severity`,
`confidence` and `sources` from `o.finding` — all already on `AnchoredFinding`. Extend
`calibrate.ts` with a `refuted` column beside `dismissed` in the by-confidence, by-category and
by-finder tables, reading the new fields as optional so an existing `runs/` tree still produces a
report. Zero pipeline behaviour change, no knob, no model call. Do this first: J depends on it.

**I. Record positive outcomes.** `collectOutcomes(threads)` for threads a human set to `fixed`
plus the ones `resolveStaleThreads` just closed, persisted to a **separate** `outcomes.jsonl` —
separate because `loadDismissals` suppresses every fingerprint in its file and a fixed finding
must never be suppressed. `calibrate.ts` gains `actedOn` and an implementation rate. Nothing
reaches a prompt.

One hazard the designer found: prloop's own auto-close PATCHes the same `fixed` status a human
sets and leaves no comment behind, so the first run after the upgrade would read the entire
backlog of self-closed threads as human fixes and inflate the rate. Needs a guard before it is
trusted — the simplest is to only count threads closed since the store's own high-water mark.

**J. `scripts/evaluate.ts`.** Offline, read-only, no new dependency. Takes a `golden.json` of
expected defects and classifies each by the furthest stage it reached: not-found, anchor-failed,
refuted, uncorroborated, below-severity, over-cap, inline. Prints recall per stage, inline
precision, comments per PR and per-finder recall. The pure half is exported for the selftest, and
`fixtures/seeded-pr.ts` gains a `SEEDED_DEFECTS` list so one golden file ships with the repo.

This is what turns PROPOSAL §12 from a plan into a command, and it is the only item here that
makes the rest of the roadmap decidable: with it, `PRR_FINDER_MODELS=a` versus `a,b` is a
measurement rather than an argument.

---

## 5. Wave 2 — robustness, then recall, then prompt safety

*None of these had an adversarial pass. Premises are verified; scopes are not.*

**F. Degrade at the two state edges.** `resolveLastReviewedIteration` currently swallows a
`listThreads` failure at `logVerbose` level — which `PRR_QUIET=1` silences entirely — and returns
undefined, so a transient 5xx turns `--since auto` into a silent full review at full model cost.
Rethrow: a cron that cannot read the PR cannot post to it either. In the other direction,
`publish()` calls `listThreads` unguarded after every model call has been paid for; wrap it so
failure returns every finding in `failed[]`, which yields exit 3 with `publish.json` and
`result.json` written, instead of an exit-1 crash that leaves a run directory indistinguishable
from a killed process.

**E. Skip terminal PRs before the model budget.** Ship for `completed` only. The single rejection
the codebase has ever recorded is `the pull request is completed` (`ado/client.ts:26`); a grep for
"abandon" finds one unrelated hit, ADO abandonment is reversible, and thread POSTs on an abandoned
PR are believed to be accepted — so adding it now would be a guess, and the design refuses an
escape hatch. Do not return bare: run a reads-only lifecycle pass first
(`listThreads` → `collectDismissals` → `recordDismissals`), because the post-merge window is
exactly when people bulk-dismiss bot comments they never got round to, and that harvest is the
basis of the whole suppression feature. Write the skipped tick's directory under a prefix
`selectForPruning` does not match, or a daily cron on a merged PR evicts the last real review
inside `PRR_RUNS_KEEP` ticks and turns every dismissal on that PR into an orphan. Name the field
`skippedReason`, not `skipped`, which already means three different things nearby. Amend the
three `PRR_DRY_RUN` rows: it becomes the only way to review a completed PR.

**N. `result.json` on every exit path.** Add identity (org/project/repo/pr, iteration, compareTo,
dry-run, models, start time) and an optional `fatal`; a module-level `currentRunDir()` and a
`createFatalRunDir(ref)` for a throw before intake; a try/catch in `loop.ts` that attaches the log
sink so the early auth and proxy lines land in `run.log`. Make `selectForPruning` treat `fatal-`
like `iter-`. On a cron over a list, the failed PRs are currently the only ones with no artifact.

**G. Per-PR lease.** A lock file cannot work — `libs/learnings.ts:12-16` states that a laptop and
a cron box do not share `RUNS_DIR`, which is the exact case. State-on-PR, consistent with
`lifecycle.ts`'s own rule: a timestamped run marker in the summary, honoured for a bounded window,
with a documented takeover after expiry. This is the one item whose knob (`PRR_RUN_LEASE_MS`) is
justified: how long a run may legitimately take is an operator fact, and a feature that can
*refuse to post* needs an off switch.

**K. Chunk over-budget diffs.** `PRR_FINDER_MAX_CHUNKS`, default 1, so nothing changes until
opted in. Every finder still sees every chunk, so the corroboration semantics are unchanged. The
split is budget-driven and seeded, so the control loop still decides everything.

**L. Fence and sanitise author-controlled text.** Two prompt fences (work item block, tool
message) and a one-line neutraliser for the title and branch names. The part that matters most is
the no-model path: `sanitizeToolMessage()` in `gates/static.ts` where `claim` is built, capping
length, collapsing to one paragraph and stripping HTML comments and leading markdown structure.
Fingerprints hash file, category and quote, never the claim, so sanitising re-posts nothing.

---

## 6. Wave 3 — operator surface

**Q. `review.html` per run.** The one idea worth taking from plannotator: put the diff and the
findings on one screen. Self-contained, no dependency, written while `ctx.files` is still in
memory — `context.json` saves only per-file hunk and changed-line counts, not the lines. Every
anchored finding on its line, every degraded finding with its failure reason. It must pass through
`redactSecrets` like every other artifact egress. This is what makes `--dry-run` a real preflight
and what makes auditing a golden set (J) tolerable by hand.

**R. Report thread lifecycle in the summary.** `result.resolved` is computed at `publish.ts:152`
and never reaches `renderSummary`. Half the idea already exists — `postingClaim` reports
commented-this-run versus already-commented versus could-not-post. What is missing is the closed
count and a "since your last push" line. Cheap, derived entirely from data publish already holds.

**S. Keep the human's reason for a dismissal.** The first reply in the thread whose body lacks
`BOT_MARKER` is the reviewer explaining why they rejected the finding, and it is discarded.
Capture it into a `reason` field and let `calibrate.ts` group by it. Two constraints: it is
author-controlled text, so it must never reach a prompt; and `recordDismissals` writes with
`fs.appendFileSync` directly, bypassing the `redactSecrets` that every other artifact egress goes
through.

**M. `--batch`.** Effort L and it depends on six other items, so it goes last. The value is real
— the documented daily job discards the exit code with `|| true` — but an in-process loop is not
available, because per-run state is module-global in four places (`models/runner.ts` token totals,
`libs/log.ts` clock and sink, `libs/artifacts.ts` call sink, and `PRR_DRY_RUN` exported into
`process.env`). So it spawns one child per line and collects exit codes and `result.json`, which
is why N should land first.

---

## 7. What this plan does not do

**Deferred: one-hop context for a skeptic's `insufficient-context` verdict.** Three sweeps
downgraded it independently. The worktree's whole life is the static gate — it is removed in a
`.finally` at `orchestrator.ts:213-219` and the skeptic runs after — so there is no tree to read
at verdict time without changing a resource's lifetime. The verdict schema has no field for the
symbol the verifier wanted. And the grepped content would be the PR author's branch, entering the
prompt unfenced. PROPOSAL §10 does endorse one dependency hop, so the idea is sound; it is
effort L, not M, and `calibrate.ts`'s `uncheckedRate` (available free with H) should first show
that `insufficient-context` is actually costing findings.

**Deferred: release hygiene.** Weaker than it first looked. `.github/workflows/release.yml`
already turns a pushed `v*` tag into a release after `npm run check`; what is missing is cutting
the first tag. Checksums are moot because there is no build step and nothing is published.
SECURITY.md's "known limit" paragraph is stale — `libs/redact.ts` now strips URL userinfo and
`configreport.ts` runs every value through `redactSecrets`. An outbound-host table is still worth
one paragraph. Least-privilege defaults (`.npmrc` with `ignore-scripts`, SHA-pinned actions, mode
0700 on `runs/`) are a separate small commit.

**Rejected from the plannotator comparison**, with reasons, so they are not re-proposed:

- **The browser UI and its server.** prloop is unattended. A review surface a human drives is a
  different product, and Q takes the part that survives the difference.
- **Tool-wielding review agents.** plannotator lets an agent with file access run the review. That
  hands a model control of the loop, which CLAUDE.md makes a bug and PROPOSAL §10 already rejected.
- **Link sharing.** Reviewed source must not leave the machine. SECURITY.md's position is correct
  and should stay.
- **Guided review's chaptered walkthrough.** It costs a model call that produces no verdict. If a
  walkthrough is ever wanted, take its fail-closed ingest rule — every changed file placed exactly
  once, fabricated paths dropped — which `FileIndex` already implements.

One thing worth keeping as it is: plannotator ignores repo-checked skills entirely, for safety.
prloop instead reads the reviewed repository's convention documents at the *target* commit
(`ado/conventions.ts:7`) and fences them (`prompts/untrusted.ts`), so a PR author cannot rewrite
the rules they are reviewed against from inside their own PR. That is the better answer and needs
no change.

---

## 8. Risk order

**Changes bytes on live pull requests:** C (marker readers; the position half is safe, the
authorship half needs the split in §3), A (which iteration number is written), R (summary text).

**Changes what gets posted or whether a merge is blocked:** B (a branch policy starts blocking
runs that previously went green — nothing is lost, those runs already exited 3, but an operator
who upgrades without reading the CHANGELOG will find out from a blocked merge), L (tool-message
claims are rewritten), E (a merged PR stops getting a summary update), G (a run can decline to
post).

**Pure additions, no exposure to anything already on a PR:** D, F, H, I, J, K, N, Q, S, M.

Sequence accordingly: D alone, then A and B together (they share the `incomplete` plumbing and
landing them separately means migrating the same code twice), then C on its own with the
credential-rollout note in the CHANGELOG, then wave 1 in one batch.

---

## 9. Coverage of this plan

17 designs, every premise verified against the code. The adversarial pass completed for four of
them (A, B, D, E) and was cut short on the rest; all four came back `amend`, none came back
`sound`, and the amendments changed the scope materially in every case — A's trigger set, B's
test, D's scaffolding, E's early return. That hit rate is the reason §3 marks C as unverified and
§5 marks its own scopes as unverified rather than presenting them at the same confidence.

Before implementing anything in waves 1 to 3, put its design through the same refutation pass.

**What happened instead.** Waves 1 to 3 were implemented without that pass, on the user's
instruction to do all of them in one go. What stood in for it, per item: the premise was
re-verified against the code before anything was written, the tests were written to fail on the
bug being fixed, and every one of them was then confirmed to go red with the fix reinstated
before the item was committed. That catches a wrong implementation. It does not catch a wrong
design, which is what the refutation pass was for — so the scopes in §4 to §6 stand as the
ones nobody attacked, and the two that changed materially (N, C) changed because the code
argued with them, not because a reviewer did.
