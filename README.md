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

## Quickstart

```
npm i @inversealtruism/csd-codec @inversealtruism/csd-crypto @inversealtruism/csd-tx @inversealtruism/csd-client @inversealtruism/csd-light
```

```js
import { keygen } from "@inversealtruism/csd-crypto";
import { buildSend } from "@inversealtruism/csd-tx";
import { CsdClient } from "@inversealtruism/csd-client";
import { LightClient } from "@inversealtruism/csd-light";

const client = new CsdClient({ baseUrl: "https://cairn-substrate.com/api/rpc" });
const me = keygen();
const utxos = (await client.utxos(me.addr)).utxos;
const tx = buildSend({ outputs: [{ to: "0x…40", value: 100_000 }], fee: 200_000, utxos, priv: me.priv });
await client.submit(tx.nodeJson);

// verify the chain yourself — no trust in the RPC
const light = new LightClient({ client });
const tip = await client.tip();
await light.syncFromCheckpoint(tip.height - 20, (await client.blockByHeight(tip.height - 20)).hash);
await light.sync(tip.height);
const inc = await light.verifyTxInclusion(tx.txid); // { trustLevel: "verified-inclusion", … }
```

Full runnable walkthrough: [`examples/quickstart.mjs`](./examples/quickstart.mjs).

## Trust model (honest limits)

The PoW header chain is the root of trust. The light client verifies, for every header: prev-link, valid PoW (`sha256d(header) ≤ target(bits)`), and that `bits` is exactly what the **LWMA** mandates (re-derived locally) — then follows the **max-chainwork** chain (reorg-aware: a higher-work branch rolls back + replaces). Sync from **genesis** (chainwork absolute, `fullyVerified`) or from a pinned **checkpoint** (`syncFromCheckpoint` — practical, no full-history fetch; chainwork relative, `fullyVerified === false`). Inclusion is provable via merkle proofs against a verified header.

What it **cannot** prove from headers alone: that an output is still **unspent** (CSD's header has no UTXO-set commitment). So balances are `rpc-trusted` unless backed by a (future) Neutrino-style block scan (`scanned`). Every read says which via `trustLevel` — never hidden. The clean fix (a TXO-accumulator header commitment) is consensus-level → **advocacy track only**.

## Conformance

The suite is **non-self-fulfilling** — checked against independent oracles, not the SDK's own output:
- **47/47 real on-chain signatures** (created by other software, accepted by the Rust node) verify against the SDK's independently-computed sighash.
- The node's own `/tx/template` `signing_hash` + `unsigned_txid` match the SDK; an SDK-**built** tx is **accepted into the node mempool**.
- The light client independently re-derives the node's **chainwork from genesis** and the **LWMA `bits` at every block** (spot-checked across the full height range, incl. high-difficulty regimes).
- 21/21 real txs survive `serialize→deserialize→serialize` byte-identical; reorg adopt/reject + checkpoint-start verified against real blocks.

`pnpm -r test` (per-package; node-dependent suites skip cleanly) · `CSD_RPC=… pnpm test:e2e` (oracle/edge/security). CI runs the deterministic core on every push.

## Dev

```
pnpm install
pnpm -r build      # tsup → ESM + CJS + d.ts per package
pnpm -r test       # conformance (CSD_RPC=http://127.0.0.1:8790 for live checks)
```

## Status

**Published on npm** under `@inversealtruism/csd-*` (v0.1.x). Built + verified 2026-06-07 against the live mainnet node. The codec/crypto/tx/client core is production-grade; the light client is a verified v1 with the documented limits below.

### Known limits (v1)
- **Light-client full-genesis sync fetches whole blocks** (the node exposes no headers-only endpoint), so syncing all history is heavy — use `syncFromCheckpoint` in practice. A node-side `/headers/:from/:count` would make genesis sync cheap (advocacy track, non-consensus).
- **Balances are `rpc-trusted`** — a header chain can't prove non-spend (no UTXO commitment); a Neutrino-style scan (`scanned`) is future work.
- The official package scope (`@csd/*` vs `@inversealtruism/*`) is still open pending CSD-maintainer coordination.
