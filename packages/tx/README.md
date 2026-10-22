# @inversealtruism/csd-tx

Transaction builder: hardened coin selection, buildSendVerified / buildProposeVerified / buildAttestVerified, signTx, and node-submit JSON. p2pkh, SafeInteger-guarded, change-to-self.

The Verified builders take a `verify` callback (for example `verifyInputValues` from `@inversealtruism/csd-client`) that checks each selected input's real value on chain and compute change from the verified total, so an RPC that under-reports a coin cannot burn the difference as fee. `buildSend` trusts the reported values and is deprecated.

Part of the [Compute Substrate SDK](https://github.com/InverseAltruism/csd-sdk) (L0). Zero `Buffer`, runs in Node, browsers, and MV3 service workers. Deps: `@noble/*` only.

```
npm i @inversealtruism/csd-tx
```

See the [repo README](https://github.com/InverseAltruism/csd-sdk#readme) and [examples/quickstart.mjs](https://github.com/InverseAltruism/csd-sdk/blob/master/examples/quickstart.mjs) for usage. MIT.
