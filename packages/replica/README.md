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
root and bodies names the same store, which is kept only on the conditions of "Pins" below.

- `.`: the types, `NOT_VERIFIED_CODES`, `NOTE_CODES`, `checkBasis`, `levelOf`, `proofOf`, `basisKey`, `memoryStore()`,
  the reader, `open` and `openLog` ("Reading" below), `checkPin` and `pinned` ("Pins" below), `nameHistory` and
  `appliedIds` ("A csd-indexer feed" below), and the resolver's five state reads with `leaseInfo` and
  `nameDetailsOf` ("The resolver's reads" below).
- `./display`: a page that shows a name or a balance from our API at level 1 ("Display" below). It does not load
  `resolve()` or the block machinery.
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
- `./server` also has `diskStore({ dir })` ("The disk store" below), `ownNode({ node, dir, pin?, witness? })`
  ("One's own node on disk" below), `indexerFeed`, `Scanner` and `branchRefusal` ("A csd-indexer feed" below) and
  `replicaReads` with `WITHHELD`, `withheldBy` and `READ_HEADERS` ("The resolver's reads" below); `./browser` has `idbStore({ name, slot })` and `sessionSlot(key)` ("The browser
  store" below).
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
  reports (height, hash and header time) is one header the root vouches for: under an anchor root the highest
  header the window verified, under a caller root the caller's verified tip. `root` is where the headers come from:

  - `{ kind: "anchor", anchor, window? }`: headers the source verifies itself with csd-light, seeded with the 45
    headers ending at `anchor` (workRoot), which must lie at or below the activation height less one
    (`BELOW_FLOOR`); the seed is kept only once it verifies, so a wrong seed answer is read again. Then each header
    is checked for its link, time rules, LWMA bits and proof of work. The window holds the last 45 + `window`
    headers (default 720), never dropping the store's cursor below the 45 a branch needs, and counts `work` from
    workRoot. When a page does not link, or the server's tip is another block at a height the window holds, the
    server's headers from the window's lowest forkable block to 256 above its tip are read (an answer that fails
    verification is read once more past caches): a branch from inside the window is csd-light's `tryReorg`, adopted
    only with more work (else `LESS_WORK`, nothing rolled back), and the store rolls back to its fork block, or to the
    activation height less one when the fork lies below it. A branch from lower is verified from workRoot: a fresh window from the same
    seed walks the server's headers to the cursor and on until it has more work than the held window (a tie keeps
    the held chain; at the server's tip without more work, `LESS_WORK`, kept until the server's tip moves),
    comparing the hash of each held block it passes, and is adopted at the highest held block on its chain, where
    the store rolls back. A header above workRoot that names another parent is `PIN_OFF_CHAIN`. A reorg found on a
    later page of a step drops the blocks the step bound above the fork and returns the rollback. Until the store's
    cursor is back on the window's chain, the rollback is returned before anything is read from the server, and the
    tip reported, by a step or by `tip()`, is the fork block, the highest block known to lie on both chains. A server whose tip is below the cursor on the chain held, or below the window, is
    `SOURCE_UNAVAILABLE`, nothing rolled back.

    The walk from workRoot reads at least one batch of 512 headers a step and stops at the step's request budget or
    deadline. A walk whose headers fail verification is dropped and starts afresh; after a transport error (a
    rejected fetch, a timeout) it resumes where it stopped. While it runs, each step it does not finish is
    `SOURCE_RATE_LIMITED` with no wait: an `advance()` ends after that step, `status()` shows that code with the
    cursor unchanged, and the next `advance()` goes on. From the anchor at 29,859 to a tip of 144,460 that is 224
    batches, about 26 steps at 10 requests a step (arithmetic, not measured). It holds a second window of 45 +
    `window` headers beside the first and the 45 of the seed: with the default window, 1,575 headers, about 1.5 MB
    at 974 bytes a header object (design section 9).
  - `{ kind: "caller", headers }`: a `VerifiedHeaders` (`floor`, `origin`, `sync`, `at`, `offer?`) the caller keeps.
    Each step syncs it to the server's tip (`SOURCE_UNAVAILABLE` when `sync` answers null, `BELOW_FLOOR` when `floor`
    lies above the activation height less one) and asks `at` for the cursor's hash. Another hash starts the search
    over the held blocks that `nodeBlocks` uses, with `at` in place of block reads, so it ends within the step, and
    the rollback lands on a held hash. The search probes only heights `at` answers, and places a fork only where it
    answered another hash: when no held block it answers for is on its chain and it lacks some, the step is
    `SOURCE_UNAVAILABLE`, not a rollback to the floor. No header at the cursor while the caller's tip is at or above
    it is `SOURCE_UNAVAILABLE`, never a rollback. A step reads to the lower of the caller's tip and the server's. Each
    page's headers are given to `offer` when it is present, after `sync`, both with the server's unverified tip
    height; what `offer` answers is not read, and every block must hash to `at` at its height. So `offer` saves the
    caller's own header reads only when its `sync` skips what an earlier offer already gave it.

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

  What a store must keep: under an anchor root, the source's header window, so that a source started over a filled
  store (a server restarted, an extension's worker woken) does not walk the headers from the anchor again. Each commit
  of blocks carries the window's headers up to the step's cursor (the lowest height in 4 bytes, then 84 bytes a
  header: with the default window 765 headers, 64,264 bytes) and sets `StoreMeta.work`, the work above workRoot at
  the stored window's top, and `workRoot`; a rollback carries none, and the stored window stays, so its top can lie
  above the cursor. The disk and browser stores name the window by its digest in their record; the open does not
  read the window, and `headerWindow()` gives nothing when the bytes it reads are missing or not the record's, so a
  window damaged at rest costs the walk, not a refill. A window file a cut commit left behind, which the record does
  not name, is removed at the disk store's next open. A `headerWindow()` that rejects is taken as no window. The source's first step takes the stored window instead of reading the seed, once it holds together:
  `workRoot` is this source's anchor (a store kept from an older pin keeps that pin's window, which is not taken);
  csd-light verifies the headers again as far as it can without the ones below them (the first 45 for links and
  proof of work, each later one for its link, time rules, LWMA bits and proof of work); and the window holds the
  cursor's block at or above its lowest forkable height. It is then rewound to the cursor, and above it the source
  reads only the new blocks' pages. Taken from the record without a check: the first 45 headers' bits, `work`, and
  that the window descends from `workRoot`. Verifying 486 recorded headers again took 14.83 ms (median of 9, Node 26 on the maintainers' host,
  2026-11-21). A window that fails any check is dropped, never refused: the source walks from workRoot as with no
  window, to the store's cursor and with no work to beat, adopting any chain from the anchor, valid in proof of work,
  that reaches the cursor's height, and rolling back to the highest held block on it (`test/hosted-window.test.ts`).
  A taken window's work is the bar another chain must beat, as for a running source, so a store on a branch the
  server no longer serves rolls back only to a heavier one (`test/hosted-work.test.ts`). A browser store whose slot
  does not name its record is reset, its window with it, and refilled under `STORE_UNCONFIRMED`. Under a caller root
  nothing is kept: the headers are the caller's. A boundary's stored state hash is not checked at open; a pinned
  source's bind replays its own ("Pins" below).

  `readBlocks({ source, from, to, authors, rule?, signal? })`, in `.` with `SourceError`, yields each block from
  `from` to `to` bound and linked to the one before, as a `BoundBlock` with the authors of `authors` bound: `"none"`,
  `"all"` (every transaction but the coinbase) or `"members"` (each Propose in the rule's domain and each Attest). It
  throws `SourceError`, `BRANCH_MOVED` for a block that does not link to the one before.
- `nodeWitness({ node, fetch? })` and `hostedWitness({ origin, fetch? })`, in `./browser` and `./server`: witnesses for
  the reader (below), a node's `/tip` and `/block/height/:h`, or our front door's `/api/rpc/tip` and
  `/api/headers/:h/1`. A witness vouches for no record, so any http or https address without credentials, query or
  fragment is accepted. Neither reports a gate table.
- `./testing`: `fixtureSource(fixture)`, a level 1 source over a recorded block fixture such as cairnx-core's
  `test/fixtures/events-blocks.json` in this repository, and the event factories `fixtures()`.

## Reading

`open({ source, store?, witnesses?, core?, clock? })` returns a `Reader` over one source and one store (default
`memoryStore()`): `name(name)`, `balance(ticker, address)`, `primary(address)`, `state()` (a copy of the deep view), `events(after)`,
`transfers(address, since)` ("Transfers" below), `dryRun(tx, author)`,
`status()`, `subscribe(fn)`, `advance({ budgetMs?, signal? })` and `close()`. `openLog({ rule, ... })` is the same loop
for another rule's events (CONVENTION section 35.2) and gives `events` and the status only, with no resolved state.
`advance()` runs the loop until it is caught up and asks every witness for its tip meanwhile. A read starts an advance
when none is running and the last ended at least `READ_ADVANCE_MS` (15 seconds, the hosted resolver's default poll)
before by `clock()`, a clock set back counting as that time passed, so a burst of reads polls the source at most once
in it; it waits for the advance running at most `waitMs` (default 0: it answers from what is held); a call of
`advance()` while a run is in flight joins that run, and the status it returns can then come from a round begun before
the call. A read waits for the advance it started and for a step's commit in flight together at most `waitMs`
(counted from the read, or until its signal aborts). It answers from the state the last whole commit left, or, while a
commit is still in flight when that bound passes, `NOT_SYNCED` with the detail "a step's commit is in flight" and
nothing shown; `status()` answers the same during a commit. A store whose commit never settles leaves `advance()`
pending: that is the store's failure, and reads still answer within their bound. Nothing runs on a timer: the caller
drives `advance()` or reads.

Each answer is `{ verified: true, value }` or `{ verified: false, value: null, shown }`, with `why` (the codes below),
`notes`, `level`, `proof`, `vouch` (the basis) and `at` (the tip, the deep height `tip - minDepth` the value is read
at, and the depth). A caller that gates value on an answer reads `value` and acts only when `verified` is true;
`shown` is for display. The deep view is the state at `tip - minDepth`; `minDepth` defaults to cairnx-core's
`FINAL_DEPTH` (12), the depth replicas compare at, which is not a depth that makes a payment safe: a caller crediting
value chooses its own. `balance`, `state` and `events` answer the deep view; `balance` adds `atTip` when the balance at
the tip differs. `name` and `primary` answer `SHALLOW` when the deep view and the tip view differ, the tip view in
`shown`.

`name(name)` is cairnx-core's `nameView` (CONVENTION section 35.4) over the deep view: `state` (`held`, `pending`,
`lapsed`, `free` when absent, `reserved`), `owner` (the reserver of a pending name, the last owner of a lapsed one),
`addr` and `profile` (a held name's only) and `paidThroughEpoch`. The replica restates none of that rule. A verified
`free`, `pending` or `lapsed` is as true as a verified `held`: the verdict is about the replica, not the name. The
name is asked as `names` writes it: a caller lowercases its input and drops a `.csd` suffix first (CONVENTION
section 35.4), since any string that does not match `NAME_RE` is `INPUT_INVALID`; cairnx-core exports no normalizer to
reuse. `constructor` and other prototype keys are names like any other (`nameView` tests for an own key). `addr` is
where a payment to the name goes, and a sender refuses a lapsed name's; `profile` is display data, never a send
target (CONVENTION section 36.3). `events` pages in the order of CONVENTION section 33.3 from an exclusive cursor (`limit`
default 100, at most 1,000); its `next` does not pass the deep height, also on an empty page. The cursor is the one
`transfers` takes ("Transfers" below), opaque to a caller: it names the event a page ended on, and the next page
resumes after that event in the apply order, where a block's Proposes precede its Attests whatever their positions. A
stored `events` cursor of the earlier `height:pos` form is `INPUT_INVALID`.

An answer is verified only when every condition holds. Each failed one adds its code, in this order:

| Code | The condition that failed |
|---|---|
| `INPUT_INVALID` | the read's input is well formed (a name matching `NAME_RE`, an address, a ticker in upper case, a cursor that a read handed out, `limit`, `minDepth` from 0 to the tip's height); this code comes alone, with nothing shown |
| `LEVEL_DISPLAY`, `LEVEL_FEED` | the basis gives level 3 |
| `RULES_DIFFER` | the gate tables agree at or below the tip: the one this package was built against, the loaded cairnx-core's, a caller's `core` whose `resolve` is another function, and any table a witness reports; under a pin, also the pin's table at or below its height |
| `PIN_MISMATCH`, `PIN_OFF_CHAIN` | under a pinned basis: the source has not refused its pin ("Pins" below). The source keeps the refusal, so the code stays for the life of the source |
| `NOT_SYNCED` | the store is open and the loop holds a cursor and the tip of a step (the next four are read only then) |
| `BEHIND` | the cursor is not below the tip |
| `BRANCH_UNRESOLVED` | the cursor is not above the tip. It is while a rollback is owed under an anchor root, and while a caller's headers end below the store's cursor on the same chain: the caller root then reports the caller's tip, since its headers no longer vouch for the blocks above it |
| `TIP_STALE` | the tip's header time is at most 30 minutes before the clock; for a source that serves final blocks only (`FINAL_VIEW`), 30 minutes plus 12 target block times (24 minutes) |
| `TIP_BEHIND_PEER` | no witness named a higher tip whose header hashes to the hash it named and meets its own bits (csd-light `tipHeaderPowOk`), however far ahead |
| `NOT_WITNESSED`, `WITNESS_SILENT` | for an anchor or caller root: a witness confirmed the chain the replica holds within the last 30 minutes. A witness with tip W is compared at h, the lower of W and the replica's cursor, only when the higher of the two is at most 12 above h; it confirms when it gives the hash the replica holds at h, from its tip or by `hashAt`. The loop keeps the block hashes of its cursor and the 12 heights below it from the blocks its steps carried (13 entries at most, emptied whenever the chain held is replaced), so every h within the bound has a hash once the loop has stepped past it; until then (after a restart, a reload or a rollback) a witness that cannot be compared voids the confirmation. The confirmation is stamped with the time the witness answered. It is void when the chain held is replaced (a rollback, a reload from the store, a reset), when a witness answers another hash at h, and when the clock reads earlier than it read before. None, or void: `NOT_WITNESSED`; older than 30 minutes: `WITNESS_SILENT` |
| `STORE_UNCONFIRMED` | the store was not reset as unconfirmed since the loop last reached a step's tip ("The browser store" below): it is set from that reset until the refill's step reaches the tip |
| `SHALLOW` | `name` and `primary`: the deep view and the tip view agree |
| `CURSOR_OFF_BRANCH` | `events` and `transfers`: the events hash in the cursor is the replica's at the cursor's height; nothing is shown |

The tip is the one the loop's last step reported, a header the root vouches for, never `Source.tip()`. Every clock is
`clock()` (default `Date.now`). Notes: `TWO_CORES` (a caller's cairnx-core is a second module with the same gate
table), `SOURCES_DISAGREE` (a witness gave another hash at the height it was compared; or, with its `detail` naming
the boundary, the store's source disagrees with a recount and a reference that agree, "Tuples and a reference"),
`WITNESS_MALFORMED` (a witness answered its tip or its gate table out of form, and was taken as silent),
`FINAL_VIEW` (the source serves final blocks only, so its tip is its final height, 12 below the chain tip it read,
by design: a csd-indexer feed with `verifyInclusion`; `BEHIND` then counts from that tip),
`PEER_FAR_AHEAD` (a witness named a tip more than 12 above the replica's whose header meets its own bits; `TIP_BEHIND_PEER`
is set with it), `TIP_STALE_LONG` (the tip's header time is more than `STALE_MAX_MS`, 6 hours, before the clock, plus
the 24 minutes of a `FINAL_VIEW`; `TIP_STALE` is set with it),
`CURSOR_ABOVE_TIP` (an `events` or
`transfers` cursor above the replica's), `STORE_UNAVAILABLE` (the store threw at open, or another process or context
holds it; the note's `detail` names why from a fixed list: another process or context holds it, it refuses its
directory, a read or write failed, or a reset it needed failed, the browser store's unconfirmed reset included; the
store's own message, which holds paths, is not put in an answer). `status()` also carries `storeReason` and
`storeError`, that message in full: it is for the server's own logs and is not forwarded to clients, since it can hold
paths. `PIN_DISPUTED` and the notes `TUPLE_BRANCH`, `TUPLE_RECORDS`, `TUPLE_RULES` and `DIVERGENCE_CONFIRMED` come from
a reference ("Tuples and a reference" below). Exported and not emitted yet: `UNSUPPORTED` and `REPLAY_SLOW`. `LEVEL_DISPLAY` and `SOURCE_UNAVAILABLE` come only from
`./display` (a display basis is refused by `open`).

A witness can withhold `verified` and cannot grant it against another's word: one witness that names a higher tip
with a valid header, gives another hash at the compared height, or cannot yet be compared within 12 blocks of the
cursor, makes every answer unverified while it does. A witness more than 12 blocks below the cursor (or above it)
neither confirms nor contradicts. A caller
that sees `TIP_BEHIND_PEER` or `SOURCES_DISAGREE` from one witness alone reads `shown`, and drops or replaces that
witness when it believes it lies; nothing in the reader decides that for it. `hostedWitness` and `nodeWitness` report
no gate table, so `RULES_DIFFER` compares the local tables (built and loaded) and the tables of witnesses that the
caller writes itself with `rules`; a witness on our front door can confirm a replica whose rules differ from the
front door's without that showing.

The clock rule has a cost: one clock read earlier than the one before (a set-back of any size) makes every answer
under an anchor or caller root `NOT_WITNESSED` until the next witness round confirms again.

No value a read returns shares a mutable object with the reader: the basis every answer carries as `vouch` is frozen,
and `events()` pages, `state()` and `status()`'s cursor, last reorg and last error are copies (a page of 1,000 events
cost about 2 ms to copy in Node on this host, 2026-11-19).

The confirmation lives in memory. After a restart (a new `open` over a filled store) no answer under an anchor or
caller root is verified until a witness answers again: `NOT_SYNCED` and `NOT_WITNESSED` before the first advance,
`NOT_WITNESSED` while the witnesses are silent. The store's meta keeps no confirmation (`StoreMeta.witnessed` is
written null).

`BUILT_GATES`, the gate table this package was built against, is compared with the loaded cairnx-core's. A cairnx-core
that adds a gate is answered as before below that gate's height and `RULES_DIFFER` from it on, until this package is
rebuilt and released against it; every new gate therefore needs a release of the replica before its height.

`open` throws `ReplicaConfigError` for a basis `checkBasis` refuses; a display basis; a basis that cannot give every
event from activation (`code` `BELOW_FLOOR`: an anchor above the activation height less one, or a caller's floor
above it, or above the pin under one); and a witness on the header source's origin (the front door's under an
anchor root, the caller's `origin` under a caller root). A store that opens refused for its format, rule, basis or
rows is reset and filled again, except a store filled under an older pin that a newer one keeps ("Pins" below).

`dryRun({ app, outputs }, author)` replays every event held with `tx` (a Propose or an Attest, its outputs as
cairnx-core's event rule reads them, so a fee or a payment can be tried) in the block above the cursor, and answers
whether it applies, with the code and note of the applied log; a transaction the event rule does not take (another
domain, an author out of form) is `INPUT_INVALID`. It changes nothing the replica holds. It reads the tip view and takes
no `minDepth`; its `at` is the cursor it was tried above, which is the tip at depth 0 when the replica is synced (behind
the tip, or with the tip below the cursor, `at` still names the cursor). `snapshot()` is the tip view at depth 0, the
lower of the cursor and the tip, with every event held up to it, both from one commit and frozen; `at` names the
view's block, and two snapshots with one `key` are one object. It is what a server answers the resolver's reads from
("The resolver's reads" below). `local({ node, pin?, fetch? })`,
in `./browser` and `./server`, is what `open` takes for one's own node held in memory: `nodeBlocks` under that entry's
address rule, above `pin` when one is given ("Pins" below), and `memoryStore()`.

What the reader keeps beyond its store's rows: under an anchor root the source's header window, with every commit ("What a
store must keep" above); the witness's confirmation lives in memory, except in the browser store's kept view ("The
browser store" below).

## Transfers

`transfers(address, since, { ticker?, limit?, minDepth?, waitMs?, signal? })` answers the token moves to `address` in
the deep view, narrowed to `ticker` when given; with `address` null and a ticker, every move of that ticker. Each row is
one move of cairnx-core's applied log (CONVENTION section 41) and nothing else, so no rule that decides an amount (a
mint's cap, a whole or partial fill's delivery, the fee) is restated here: `txid`, `height`, `pos`, `leg` (`mint`,
`xfer`, `sale`, `fee` or `fill`), `ticker`, `deployId` (the deep view's `tokens[ticker].deployId`), `from` (null for a
mint), `to`, `amount` (base units, a decimal string), `memo` (the memo of the entry's own record, null when it has none;
a fill is an Attest and carries no record) and the entry's `code`. A refused record moves nothing and gives no row, so
`applied` is always `true`; a caller that shows refused attempts reads the applied log in `state()`. A memo is the
sender's text as its record holds it: at most 64 UTF-16 units, possibly empty (`""`), and it can hold U+0000, control
characters and direction overrides; a server stores it as bytes or escaped, and never lets it fail a credit.

Rows come by height, then transaction position (not the apply order of CONVENTION section 33.3, where a block's
Proposes precede its Attests), from the exclusive cursor `since` (null for the first page). A page holds whole entries:
at most `limit` rows (default 100, at most 1,000), more only when its first entry alone has more (a fill writes at most
three moves). Each page walks the deep view's log once in memory and returns at most that page.

The cursor is `height:pos:eventsHash`, the same as `events`', and opaque to a caller: the position of the page's last
entry, or, on the last page, the deep height and the largest position (a position that names no held event at that
height, other than the largest, is `INPUT_INVALID`), so `next` does not pass the deep height, also on an empty page, unless `since` already did (it is
then kept). The events hash is the replica's
running hash at that height (CONVENTION section 34.2), over every event at or below it. The moves at or below a height
follow from the events at or below it, so while that hash is the replica's, every row before the cursor is still the
chain's and no row the caller has not read lies at or below it: a reorg above the cursor changes nothing a caller has
read, and one that keeps every event below it keeps the cursor. When the events below the cursor changed (a reorg
deeper than the caller's `minDepth`), the read answers `CURSOR_OFF_BRANCH` with nothing shown, rather than read on from
a position on a branch it no longer holds. A cursor above the replica's cursor cannot be compared yet: an empty page
that keeps it, noted `CURSOR_ABOVE_TIP`.

Any replica of the same chain computes the same events hash, so a stored cursor stays valid across a restart of the
replica (which answers `NOT_SYNCED` or `BEHIND` until it has read to the tip again) and across a change of replica. The
cursor binds the events, not the rules that turn them into moves: a cairnx-core release that changed what an older
entry's moves report would not refuse a stored cursor, and such a release says so in cairnx-core's CHANGELOG.

A server crediting deposits from its own node is `examples/deposits.ts` in this repository: `openReplica` (`open` over
`ownNode`, the store on disk, so a restart reads on from the stored cursor), `creditDeposits` (each verified page
credited once by the key `(txid, leg)`, its cursor stored with its credits in one transaction, `CURSOR_OFF_BRANCH`
raised to the operator) and `recover` (below). `test/deposits.test.ts` runs it over the recorded node across a
restart, a 20-block reorg while running and one while closed, and a newer pin; `test/deposits-recover.test.ts` stops
`recover` at each of its steps and runs the server again; `test/transfers-reorg.test.ts` runs the two calls over a
memory store at two depths.

```ts
import { PIN } from "@inversealtruism/cairnx-pin";
import { creditDeposits, openReplica } from "./deposits";   // examples/deposits.ts
const replica = await openReplica({ node: "http://127.0.0.1:8789", dir: "/var/lib/deposits/replica", pin: PIN });
for (const address of addresses) await creditDeposits(replica, db, address, { minDepth: MIN_DEPTH, pinned: PINNED });
```

What `transfers` gives that server: each move to its address once across pages, only from a verified answer, only at
`minDepth` or deeper, and a refusal instead of a silent skip when the chain below its cursor changed. What it must still
do itself:

- Pin the deploy id of each token it credits (`PINNED` above): a ticker names one token in one replay, but a replay of
  another chain can bind it to another deploy (CONVENTION section 41).
- Choose `minDepth` for value. The default, `FINAL_DEPTH` (12), is the depth replicas compare at; a row is credited only
  once it is that deep, and a reorg deeper than it can still take back a credited row.
- Store `next` with its credits in one transaction, only from a verified answer (`shown` carries a page too), and keep
  `(txid, leg)` unique: one entry can move two legs to one address. Store a memo as bytes or escaped, so that a
  database refusing U+0000 in text does not stop the address.
- Drive the replica: nothing runs on a timer, and a read with the default `waitMs` of 0 answers from what is held.
- On `CURSOR_OFF_BRANCH`: rows it credited may be gone and rows it has not seen may lie below its cursor. Retrying
  answers the same code while the replica holds that branch, so an address stuck on it credits nothing until the
  server recovers it. It keeps its earlier cursors and takes the newest one the read still accepts (verified, not
  `CURSOR_OFF_BRANCH`; null when none is) as the start. It reads the pages after the start without writing, then, in
  one transaction, raises each credit written after the transaction that stored the start (not compared by height:
  a page's cursor lies below the deep height its answer was read at) that the pages do not give, and stores the start
  as the cursor; then it reads on crediting by the unique key. Until that transaction nothing it stores has moved, so
  a recovery stopped anywhere runs again over the same range. A credit raised so is not at `minDepth` or deeper on the
  branch the replica holds: it may be gone, or mined again in a block not yet that deep, in which case a later page
  offers it again and the key refuses a second credit; the raise is for the operator to look at, not to reverse a
  credit on. A credit offered again with another amount has changed under its key; that goes to the operator too. A
  capped mint's amount (the remaining supply before it) and a partial fill's (the offer's fills
  before it) can change under one `(txid, leg)`, which `test/transfers.test.ts` shows. A transfer's, a sale's and a
  fee's do not, by the core's code (read, not tested here): a transfer moves its record's amount, a sale the price of
  the offer the fill names, a fee that offer's fee on it (`resolve/tokens.ts`, `resolve/attest.ts` in cairnx-core). The
  example's `recover` is that recovery.

## Pins

A pin is a release's log of one rule's events at or below an epoch boundary, so a new replica reads only the blocks
above it. Below the pin the trust is the release. A `Pin` carries `format` 1, the `rule`, the `height` (a multiple of
`EPOCH_LEN`), the `blockHash` there, the log's `logSha256`, the `eventsHash` and `stateHash` at the height, the gate
table cut at the height (`gates`), the cairnx-core version that cut it (`core`, information only) and `log()`, the
log's bytes: the UTF-8 canonical JSON of the event list in the order of CONVENTION section 33.3. `checkPin` checks the
form; `derivePin(fixture)` in `./server` derives a pin and its log from a recorded block fixture (cairnx-core's
`test/fixtures/events-blocks.json` format) through `fixtureSource` and the loop, reading nothing else.

`pinned({ pin, then })`, in `.`, is a source of the log and then of `then`, a block source, above the pin; its basis is
`pinned` over `then`'s, level 3, proof `pinned`. `open` and `openLog` throw `ReplicaConfigError` with code
`PIN_MISMATCH` for a pin of another rule than the store's. The first step checks, before anything is committed and in
this order: the log's sha256 (`PIN_MISMATCH`); that it is the canonical JSON of an event list keeping the loop's
contract at or below the pin (`PIN_MISMATCH`); its events hash (`PIN_MISMATCH`); the gate table against the loaded
core's at or below the pin (`RULES_DIFFER`); its state hash, replayed with `resolve` (`PIN_MISMATCH`). It then takes
`then`'s step from the pin, whose root checks the pin's block hash: one's own node must link the block above to it,
an anchor root's seed must end at it, a caller's headers must hold it. A reorg, or a chain that does not hold the
pin's block, is `PIN_OFF_CHAIN`; a root whose tip is below the pin is `SOURCE_UNAVAILABLE`, nothing committed. Under
an anchor root a header above the pin that names another parent is `HEADER_INVALID` while the window still starts at
the pin, and `PIN_OFF_CHAIN` once the window has moved up. The log's rows and that step are committed together, so the log loads in one step:
at the newest boundary on 2026-11-21 (143,340) that is 1,486 events, 711,379 bytes, and in Node a sha256 of 5.8 ms,
a parse of 2.4 ms, a canonical re-encode of 10.2 ms, an events hash of 13.5 ms and a replay with the state hash of
43.5 ms (medians of five runs), before the loop's own replay. No size is refused. Loading in steps would not shorten
it, since no row counts before the whole log's sha256, events hash and state hash hold; when to revisit is under
"Limits" in "One's own node on disk" below. Later steps go to `then`; a reorg
below the pin, or to its height with another hash, is `PIN_OFF_CHAIN`. A node that moves to a branch forking below the
pin whose tip is still below the pin's height reads as behind the cursor (`SOURCE_UNAVAILABLE`), so the answer stays
as it was until `TIP_STALE`, and is `PIN_OFF_CHAIN` once that tip reaches the pin's height. A refusal of the pin is
the answer to every later step of that source, so a later step cannot clear it, and the answers carry its code in
`why`. A store reopened under the same basis (the pin's height and block hash and the log's `logSha256`) is bound to
the descriptor once per source without reading the log: the block hash, the events hash, the digest of the stored
events at or below the pin (payloadHash, so their content, which the events hash does not cover, must give the
`logSha256`) and the state hash at the pin must be the descriptor's (`PIN_MISMATCH`), and its gate table the loaded
core's at or below the pin (`RULES_DIFFER`). The state hash is replayed from the stored rows, never read from the pin's
boundary, which a store can hold wrong. Under `openLog`, which holds no state, no state hash is compared. The log's bytes and its contract are not checked again then: the stored rows were
checked against the contract and their own running hashes when they were read back.

A store reopened under another basis is reset, with one exception: a store filled under an older pin is kept under a
newer one when both are pinned with one `basisKey` (the same root and bodies), the new pin lies above the old, the
store's cursor is at or above the new pin, and the stored rows give the new pin's block hash, events hash and log
digest; the bind above then replays the state hash at the new pin (`PIN_MISMATCH` when it is not the pin's). A kept store answers without reading the new log
and records the new pin with its next commit. Every other change resets it and refills from the new log: an older pin,
another log at the same height, a cursor below the new pin, rows that give another value at it, another node or body
origin, an anchor root in place of one's own node, a feed's or an unpinned store (`test/disk-pins.test.ts`).

What the checks prove: they tie the log to its descriptor and the descriptor's block to the header chain, not the
log's content to the chain. A descriptor recomputed for another log (an event removed, changed or added) is accepted,
by design: below the pin the trust is the release, and a second derivation on another host is the check on it.

`hosted({ pin, origin, witness?, store?, fetch?, paceMs?, timeoutMs?, window? })`, in `./browser` and `./server`, is
what `open` takes for a page reading our hosted blocks: `pinned` over `hostedBlocks` at `origin` (required) with the
pin as its anchor, `store` (default `memoryStore()`; an extension passes `idbStore`), and the witness, without which no answer is verified (`NOT_WITNESSED`). Under an
anchor root the seed proves only that the server's headers pass through the pin; that the branch is the heaviest is
the witness's to confirm.

## The disk store

`diskStore({ dir })`, in `./server`, keeps a store in `dir`, an absolute path on a local filesystem (created with mode
700 at open; a relative path, or one that is a file or cannot be created, throws `ReplicaConfigError`). Pass it as
`store` to `open` or `openLog`. Files: `meta.json` (the store's tag and format, the meta without `witnessed`, the
committed lengths of the two row files, the chain over the boundaries and the window's digest), `rows.jsonl` and
`bounds.jsonl` (one row or boundary a line, appended), `window-<digest>.bin` and `lock`. These are the only names it
writes or removes: other files and directories in `dir` are left alone, and a `meta.json` another program wrote makes
`open` throw `ReplicaConfigError` naming it, with nothing removed. Give the store a directory of its own all the same:
a file named `lock` is taken for a lease (and moved aside once it has gone 20 s untouched), and a `meta.json` that is not JSON for
the store's own damaged meta, replaced at the next reset. Two processes of different configuration (another node,
pin or rule) on one directory can reset each other's store whenever the lease changes hands. A commit appends at the committed lengths, syncs
each file, then writes the new meta to a temporary file, syncs it, renames it over `meta.json` and syncs the
directory; a rollback is that rename alone. While one holder's directory syncs return, nothing is written below the
lengths of a meta that can be on disk, so a kill at any point leaves a whole commit, the one before or the one after
(`test/disk-kill.test.ts` kills a process at every point of a 20-commit sequence with a rollback, 266 times, every extend
carrying a header window, and each store opens with the window of the meta it opened with); the
order of the syncs, which a kill cannot show, is what carries this past a power loss (`test/disk-store.test.ts`). An
extend after a rollback whose directory sync did not land, or a refill after a reset cut short, can leave files that
open `corrupt`; the store is then refilled, as for any file that fails its checks.

At open, in order: the format, the rule, the basis and the gate table the rows were written under (another table at or
below the cursor resets the store, reason `rule`); then the files (a file shorter than its committed length, a line
out of form, a boundary chain other than the meta's: `corrupt`, and the reader resets and refills; the header window
is checked where it is read, "What a store must keep" above);
then the loop's checks of every row against the contract and both running hashes, and under a pin the bind above. A
store refused for any reason but `unavailable` is reset and refilled whenever the reader loads it, also when it first
found the store held by another process. The checks prove that the files agree with each other, not where they came
from: rows above a pin, and every row without one, are not compared with the chain at open, so a consistent edit of
them passes. For a server that credits deposits from the replica, the directory is as sensitive as its table of
credits. Do not use a store someone else wrote.

One process writes a directory at a time, by a lease on `lock`: the holder touches it every 5 s, and one not touched
for 20 s is stale and taken over. While another process holds it, `open` is `unavailable` (the answers carry
`NOT_SYNCED` and the note `STORE_UNAVAILABLE`) and the next advance tries again. A holder whose lease was taken
over while it waited between commits fails its next commit and writes nothing; one stopped after that commit's check
of its lease finishes the commit over the taker's files, and the store then opens `corrupt` and is refilled. The package installs no signal handler: a server calls `close()` at
shutdown, which releases the lease; after a crash the next start waits until the lease is stale.

## One's own node on disk

`ownNode({ node, dir, pin?, witness?, fetch?, paceMs?, timeoutMs? })`, in `./server`, is what `open` takes for a
server's replica of its own node kept across restarts: the source of `local` (`nodeBlocks` at `node` under the
server's address rule, above `pin` when one is given; the caller imports the pin, from `@inversealtruism/cairnx-pin`
for ours), `diskStore({ dir })`, the witness when one is given, and a step budget of 512 blocks and 600 requests in
place of the loop's 64 and 10, since every commit on disk costs its syncs. A node outside the rule or a relative `dir`
throws `ReplicaConfigError`, and `open` throws it for a `dir` that is a file or cannot be created; a lock another
process holds, or a disk error at open, is `NOT_SYNCED` with the note `STORE_UNAVAILABLE`, tried again at the next
advance.

```ts
import { PIN } from "@inversealtruism/cairnx-pin";
import { hostedWitness, open, ownNode } from "@inversealtruism/cairnx-replica/server";
const replica = await open(ownNode({ node: "http://127.0.0.1:8789", dir: "/var/lib/deposits/replica", pin: PIN,
  witness: hostedWitness({ origin: "https://cairn-substrate.com" }) }));   // the witness line is optional
```

No witness is set unless the caller names one: the package asks no host the caller did not name. One's own node is
the header root, so its answers need no witness to be verified. A witness on another origin only withholds
`verified`: it adds `TIP_BEHIND_PEER` when it names a higher tip with a valid header (one's node is behind,
or on a branch the witness does not follow) and the note `SOURCES_DISAGREE` when it holds another block at the height
compared.

A day of blocks (720) above a pin, read through `open` on a disk store from a node serving the recorded capture to
30,300 and blocks holding 30,300's transactions above it: with `ownNode`'s budget 2 steps and 2 commits, the advance
0.34 to 0.39 s; with `local`'s source over the same `diskStore` (the loop's budget) 81 steps and 81 commits, 2.42 to
2.45 s (three runs each, Node 26 on this host, 2026-11-21).

Limits: the pin's log loads in one step ("Pins" above). Revisit that when a first step takes over 5 s on a server or
a browser store's transaction is found too large; the answer then is a resumable replay context and a log fetched by
its hash, not steps.

## A csd-indexer feed

`indexerFeed(options)`, in `./server` only, is a source over the CairnX resolver's Scanner, which reads the cairnx:v1
proposals and attestations a csd-indexer serves; `options` are the Scanner's (`ScanOptions`: `indexerUrl`, `fetch`,
`timeoutMs`, page sizes, and for `verifyInclusion` the header merkle, raw transaction and verified tip reads). Its
basis is a feed: level 1, or 2 with `verifyInclusion`, where each payment's transaction is bound to its txid and
merkle-proven against the caller's header source and each record's fields and author come from the node's body. The
Scanner checks no proof of work, so that level is as good as the header source the caller wires.

Each step is one scan. A scan whose tip block changed during the pull, or whose hash could not be read before and
after it, is `BRANCH_MOVED` (`branchRefusal`), tried again at the next step. The rule's events are those at or above
its activation, an Attest only on a Propose among them (CONVENTION section 33.1). Up to the lower of the cursor and the
scan's top they are compared with the store by their events hash; where they differ the step is a reorg to the last
event block whose events hash agrees (section 34.3). The cursor's block is off the indexer's chain when the indexer's
tip is below the cursor or the indexer gives another hash at the cursor's height; then the step is a reorg to the lower
of that block and the last held boundary whose hash the indexer gives, never below the floor, and the next step reads
on to the indexer's tip. So a shorter branch that changes only block hashes is followed, at any tip, a held boundary's
height included, and so is one above the final height under `verifyInclusion`; an indexer whose tip drops on one
chain (a rebuild) rolls the store back the same way, as the hosted resolver's published state drops with it. An
indexer whose tip is under the floor names no block a rollback could end on: the step is idle with that tip, below the
cursor (the reader's `BRANCH_UNRESOLVED`), until its tip reaches the floor again. A final height that moves back below
the cursor with the cursor's block still the indexer's is no reorg: the step is idle until it passes the cursor
again. The events above the cursor are
the step's blocks, by height in the order of section 33.3, with a row at each epoch boundary carrying the block hash
the indexer's `/block-height` gives. The cursor is the last block the scan answered for whole: the indexer's tip, or
with `verifyInclusion` the final height (the verified tip less `confDepth`; the Scanner emits nothing above it). A step
whose request or block budget runs out ends at the last boundary it read, with the tip as its reach. A step's tip is
the block at the scan's top with its header time from the indexer's `/block/<hash>` (an answer that does not name
that block at that height with a whole number of seconds is `SOURCE_MALFORMED`): the indexer's tip, or with
`verifyInclusion` the final height, the highest block the Scanner emits for, so every answer carries the note
`FINAL_VIEW` and `BEHIND` means behind what the feed can serve. `Source.tip()` reads the indexer's tip, or with
`verifyInclusion` gives the last step's. Neither changes the level, which a feed caps at 2. Each step's scan reads the
whole domain the first time and the indexer's chain-order feeds after it; the scan is not cut short by the step's
signal.

The Scanner and `nameHistory`, the resolver's name-history selector (`.`), come from the private CairnX resolver
byte for byte apart from import paths, then cleaned under review; `appliedIds` (`.`) is the set of ids a replay
applied, which the resolver passes to `nameHistory` as `fullApplied`. `scripts/move-residual.mjs <resolver git dir>
<commit>` prints what differs from the resolver's copy, file by file, and says "code identical" for a file whose
tokens, comments, whitespace and import paths aside, are the resolver's. The resolver's hash tuple book is not moved:
the loop's boundaries are this package's book ("Tuples and a reference" below). The `F4:` that starts some of the Scanner's thrown messages (a failed output, height or body binding
with `verifyInclusion`) is a stable prefix: the resolver serves these messages and its tests match it.

Who runs the scan, by design: an outside replica's feed owns its Scanner and scans in each step, and a hosted resolver
runs its own scan, publishes from it and writes a store after publication, off that path. A loop whose store cannot
commit (held by another process, broken, or a full disk) backs off for up to 300 seconds and takes no step, so a
service that published through its loop would stop publishing on a full disk; the feed therefore does not expose its
scan for a host to publish from.

## The resolver's reads

`readState`, `readName`, `readResolve`, `readNameHistory` and `readProfile` (`.`) are the CairnX resolver's answers of
`/cairnx/state`, `/cairnx/name/<name>`, `/cairnx/resolve/<name>`, `/cairnx/name-history/<name>` and
`/cairnx/profile/<name>`: pure functions of a `ReadSnapshot` (a state, `canonical` and `history`, the derivations a
host memoizes) to a status and the exact body text, taken from the resolver with their code unchanged (`leaseInfo` and
`nameDetailsOf` with them). They load only cairnx-core: no file, process, network, clock or setting, and no import at
run time (`test/handlers.test.ts`). A 404 is theirs alone: a name that is not registered.

`replicaReads(reader, { waitMs? })` in `./server` answers those five paths from `reader.snapshot()`, the tip view: a
function of a URL's pathname to `{ status, headers, body }`, or null for any other path. On the same state its
statuses and bodies are the resolver's (on cairnx-core's recorded fixture to 117,000, every name's four routes and the
state, 0 differ, `test/read-routes.test.ts`); the canonical state, the applied ids and each name's history (at most
1,024) are kept while the snapshot's key holds. The headers are the resolver's (`content-type`
`application/json; charset=utf-8`, `access-control-allow-origin: *`, `x-content-type-options: nosniff`) with the
server's own verdict: `x-cairnx-at` (`<height>:<hash>` of the view's block), `x-cairnx-why` (the verdict's codes,
comma-separated, empty when verified) and `x-cairnx-notes` (its notes' codes, comma-separated, empty when none), all
three named in `access-control-expose-headers` so a page on another origin can read them, on a 503 too. The bodies carry no level: over HTTP every answer is level 1 to its reader. While the snapshot is not one to
serve the answer is 503 `{ ok: false, error: "not ready: <codes>; retry shortly" }`, never a 404 (which a wallet takes
as "not registered"): on `WITHHELD` (`NOT_SYNCED`, `STORE_UNCONFIRMED`, `PIN_DISPUTED`, `PIN_MISMATCH`,
`PIN_OFF_CHAIN`, `RULES_DIFFER`, `BRANCH_UNRESOLVED`) and on `BEHIND` once the view is 12 or more below the tip (a
catch-up; under that the resolver also answers between two polls), and on the notes `WITHHELD_NOTES`:
`SOURCES_DISAGREE` (a witness gave another block at a height the replica holds), `PEER_FAR_AHEAD` (a witness's valid tip
is more than 12 above the replica's; a peer up to 12 ahead is served with `TIP_BEHIND_PEER`) and `TIP_STALE_LONG`
(the tip is more than 6 hours old; a tip stale by the 30 minutes of `TIP_STALE` alone is served, since a drought
between blocks would otherwise make every replica refuse at once). Every other code and note is served and named:
the codes in `x-cairnx-why`, the notes in `x-cairnx-notes`, both exposed. Under `FINAL_VIEW` a served answer is at
most 23 blocks behind the chain tip its source read: 12 by design and fewer than 12 of `BEHIND`. The hosted resolver
imports the five reads and keeps its own dispatch: only a replica's own server withholds.

## Tuples and a reference

Each epoch boundary the loop holds `FINAL_DEPTH` deep is a tuple of CONVENTION section 34: `{ height, blockHash,
eventsHash, stateHash }`. A boundary is added once it is 12 deep, dropped by a rollback below it and kept by the store;
a refused step commits none. A rollback to a shorter branch that leaves a kept boundary fewer than 12 blocks under the
cursor withholds it (no tuple, not compared) until the chain held is 12 above it again, as the resolver withdraws it.
`status().tuple` is the newest boundary whose state hash is known (the loop replays a boundary's state when it becomes
deep within 24 epochs of the tip; an older one is replayed on demand), read from memory.
`test/tuple-differential.test.ts` feeds one feed through this book and through the resolver's own (a test-only copy of
its `src/tuple.ts` at cairnx `c89ab86`, unchanged since `a0d3f27`) and finds the same tuple at every boundary both hold:
the 2,905 of the recorded capture to 117,000, and across a reorg below and above kept boundaries, a refused scan and
rollbacks that leave a boundary 1 to 11 blocks under the cursor; after each accepted scan both serve the same boundaries.
While scans are refused the resolver withholds every tuple and this book serves the tuples it committed. If the chain
reorganises below them meanwhile, those tuples name a block the chain no longer holds at that height until the next
accepted step rolls them back: a comparer reading one then sees `branch`, another block hash, not a difference.

`open({ ..., reference: { base, fetch?, timeoutMs?, maxRequests? } })` compares the replica's tuples with a host's
(`base` the prefix of `/cairnx/tuple/<height>[:<blockHash>]`, ours `https://cairn-substrate.com/trade/api`). When an
advance holds a new newest boundary with a known tuple, the reference is read for it by height and block hash, then by
height. This runs after the advance's step: a read that waits on the advance waits for the step and the witnesses,
not for the reference. `status().compare` is a `CompareReport` (null before the first comparison; `height` is -1 on
an `unavailable` report that has no boundary yet):

| kind | what the reference answered | note |
|---|---|---|
| `equal` | the same tuple | none |
| `branch` | another block hash at that height: two branches, compared again later, never a difference | `TUPLE_BRANCH` |
| `records` | the same block hash and another events hash at the first boundary that differs | `TUPLE_RECORDS` |
| `rules` | the same events hash and another state hash there (`gates` carries this package's table; the reference serves none) | `TUPLE_RULES` |
| `missing` | a 404 by hash and by height | none |
| `unavailable` | no answer within the run's bounds, or an answer that is not the documented shape | none |

For a difference, a binary search over the held boundaries between the last agreeing one and the newest finds the
first that differs (`height`, with `lastAgreeing` below it); `streak` counts the new newest boundaries in a row whose
difference starts at that boundary (advances at one tip do not add to it). A pinned store's pin is read with each new
newest boundary until the reference gives the pin's own tuple, which is then kept: the pin's block hash with another
events hash is `PIN_DISPUTED`, which withholds `verified` until the reference answers the pin's tuple (a 404 at the pin
leaves the last answer's verdict). So a reference can withhold `verified` on a pinned store: that is the design, a
recount does not settle it, and an integrator who names a reference accepts it. A difference first seen above the pin
lies in rows the replica proved from blocks, so it is `TUPLE_RECORDS` with `verified` unchanged. A reference is hostile
input: each advance reads it at most
`maxRequests` times (default 16) within 20 s, each request within `timeoutMs` (default 5 s), each answer at most 4,096
bytes; an answer out of shape, or one that contradicts itself, ends that run `unavailable`. `status()` reads nothing.
Nothing a reference answers raises a level or counts as a witness's confirmation. A reference on an origin the store is
filled from is marked `sameOrigin`; the test is equality of URL origins and nothing more (`www.`, a trailing dot,
another scheme or port read as another origin), so it is a label for a caller who names its sources honestly, not a
defence against one host under two names.

A difference is acted on only with `recount` (`./server`'s `open`), a block source of the server's (`open` refuses a
source whose basis is not blocks), and only once its first boundary has stayed the same for `STREAK` (3) new
boundaries: a separate loop over `recount` in memory reads from its floor to its source's tip, for at most `RECOUNT_MS`
(10 minutes), and takes that boundary. The advance's signal and `close()` end a recount, and an ended recount settles
nothing. Equal to the replica's tuple, the difference is confirmed (`DIVERGENCE_CONFIRMED`) and the replica keeps
answering; equal to the reference's, the store is rebuilt (`STORE_UNCONFIRMED` while it refills to the tip; a reset
that throws keeps `STORE_UNCONFIRMED` and is tried again at the next new boundary); neither, nothing changes. Without
`recount` a difference is reported and never acted on. The cost a reference can impose is bounded: a recount per
difference held for three boundaries, so a reference that differs for three and agrees for one forces one full read
from the floor every four boundaries (120 blocks). A rebuild refills from the store's own source, so a source that
keeps serving what the recount and the reference agree against would be rebuilt every few boundaries: after `REBUILDS`
(2) rebuilds with no equal comparison between them, a recount that sides with the reference rebuilds no more. The
store is kept, `STORE_UNCONFIRMED` holds and the note `SOURCES_DISAGREE` names the boundary, until a comparison is
equal (which also clears the count) or a recount equals the store's tuple. Replace that source. The same object may be both `source` and `recount`: the recount then
reads the store's own source again, which still finds a store damaged since it was filled.

## The browser store

`idbStore({ name, slot })`, in `./browser`, keeps a store in the IndexedDB database `cairnx-replica:<name>` (`name`: 1
to 64 of a-z, 0-9 and -) of an extension's own contexts, its service worker above all; pass it as `store` to `open` or
`openLog`. `slot` is `sessionSlot(key)`, the key `key` of `chrome.storage.session`, which only the extension's own
contexts reach by default, which lives in memory and which a browser start, an extension update or reload clears;
`sessionSlot` throws `ReplicaConfigError` where that area does not exist (a page: pages use `memoryStore()`), and so
does `idbStore` for another name or without a slot. The database holds four object stores, the only names the store
writes or removes: `meta` (the record: the store's tag and format, the meta without `witnessed`, the chain over the
boundaries and the header window's digest, the same record checks as the disk store's), `rows` and `bounds` (by height)
and `window`. A commit is one transaction, `relaxed` (a power loss can drop the last commits, and it also clears the
slot, so the store is refilled anyway), that first compares the stored cursor with the one the commit expects and
aborts on another. The slot holds the hash of the record: before the transaction the pair of the stored record's and
the new record's hashes, after it the new one alone, so a worker stopped at any point leaves a record the slot names
(`test/browser/idb-store.test.ts` stops it before, between and after the writes, with the transaction issued, and at
random times).

At open, in order, as the code runs: the record's tag, format and form, the chain over the boundaries (each in form:
three hashes, a height, a state hash null or a hash, since canonical JSON writes NaN and Infinity as null)
(`corrupt`, `format`; the header window is checked where it is read); then the slot: a record whose hash it does not name is `unconfirmed`, and the
reader resets the store and refills it; then the format, rule and basis key (`format`, `rule`, `basis`); then the loop's
checks of every row (`corrupt`), the gate table (`rule`) and the newer-pin rule (`basis`), and under a pin the bind. The
slot is what tells this package's commits from a profile written by another program: an edit of the database, however
consistent, or an older copy put back, is not named by the slot, and after every browser start the slot is empty, so the
store is refilled: rows at or below a pin from the release's log, every block above it from the source again. A database
of a later layout is `format`, deleted and made again by the reset. Each store needs a slot key of its own: two stores
on one key replace each other's hash at every commit and refill each other without end.

One context writes a store at a time, by the Web Lock `cairnx-replica:<name>` taken at `open` and held until `close()`
or the end of the context that holds it (a stopped worker, a closed page). While another context holds it, `open` is
`unavailable` (`NOT_SYNCED`, the note `STORE_UNAVAILABLE`) and the next advance tries again. A store deleted under an
open one (another context deleting the database) gives the next commit `CURSOR_MOVED`, and the reader refills it. A
caller must not steal the store's lock (`navigator.locks.request` with `steal`): the store that loses it opens
`unavailable` and commits nothing from then on, and its last slot write is made only over the pair it wrote, so the
successor keeps its confirmation, but that reader answers nothing verified until its context starts again. A record of
another tag in the database is `corrupt` and reset, where the disk store refuses another program's `meta.json`: the
database's name carries this package's prefix, so nothing else is expected in it.

The slot also keeps what the reader had settled when it last advanced verified: the clock's reading, the tip of its last
step and the witness confirmation it held then, bound to the record hash it was kept under. An advance that ends with
any code in the verdict (a witness's higher tip or gate table, a refused pin, a stale tip, a silent witness, behind or
not synced) clears it, so a restart does not forget a denial. When the context starts again (an MV3 worker is stopped
after about half a minute idle), the reader takes that view back, whole or not at all, only where a running reader would
answer from it: the record is the one kept with it and was committed under this source's basis (a store kept from an
older pin waits for a commit under the new one, after its bind), the clock reads no earlier than it did at the keep (a
running reader voids its confirmation on a clock set back), the tip is the block at the store's cursor and at most 30
minutes old, and, where the root needs a witness, the confirmation is of a block the store holds, at most 30 minutes old
and not later than the clock, by one of this reader's witnesses, held with that tip. Then the first read answers as the
stopped worker would have, with no request; otherwise the reader starts as a fresh one, with a fresh one's `why`. A
commit drops the view until the next advance keeps one for the new record. A store that throws while it keeps or clears
the view does not stop the advance: the error is `keepError` on `status()`, the view is cleared where the store lets it,
and the next start restores nothing.

Who reaches the slot: the extension's own contexts (its worker and its pages, the popup included: the test reads it from
a page); not content scripts, by the session area's default access level (`TRUSTED_CONTEXTS`, which the platform
documents and the store does not change), and not a page of another origin, which has no `chrome.storage` of this
extension. An extension that opens the session area to content scripts (`setAccessLevel`) hands the slot, and with it
what counts as confirmed and the kept view, to every page its content scripts run in. The rig tests the extension page
only, since it loads no site. The slot's value after a kept view measured 496 bytes in the test (the area's quota is
10,485,760 bytes).

Measured on 2026-11-21, Chromium 153 headless on the maintainers' host, in the test's worker: a store of 2,000 blocks
with 1,512 synthetic Proposes, unpinned, under a caller root with a witness; the worker stopped and woken, the network
refused: wake to the first verified read 86 ms (median of 7, 75 to 106), of which the open 34.2 ms and the read with
its two replays 34.7 ms. Without a kept view (a browser start), the first verified answer waits for the refill. At the
shipped pin (143,340, 1,486 events, 8,640 blocks above) without a kept view, the design pass measured 235 and 258 ms
(medians of 7), three replays of about 36 ms each among them; the plan's 150 ms row for a worker restart is missed
until cairnx-core's resumable replay lets one pass serve the bind and both views.

Under an anchor root, measured on 2026-11-21 in the same rig: `hosted({ pin, origin, witness, store: idbStore })` with
the pin at 30,000 over the recorded chain to 30,300 (not the rig's synthetic chain: the anchor root verifies real
proof of work), the front door served inside the worker, so no time below includes a network. The store held 31 rows
and a window of 28,984 bytes (345 headers). From a wake to the first verified read, which waits for the advance it
starts, medians of 7: with the store's window, 72 ms (64 to 74), of it the read with its advance 26.0 ms, and 1
request (the server's tip), no header read; with the window withheld, as before the store kept it, 74 ms (70 to 91),
the read with its advance 37.1 ms, and 3 requests, the seed and 300 headers from the pin. Over a network the
difference is those requests: the walk reads the seed and one request per 512 headers above the pin.

## Display

```ts
import { open, ourApi } from "@inversealtruism/cairnx-replica/display";
const d = await open({ source: ourApi({ origin: "https://cairn-substrate.com" }) });
const a = await d.name("alice");   // a.verified is false; show a.shown with a.why
```

`ourApi({ origin, fetch?, timeoutMs? })` is our front door's `/trade/api/cairnx/name/:name` and
`/trade/api/cairnx/token/:ticker` at `origin` (an http or https URL without credentials, query or fragment), one
request per read, redirects refused, `timeoutMs` (default 10 s) per request. `open({ source })` from this entry gives
`name(name, { signal? })` and `balance(ticker, address, { signal? })`, the same `NameValue` (cairnx-core's `nameView`
over the served name record) and `BalanceValue` (without `atTip`) a replica answers. It refuses every source but a
display one with `ReplicaConfigError`, and the root entry's `open` refuses a display source.

These are the resolver's legacy routes. When the versioned API's reads are live, the display entry moves to them.
`balance` reads the token's whole `holders` map and takes one entry, so its answer grows with the number of holders:
on the pinned corpus at its tip 117,000 the largest of its 19 tokens, CAIRN, has 25 holders and a 2,463-byte answer.
Past 16 MiB the front door and this entry both refuse it. The versioned API's `holders?keys=` read, which names the
addresses asked, replaces it when live.

What a display answer proves: nothing beyond what the server said. It is the server's state at the server's tip, with
no record checked, no depth and no witness. Every answer is `{ verified: false, value: null, shown }` with
`level: 1`, `proof: "served"`, `at: null`, the display basis as `vouch`, and `why` led by `LEVEL_DISPLAY` (the
verified rule's level condition, `levelCode` in `verdict.ts`). `DisplayAnswer`'s type has no verified member, the
answer is built with `verified: false`, and no option can change it: the tests cross every server behaviour they
model (an honest answer, a body that claims `verified` and level 3, errors, bodies out of form, a fetch that throws
or never answers) with each origin form, timeout and read option the entry takes. A further `why` code:
`INPUT_INVALID` for a name or ticker out of form, `SOURCE_UNAVAILABLE` (with a detail) for no answer, a status other
than 200, a 404 other than the resolver's refusal for that read, or a body out of form (a JSON `null` included);
`shown` is then null. Only the exact refusal `{"ok":false,"error":"unregistered name"}` of the name route is an absent
name (`free`, or `reserved`), and only `{"ok":false,"error":"unknown ticker"}` of the token route an unknown ticker
(no balance). Any other 404, such as the resolver's catch-all or the front door's allowlist refusal, is
`SOURCE_UNAVAILABLE`, so an origin set to the wrong server shows nothing rather than every name free; a reworded
refusal fails the same way. A caller that needs
`verified` reads the name from a replica of level 3 (`open` of the root entry).

The minified bundle of `./display` measured 5,208 bytes gzip on 2026-11-21 and is pinned under 6 KB by
`test/bundle.test.ts`. Of that, 2,290 bytes is what any import from cairnx-core costs: module-level statements of its
build and csd-codec's that a bundler cannot drop.

ESM only, `sideEffects: false`. `@inversealtruism/cairnx-core` is a peer dependency, so a process runs one `resolve()`.
