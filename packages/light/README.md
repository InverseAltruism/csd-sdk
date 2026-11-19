# @inversealtruism/csd-light

Light client: headers-first sync with client-side PoW + LWMA + chainwork verification, merkle-inclusion proofs, reorg + checkpoint-start, and a verified-RPC facade with an honest trustLevel.

Part of the [Compute Substrate SDK](https://github.com/InverseAltruism/csd-sdk) (L0). Zero `Buffer`, runs in Node, browsers, and MV3 service workers. Deps: `@noble/*` only.

```
npm i @inversealtruism/csd-light
```

`bindBlockBody` and `bindBlockTxs` bind a served block body to a header you verified: every txid is re-derived from
its body, a repeated txid is refused, the set must hash to the header's merkle root, and every transaction must be
served as the node writes it (its `txid` field the id its body hashes to; each hash, address and script `0x` and
lower-case hex; the app type `None`, `Propose` or `Attest`), else the result is `body-mismatch`. `verifyTxInclusion`
runs through the same bind.

See the [repo README](https://github.com/InverseAltruism/csd-sdk#readme) and [examples/quickstart.mjs](https://github.com/InverseAltruism/csd-sdk/blob/master/examples/quickstart.mjs) for usage. MIT.
