# @inversealtruism/csd-light

Light client: headers-first sync with client-side PoW, LWMA and chainwork verification, merkle-inclusion proofs, reorg
and checkpoint start; its inclusion and balance reads carry a `trustLevel`.

Part of the [Compute Substrate SDK](https://github.com/InverseAltruism/csd-sdk) (L0). Zero `Buffer`, runs in Node, browsers, and MV3 service workers. Deps: `@noble/*` only.

```
npm i @inversealtruism/csd-light
```

## What the client checks

For every header it is given, `LightClient` checks that it links to its parent; that its time follows the node's rules
(at least 60 seconds after its parent, above the median of the 11 times before it, at most 2 hours ahead of this
clock); that its `bits` are those the LWMA rule demands from the 45 headers before it; and that its hash meets those
bits within the proof-of-work limit. Of the branches it is given it follows the one with the most chainwork
(`tryReorg` replaces the chain it holds with a heavier branch).

It does not establish alone that the chain it holds is the heaviest one that exists. The LWMA rule lowers the
difficulty of a branch whose headers are timed at the longest solvetime it counts (12 x 120 seconds), so a server that
answers every header request can serve a branch that passes every check above and carries less work. From the
difficulty of block 143,000 such a branch reaches the proof-of-work limit after 80 blocks, 32 hours of header time, so
it forks from a block about 30 hours old (a time may run 2 hours ahead of the clock); getting there costs about 4.6
blocks of the real chain's work, and from there a block costs about one 58-millionth of a real one.
`verifyTxInclusion` then answers `verified-inclusion` for a transaction in that branch when the same server serves its
block. What exists around it:

- `checkpoints` pin block hashes at heights: a header at a pinned height must match, so a branch through one is
  refused; `@inversealtruism/csd-anchors` publishes such a table (an entry is a checkpoint, not a proof of work). The
  top of a seed (`syncFromCheckpoint`, `seedTrusted`) is checked once when it is seeded and is pinned only when its
  height and hash are also in `checkpoints`; without that entry `tryReorg` replaces it with a heavier branch forking
  below it. A branch that forks below a pinned height and ends below it never meets the pin, so `tryReorg` adopts it
  only when it carries more work than the whole chain it replaces, the blocks above the pin included (the node's own
  rule, with no checkpoint);
- a second header source that the first does not control, its headers offered through `tryReorg`, which follows the
  heavier branch;
- cairnx-replica compares the chain it holds with independent witnesses and marks its state `NOT_WITNESSED` until one
  confirms it.

Node 22 or later (`engines`): see csd-client's README for the exact 64-bit parsing a block body needs; on an older
Node a block holding an integer above 2^53 - 1 fails to bind (`malformed`).

## Block bodies

`bindBlockBody` and `bindBlockTxs` bind a served block body to a header you verified: every txid is re-derived from
its body, a repeated txid is refused, the set must hash to the header's merkle root, and every transaction must be
served as the node writes it (its `txid` field the id its body hashes to; each hash, address and script `0x` and
lower-case hex; the app type `None`, `Propose` or `Attest`), else the result is `body-mismatch`. `verifyTxInclusion`
runs through the same bind.

See the [repo README](https://github.com/InverseAltruism/csd-sdk#readme) and [examples/quickstart.mjs](https://github.com/InverseAltruism/csd-sdk/blob/master/examples/quickstart.mjs) for usage. MIT.
