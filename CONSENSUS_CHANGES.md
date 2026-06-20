# Consensus changes

This file tracks every released change to the **byte-level consensus surface** of the SDK —
anything that alters what bytes a transaction/sighash/header serializes to, what the LWMA or
chainwork math computes, what a merkle proof accepts, or what the CairnX replay derives. If a
release is not listed here, it did not touch consensus behavior.

## Why this exists, and the rule for consumers

The packages are released in **lockstep**: every `@inversealtruism/csd-*` package (and
`@inversealtruism/cairnx-core`) is published at the **same version** in the same release, and
inter-package dependencies are published as **exact versions** (no `^`/`~` — `workspace:*` is
converted to the exact version at publish time). CI enforces the lockstep invariant
(`scripts/check-lockstep.mjs`).

**If you build on these packages, pin exact versions and keep the set uniform.** A lockfile that
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

## History

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
2. Bump **all** packages to the same new version (lockstep), even the untouched ones.
3. Add an entry here describing exactly what bytes/math changed and why.
4. Run the full suite against a live node (oracle + light full-range) before `pnpm -r publish`.
