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

- `.`: the types, `NOT_VERIFIED_CODES`, `NOTE_CODES`, `checkBasis`, `levelOf`, `proofOf`, `basisKey`, `memoryStore()`,
  and the reader, `open` and `openLog` ("Reading" below).
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
- `nodeWitness({ node, fetch? })` and `hostedWitness({ origin, fetch? })`, in `./browser` and `./server`: witnesses for
  the reader (below), a node's `/tip` and `/block/height/:h`, or our front door's `/api/rpc/tip` and
  `/api/headers/:h/1`. A witness vouches for no record, so any http or https address without credentials, query or
  fragment is accepted. Neither reports a gate table.
- `./testing`: `fixtureSource(fixture)`, a level 1 source over a recorded block fixture such as cairnx-core's
  `test/fixtures/events-blocks.json` in this repository, and the event factories `fixtures()`.

## Reading

`open({ source, store?, witnesses?, core?, clock? })` returns a `Reader` over one source and one store (default
`memoryStore()`): `name(name)`, `balance(ticker, address)`, `primary(address)`, `state()` (a copy of the deep view), `events(after)`,
`dryRun(tx, author)`,
`status()`, `subscribe(fn)`, `advance({ budgetMs?, signal? })` and `close()`. `openLog({ rule, ... })` is the same loop
for another rule's events (CONVENTION section 35.2) and gives `events` and the status only, with no resolved state.
`advance()` runs the loop until it is caught up and asks every witness for its tip meanwhile. A read starts an advance
when none is running and waits for it at most `waitMs` (default 0: it answers from what is held); a call of
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
target (CONVENTION section 36.3). `events` pages in the order of CONVENTION section 33.3 from an exclusive `height:pos` cursor (`limit`
default 100, at most 1,000); its `next` does not pass the deep height, also on an empty page.

An answer is verified only when every condition holds. Each failed one adds its code, in this order:

| Code | The condition that failed |
|---|---|
| `INPUT_INVALID` | the read's input is well formed (a name matching `NAME_RE`, an address, a ticker in upper case, a cursor, `limit`, `minDepth` from 0 to the tip's height); this code comes alone, with nothing shown |
| `LEVEL_DISPLAY`, `LEVEL_FEED` | the basis gives level 3 |
| `RULES_DIFFER` | the gate tables agree at or below the tip: the one this package was built against, the loaded cairnx-core's, a caller's `core` whose `resolve` is another function, and any table a witness reports |
| `NOT_SYNCED` | the store is open and the loop holds a cursor and the tip of a step (the next four are read only then) |
| `BEHIND` | the cursor is not below the tip |
| `BRANCH_UNRESOLVED` | the cursor is not above the tip. It is while a rollback is owed under an anchor root, and while a caller's headers end below the store's cursor on the same chain: the caller root then reports the caller's tip, since its headers no longer vouch for the blocks above it |
| `TIP_STALE` | the tip's header time is at most 30 minutes before the clock |
| `TIP_BEHIND_PEER` | no witness named a higher tip whose header hashes to the hash it named and meets its own bits (csd-light `tipHeaderPowOk`), however far ahead |
| `NOT_WITNESSED`, `WITNESS_SILENT` | for an anchor or caller root: a witness confirmed the chain the replica holds within the last 30 minutes. A witness with tip W is compared at h, the lower of W and the replica's cursor, only when the higher of the two is at most 12 above h; it confirms when it gives the hash the replica holds at h, from its tip or by `hashAt`. The loop keeps the block hashes of its cursor and the 12 heights below it from the blocks its steps carried (13 entries at most, emptied whenever the chain held is replaced), so every h within the bound has a hash once the loop has stepped past it; until then (after a restart, a reload or a rollback) a witness that cannot be compared voids the confirmation. The confirmation is stamped with the time the witness answered. It is void when the chain held is replaced (a rollback, a reload from the store, a reset), when a witness answers another hash at h, and when the clock reads earlier than it read before. None, or void: `NOT_WITNESSED`; older than 30 minutes: `WITNESS_SILENT` |
| `SHALLOW` | `name` and `primary`: the deep view and the tip view agree |

The tip is the one the loop's last step reported, a header the root vouches for, never `Source.tip()`. Every clock is
`clock()` (default `Date.now`). Notes: `TWO_CORES` (a caller's cairnx-core is a second module with the same gate
table), `SOURCES_DISAGREE` (a witness gave another hash at the height it was compared), `WITNESS_MALFORMED` (a witness
answered its tip or its gate table out of form, and was taken as silent), `CURSOR_ABOVE_TIP` (an `events` cursor above
the replica's), `STORE_UNAVAILABLE` (the store threw at open). Exported and not emitted yet: `STORE_UNCONFIRMED`,
`UNSUPPORTED`, `PIN_MISMATCH`, `PIN_OFF_CHAIN`, `PIN_DISPUTED`, and the notes `TUPLE_BRANCH`, `TUPLE_RECORDS`,
`TUPLE_RULES`, `DIVERGENCE_CONFIRMED` and `REPLAY_SLOW`. `LEVEL_DISPLAY` and `SOURCE_UNAVAILABLE` come only from
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
rows is reset and filled again; the newer-pin exception of the design is the disk store's slice.

`dryRun({ app, outputs }, author)` replays every event held with `tx` (a Propose or an Attest, its outputs as
cairnx-core's event rule reads them, so a fee or a payment can be tried) in the block above the cursor, and answers
whether it applies, with the code and note of the applied log; a transaction the event rule does not take (another
domain, an author out of form) is `INPUT_INVALID`. It changes nothing the replica holds. `local({ node, fetch? })`, in
`./browser` and `./server`, is what `open` takes for one's own node held in memory: `nodeBlocks` under that entry's
address rule and `memoryStore()`.

What the reader does not answer yet: `transfers` waits for cairnx-core to export the token movements of an address (a
whole fill's delivered amount and a mint's amount are not fields of the state today, and deriving them here would
restate the core's settlement). What it does not persist: the witness's confirmation and the source's header window
live in memory.

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
