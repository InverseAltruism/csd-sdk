# Gate template

Each gate after v2.9 has one file in this directory, `docs/gates/<gate>.md` (for example `docs/gates/v2.10.md`),
copied from this template and linked from its entry in `CONSENSUS_CHANGES.md` (CONVENTION.md §39).
`scripts/check-consensus-citations.mjs` checks the citations in every file here as it does in the ledger, and fails
on a gate file the ledger does not link. A citation is `path/to/file.ts:NNN` with a code span of at least 12
characters from the cited line in the same paragraph, or followed by a verbatim quotation indented four spaces.
Replace every bracketed line below; keep the headings.

## Motivation

[What fails or is missing today, with the evidence: a vector, a replay, a live query with its date.]

## Rule

[The normative text, as it goes into CONVENTION.md, and the section it goes into.]

## Class

[reject-more: an input the earlier rule applied becomes a no-op. accept-different: an input is applied where it was
not, or applied otherwise. Say which, and why a stale replayer forks under it.]

## Height

[The constant in `packages/cairnx/src/types.ts` and its value, the date it was set and the tip at that date. A
published height never moves earlier.]

## Vectors

[The vector files and case names that pin the rule on both sides of the height, the cross-language check that runs
them, and whether the replay hashes move (they move only if `resolve()` changes below the tip).]

## Rollout

Every consumer, and how its adoption is observed by a live query, never by a manifest. A row is done when the
observation shows the new core, and every row is done before the tip reaches the height.

| Consumer | Kind | How adoption is observed | Observed (date, value) |
|---|---|---|---|
| cairnx service | service | `gates` and `build.core` of its `/cairnx/health` | |
| clarvis | service | `gates` and `build.core` of its `/trade/api/cairnx/health` | |
| cairn web server | service | [the route that reports its core version] | |
| csd-indexer | service | [the route that reports its core version] | |
| cairn site bundle | vendored bundle | the `PROVENANCE.json` of the bundle as served | |
| cairn-wallet bundle | vendored bundle | the `PROVENANCE.json` of the build the store serves | |
| cairn-sdk | npm package | the cairnx-core version its published release pins | |
| Python oracle (`conformance/cairnx_ref.py`) | reference | the cross-language check above, green on the gate's vectors | |
| outside replicas | replica | a written acknowledgement from each known operator | |
