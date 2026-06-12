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
