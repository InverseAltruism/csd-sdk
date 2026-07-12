# Consensus changes

This file tracks every released change to the **byte-level consensus surface** of the SDK —
anything that alters what bytes a transaction/sighash/header serializes to, what the LWMA or
chainwork math computes, what a merkle proof accepts, or what the CairnX replay derives. If a
release is not listed here, it did not touch consensus behavior.

## Why this exists, and the rule for consumers

The packages are released on **independent cadence**: `@inversealtruism/cairnx-core` tracks consensus
activation heights and bumps ahead of the stable `@inversealtruism/csd-*` primitives, which move on
their own — they need **not** share a version. What guarantees coherence is that inter-package
dependencies are published as **exact versions** (no `^`/`~` — `workspace:*` is converted to the
publishing package's exact current version at publish time), so a consumer can never resolve a
mismatched pair. CI enforces this `workspace:*` discipline + dist-freshness
(`scripts/check-lockstep.mjs`); cross-package byte-identity is enforced separately by the conformance
job (the REAL guard).

**If you build on these packages, pin exact versions and let your lockfile resolve the matching
inter-deps.** A lockfile that
mixes, say, `csd-codec@0.1.4` under `csd-tx` with `csd-codec@0.1.6` under `csd-light` can sign
with one byte-encoding and verify with another. The packages themselves can't fully prevent a
consumer lockfile from holding two codec copies — uniform exact pins in *your* `package.json` do.

```json
"dependencies": {
  "@inversealtruism/csd-codec":  "0.1.5",
  "@inversealtruism/csd-crypto": "0.1.5",
  "@inversealtruism/csd-tx":     "0.1.5",
  "@inversealtruism/csd-client": "0.1.5",
  "@inversealtruism/csd-light":  "0.1.5"
}
```

Consensus-critical packages: **codec** (serialization, canonical JSON, merkle), **crypto**
(sighash `CSD_SIG_V1`, RFC-6979/low-S, p2pkh), **tx** (transaction construction), **light**
(header validation, LWMA-45, chainwork), **vectors** (the golden contract all of the above must
match). `client` is transport (consensus-relevant only in what it passes through);
`cairnx-core` carries its own determinism contract (state-replay hashes + conformance vectors
in the package).

## Auditing a resolver / consensus change (directive)

Before releasing any change to `cairnx-core` resolver behavior (`packages/cairnx/src/*`) or adding a
consensus gate, run the money-safety audit tooling in addition to `test:crosslang`:

```
pnpm run audit:all     # ledger-soundness invariants + money-safety + adversarial races
```

`test:crosslang` proves JS and Python agree byte-for-byte, but two implementations can AGREE and both
be unsound (a burn, a mint-from-nothing, a leaked lock). `audit:all` checks the ledger stays sound and
that no honest-user money is burned. It is intentionally not a CI gate, so run it by hand. When a
change adds a feature the audit fuel does not exercise, extend the fuel first (see
`conformance/AUDIT.md`, "Standing practice"). A clean run with a thin coverage line is a weak signal.

## History

## cairnx-core 0.1.37 (2026-07-12, PENDING publish + activation) - V28 fclaim open-lane settlement atomicity (CONVENTION v2.8, §31)

**Consensus change (gated, non-retroactive): `V28_HEIGHT` = 55,000.** The largest CairnX replay change since the
gate ladder began. It closes the cross-block "pay without delivery" flaw on the open-lane marketplace buy
(CX-DVP-CROSSBLOCK-1): Half A (seller cancels in block N, buyer fills in N+1 - L0 satisfied, overlay rejects
delivery) and Half B (a fill delayed past the overlay hold but before offer expiry). Neither half is closable
app-layer-only (Half A's burn lands after the buyer signs; Half B has no client-enforceable expiry since L0 does
not enforce locktime), so the fix is a resolver rule change, which in this architecture is a coordinated
height-gated replayer upgrade, NOT an L0 hard fork (the Rust node is untouched; the independent miners are
unaffected).

At an event height >= V28 the following apply (all in `packages/cairnx/src/{resolve,types,records,preflight}.ts`,
mirrored in `conformance/cairnx_ref.py`):
- The open-lane claim becomes a short-expiry **`fclaim` Propose** (`{v,t:"fclaim",offer}`, FCLAIM_KEYS), and the
  open-lane fill **Attests that fclaim's txid** (not the offer id). L0's own attest-existence + attest-after-
  `expires_epoch` invalidity rules THEN ARE the hold deadline, so the overlay hold deadline == the L0 minability
  deadline and the cross-block window is removed by construction.
- **Grant ladder**: an fclaim is GRANTED as the offer's live hold only if the offer is open, CSD-priced, not
  taker-bound, not already held, past `CLAIM_COOLDOWN_BLOCKS`, with `E in [epochOf(h), epochOf(h)+
  FCLAIM_MAX_EPOCH_AHEAD]` (anti-squat) and under `MAX_ACTIVE_CLAIMS`; else DENIED. Denials are recorded
  `granted:false` in an internal `fclaims` map that is materialized GRANTED-only and **excluded from
  `canonicalState`** (so it never enters the replay hash - byte-identity preserved).
- **Correction 1**: an offer-txid fill during a live fclaim hold is rejected (openFillReject; both whole + partial).
- **Correction 2**: an offer cancel (ocancel or a score-0 cancel) landing during a live hold is FROZEN (no-op),
  keyed on the cancel's OWN captured block height, evaluated live on the offer object. This IS the Half A closure.
- **Lane B**: taker-bound V28+ offers are uncancellable (kills Half A for firm RFQ quotes).
- **SCORE_CLAIM sunset**: legacy claim Attests stop granting holds at V28 (self-sunsetting, no-height-literal
  predicate; otherwise legacy claims would keep minting Half-B-vulnerable holds forever). A pre-V28 legacy hold's
  fill is still HONORED after V28 until the hold lapses (no fork on the honored fill).
- **Last-write-wins `claimTxid`**: re-assigned on every grant, never cleared (a stale claimTxid = a second-holder
  burn).
- New client fund boundary **`verifyFillSpv`** (`verifyfill.ts`): the shared, fail-closed fill-SPV surface the
  site + wallet run before building an open-lane fill (grant replay over merkle-proven events; refuses a denied /
  superseded fclaim, a forged-holder fill, a below-depth fill, a cross-offer `MAX_ACTIVE_CLAIMS` over-cap, and a
  past-deadline strand). New selectors `fclaimHoldEnd`/`fclaimEpochFor`; `GAP_NEEDED`=104, `MAX_SCAN`=134.

New constants: `V28_HEIGHT`=55,000, `FCLAIM_MAX_EPOCH_AHEAD`=2, `FILL_TIP_MARGIN`=2.

**Byte-identity**: every pre-V28 canonical-state replay hash is byte-identical (`vectors.test.ts` 71/71; all
pinned real-chain heights <= 45,959 < 55,000). Only events at height >= 55,000 see the new rules; the live tip
was ~52.6k at the edit, so nothing is active yet. `resolve.ts` grew only ~+111 lines and `cairnx_ref.py` ~+76;
7 new `v28-*` golden vectors in `cases.json` (regenerated relative to V28_HEIGHT).

**Adoption discipline (HARD gate, both directions)**: this is a fund-safety rule change, so EVERY replayer
(cairnx svc, clarvis, cairn-cli, cairn-sdk, and the vendored cairn-site + cairn-wallet bundles) MUST be on this
core before the tip reaches 55,000, or a stale replayer forks the app layer (stale clients strand, never burn -
the fail direction is safe). The D2 service alias (cairnx svc + clarvis) bridges the stale CWS field wallet so it
does not 404 into an open-lane outage. STRONG COMPANION: the node reorg ghost-UTXO fix (finding-9,
`cairn-node-v0.1.4`) must land BEFORE V28 - V28 sharpens its trigger (a reorg-orphaned short-lived fclaim Propose
plus a payment-bearing fill Attest hits the app-phase existence/expiry bail mid-apply). 55,000 is legally
BUMP-able (a coordinated same-day re-pin of every verifier) if the rollout needs more runway.

**Audit**: `test:crosslang` v28 26/26 (JS==Python at 55k, incl. below-gate inertness) + all v20-v27 grids +
fuzz 1500 + regex 2301; `audit:all` money-safety --selftest green (v2.8 honest fclaim fill silent, every known
misbehaving-client burn re-surfaced); 4,800 newly-authored fclaim fuzz scenarios (0 zero-delivery accepts) + a
3-agent red-team (found + fixed 3 client-side burns; the consensus core resisted every attack, no break).
DEDUP DEBT noted for follow-up: the client fill-SPV evidence layer (scan + prevout bind + cap count + give-backing
synthesis) is hand-implemented TWICE (site swapguard.js + wallet fillspv.ts) with divergent algorithms and no
shared vector; consolidate into a shared cairnx-core evidence helper before the next such change. Rollout order:
follow "Rollout checklist for a NEW GATE" below (this is a rule change, not just a fee tier, so step 2 adds the
crosslang cases + re-pins nothing that resolve() did not change - all pre-V28 hashes stayed identical).

## cairnx-core 0.1.36 (2026-07-10) - finalizeWinnerCheck gains the finalize-window checks (client helper only, replay untouched)

`packages/cairnx/src/preflight.ts` completes `finalizeWinnerCheck` with the N-2 finalize-window
checks: an optional `tip` parameter adds BOTH the freeze-window ("too early") and expiry ("window
closed") refusals, mirroring the resolver's authoritative nfinalize gates (`resolve.ts`: rejects
unless `ev.height > effHeight + REG_COMMIT_MAX_BLOCKS`; rejects when `ev.height > finalizeBy`) with
the client-side `FINALIZE_TIP_MARGIN` band the site's `finalizeReady` already applies. Callers that
omit `tip` keep the exact winner-only semantics (backward compatible). The window is derived PURELY
from the caller's pinned `commitHeight` (`= effectiveHeight`), NEVER from the resolver-supplied
`finalizeBy` (the true deadline is always `eff + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS`),
so a hostile resolver returning an inflated `finalizeBy` cannot widen the safe band into a fee burn --
preserving the module's "no resolver value can induce a loss" invariant. The consensus surface is
UNTOUCHED: the `resolve.ts`/`records.ts`/`types.ts` diff for this release is empty, no serialization,
gate, constant, or replay byte changes, so replayers on 0.1.35 compute byte-identical canonical
state. Pinned by a 10-case window grid in `test/preflight.test.ts` (the refusal + lying-finalizeBy
cases fail on 0.1.35). No height gate needed (additive client-selector logic).

## csd-light 0.1.17 (2026-07-10) - snapshot anchor containment + restore-time timestamp rules (reject-more only)

`LightClient.fromSnapshot` (`packages/light/src/index.ts`) hardens the restore path in two
reject-more-never-accept-different ways. (1) Anchor containment: a checkpoint-configured client now
refuses any snapshot unless a pinned checkpoint COVERS the whole trusted seed prefix, i.e. some
configured `cp` with `baseHeight + LWMA_WINDOW - 1 <= cp <= last` (genesis-rooted snapshots stay
exempt, anchored by the H4 genesis check; honest wallet snapshots seed `baseHeight = cp - LWMA_WINDOW`
so they pass with zero false-reject). The restored `trusted` seed prefix (first `LWMA_WINDOW` headers)
skips LWMA/time re-derivation, so it is only safe when a checkpoint's hash-pin sits at/above its top
and the backward prev-chain forces every prefix header real. Without this a poisoned snapshot could
place forged min-difficulty headers inside the prefix and restore them as verified (grindable at
POW_LIMIT; requires storage-write + a hostile RPC). This supersedes the initial "must contain the
lowest checkpoint" rule, which still left a poisoning BAND (`baseHeight` within `LWMA_WINDOW` of the
checkpoint) open -- closed here and pinned by a dedicated band test. (2) The H3 timestamp rules
(min-spacing, MTP, future-drift) now also run on restore for
exactly the headers whose LWMA window is re-derived, in `verifyOne`'s check order (time before bits
before PoW, as the node does). Deterministic for min-spacing/MTP and the wall-clock bound only
loosens with time, so an honestly-synced snapshot can never regress on restore. Forward-sync
(`sync`/`ingest`/`verifyOne`), LWMA math, header bytes: untouched. Every accepted header set for
honest chains is identical; only forged/unanchored snapshots are newly rejected. Pinned by the C1/H1
containment + band + H3-on-restore mutation tests in `light-offline.test.ts` (each fails on 0.1.16).
No height gate needed (client-local trust hardening, no consensus-byte change).

## csd-light 0.1.16 (2026-07-10) - LWMA bits->target memo (perf only, byte-identical)

`packages/light/src/lwma.ts` gains a module-scope memo of the pure `targetToBigInt(bitsToTarget(bits))`
composition (capped Map, clear-at-cap 4096; invalid encodings cache as `0n` and still throw exactly
where the old all-zero-bytes check threw). ZERO math changes: every accepted/rejected `bits` and every
derived target is identical; the sliding 45-header window just stops re-converting the same header's
bits up to 45 times. Motivation: a wallet-scale `LightClient.fromSnapshot` restore measured ~85% LWMA
re-derivation; the memo cuts restore cost ~4x (192 -> 47 us/header on the real-header fixture).
Byte-identity pinned by the new `packages/light/test/lwma-memo.test.ts` (memoized impl vs an
unmemoized raw-codec reference on every real fixture window + edge encodings + forced cap eviction)
and by the unchanged `light-offline.test.ts` golden (real mainnet headers incl. the H4 poison vector).
No height gate needed (no behavior change).

## 0.1.33 (2026-07-03) - activation heights pulled in (no rule changes)

`V24_HEIGHT` 49,200 -> 46,400 · `V25_HEIGHT` 51,000 -> 46,440 · `V26_HEIGHT` 51,200 -> 46,480 ·
`V27_HEIGHT` 52,500 -> 46,520 (tip was ~46,071 at edit). ZERO byte-level rule changes: the same
gates activate sooner. Safe ONLY as a coordinated same-day re-pin of every verifier (cairnx svc,
mm, website vendor bundle, wallet vendored SPV, cli, clarvis) BEFORE the tip crosses 46,400 -
operator-approved private-alpha compression of the adoption windows (the wallet is being
resubmitted to CWS anyway). All recorded history (<= tip at edit) is below every new height, so
pre-gate replay stays byte-identical and the pinned conformance corpus is unaffected.

## 0.1.32: V27 young-name sale-embargo relaxation + polish (2026-07-03)
- **Consensus change (gated, non-retroactive): V27_HEIGHT = 52,500.** At an offer's anchor height >= V27 the
  young-name SALE embargo shrinks from `COMMIT_MAX_BLOCKS` (240 blocks, ~8h) to `REG_COMMIT_MAX_BLOCKS` (8
  blocks, ~16min): `saleEmbargo = ev.height >= V27_HEIGHT ? REG_COMMIT_MAX_BLOCKS : COMMIT_MAX_BLOCKS`
  (resolve.ts offer branch; mirrored in cairnx_ref.py). Provably redundant under the V25 sealed model (an
  offer requires a finalized/non-pending name, and finalize requires the displacement freeze
  `ev.height > effHeight + REG_COMMIT_MAX_BLOCKS` to have passed, so every window-valid displacer's reveal
  deadline is closed by the time any sale can exist; displacement of a finalized name is arithmetically
  impossible). Below V27: byte-identical (the 240-block rule). This is a RELAXATION, so it is a HARD ADOPTION
  GATE: every replayer (Granus, clarvis, the vendored UI/wallet bundles) MUST run 0.1.32 before the tip
  crosses 52,500, else a stale one rejects an offer the chain accepts (view divergence, no fund loss). Set
  past V26 (51,200) and the unrelated V23 nset-clear gate (also 52,000) so no two activations share a block.
  Pinned by conformance/v27-sale-embargo-crosslang.mjs (straddle, both languages) + a money-safety
  sealed-sale scenario (0 burns); non-retroactivity proven by 64/64 unchanged vectors + fuzz 1500/1500 +
  an independent old-0.1.31-vs-new-0.1.32 differential (1000/1000 byte-identical) + a live 269-event replay.
- **Behavior-preserving polish (byte-identical below AND at every prior gate; proven by the same suites):**
  the comment-truth pass (V18-V26 stale "placeholder/dormant" wording corrected to their active heights);
  `delete n.pending/finalizeBy` instead of `= undefined` (removes the one JS/Python present-undefined-vs-pop
  asymmetry); extracted `voidOpenNameOffers` (from 4 inline copies) and `earlierAnchor` (from 3 displacement
  contests); dropped a dead `isName` import; documented the tip+1 closing sweep and the
  unreachable-under-production-constants pay-now reclaim. **CONVENTION.md §5.1 A2:** documented the
  numeric-key trap CORRECTLY for BOTH hash paths. `canonicalJson` (record/payload) sorts pure code-unit
  (`"10"` before `"2"`), but `canonicalState` inherits `JSON.stringify`'s enumeration (integer-index keys
  ascending-numeric FIRST, then code-unit, so `"2"` before `"10"`). A third-party impl MUST reproduce both;
  a review caught the first draft had it inverted for canonicalState (a genuine fork trap for numeric names).
- Bumped **only** cairnx-core (0.1.31 -> 0.1.32); csd-* stay 0.1.15.
- (History note: 0.1.15-0.1.31 shipped V20-V26: late-fill fix, duration cap add/remove, nset-clear,
  length-graded fee, and the V25/V26 sealed reservation/recapture. Those bumps were logged in their plan
  docs + handoffs rather than here; this entry re-establishes the per-gate History convention.)

### 0.1.14 — quality/AI-slop pass (2026-06-20)
- **No consensus-surface or runtime-behavior change** (the forward-codec + resolver differential vs the live
  node stays at 0; all suites byte-identical). Maintainability only: corrected over-claiming consensus comments
  to name what is *guarded* vs *asserted* (resolve.ts header, records.ts onlyKeys, conformance/README META-1);
  type hygiene (`verifyInputValues` typed input, `health(): RpcHealth`, generic `getJson<T>`, `txToNodeJson():
  NodeTxJson`, `Signed.nodeJson` typed); added the `siwc` README. (Deferred: `TREASURY_ADDR` single-sourcing —
  guarded by the new consts-parity check — and the 600-line `resolve.ts` structural split.)

### 0.1.13 — security remediation (2026-06-20)
> Bytes differ from npm `0.1.12` by the entire Phase-1 remediation below — hence the version bump (M4:
> never the same version with different bytes). Published lockstep; `cairn-sdk` exact-pins this version.
- **Consensus-surface conformance hardening (no change to live acceptance, one reference correction):**
  - **C1 (reference correction):** the Python reference `cairnx_ref.py` validated the 6 schema regexes with
    `re.match(…$)`, which accepts a trailing `\n` the JS `.test(/…$/)` rejects — a latent cross-language fork.
    Changed all to `re.fullmatch`. The authoritative JS resolver already rejected these, so **no live state
    changes**; this converges the reference to the live resolver. New `conformance/crosscheck-regex.mjs`
    (regex-vs-regex differential) + a parse-gate corpus pin it.
  - **NEW-1 (PoW-limit gate):** `powOk`/`workForBits` now reject `bits` whose target is easier than
    `POW_LIMIT_BITS` (mirrors the node's `bits_within_pow_limit`). Reject-more; honest headers unaffected.
  - **NEW-2 / L10 (codec):** `deserialize` now rejects invalid UTF-8 in `domain`/`uri` (`TextDecoder fatal:true`),
    matching the node's bincode + restoring the byte round-trip. Reject-more; on-chain data is always valid UTF-8.
  - **L16:** truncated reads throw the documented "unexpected end of bytes" (not a native `RangeError`).
  - **H3 (light):** `verifyOne` enforces MTP / min-spacing / future-drift (the node's timestamp rules).
  - **H4 (light):** `fromSnapshot` re-derives LWMA for any header with a full window regardless of the
    attacker-controllable `trusted` flag; a genesis-rooted snapshot must start at the real genesis.
  - Non-consensus fund-safety/robustness: `verifyInputValues` wired via `buildSendVerified` (H2);
    `verifyDigest` fail-closed (M1); 32-byte digest enforced (L14); NaN/∞ confirmations rejected (L4);
    `EPOCH_LEN` single-sourced from `codec` (M5); SIWC zoneless-timestamp + future-skew hardening (L2/L3/L17).
- **Forward codec executed-verified** against the live `csd` node (serialize/txid/sighash/sign/header/merkle/
  bits↔target byte-identical JS == Python == Rust). The vendored bundles (`cairn/public/vendor/csd-light.js`,
  `cairn-wallet/src/vendor/cairnx-spv.js`) were rebuilt from this dist (H6).

### 0.1.6 – 0.1.11 (V16–V19 — height-gated CairnX convention bumps)
- **V16 (`V16_HEIGHT=33600`):** trade fee 1%→1.5% + maker rebate on the resting-liquidity lane (height-gated;
  pre-V16 replay byte-identical).
- **V17 (`V17_HEIGHT=34000`):** open-ask claim-to-fill (payment-free first-claim exclusivity; height-gated).
- **V18 (`V18_HEIGHT=40000`):** simplified 2-tier `.csd` name registration fee (≤4ch / ≥5ch; height-gated, dormant).
- **V19 / nprofile (`V19_HEIGHT=36700`, ACTIVE on-chain):** ENS-class inline identity (`nprofile`) — owner-gated
  profile map, last-write-wins, cleared on transfer; tip-gated materialization (pre-V19 replay byte-identical).
  JS⇄Python byte-identical over 50k+ differential cases; now wired into `test:crosslang` + CI
  (`nprofile-crosslang.mjs` with cross-impl constant PARITY + the fuzzer emits nprofile).

### 0.1.5 (unpublished lockstep — on `master`)
- **No consensus-surface changes.** `buildPropose`/`buildAttest` gained optional DvP value
  outputs (new *capability*, existing byte encodings unchanged — an attest with value outputs
  was always valid chain-side); client retries/types; light snapshots/batch. Existing vectors
  unchanged and green.
- `@inversealtruism/cairnx-core` extracted as a package. Its replay-hash contract is pinned by
  the CairnX conformance artifact (16 vectors + replay hashes) — any change to those is a
  CairnX convention version bump (activation-height gated), never a silent edit.

### 0.1.4
- **No consensus-surface changes.** Hardening only: `deserialize` MAX_TX guards (C-S1),
  chainwork u128 clamp (A-S4) — both reject-more, never accept-different; `buildSend` refuses
  >2^53 values it would previously have silently truncated (C-S2 — fail-loud on inputs that
  could never have produced a valid tx).

### 0.1.3
- **No consensus-surface changes.** u64 precision/negative guards + `canonicalJson`
  undefined/DoS guards (reject-more), merkle root normalization (0x/case — accepts equivalent
  encodings of the *same* root).

### 0.1.2
- **light**: checkpoint-start + reorg handling + full-range LWMA-45 (validated 401/401 against
  the live chain). First release where header validation is complete.

### 0.1.0–0.1.1
- Initial release of the consensus surface: codec serialization byte-identical to the Rust
  node's `golden_vectors.rs`, `CSD_SIG_V1` sighash verified against real on-chain signatures
  (67/67), SDK-built transactions accepted by the live node.

## Release checklist for a consensus-touching change

1. Land the change with updated/extended golden vectors in `csd-vectors` — never change
   behavior without a vector that pins it.
2. Bump **only the package(s) you changed** (independent cadence) — typically just `cairnx-core` for a
   consensus-height change; leave untouched packages at their current version. `workspace:*` keeps every
   inter-dep pinned to the exact published version, so the set stays coherent without lockstep bumps.
3. Add an entry here describing exactly what bytes/math changed and why.
4. Run the full suite against a live node (oracle + light full-range) before `pnpm -r publish`.

## Rollout checklist for a NEW GATE or FEE TIER (V28+)

Since the 2026-07-06 promotions, a new name-fee tier is a ONE-FILE core change; the rest is
mechanical refresh. In order:

1. Add the gate height to `packages/cairnx/src/types.ts` and, for a fee tier, add it to
   `NAME_FEE_GATES` in `packages/cairnx/src/preflight.ts` (buildFeeHeight owns the list; the
   wallet and the trade UI import it, so no hand edit exists anywhere else).
2. Vectors + conformance: extend `packages/cairnx/test/preflight.test.ts` (gate +/- margin grid),
   add the crosslang case if the change affects canonical state, re-pin replay hashes if (and
   only if) resolve() behavior changed.
3. Bump `packages/cairnx` version, `pnpm -r build`, `pnpm publish` (publish-guard enforces pnpm).
4. Re-pin the npm consumers: cairnx svc + cairn-cli package.json, `node scripts/check-consumer-pins.mjs`,
   reinstall, restart cairnx.service off-peak (never during a gate crossing).
5. Re-vendor the bundled consumers: wallet `bash scripts/build-spv-vendor.sh` +
   `node scripts/check-vendor-fresh.mjs --write`; cairn `bash scripts/build-trade-vendor.sh` +
   `node scripts/check-vendor-fresh.mjs --write`. Land these promptly: both freshness gates diff
   against csd-sdk HEAD, so their CI is red between the core merge and the re-vendor commit.
6. Grep the ecosystem for the new height as a raw literal; the only hits should be vendored
   bundles and parity-test expectation grids.
7. Purge Cloudflare for cairn (`/vendor/cairnx-core.js` + the usual .js/.css) after deploy.
