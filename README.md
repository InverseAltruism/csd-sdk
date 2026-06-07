# csd-sdk — the developer toolkit for Compute Substrate

**Build apps, wallets, and bots on the Compute Substrate (CSD) blockchain in JavaScript or
TypeScript** — create and sign transactions, read the chain, and *verify the chain yourself*
instead of trusting whatever server you're talking to.

It works the same in Node, the browser, and a Chrome extension (no `Buffer`, only two small
audited crypto dependencies). Everything it produces is **byte-for-byte identical to the official
Rust node** — checked on every release against the node's own test vectors and against real
mainnet transactions, so a transaction you build here is one the network will accept.

```
npm i @inversealtruism/csd-codec @inversealtruism/csd-crypto @inversealtruism/csd-tx @inversealtruism/csd-client @inversealtruism/csd-light
```

## What you can do with it

```js
import { keygen } from "@inversealtruism/csd-crypto";
import { buildSend } from "@inversealtruism/csd-tx";
import { CsdClient } from "@inversealtruism/csd-client";
import { LightClient } from "@inversealtruism/csd-light";

// 1) make a key, read your coins, send some — fully client-side signing
const client = new CsdClient({ baseUrl: "https://cairn-substrate.com/api/rpc" });
const me = keygen();
const utxos = (await client.utxos(me.addr)).utxos;
const tx = buildSend({ outputs: [{ to: "0x…40", value: 100_000 }], fee: 200_000, utxos, priv: me.priv });
await client.submit(tx.nodeJson);

// 2) don't trust the server — verify your transaction is really in the chain
const light = new LightClient({ client });
const tip = await client.tip();
await light.syncFromCheckpoint(tip.height - 20, (await client.blockByHeight(tip.height - 20)).hash);
await light.sync(tip.height);
const inc = await light.verifyTxInclusion(tx.txid); // { trustLevel: "verified-inclusion", … }
```

Runnable walkthrough: [`examples/quickstart.mjs`](./examples/quickstart.mjs).

## The pieces (install only what you need)

| Package | What it gives you |
|---|---|
| **`@inversealtruism/csd-codec`** | Encode/decode transactions and block headers exactly as the chain does; transaction IDs, signing hashes, merkle proofs, and content hashing. |
| **`@inversealtruism/csd-crypto`** | Make keys and addresses; sign and verify with secp256k1 (low-S / RFC-6979, the same rules consensus enforces). |
| **`@inversealtruism/csd-tx`** | Pick coins and build ready-to-broadcast `send` / `propose` / `attest` transactions, signed locally. |
| **`@inversealtruism/csd-client`** | A typed client for reading the chain and broadcasting (point it at a node, a hosted proxy, or a gateway). |
| **`@inversealtruism/csd-light`** | A **light client**: sync block headers, check the proof-of-work and difficulty yourself, and prove a transaction is included — so an untrusted RPC can't lie to you. |
| **`@inversealtruism/csd-vectors`** | The shared test fixtures that pin every package to the official node's behaviour. |

## Why the light client matters

A normal app asks a server "is my transaction confirmed?" and believes the answer. The light
client instead downloads block headers and checks them itself: each header links to the previous
one, its proof-of-work is valid, and its difficulty is exactly what the network's rules require.
Then it proves your transaction belongs to a verified block with a merkle proof. So you get a real
answer rooted in proof-of-work — not the server's word.

**What it can and can't prove (stated plainly):**
- ✅ *Inclusion* — "this transaction is in the chain" is fully provable.
- ⚠️ *Balance* — a header chain can't prove a coin is still **unspent** (CSD headers don't commit to
  the coin set), so balance reads are marked `rpc-trusted`. Every result tells you its trust level —
  nothing is hidden behind a confident-looking number.

## Trustworthiness — tested against independent oracles

The test suite never grades its own homework. It checks the SDK against things it doesn't control:

- **47+ real signatures** made by other software and already accepted by the network verify against
  the SDK's independently-computed signing hash.
- The node's own transaction-template hashes match the SDK's, and a transaction **built by the SDK
  is accepted into the live node's mempool**.
- The light client re-derives the chain's total work from genesis and the difficulty at every block,
  and matches the node exactly — including a tamper test where a forged header is rejected.
- Real transactions survive an encode→decode→encode round-trip byte-for-byte.

```
pnpm install
pnpm -r build      # build every package
pnpm -r test       # offline conformance (set CSD_RPC=… to also run the live checks)
```

## Status & honest limits

Published on npm as `@inversealtruism/csd-*`, verified against live mainnet. The transaction +
crypto core is production-grade; the light client is a verified v1 with two known limits:

- **Syncing all history is heavy** (the node has no headers-only endpoint), so in practice start
  from a recent checkpoint with `syncFromCheckpoint` rather than from genesis.
- **Balances are `rpc-trusted`** (see above) until a future block-scan mode lands.

MIT licensed.
