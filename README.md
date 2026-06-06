# csd-sdk — Compute Substrate SDK + Light Client (L0)

> One canonical, golden-vector-tested toolkit for building on **Compute Substrate (CSD)** — plus a light client that turns an untrusted RPC into a locally-verified one. **L0** of the [no-fork ecosystem roadmap](../cairn/docs/ecosystem/ROADMAP.md).

Replaces the four hand-ported codec copies (`csdtx.ts` / `txcodec.ts` / `csd-signer.ts` / `txclient.ts`) with one source of truth, **byte-identical to the Rust node** (gated on golden vectors + verified against live mainnet).

## Packages

| Package | What |
|---|---|
| **`@inversealtruism/csd-codec`** | bincode (fixint-LE) serialize/deserialize · txid · sighash (`CSD_SIG_V1`) · header serialize/hash · compact-bits→target · merkle · content-addressing (`payloadHash`) |
| **`@inversealtruism/csd-crypto`** | secp256k1 keygen/sign(LOW-S, RFC6979)/verify · `hash160` address derivation |
| **`@inversealtruism/csd-tx`** | coin selection (hardened) · `buildSend`/`buildPropose`/`buildAttest` · `signTx` · node-submit JSON |
| **`@inversealtruism/csd-client`** | typed HTTP RPC client (node / Cairn proxy / discovered gateway) — read + broadcast |
| **`@inversealtruism/csd-light`** | headers-first sync · client-side **PoW + LWMA + chainwork** verification · merkle-inclusion proofs · Helios-style verified-RPC facade with an honest **`trustLevel`** |
| **`@inversealtruism/csd-vectors`** | golden conformance fixtures (the contract) — from the node's `golden_vectors.rs` + real on-chain blocks |

Zero `Buffer`, browser/MV3/Node-safe. Runtime deps: `@noble/curves`, `@noble/hashes` only.

## Trust model (honest limits)

The PoW header chain is the root of trust. The light client verifies, for every header: prev-link, valid PoW (`sha256d(header) ≤ target(bits)`), and that `bits` is exactly what the **LWMA** mandates (re-derived locally) — then follows the **max-chainwork** chain. Inclusion is provable via merkle proofs against a verified header.

What it **cannot** prove from headers alone: that an output is still **unspent** (CSD's header has no UTXO-set commitment). So balances are `rpc-trusted` unless backed by a (future) Neutrino-style block scan (`scanned`). Every read says which via `trustLevel` — never hidden. The clean fix (a TXO-accumulator header commitment) is consensus-level → **advocacy track only**.

## Conformance

`pnpm -r test` — 76 tests, gated on `@inversealtruism/csd-vectors` (golden) **and the live node**: the codec reproduces every golden vector, real on-chain txids/merkle/header-hashes, and the light client independently re-derives the node's **chainwork** from genesis.

## Dev

```
pnpm install
pnpm -r build      # tsup → ESM + CJS + d.ts per package
pnpm -r test       # conformance (CSD_RPC=http://127.0.0.1:8790 for live checks)
```

## Status / open questions

Built + tested 2026-06-07. **Not yet published to npm** — the package scope (`@inversealtruism/csd-*` chain-neutral vs `@inversealtruism/*`) needs the CSD maintainers' blessing for an official name (roadmap §9). Consumable today via workspace / `file:` deps. Next: migrate Cairn (CLI/server/console) and the wallet onto these (P0.4/0.5), then `@inversealtruism/csd-light` WASM-codec decision (P1.4).
