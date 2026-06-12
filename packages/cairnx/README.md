# @inversealtruism/cairnx-core

**CairnX** — tokens, atomic delivery-versus-payment trades, and a leased `.csd` name registry on
[Compute Substrate](https://cairn-substrate.com/docs), implemented as a **pure deterministic
convention** over the chain's native `Propose`/`Attest` transactions. No fork, no smart
contracts, no custodian — the same trust class as Bitcoin Ordinals/Runes/BRC-20, stated plainly.

Live market: **https://cairn-substrate.com/trade** · Explorer: **/explorer**

## The trust model, in one paragraph

CairnX state (token balances, name ownership, open offers) is computed by replaying the chain
through one pure function: `resolve(events, tipHeight) → state`. The chain enforces ordering,
the one-transaction atomicity of payment + fill, and offer expiry; this convention enforces
token/name semantics. **Determinism is the trust model**: every honest resolver fed the same
chain prefix MUST produce byte-identical canonical state. `CONVENTION.md` (shipped in this
package) is normative; `test/vectors/` is the conformance bar.

## Use it

```ts
import { resolve, canonicalState, offer, buildRecord, DOMAIN } from "@inversealtruism/cairnx-core";
import { buildPropose } from "@inversealtruism/csd-tx";

// 1. BUILD a record (a partially-fillable sell offer, reserved for one buyer — v1.3 RFQ)
const built = offer({ give: { ticker: "CAIRN", amount: "5000000000" },
                      want: { value: "100000000" }, min: "10000000", taker: buyerAddr });

// 2. ANCHOR it (the record IS the uri; same-tx outputs can pay fees/sellers — atomic DvP)
const tx = buildPropose({ domain: DOMAIN, uri: built.uri, payloadHash: built.payloadHash,
  expiresEpoch, fee: 25_000_000, utxos, priv });

// 3. RESOLVE the chain (events come from any indexer; see the Scanner reference impl)
const state = resolve(events, tipHeight);
console.log(state.tokens.CAIRN, state.balances.CAIRN, state.names);
```

## Write a conformant resolver in another language

1. Implement `CONVENTION.md` §1–§18 (apply order, every record type, the version activation
   heights, canonical-state format 2 — ordinal key ordering, data surface only).
2. Replay `test/vectors/cases.json`: for every case, your canonical state must equal
   `expectedState` byte-for-byte (16 cases covering tokens, partials, swaps, RFQ, names,
   leasing, and the v1.3/v1.4 safety semantics).
3. Replay the live chain and compare `sha256(canonicalState)` against
   `test/vectors/replay-hashes.json` at the pinned activation heights.

## Versions (activation heights are consensus-grade — never reinterpret history)

| | height | what |
|---|---|---|
| v1.0/1.1 | 29 860 / 29 960 | tokens · names + protocol fees |
| v1.2 | 30 300 | token⇄token swaps · partial fills · bids (RFQ) · ocancel |
| v1.3 | 31 100 | CSD-priced offers must be taker-bound (open-fill race made unrepresentable) |
| v1.4 | 31 400 | fill-before-cancel (the cancel snipe is dead) |
| v1.5 | 32 000 | name **leasing** (renew/grace/decaying-premium recapture) · `tmeta` |

The invariant after v1.3+v1.4: **a buyer can never lose more than the anchor fee** — not to a
racing buyer, not to a malicious seller.
