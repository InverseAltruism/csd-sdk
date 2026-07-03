# @inversealtruism/csd-indexwire

TypeScript types + runtime guards for the csd-indexer REST wire: proposals, attestations,
txs/outputs, and /health. One source of truth for a contract that was previously hand-maintained
in five places (the indexer serializer, the cairnx scanner's local `RawProposal`, cairn's project
reader, cairn-sdk's untyped `IndexerClient`, and each repo's test fixtures).

## Posture (inherited from the production consumers, verbatim)

- **Structure fails loud.** A non-array page, a missing txid, a non-ordinal height/pos throws.
  The CairnX resolver must freeze on last-good state rather than resolve from a malformed feed.
- **Values fail conservative.** A malformed tx output is skipped, never thrown: dropping an output
  can only make a payment look smaller, so an uncovered fill/fee gets rejected, and one weird tx
  cannot DoS a scan.
- **Coercions are the resolver feed's.** Ids and addresses lowercase; epochs/scores through
  `Number()`; a saturated `expires_epoch` stays non-safe on purpose (GRX-WIRE-CLAMP-1: the
  resolver's own `isSafeInteger` gate must fire identically on the indexer and SPV wires).

Do not "tighten" a guard here without reviewing the consumer it was extracted from: several
asymmetries (e.g. `confidence` clamping to 0 while `score` passes through) are deliberate.

## API

Types: `ProposalRow`, `AttestationRow`, `TxRow`, `TxOut`, `HealthResponse` (the snake_case wire
shapes). Guards: `requireArrayPage`, `requireOrdinal`, `parseProposalRow`, `parseAttestationRow`,
`conservativeOutputs` (+ `MAX_OUTPUTS_PER_TX`), `parseHealth`.

## Adoption map (post-publish; each swap is behavior-preserving by construction)

1. **cairnx** `src/scan.ts`: replace the local `RawProposal` interface with `ProposalRow`/
   `parseProposalRow`, the inline attestation coercions with `parseAttestationRow`, `reqOrd` with
   `requireOrdinal`, and the output filter with `conservativeOutputs`. Acceptance bar: full cairnx
   suite green, `pnpm run audit:all` clean on a settled tree, `/cairnx/state` byte-equal
   before/after at an equal tip.
2. **csd-indexer**: a serializer conformance test asserting every served row parses with these
   guards (binds the producer to the contract; no runtime change).
3. **cairn** `src/lib/project.ts`: parse indexer rows with `parseProposalRow`.
4. **cairn-sdk** `src/indexer.ts`: type the `unknown` returns of `proposal()/attestations()/
   domainProposals()/health()` with these types.

Versioning: additive response fields are a minor bump; renames/removals are a major bump plus a
changelog entry. The indexer's `/health.version` field (0.2.5+) says what the producer runs.

## Tests

`pnpm test` — guard assertions over verbatim fixtures captured from the live Granus indexer
(2026-07-03) plus adversarial structure/value cases pinning the posture above.
