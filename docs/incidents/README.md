# Incidents and lessons

The history behind rules in `AGENTS.md`. Each entry says what happened and which rule or check it produced;
`AGENTS.md` keeps the rule as one line.

## C1: a proven consensus-fork class (2026-06-20)

Python `re.match(...$)` accepts a trailing newline where the JavaScript `$` anchor rejects it, so one mined
record such as `{"name":"alice\n"}` would have forked the two resolvers. Fixed by moving the validators in
`conformance/cairnx_ref.py` to `re.fullmatch`. The raw regex differential (`conformance/crosscheck-regex.mjs`) now
guards the class. This is the incident that motivated the `conformance/` directory and the rule that the Python
oracle is written from the spec, never transliterated from the JavaScript.

## Raw npm publish of 0.1.22

A publish with the npm client shipped unresolved `workspace:*` specifiers. Every package's `prepublishOnly` now
runs `scripts/publish-guard.mjs`, which refuses any client but pnpm.

## A published version keeps its pins

After csd-codec moved to 0.1.16, csd-crypto 0.1.15 still pinned csd-codec 0.1.15 in the published graph,
because a published version keeps the exact pins it shipped with. Hence the rule to bump every workspace
dependent of a changed package.

## pnpm pack orders dependencies nondeterministically (2026-10-19)

pnpm 10.32.1 writes the packed `package.json` dependencies in the order the `workspace:*` resolutions finish,
so repeated packs of csd-tx matched the registry tarball 11 times in 15. The published-dist leg of
`scripts/check-lockstep.mjs` therefore compares the extracted `dist/` files, not a whole-tarball hash.

## Declined docs-only republish (0.1.36)

A republish to refresh stale docs was declined; docs changes ride the next real release.

## Dead-green tests

A consumer repo's fail-closed test asserted a frozen flag after the lane had already shipped `true`, and it
always skipped because an optional dependency was missing, so it read green for weeks. The same class was later
found in another consumer's stats tests. Lesson: mutation-test the guards; a test that cannot fail is worse
than none.

## Race-harness P4 divergence mid-rebuild

Running the audits while packages were rebuilding produced 302 fake JS/Python divergences once. Run
`audit:race` only on a settled tree; heavy audit and mutation runs belong in a disposable git worktree.

## Invariant coverage gap (5c0bb71)

An invariant run exercised less than it claimed. Commit 5c0bb71 widened the fuel. Read the `coverage reached:` line of
`audit:invariants` before trusting a clean run.

## Stale golden vector (GOLDEN_POW)

A stale golden vector once masked a missing proof-of-work-limit gate. Vectors must track live parameters.

## Coordinated activation-height re-pin (2026-07-03)

The V24 to V27 activation heights were pulled in, which required a same-day re-pin of every verifier.
Re-pinning an activation height is legal but only as a coordinated change.

## Shared-core deduplication (2026-06-24)

The ecosystem moved to two implementations of the consensus surface: this TypeScript core, imported or
vendored by every consumer, and one independent Python oracle used only for differential testing.
