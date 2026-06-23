# CairnX conformance artifacts

**`cases.json`** — language-neutral replay vectors: `{name, events, tipHeight, expectedState}`.
A third-party resolver is conformant iff, for every case, replaying `events` (already
consensus-normalized: height/pos/proposer/attester/paidTo as the chain provides them) at
`tipHeight` produces a canonical state JSON-equal to `expectedState`. This is the CI-enforced
bar (no live node needed): `test/vectors.test.ts` asserts JS==expectedState, and
`conformance/crosscheck-resolve.mjs` asserts JS==Python==expectedState. Coverage spans v1.0–v2.1
incl. nprofile, the V20 claim grace/late-fill, the V21 offer-cap, name ops, lapsed-premium reclaim,
and rejection paths. Regenerate the height-gated families from the SHIPPING resolver with the
generators in `conformance/`: `node conformance/gen-v18-vectors.mjs` (v1.8 name fee) and
`node conformance/gen-post-v18-vectors.mjs` (v1.9–v2.1) — each derives `expectedState` from the
built `dist/` and rewrites only its own `*-` prefixed cases. Run all: `npx tsx test/vectors.test.ts`.

**`replay-hashes.json`** — sha256 of the canonical state of the **REAL chain** at each activation
height (+ a dated tip, informational). This file (csd-sdk copy) is the published/static anchor;
the operator-maintained copy with the current pin set lives in the `cairnx` repo
(`cairnx/test/vectors/replay-hashes.json`) and is what the real-chain co-sign verifies. The
real-chain tools require a live indexer (CI has none → they skip): in the `cairnx` repo run
`tsx scripts/conformance.mjs` to verify the resolver against the live chain (`--update` re-pins —
only legitimate after an intentional canonical-format change, documented below), and
`tsx scripts/conformance-crosslang.mjs` for the JS⇄Python⇄pinned-hash co-sign over real on-chain data.

| format | what changed |
|---|---|
| 1 | initial pin (2026-06-12, tip 31083): localeCompare tiebreak, events log included in canonical state — RETIRED same day |
| 2 | 2026-06-12: ordinal (code-unit) comparison everywhere; canonical surface = data only (event log informational); CONVENTION §3/§5 made normative for both |
