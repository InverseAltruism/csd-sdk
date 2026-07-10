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
