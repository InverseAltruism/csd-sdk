# Changelog

Releases before 0.1.27 are recorded in the repo's `CONSENSUS_CHANGES.md`.

## 0.1.28

- Docs: the README says what the client checks for every header and what it does not establish alone, that the
  chain it holds is the heaviest one that exists: the LWMA rule lowers the difficulty of a branch timed at its longest
  counted solvetime, so a sole header source can serve a valid branch with less work. The source comments that said a
  server "cannot feed a low-difficulty fork" say this instead. The README no longer names a "verified-RPC facade",
  which the package does not export. No code changes.
- `engines.node` is `>=22`, as csd-client's. A block body is read with csd-client's `parseJsonExact`, which keeps an
  integer above 2^53 - 1 exact only where `JSON.parse` hands its reviver the source text (Node 22 and later here; 18
  and 20 lack it). On an older Node a block holding such a value (a Propose's `expires_epoch`, which the node does
  not bound, or an output value) fails closed: `bindBlockBody` refuses it as `malformed`, and `verifyTxInclusion`
  refuses every transaction in it. npm only warns about `engines` (unless the consumer sets `engine-strict`), so the
  install still succeeds there.
- Docs: the README and the JSDoc of `checkpoints`, `seedTrusted` and `tryReorg` say what a checkpoint holds against a
  reorg. A seed's top (`syncFromCheckpoint`, `seedTrusted`) is checked once when it is seeded and is pinned only when
  `checkpoints` also lists it; without that entry `tryReorg` replaces it with a heavier branch forking below it. A
  branch through a checkpoint is refused; a branch ending below one never meets it and is adopted on work alone, so a
  reorg below a checkpoint needs more work than the whole chain it replaces. `test/light-offline.test.ts`
  ("checkpoints and tryReorg") pins the three cases. No code changes.
- Pins `@inversealtruism/csd-codec` 0.1.19 and `@inversealtruism/csd-client` 0.1.21 (a non-2xx error carries its
  status and, when it arrives within 1 second, its body).

## 0.1.27

- `bindBlockTxs`, and with it `bindBlockBody` and `LightClient.verifyTxInclusion`, refuses as `body-mismatch` a
  served transaction that is not as the node writes it: a `txid` field that is absent or is not exactly the id its
  body hashes to (`0x` and lower-case hex), an input's `prev_txid` or `script_sig`, an output's `script_pubkey`, a
  Propose's `payload_hash` or an Attest's `proposal_id` that is not `0x` and lower-case hex, or an app type other than
  exactly `None`, `Propose` or `Attest`. The reason names the transaction's position and the field. No hash commits
  the `txid` field, the codec reads a hex field without `0x` or in upper case to the same bytes, and `rpcTxToTx`
  rebuilds any other app type as an Attest, so such a body still matched the verified merkle root, and
  `verifyTxInclusion` returned the served JSON, so a body that kept a transaction's bytes and replaced its `txid`
  field was proven with the replaced id in `result.tx.txid`. A bound transaction's `json.txid` now equals its
  `txid`. Keys outside `RpcTxJson` are still passed through as served and are committed by nothing.
- The node's own bodies are unaffected: it writes every transaction's `txid` and every one of these fields as `0x`
  and lower-case hex, and all 486 recorded node blocks in this repo (576 transactions, each with its `txid`) bind
  byte-identically before and after. Txids, sighashes, `rpcTxToTx`, the codec
  and the transaction builders are unchanged.
- For consumers that read `payloadHash` or `proposalId` (or `appPayloadHash`, an address, or the returned `txid`) of a
  bound transaction as text and compare it with a `0x` lower-case value: under 0.1.26 a block source could serve that field in another
  spelling, the bind passed, and the comparison silently dropped the record (a name transfer, an offer cancel, a
  competing claim). From 0.1.27 such a read fails the bind instead, on the path a consumer already takes for a body
  that does not match its header. A bundled copy (the site's and the wallet's vendored builds) gets this only when it
  is rebuilt from 0.1.27.
