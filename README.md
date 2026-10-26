# csd-sdk: the developer toolkit for Compute Substrate

Build dapps, wallets, bots and more on Compute Substrate in JavaScript or TypeScript: create and sign
transactions, read the chain, and verify the chain yourself instead of trusting whatever server you are
talking to.

It works the same in Node, the browser, and a Chrome extension (no `Buffer`, only two small audited crypto
dependencies). Everything it produces is byte-for-byte identical to the official Rust node, checked on every
release against the node's own test vectors and against real mainnet transactions, so a transaction you build
here is one the network will accept.

```
npm i @inversealtruism/csd-codec @inversealtruism/csd-crypto @inversealtruism/csd-tx @inversealtruism/csd-client @inversealtruism/csd-light
```

> Pin exact versions and keep the set uniform. The packages are versioned independently, and every change to
> the byte-level consensus surface is recorded in [`CONSENSUS_CHANGES.md`](./CONSENSUS_CHANGES.md): read it
> before upgrading, and never let a lockfile resolve two different `csd-codec` versions under different
> packages.

## What you can do with it

```js
import { keygen } from "@inversealtruism/csd-crypto";
import { buildSendVerified } from "@inversealtruism/csd-tx";
import { CsdClient, verifyInputValues } from "@inversealtruism/csd-client";
import { LightClient } from "@inversealtruism/csd-light";

// 1) make a key, read your coins, send some; signing happens on your machine
const client = new CsdClient({ baseUrl: "https://cairn-substrate.com/api/rpc" });
const me = keygen();
const { utxos } = await client.utxos(me.addr);
const tx = await buildSendVerified({
  outputs: [{ to: "0x…40", value: 100_000 }], fee: 200_000, utxos, priv: me.priv,
  verify: (inputs) => verifyInputValues(client, inputs), // checks each input's real value on chain
});
if (!tx.ok) throw new Error(tx.error);
await client.submitOrThrow(tx.nodeJson); // throws if the node rejects the transaction

// 2) don't trust the server: verify your transaction is really in the chain
const light = new LightClient({ client });
const tip = await client.tip();
await light.syncFromCheckpoint(tip.height - 20, (await client.blockByHeight(tip.height - 20)).hash);
await light.sync(tip.height);
const inc = await light.verifyTxInclusion(tx.txid); // { trustLevel: "verified-inclusion", … }
```

Use `buildSendVerified`, not `buildSend`. A CSD fee is whatever the inputs hold above the outputs, so a builder
that trusts the coin values an RPC reports can be made to compute too little change and burn the difference
as fee. `buildSendVerified` fetches each selected input's source transaction, recomputes its txid, and computes
change from the verified values; if any input cannot be verified it returns `{ ok: false }` and signs nothing.
`buildSend` is deprecated for that reason. The same applies to `buildProposeVerified` and `buildAttestVerified`.

`client.submit()` returns `{ ok: false, err }` when the node rejects a transaction (with a `txid` still filled
in), so check `ok` or use `submitOrThrow`.

Runnable walkthrough (read-only, it never broadcasts): [`examples/quickstart.mjs`](./examples/quickstart.mjs).

## The pieces (install only what you need)

| Package | What it gives you |
|---|---|
| `@inversealtruism/csd-codec` | Encode and decode transactions and block headers exactly as the chain does; transaction IDs, signing hashes, merkle proofs, and content hashing. |
| `@inversealtruism/csd-crypto` | Make keys and addresses; sign and verify with secp256k1 (low-S, RFC 6979, the same rules consensus enforces). |
| `@inversealtruism/csd-tx` | Pick coins and build ready-to-broadcast `send`, `propose` and `attest` transactions, signed locally. |
| `@inversealtruism/csd-client` | A typed client for reading the chain and broadcasting (point it at a node, a hosted proxy, or a gateway), plus `verifyInputValues`. |
| `@inversealtruism/csd-light` | A light client: sync block headers, check the proof-of-work and difficulty yourself, and prove a transaction is included, so an untrusted RPC cannot lie to you. |
| `@inversealtruism/csd-siwc` | Sign in with CSD: audience-bound, replay-resistant wallet sign-in (an EIP-4361 / CAIP-122 analogue). |
| `@inversealtruism/cairnx-core` | CairnX, the application layer: tokens, `.csd` names and atomic delivery-versus-payment trades as a pure deterministic replay of on-chain records. Ships the normative `CONVENTION.md`. |
| `@inversealtruism/csd-vectors` | The shared test fixtures that pin every package to the official node's behaviour. |

## Why the light client matters

A normal app asks a server "is my transaction confirmed?" and believes the answer. The light client instead
downloads block headers and checks them itself: each header links to the previous one, its proof-of-work is
valid, and its difficulty is exactly what the network's rules require. Then it proves your transaction belongs
to a verified block with a merkle proof, so the answer rests on proof-of-work rather than on the server's word.

What it can and cannot prove:

- Inclusion: "this transaction is in the chain" is fully provable.
- Balance: a header chain cannot prove a coin is still unspent (CSD headers do not commit to the coin set), so
  balance reads are marked `rpc-trusted`. Every result carries its trust level.

## Tested against independent oracles

The test suite checks the SDK against things it does not control:

- Real signatures made by other software and already accepted by the network verify against the SDK's
  independently computed signing hash.
- The signing hash and unsigned txid the node computes for a transaction template match the SDK's.
- The light client re-derives the chain's total work from genesis and the difficulty at every block, and
  matches the node exactly, including a tamper test where a forged header is rejected.
- Real transactions survive an encode, decode, encode round trip byte for byte.

```
pnpm install
pnpm -r build                      # build every package
pnpm test                          # offline conformance suites
CSD_RPC=<node url> pnpm test:live  # the live checks above, against a node you choose
```

## Limits

Published on npm as `@inversealtruism/*`, verified against live mainnet. The light client has two known limits:

- The node serves headers only inside full blocks, so syncing all of history block by block is slow. Pass a
  `headersBatchProvider` (for example one that reads a `/headers/{from}/{count}` endpoint such as
  `https://cairn-substrate.com/api/headers/{from}/{count}`; every row is still verified), or start from a
  recent checkpoint with `syncFromCheckpoint`.
- Balances are `rpc-trusted` (see above).

MIT licensed.
