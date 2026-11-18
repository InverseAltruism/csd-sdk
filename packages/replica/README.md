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
- `./browser` and `./server`: everything in `.`, and `nodeBlocks({ node, fetch?, paceMs?, timeoutMs? })`, a level 3
  source of complete blocks from one's own node (`/block/height/:h`), the node being the header root. `./browser`
  accepts only `localhost`, `127.0.0.1` or `[::1]`; `./server` also the private literals 10/8, 172.16/12, 192.168/16,
  100.64/10 and fc00::/7 and the hosts listed, comma-separated, in the environment variable `CAIRNX_OWN_NODE_HOSTS`,
  read once at the first use. Each entry there is a bare lowercase ASCII host name or IP literal (an IPv6 literal in
  brackets); any other entry throws `ReplicaConfigError` naming it. Any other address, or one with credentials, a
  query or a fragment, throws `ReplicaConfigError`, naming the host alone. `./browser` reads no environment and imports
  no Node built-in.

  Every request bypasses HTTP caches (cache mode `no-store`, which sends `Cache-Control: no-cache`) and refuses
  redirects, so every host read is one the address rule accepted. `timeoutMs` (default 10 s) runs from a request's
  start, after its pace wait; `paceMs` spaces request starts, across steps too; an abort ends a wait or a request at
  once (a request only at its timeout on Node before 20.3, which lacks `AbortSignal.any`) and rejects the step. A step reads the node's tip, then each block from the cursor up while its budget lasts
  (always one block; the requests count every read, the source transactions included, and the tip's header may take
  one more). Each block is bound: its header hashes to the hash served and links to the block before, its
  transactions hash to the header's merkle root (csd-light `bindBlockTxs`), and the author of each event member is
  bound with csd-crypto `authorOf` to the owner of the coin its first input spends, read from the source transaction
  after its txid is recomputed: from the block answer's `spent_tx` field when the answer carries one that hashes to
  the spent id, else from `/tx/:id`, up to four at a time. The events are cairnx-core's `blockMembers` and
  `blockEvents`. A failure ends the step before the failing block and keeps the blocks bound before it; the next step
  meets it first and is refused: `HEADER_INVALID`, `BODY_MISMATCH` (a transaction missing or added), `AUTHOR_UNBOUND`
  (an unlocking signature that is not the coin owner's, or a source transaction that does not hash to its id),
  `SOURCE_MALFORMED` (an answer out of form, or a body the rule of CONVENTION section 33 refuses),
  `SOURCE_UNAVAILABLE` (no answer, a 503, a source transaction the node does not have), `SOURCE_RATE_LIMITED` (a
  429). A Retry-After in delta seconds or an IMF-fixdate is waited, at most 300 s; any other value is ignored.

  A reorg is followed when the node's chain no longer holds the cursor's block: its tip is another block at the
  cursor's height, the block above the cursor does not link to it, or its tip is below the cursor and is not the block
  the store holds there. The step is then a reorg to the highest held block the node's chain still holds, found by a
  search over the held blocks (galloping down from the top, then bisecting) of at most 2 * ceil(log2(n + 1)) block
  reads for n held blocks, kept across steps when a step's requests run out (that step is `SOURCE_RATE_LIMITED` with
  no wait); with no held block on the node's chain, a reorg to the floor. A node behind the cursor on the chain the
  store holds is `SOURCE_UNAVAILABLE`, nothing rolled back. A node that holds the cursor's block while the block above
  does not link to it, or that serves another block at its tip height than its `/tip` names, is `SOURCE_MALFORMED`.
  `BRANCH_MOVED` remains only for a chain that moved below the floor.

  `readBlocks({ source, from, to, authors, rule?, signal? })`, in `.` with `SourceError`, yields each block from
  `from` to `to` bound and linked to the one before, as a `BoundBlock` with the authors of `authors` bound: `"none"`,
  `"all"` (every transaction but the coinbase) or `"members"` (each Propose in the rule's domain and each Attest). It
  throws `SourceError`, `BRANCH_MOVED` for a block that does not link to the one before.
- `./testing`: `fixtureSource(fixture)`, a level 1 source over a recorded block fixture such as cairnx-core's
  `test/fixtures/events-blocks.json` in this repository, and the event factories `fixtures()`.

ESM only, `sideEffects: false`. `@inversealtruism/cairnx-core` is a peer dependency, so a process runs one `resolve()`.
