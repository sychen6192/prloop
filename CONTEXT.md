# prloop

An automated PR-review loop for Azure DevOps: a deterministic pipeline that calls models
only at the finder/verifier points, anchors every finding to the exact content under
review, and publishes convergent comments.

## Language

**Iteration**:
Azure DevOps' numbered snapshot of a PR push; the unit an incremental review compares against.
_Avoid_: revision, round

**Requirement axis / Code axis**:
The two independent review verdicts — "does the change do what the work item asked" and
"is the changed code defective" — computed blind to each other so neither can excuse the other.
_Avoid_: track, lane, check (as a noun)

**Anchor**:
The right/left-side line span (1-based offsets, both ends always sent) that ties a finding
to the iteration's content; computed from a quote, never taken from a model's line number.
_Avoid_: location, position

**Degraded (finding)**:
A finding whose quote could not be anchored unambiguously; it appears in the summary with
its failure reason, never inline.
_Avoid_: dropped, lost

**Fingerprint**:
The stable identity of a finding across runs, hashed from its normalized file, category and
quote, and carried in a hidden comment marker so re-runs recognise what they already said.
_Avoid_: id, hash (bare)

**Marker**:
A hidden HTML comment prloop embeds in every comment it writes — authorship, fingerprint,
category, iteration — and reads back on the next run to recognise its own threads. One
grammar, owned by `publish/markers.ts`: writers and readers agree byte for byte, and the
bytes are fixed because they already sit on live PRs.
_Avoid_: tag, annotation, sentinel

**ReviewContext**:
Everything one review reads: the iteration's file diffs with real line indexes, what was
skipped and why, and the FileIndex built from them. Its contract — what a provider must
guarantee — lives in `libs/context.ts`, not in either provider; `ado/` builds one from the
REST API, `git/` from a working tree, each as its ReviewHost's `intake`.
_Avoid_: state, payload, snapshot

**ReviewHost**:
The service a pull request lives on, as the pipeline sees it: where the change, the
repository's conventions and the acceptance criteria come from, which paths the whole change
touches, and where threads and the
merge-gate status go. The contract is `libs/host.ts`; `ado/host.ts` answers it for a pull
request, `git/host.ts` for a local branch (no threads, every write refused). Nothing in the
pipeline reaches Azure DevOps any other way.
_Avoid_: backend, platform, client

**OpenSpec requirement**:
A requirement that the pull request's own OpenSpec spec delta
(`openspec/changes/<id>/specs/<capability>/spec.md`) adds or modifies. It is judged against
the code in a call apart from the work items and reported as advisory: it never fails the
status or the exit code. OpenSpec documents state intent and are never evidence.
_Avoid_: spec criterion, AC (an acceptance criterion is a work item's)

**FileIndex**:
The one resolver from a foreign path string — model-quoted or tool-reported — to a FileDiff
in the change set; built once per review from the iteration's files, unique-match-or-nothing
at every tier. Foreign paths are re-keyed onto the resolved `FileDiff.path` at the point
they enter the pipeline, so everything downstream looks up by exact path.
_Avoid_: path resolver, file lookup, byPath map
