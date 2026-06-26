# @inversealtruism/csd-codec

bincode codec (serialize/deserialize), txid, sighash (CSD_SIG_V1), header serialize/hash, compact-bits↔target, merkle proofs, content-addressing. Byte-identical to the Rust node (golden-vector + live-chain gated).

Part of the [Compute Substrate SDK](https://github.com/InverseAltruism/csd-sdk) (L0). Zero `Buffer`, runs in Node, browsers, and MV3 service workers. Deps: `@noble/*` only.

```
npm i @inversealtruism/csd-codec
```

See the [repo README](https://github.com/InverseAltruism/csd-sdk#readme) and [examples/quickstart.mjs](https://github.com/InverseAltruism/csd-sdk/blob/master/examples/quickstart.mjs) for usage. MIT.
