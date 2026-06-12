# CairnX conformance artifacts

**`cases.json`** — language-neutral replay vectors: `{name, events, tipHeight, expectedState}`.
A third-party resolver is conformant iff, for every case, replaying `events` (already
consensus-normalized: height/pos/proposer/attester/paidTo as the chain provides them) at
`tipHeight` produces a canonical state JSON-equal to `expectedState`. Regenerate from the
reference implementation: `npx tsx test/vectors/gen.ts`. Run: `npx tsx test/vectors.test.ts`.

**`replay-hashes.json`** — sha256 of the canonical state of the REAL chain at each activation
height (+ a dated tip, informational). Any resolver refactor must reproduce these bit-for-bit:
`node scripts/conformance.mjs` verifies against the live indexer; `--update` re-pins (only
legitimate after an intentional canonical-format change, with the change documented here).

| format | what changed |
|---|---|
| 1 | initial pin (2026-06-12, tip 31083): localeCompare tiebreak, events log included in canonical state — RETIRED same day |
| 2 | 2026-06-12: ordinal (code-unit) comparison everywhere; canonical surface = data only (event log informational); CONVENTION §3/§5 made normative for both |
