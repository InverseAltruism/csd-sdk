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

  `hostedBlocks({ origin, root, fetch?, paceMs?, timeoutMs? })`, in `./browser` and `./server`, is a level 3 source
  of complete blocks from a server it does not trust, our front door at `origin` (an http or https URL without
  credentials, query or fragment): `/api/rpc/tip`, `/api/blocks/:from/:count`, `/api/headers/:from/:count` and
  `/api/rpc/tx/:id`, with the HTTP rules above. The server's `/api/rpc/tip` only says how far to try to read: it
  travels as the step's `reach`, which the loop uses to take another step, and never as a tip. The tip a step
  reports (height, hash and header time) is the highest header the anchor root's window verified. `root` is where
  the headers come from:

  - `{ kind: "anchor", anchor, window? }`: headers the source verifies itself with csd-light, seeded with the 45
    headers ending at `anchor` (workRoot), which must lie at or below the activation height less one
    (`BELOW_FLOOR`); the seed is kept only once it verifies, so a wrong seed answer is read again. Then each header
    is checked for its link, time rules, LWMA bits and proof of work. The window holds the last 45 + `window`
    headers (default 720), never dropping the store's cursor below the 45 a branch needs, and counts `work` from
    workRoot. When a page does not link, or the server's tip is another block at a height the window holds, the
    server's headers from the window's lowest forkable block to 256 above its tip are read: a branch from inside the
    window is csd-light's `tryReorg`, adopted only with more work (else `LESS_WORK`, nothing rolled back), and the
    store rolls back to its fork block. A branch from lower is verified from workRoot: a fresh window from the same
    seed walks the server's headers to the cursor and on until it has more work than the held window (a tie keeps
    the held chain; at the server's tip without more work, `LESS_WORK`, kept until the server's tip moves),
    comparing the hash of each held block it passes, and is adopted at the highest held block on its chain, where
    the store rolls back. A header above workRoot that names another parent is `PIN_OFF_CHAIN`. A reorg found on a
    later page of a step drops the blocks the step bound above the fork; a rollback the store did not commit is
    returned again. A server whose tip is below the cursor on the chain held, or below the window, is
    `SOURCE_UNAVAILABLE`, nothing rolled back.

    The walk from workRoot reads at least one batch of 512 headers a step and stops at the step's request budget or
    deadline; a walk that fails is dropped and starts afresh. While it runs, each step it does not finish is
    `SOURCE_RATE_LIMITED` with no wait: an `advance()` ends after that step, `status()` shows that code with the
    cursor unchanged, and the next `advance()` goes on. From the anchor at 29,859 to a tip of 144,460 that is 224
    batches, about 26 steps at 10 requests a step (arithmetic, not measured). It holds a second window of 45 +
    `window` headers beside the first and the 45 of the seed: with the default window, 1,575 headers, about 1.5 MB
    at 974 bytes a header object (design section 9).

  A step reads the server's tip, then pages from the cursor up while its budget lasts (always one page). A page is
  the route's whole aligned 64 when all of it lies at or below that height, so that an edge cache can serve every
  reader the same URLs. With `maxBlocks` of 64 or more a step that spans pages ends on a page's last block and no
  page is read twice; with fewer, a page is read once by each step that needs it. A page refused for what it holds
  (a block that does not link or verify, a body that does not bind) is read once more from the first block not
  bound, with a fresh query parameter, and only that answer is refused; `readBlocks` over the source re-reads a
  block the same way. Blocks bound before a refusal are kept. The route does not yet carry `spent_tx`, so each
  member's source transaction is one `/api/rpc/tx/:id` read. No pace is set by default: a 429 is waited per its
  Retry-After.

  What the hosted route must keep for this source: it ignores unknown query parameters, and any cache in front of
  it keys on the whole URL, query included, so the fresh re-read reaches the origin. Neither is checked by the
  source.

  What a store must keep (not yet done; the disk and browser stores' slices): the window, `work` and `workRoot`.
  Until a store persists them, a source started over a filled store has no held work: it walks from workRoot to the
  store's cursor and adopts any chain from the anchor, valid in proof of work, that reaches the cursor's height,
  rolling back to the highest held block on it. A running source never does this. The store needs a channel to take
  `work`, `workRoot` and the window with a commit (`StoreMeta.work`, `workRoot`, `windowSha256` and
  `Commit.headerWindow` exist, but the `Source` interface cannot hand them over) and to give them back at open, and
  the design's rule then applies: a confirmed store keeps its work, and only an unconfirmed one reads its window
  again from the root under `STORE_UNCONFIRMED`, earning `witnessed` again.

  `readBlocks({ source, from, to, authors, rule?, signal? })`, in `.` with `SourceError`, yields each block from
  `from` to `to` bound and linked to the one before, as a `BoundBlock` with the authors of `authors` bound: `"none"`,
  `"all"` (every transaction but the coinbase) or `"members"` (each Propose in the rule's domain and each Attest). It
  throws `SourceError`, `BRANCH_MOVED` for a block that does not link to the one before.
- `./testing`: `fixtureSource(fixture)`, a level 1 source over a recorded block fixture such as cairnx-core's
  `test/fixtures/events-blocks.json` in this repository, and the event factories `fixtures()`.

ESM only, `sideEffects: false`. `@inversealtruism/cairnx-core` is a peer dependency, so a process runs one `resolve()`.
