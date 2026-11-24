# @inversealtruism/csd-client

Typed HTTP RPC client for a Compute Substrate node (or the Cairn proxy / a discovered gateway): tip, block, tx, utxos, proposals, top, domains, mempool, submit, templates.

Part of the [Compute Substrate SDK](https://github.com/InverseAltruism/csd-sdk) (L0). Zero `Buffer`, runs in Node, browsers, and MV3 service workers. Deps: `@noble/*` only.

```
npm i @inversealtruism/csd-client
```

A non-2xx answer throws an `Error` whose message names the method, the path and the status, as before, and which
carries `status` and, when the body arrives within 1 second (or the request's remaining time, if less), `body`
(`HttpErrorFields`): the first `ERROR_BODY_MAX_BYTES` (4,096) bytes as text, decoded as UTF-8, never parsed and never
logged, so a caller can tell why a node or a proxy refused a request. A body that is late or cannot be read is not
waited for further, and the error has no `body`. A 4xx is not retried, `submit` never is, and a 5xx retried within
`retries` is retried without reading its body.

See the [repo README](https://github.com/InverseAltruism/csd-sdk#readme) and [examples/quickstart.mjs](https://github.com/InverseAltruism/csd-sdk/blob/master/examples/quickstart.mjs) for usage. MIT.
