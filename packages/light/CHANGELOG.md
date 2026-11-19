# Changelog

Releases before 0.1.27 are recorded in the repo's `CONSENSUS_CHANGES.md`.

## 0.1.27

- `bindBlockTxs`, and with it `bindBlockBody` and `LightClient.verifyTxInclusion`, refuses as `body-mismatch` a
  served transaction that is not in the node's text form: an input's `prev_txid` or `script_sig`, an output's
  `script_pubkey`, a Propose's `payload_hash` or an Attest's `proposal_id` that is not `0x` and lower-case hex, or an
  app type other than exactly `None`, `Propose` or `Attest`. The reason names the transaction's position and the field.
  The codec reads such a field without `0x` or in upper case to the same bytes, and `rpcTxToTx` rebuilds any other app
  type as an Attest, so the body still matched the verified merkle root.
- The node's own bodies are unaffected: it writes every one of these fields as `0x` and lower-case hex, and all 486
  recorded node blocks in this repo bind byte-identically before and after. Txids, sighashes, `rpcTxToTx`, the codec
  and the transaction builders are unchanged.
- For consumers that read `payloadHash` or `proposalId` (or `appPayloadHash`, or an address) of a bound transaction as
  text and compare it with a `0x` lower-case value: under 0.1.26 a block source could serve that field in another
  spelling, the bind passed, and the comparison silently dropped the record (a name transfer, an offer cancel, a
  competing claim). From 0.1.27 such a read fails the bind instead, on the path a consumer already takes for a body
  that does not match its header. A bundled copy (the site's and the wallet's vendored builds) gets this only when it
  is rebuilt from 0.1.27.
