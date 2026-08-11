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

**FileIndex**:
The one resolver from a foreign path string — model-quoted or tool-reported — to a FileDiff
in the change set; built once per review from the iteration's files, unique-match-or-nothing
at every tier. Foreign paths are re-keyed onto the resolved `FileDiff.path` at the point
they enter the pipeline, so everything downstream looks up by exact path.
_Avoid_: path resolver, file lookup, byPath map
