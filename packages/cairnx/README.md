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

## ★ Single source of truth — consumers & how to change consensus without drift

**This package is the ONE canonical implementation of the CairnX convention.** Every consumer in the
ecosystem **imports** its constants / regexes / fee+claim+expiry math / `canonicalJson` / `parseRecord`
from here (directly via npm, or via a *deterministic vendored esbuild* of this exact dist where a
browser/MV3 constraint forbids a runtime dep tree). **Nothing re-declares a consensus value by hand** — a
hand-mirror that drifts across a version bump is a silent chain fork, which is exactly the bug class the
2026-06-24 shared-core de-duplication (`cairn/docs/Plans/46`) deleted. Do not re-introduce one.

| Consumer | How it gets consensus | Guard |
|---|---|---|
| **cairnx svc** (`cairnx/`, the live resolver `:8794`) | npm pin → `src/resolve.ts` re-export shim | svc replay-hash conformance |
| **cairn /trade + /names UI** (browser) | `public/vendor/cairnx-core.js` — esbuild of this dist; `helpers.js` imports+re-exports it | `test/vendor-cairnx-parity.test.mjs` (consumer golden) + `scripts/check-vendor-fresh.mjs` (CI) |
| **cairn-wallet** (MV3 extension, fund custody) | `src/vendor/cairnx-spv.js` — esbuild of this dist (`export *`); `core/cairnx.ts` imports it | `test/cairnx.ts` (fixtures vs this pkg) + `scripts/check-vendor-fresh.mjs` + `PROVENANCE.json` |
| **cairn-cli** | npm pin → `src/lib/cairnx.ts` imports the regexes/limits | `test/cairnx.mjs` |
| **cairn server** (`cairn/src`) | proxies reads to the cairnx svc; imports `csd-*` (codec/crypto/tx) via `file:` | — |
| **the Python oracle** `conformance/cairnx_ref.py` | INDEPENDENT re-implementation (the differential — **KEEP**, never collapse) | `test:crosslang` (JS⇄Python) |

### Versioning (independent cadence)

`cairnx-core` versions on its **own** consensus cadence (it bumps when the convention changes); the stable
`csd-*` primitives version on theirs. They need **not** share a version — coherence comes from `workspace:*`
inter-deps (pnpm freezes each to the exact published version at publish), enforced by `scripts/check-lockstep.mjs`.
**Never publish two different builds under one version** (the M4 hazard): bump the version whenever the bytes change.

### To make a CONSENSUS change (the whole flow — edit ONE source, not 4–5 mirrors)

1. Edit `src/` here **and** the Python oracle `conformance/cairnx_ref.py` (the differential). Add a height-gated
   activation (`V*_HEIGHT`) — never reinterpret history; add/extend a vector in `test/vectors/cases.json`.
2. `pnpm --filter @inversealtruism/cairnx-core build` · `pnpm --filter @inversealtruism/cairnx-core test` ·
   `pnpm test:crosslang` (JS≡Python) · `node scripts/check-lockstep.mjs`. All green.
3. **Bump** `package.json` version. `pnpm publish` (converts `workspace:*` → the exact csd-* version).
4. **Rebuild + recommit the two vendored bundles** (they are generated artifacts, not hand-copies):
   `cd cairn && bash scripts/build-trade-vendor.sh` → commit `public/vendor/cairnx-core.js`; `node scripts/check-vendor-fresh.mjs`.
   `cd cairn-wallet && bash scripts/build-spv-vendor.sh` → `node scripts/check-vendor-fresh.mjs --write` (regen PROVENANCE) → commit the bundle + `PROVENANCE.json`.
   *(esbuild is version-pinned in each repo — same version → byte-reproducible bundle; the freshness gates fail loud on a stale bundle.)*
5. **Re-pin every consumer** to the new version (cairnx svc + cairn-cli `package.json`) and, for a height-gated
   change, **deploy all consumers BETWEEN activation heights, not across one** (below the gate the output is
   byte-identical to history, so the rollout is safe).
6. Restart the cairnx svc; run its replay-hash conformance; (wallet) run the release flow + CWS upload.

### For agents / contributors

- **Never hand-declare a CairnX consensus constant/regex/formula in a consumer.** Import it from this package
  (or its vendored bundle). If you find a hand-mirror, collapse it — don't add a guard.
- A new exported symbol must be added to the consumers' import+re-export lists (`helpers.js`, `core/cairnx.ts`)
  and to the wallet's `cairnx-spv.d.ts`; the build scripts' export-assertion lists catch a dropped one.
- The KEEP-list (do **not** collapse — these are *verification*, not duplication): the Python oracle, the
  wallet/swapguard SPV light-client + `namespv.ts`, the wallet `core/csdtx.ts` tx-codec twin, the portable
  vectors. The cross-language differential is the trust model — keep it intact.
