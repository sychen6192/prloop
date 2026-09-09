<!-- Keep it short. The commit message carries the why; this is the reviewer's checklist. -->

## What changed, and why

<!-- The failure this fixes, or the gap it closes. Not a restatement of the diff. -->

## Invariant touched

<!--
Name it if the change goes near one (CLAUDE.md has the list), and say how it still holds:
deterministic control loop · models never emit line numbers · the two axes stay blind to
each other · skeptic lowers only / fails open · anchoring fails closed · config SSOT ·
undici is the only runtime dependency. "None" is a fine answer.
-->

## Checks

- [ ] `npm run check` passes (typecheck + both selftests) — paste the counts
- [ ] New knob? It exists in **all four** places, or none: read in `config.ts`, listed in
      `KNOWN_KEYS`, documented in `.env.example`, and in the README settings table
- [ ] Comments explain *why* — the failure that motivated the code, not what the code does
