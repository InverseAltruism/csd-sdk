# @inversealtruism/cairnx-replica

A CairnX replica: the chain's records, read from a source, kept in a store and replayed by
`@inversealtruism/cairnx-core`. Not yet released. Each store is filled from one basis, fixed when it is created, and the
level of every answer (CairnX `CONVENTION.md` section 37) is a function of that basis alone:

| Basis | Level | Proof of each record |
|---|---|---|
| `display`: someone's API | 1 | `served` |
| `feed`: a list of records, complete on its word | 1, or 2 with `inclusion` | `served` or `inclusion` |
| `blocks`: complete blocks bound to headers from one's own node, an anchor or the caller's headers | 3 | `inclusion` |
| `pinned`: a release's log below its pin, `blocks` above it | 3 | `pinned` |

Only blocks sit above a pin: a pin over a feed does not compile, and `checkBasis`, `levelOf`, `proofOf` and `basisKey`
throw `ReplicaConfigError` for one at run time. `basisKey` names a store without its pin, so a newer pin over the same
root and bodies names the same store.

- `.`: the types, `NOT_VERIFIED_CODES`, `NOTE_CODES`, `checkBasis`, `levelOf`, `proofOf`, `basisKey`, `memoryStore()`.
  The interfaces documented as internal (`Source`, `Step`, `StepContext`, `Store`, `Commit`, `Materializer`, the store
  records) and the loop (`replicaLoop`, `fullReplay`) are unstable and outside semver.

The loop takes one step of its source at a time. A step is refused whole, as `SOURCE_MALFORMED`, unless its blocks
ascend above the cursor and lie at or above the activation height, each event sits at its block's height in the
order of CONVENTION section 33.3, no event id is held already, every Attest is on a held Propose or one of its block,
and the cursor is at or above the last block. A step that keeps the contract is committed whole with two running
values after each row, kept in the row and the store's meta: the events hash (CONVENTION section 34.2), over each
event's height, position, id and author, and the rows hash, sha256 over the canonical JSON of the row's height, block
hash and events in stored order, chained from the value before it. No resolved state is stored: after a restart the
rows are read back and checked against the contract and both values before any is replayed, so a row changed in any
field, dropped, added or moved makes the store `corrupt`.

Each epoch boundary `FINAL_DEPTH` deep keeps its block hash and events hash. Its state hash costs a full replay, so it
is computed only for a boundary at most 720 blocks (24 epochs) below the tip when it becomes deep: a catch-up to a tip
that holds still replays at most 24 boundaries, then one per epoch as the tip moves. An older boundary's state hash is
replayed on demand.
- `./testing`: `fixtureSource(fixture)`, a level 1 source over a recorded block fixture such as cairnx-core's
  `test/fixtures/events-blocks.json` in this repository, and the event factories `fixtures()`.

ESM only, `sideEffects: false`. `@inversealtruism/cairnx-core` is a peer dependency, so a process runs one `resolve()`.
