# Changelog

## 0.1.0 (unreleased)

- The basis of a store (`display`, `feed`, `blocks` on an own-node, anchor or caller root, `pinned` over blocks only),
  `checkBasis`, `levelOf`, `proofOf` and `basisKey`; the source, step and store types; `NOT_VERIFIED_CODES` and
  `NOTE_CODES`; `memoryStore()`.
- `./testing`: `fixtureSource` over a recorded block fixture and the event factories `fixtures()`.
- Internal: `replicaLoop`, which drives a source into a store (each step checked against the contract and refused
  whole as `SOURCE_MALFORMED` when it breaks it, committed whole with a compare of the cursor, a reorg rolled back, a
  failing source backed off) and `advance()`; `fullReplay`, the only way to a resolved state, from rows read back and
  checked against the contract, their events hash and their rows hash first. The order of CONVENTION section 33.3 is
  cairnx-core's `applyOrder` and `eventId`, re-exported, the comparator `resolve()` sorts with.
- `BlockRow.rowsHash` and `StoreMeta.rowsHash`: a running sha256 over each row's full content, so a stored row
  changed in a field the events hash does not cover is refused. `memoryStore` refuses a commit whose meta does not
  carry the events hash and rows hash of the last row held after it.
- `Boundary.stateHash` is null for a boundary more than 24 epochs below the tip as it became deep;
  `Loop.boundary(height)` replays one on demand.
- `./browser` and `./server` with `nodeBlocks`, complete blocks from one's own node bound to its headers, their authors
  bound with csd-crypto `authorOf` (from the block answer's `spent_tx` field when it hashes to the spent id, else
  `/tx/:id`). Every request bypasses HTTP caches and refuses redirects; request budgets, pacing across steps, a timeout
  from each request's start, aborts that reject the step; a failure mid-step keeps the blocks bound before it;
  Retry-After on a 429 or a 503, at most 300 s. Reorgs of the node are followed by a search over the held blocks that
  resumes across steps, to the floor when none is on the node's chain; a node behind the cursor on the same chain rolls
  nothing back. The address rule of each entry, with `CAIRNX_OWN_NODE_HOSTS` on a server, parsed strictly. `readBlocks`,
  `BoundBlock`, `BlocksSource` and `SourceError`. Dependencies: csd-client, csd-codec, csd-crypto and csd-light.
- The loop takes a source's Retry-After up to 300 s and ignores one that is not a finite number >= 0.
