# @inversealtruism/csd-client

Typed HTTP RPC client for a Compute Substrate node (or the Cairn proxy / a discovered gateway): tip, block, tx, utxos, proposals, top, domains, mempool, submit, templates.

Part of the [Compute Substrate SDK](https://github.com/InverseAltruism/csd-sdk) (L0). Zero `Buffer`, runs in Node, browsers, and MV3 service workers. Deps: `@noble/*` only.

```
npm i @inversealtruism/csd-client
```

A non-2xx answer throws an `Error` whose message names the method, the path and the status, as before, and which
carries `status` and `body` (`HttpErrorFields`): the first `ERROR_BODY_MAX_BYTES` (4,096) bytes of the body as text,
decoded as UTF-8, never parsed and never logged, so a caller can tell why a node or a proxy refused a request. A 4xx
is not retried, and `submit` never is.

See the [repo README](https://github.com/InverseAltruism/csd-sdk#readme) and [examples/quickstart.mjs](https://github.com/InverseAltruism/csd-sdk/blob/master/examples/quickstart.mjs) for usage. MIT.
