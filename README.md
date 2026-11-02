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

// 2) don't take the server's word for inclusion: check the headers yourself, forward from a checkpoint.
//    The checkpoint is the one input the light client trusts: pin a recent block height and hash that you
//    verified yourself (your own node, or a value you audited), not one this server gave you. Headers come in
//    batches of up to 512 from a /headers endpoint; every row is checked, so the endpoint is not trusted either.
const CHECKPOINT = { height: Number(process.env.CP_HEIGHT), hash: process.env.CP_HASH };
const headersBatchProvider = async (from, count) => {
  const res = await fetch(`https://cairn-substrate.com/api/headers/${from}/${count}`);
  if (!res.ok) throw new Error(`headers ${from}+${count}: HTTP ${res.status}`); // a 429 or 502 names itself
  return (await res.json()).headers;
};
const light = new LightClient({ client, headersBatchProvider });
await light.syncFromCheckpoint(CHECKPOINT.height, CHECKPOINT.hash);
await light.sync((await client.tip()).height);
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
| `@inversealtruism/csd-light` | A light client: sync block headers from a checkpoint you pin, check the proof-of-work and difficulty yourself, and prove a transaction is included, so an inclusion above that checkpoint rests on proof-of-work, not on the RPC's word. |
| `@inversealtruism/csd-siwc` | Sign in with CSD: audience-bound, replay-resistant wallet sign-in (an EIP-4361 / CAIP-122 analogue). |
| `@inversealtruism/cairnx-core` | CairnX, the application layer: tokens, `.csd` names and trades as a pure deterministic replay of on-chain records. A fill's payment and its record share one transaction and the replay decides delivery: a CSD-paid fill it refuses keeps the payment, and a token-for-token fill is atomic. Ships the normative `CONVENTION.md`. |
| `@inversealtruism/csd-vectors` | The shared test fixtures that pin every package to the official node's behaviour. |

## Why the light client matters

A normal app asks a server "is my transaction confirmed?" and believes the answer. The light client instead
downloads block headers and checks them itself: each header links to the previous one, its proof-of-work is
valid, and its difficulty is exactly what the network's rules require. Then it proves your transaction belongs
to a verified block with a merkle proof, so the answer rests on proof-of-work rather than on the server's word.

It starts from a checkpoint (`syncFromCheckpoint`): a block height and hash it takes as given. It checks that
the headers it fetches link up to that hash, and every header after it, but nothing it fetches can vouch for the
hash itself, so pin it from a source other than the server you are checking; a server that chose the checkpoint
could also choose the chain after it. `sync` from genesis trusts only the genesis hash the SDK ships, at the
cost of fetching every header.

What it can and cannot prove:

- Inclusion: "this transaction is in the chain" is provable for any block above the checkpoint.
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

- The node serves headers only inside full blocks, so without a batch source the light client fetches one full
  block per header. Pass a `headersBatchProvider` as the example above does (a `/headers/{from}/{count}`
  endpoint such as `https://cairn-substrate.com/api/headers/{from}/{count}`, up to 512 headers a request; every
  row is still verified), and start from a recent checkpoint you verified yourself with `syncFromCheckpoint`:
  every header after the checkpoint is fetched and checked, so an old one makes a long sync.
- Balances are `rpc-trusted` (see above).

MIT licensed.
