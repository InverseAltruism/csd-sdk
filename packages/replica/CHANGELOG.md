# Changelog

## 0.1.0 (unreleased)

- `indexerFeed` with `verifyInclusion` takes its tip and every block hash it holds from the caller's verified headers
  through the new option `headerAt(height)` (`IndexerFeedOptions`), required with inclusion (`ReplicaConfigError`
  without it): the tip is the final height with the verified hash and time, the indexer's `/block` is not read, and
  the cursor ends where the indexer still gives the verified hash. An indexer that lags reads as `BEHIND` (it read as
  synced at its own tip, so a server answered 200 for a state 20 blocks behind), and one on another branch than the
  verified headers is served only up to where they agree. Without inclusion nothing changes.
- A read starts an advance only when none runs and the last ended at least `READ_ADVANCE_MS` (15 s) before, so a burst
  of requests to a replica's server polls its source at most once in that time; `advance()` is unchanged.
- `replicaReads`, after review: 503 also on the notes `WITHHELD_NOTES`: `SOURCES_DISAGREE`, the new `PEER_FAR_AHEAD` (a
  witness's valid tip more than 12 above, more than 24 under `FINAL_VIEW`) and the new `TIP_STALE_LONG` (the tip older than `STALE_MAX_MS`, 6 hours); a
  `TIP_STALE` tip alone and a peer up to that far ahead stay served. The notes reach a client in `x-cairnx-notes`, exposed
  with the other two (`FINAL_VIEW` never reached the headers).
- `replicaReads(reader)` in `./server`: the resolver's five state reads from `reader.snapshot()`, with the resolver's
  statuses, bodies and headers (equal on the recorded fixture to 117,000), the verdict in `x-cairnx-at` and
  `x-cairnx-why` (exposed to other origins), and 503, never 404, on `WITHHELD` and on `BEHIND` 12 or more below the
  tip. The withhold rule is the server's, not the handlers'.
- The resolver's five state reads, moved from the private CairnX resolver at 0c95ad2 with their code unchanged
  (`src/resolver/read.ts` as `src/handlers.ts`, and `src/nameview.ts`): `readState`, `readName`, `readResolve`,
  `readNameHistory`, `readProfile` over a `ReadSnapshot`, with `leaseInfo` and `nameDetailsOf`, exported from `.`;
  the resolver's purity guard moved with them (`test/handlers.test.ts`), and so did its nameview cases. `appliedIds` is
  exported from `.`. `scripts/move-residual.mjs` lists both files and reports "code identical" for a TypeScript
  file whose tokens equal the resolver's.
- `Reader.snapshot()`: the tip view and the events held up to it from one commit, frozen, one object per state
  (`Snapshot`). `dryRun`'s `at` is the cursor it was tried above (it named the tip, also while behind it or above it).
- `indexerFeed`: a step's tip carries its header time, read from the indexer's `/block/<hash>` (it was 0, so every
  answer said `TIP_STALE`); with `verifyInclusion` the tip is the final height, the highest block the Scanner emits
  for (it was the indexer's tip, so every answer said `BEHIND`), and every answer carries the new note `FINAL_VIEW`;
  such a tip is stale only 12 target block times (24 minutes) after the 30 minutes. `Source.tip()` with
  `verifyInclusion` gives the last step's tip.
- `indexerFeed`: a store cursor whose block is off the indexer's chain (the indexer's tip below it, or another hash at
  its height) rolls back to the lower of that block and the last held boundary whose hash the indexer gives, never
  below the floor, and the next step reads on to the indexer's tip. A shorter branch that changes only block hashes
  left the cursor above the indexer's tip (`BRANCH_UNRESOLVED`, and a boundary 11 deep on the indexer's chain was
  served); after review, also a tip that lands on a held boundary, the floor, and a shorter branch above the final
  height under `verifyInclusion`. The cost: an indexer whose tip drops on one chain (a rebuild) rolls the store back
  to it, as the hosted resolver's published state already drops; the store refills from the next scans. An indexer
  whose tip is under the floor leaves the step idle at that tip, below the cursor. A final height that moves back with
  the cursor's block still the indexer's rolls nothing back.
- The tuple book and the comparison (design section 6): `status().tuple`, the newest boundary's tuple from the loop's
  boundaries; `OpenOptions.reference` and `status().compare` (`CompareReport`: equal, branch, records, rules, missing,
  unavailable, with the first differing boundary, `lastAgreeing`, `streak`, `sameOrigin`); `PIN_DISPUTED` at a pin;
  the notes `TUPLE_BRANCH`, `TUPLE_RECORDS`, `TUPLE_RULES`, `DIVERGENCE_CONFIRMED`; `./server`'s `open` takes `recount`,
  which settles a difference held for `STREAK` new boundaries (confirmed, or the store rebuilt). After review: the pin
  is read again at each new boundary until an equal answer; reads do not wait on the reference; a recount ends with the
  advance's signal or `close()`; `recount` must be a block source; a failed reset keeps `STORE_UNCONFIRMED` and is
  retried. The resolver's `tuple.ts` is not moved: a differential against a test-only copy of it finds the same tuple
  at every boundary both serve. After the second review: a boundary a rollback leaves under 12 deep is withheld
  until the chain grows back over it; at most `REBUILDS` (2) rebuilds with no equal comparison between, then
  `STORE_UNCONFIRMED` and `SOURCES_DISAGREE`; an answer refused by its `Content-Length` has its body cancelled, so its
  connection is not held until a garbage collection.
- `indexerFeed(options)` in `./server`: a feed source over the resolver's Scanner (level 1, or 2 with
  `verifyInclusion`); a scan whose tip block moved is `BRANCH_MOVED`, changed events below the cursor roll back to the
  last event block that agrees, and the cursor is the tip, or with `verifyInclusion` the final height, or the last
  boundary a step's budget reached. The recorded capture to 117,000 through it gives cairnx-core's corpus and pinned
  events hash (`test/indexer-feed.test.ts`). After review: an Attest on a Propose mined before activation is left out
  (the loop refused every step); the store is compared only up to the scan's top, so a verified tip that moves back
  rolls nothing back; the block hashes the store holds (the cursor's, its boundary rows') are compared with the
  indexer's and a replaced block rolls back to the last that agrees; a boundary at the tip takes the scan's tip hash.
- Moved from the private CairnX resolver, byte for byte apart from import paths and then cleaned: the Scanner
  (`src/scanner.ts`, exported from `./server` with `branchRefusal`), its kept events (`src/kept.ts`) and the
  name-history selector (`nameHistory`, exported from `.`), with 22 of the Scanner's suites and the selector's three;
  `scripts/move-residual.mjs` prints the residual against the resolver at a commit. The Scanner now reads at most
  `MAX_TX_OUTPUTS` (512) outputs of a /tx answer, where it read 1,024.
- Under an anchor root the store keeps the source's header window: each commit of blocks carries the window's headers
  up to the cursor and sets `StoreMeta.work` and `workRoot`, and a source started over a filled store takes the
  stored window instead of walking the headers from the anchor, once csd-light has verified it again and it holds
  the cursor's block under this anchor; any other window is dropped and the walk runs as before. A taken window's
  work is the bar another chain must beat, so a restart over a store on a branch the server no longer serves rolls
  back only to a heavier one (until now it followed any chain that reached the cursor). `headerWindow()` of the disk
  and browser stores gives nothing when the bytes it reads are missing or not the record's, and their open no longer
  reads the window: a window damaged at rest costs the walk from the anchor, not a reset and refill of the store. A
  `headerWindow()` that rejects is taken as no window. The disk store removes at open a window file its record does
  not name (a commit cut before its meta landed). `StoreMeta.windowSha256`, never set or read, is removed: a record
  written before keeps the field, which is ignored. Internal: `Source.windowAt`, `Source.restoreWindow`, `HeldWindow`.
- `idbStore({ name, slot })` and `sessionSlot(key)` in `./browser`: a store in IndexedDB for an extension's own
  contexts, one transaction a commit that compares the stored cursor first, confirmed by the hash of its record in
  `chrome.storage.session` (written as a pair before the transaction and alone after it); a record the slot does not
  name opens `unconfirmed` and is reset and refilled; one writer by a Web Lock. The record checks and the boundary
  chain are one module both stores import, every digest in it `payloadHash`. A disk store written before this change
  that holds a boundary or a header window (its chain and window name were sha256 over raw bytes) opens `corrupt` and
  is refilled. Internal:
  `Store.open`'s reason `unconfirmed`, `TrustedSlot`.
- `hosted({ ..., store })`: the store, default `memoryStore()`. `STORE_UNCONFIRMED` is set from an unconfirmed reset
  until the refill reaches a step's tip. The browser store's slot also keeps the reader's last settled tip and witness
  confirmation, bound to the record hash; a reader whose context starts again takes them back, whole or not at all,
  only where a running reader would answer from them (the block at the cursor, 30 minutes, a held block confirmed by
  one of its witnesses with that tip), else it starts fresh. Internal: `Store.keep`, `Store.kept`, `KeptView`,
  `Loop.resume`, `LoopStatus.unconfirmed`.
- The kept view, after review: kept only while the reader's verdict has no code, cleared by any other verdict; taken
  back only with a clock no earlier than at the keep and from a record committed under the source's basis; a store
  that throws while keeping it fails soft (`ReplicaStatus.keepError`). Both stores refuse a boundary out of form at
  open (a state hash NaN or Infinity, which canonical JSON writes as null). README: each store a slot key of its own;
  the open order as the code runs.
- `idbStore`, after review: a store whose Web Lock was stolen is lost (it opens `unavailable` and writes nothing to the
  database or the slot), and a commit's last slot write is made only while the slot still holds the pair that commit
  wrote, so a writer that lost its lock cannot overwrite its successor's confirmation.
- A store filled under an older pin is kept under a newer one when both are pinned with one `basisKey`, the new pin
  is higher, the store's cursor is at or above it and the stored rows give its block hash, events hash and log digest
  (`keepsStore`, internal); the bind then replays its state hash, and the next commit records the new pin. Every other
  change of basis resets the store, as before (`test/disk-pins.test.ts`). Internal: a store compares the basis by its
  key; `Source.pin`.
- `ownNode({ node, dir, pin?, witness?, fetch?, paceMs?, timeoutMs? })` in `./server`: `local`'s source, `diskStore`,
  the witness only when one is named, and a step budget of 512 blocks and 600 requests (internal: `OpenOptions.step`).
  A day above a pin on disk went from 81 commits to 2.
- `STORE_UNAVAILABLE` carries in its `detail` why the store is unavailable, one of a fixed list (another process holds
  it, it refuses its directory, a read or write failed, a reset it needed failed), so a refusal of the store's
  directory met after a start that found it held (which rejects only `advance()`) reaches a caller that only reads;
  the store's message, which holds paths, is in `status()` as `storeReason` and `storeError`, for the server's own
  logs (internal: `LoopStatus.storeReason`, `storeError`). README: give the store a directory of its own; two processes of
  different configuration on one directory reset each other's store.
- The server example is a file, `examples/deposits.ts` (`openReplica` over `ownNode`, `creditDeposits`, `recover`),
  which the README points at; `test/deposits.test.ts` runs it over the recorded node across a restart, a 20-block
  reorg while running and one while closed, and a newer pin that keeps the store, and `test/transfers-reorg.test.ts`
  runs its two calls over a memory store.
- The example's `recover` reads the pages after its start without writing, then raises the credits they do not give
  and stores the start in one transaction, so a recovery stopped at any step runs again over the same range and
  raises each such credit once; the credits to raise are those written after the transaction that stored the start
  (`Deposits.creditedAfter`), not compared by a height, and the raise says the credit is not at `minDepth` on this
  branch (it may be mined again higher). Alerts are written in a transaction (`Credit.alert`).
- A store kept under a newer pin whose gate table differs answers `RULES_DIFFER`, as a fresh store does (the bind
  compares the gate table before the state hash).
- `diskStore({ dir })` in `./server`: a store in one directory, appended rows and boundaries with a meta swapped by
  rename, one writer by a lease (5 s touches, stale at 20 s), and checks at open (format, rule, basis, the gate table,
  the files' lengths, chain and digest, then the loop's row checks). The pin's reopen bind replays the state hash
  rather than reading the one a boundary stores, and compares the stored events at or below the pin with
  `logSha256`. Internal: `Commit` is an extend or a rollback that carries the meta only; `StoreMeta.gates`;
  `Boundary.rowsHash`; the commit checks of both stores in one module.
- `diskStore`, after review: it writes and removes only its own names (other files and directories in `dir` are left
  alone; another program's `meta.json` makes `open` throw `ReplicaConfigError`); a missing row file under a meta that
  commits bytes of it is `corrupt`; a write that lands short is completed or fails the commit; the lease's takeover
  reads the lock's time and token through one descriptor. The reader resets a refused store at whichever load finds
  it, also after a start that found the store held (internal: `LoopOptions.resetRefused`).
- `Pin`, `checkPin` and `pinned({ pin, then })`: a release's log below a pin, then a block source above it. The first
  step checks the log's sha256, its canonical form and contract, its events hash, the gate table and its state hash,
  then the pin's block hash against `then`'s root, and commits the log with `then`'s first step; `PIN_MISMATCH`,
  `RULES_DIFFER` and `PIN_OFF_CHAIN` (a reorg or a chain below the pin included) are kept for the source's life and
  reach `why`. `open` and `openLog` throw `ReplicaConfigError` `PIN_MISMATCH` for a pin of another rule.
  `derivePin(fixture)` in `./server`; `local({ node, pin })` and `hosted({ pin, origin, witness })` in `./browser` and
  `./server`. Internal: `StepContext.floor` (the pin, else the activation height less one), where the roots and the
  fork search stop; `floorBreak` takes the floor.
- `pinned`, after review: the reader takes a refusal of the pin into `why` only under a pinned basis (an unpinned
  anchor root's `PIN_OFF_CHAIN` stays a step's refusal, as before); a first step whose root's tip is below the pin is
  `SOURCE_UNAVAILABLE` with nothing committed; a store that holds the pin's rows is bound to the descriptor once per
  source (block hash, events hash, state hash at the pin, gate table) without reading the log; `derivePin` refuses a
  fixture that starts above the activation height. Internal: `StepContext.stateHashAt`.
- The reopen bind compares no state hash where the loop holds none, so `openLog` over a pin of its own rule is
  verified again (it was refused `PIN_MISMATCH` from its second step).
- `transfers(address | null, since, { ticker?, limit?, minDepth? })`: the token moves of cairnx-core's applied log
  (CONVENTION section 41) in the deep view, one row per move (`Transfer`: txid, height, position, leg, ticker, the
  state's deploy id, from, to, amount, the entry's own record's memo, `applied`, code), answered through the reader's
  verified rule. Rows by height then position; a page holds whole entries. The cursor, `BoundCursor`, is
  `height:pos:eventsHash`; a cursor whose events hash is no longer the replica's at its height is `CURSOR_OFF_BRANCH`
  (a new not-verified code), nothing shown. `Page` takes the cursor type as a second parameter. The README's server
  example runs over a 20-block reorg in `test/transfers-reorg.test.ts`; it raises `CURSOR_OFF_BRANCH` to its operator,
  and the test runs the README's recovery (from the newest earlier cursor still accepted).
- `events` takes the cursor of `transfers`, `height:pos:eventsHash`, and resumes after the event the cursor names in
  the apply order of CONVENTION section 33.3: a page cut between a block's Propose and an Attest at a lower position
  of the same block lost the Attest (the `height:pos` cursor was compared as a sort key). Both reads parse and check
  the cursor in one module: a stored `events` cursor of the `height:pos` form, and a position that names no held
  event other than the largest, are `INPUT_INVALID`; `events` answers `CURSOR_OFF_BRANCH` as `transfers` does.
  `TransferCursor` is removed; `Page`'s cursor type defaults to `BoundCursor`. While the deep height lies above the
  replica's cursor (a catch-up, a rollback before the blocks after it) and after `close()`, both reads show no page
  and answer the state's code (`BEHIND`, `NOT_SYNCED`).
- `dryRun`'s `at` is the tip at depth 0 (it carried the deep view's), and it takes no `minDepth`.

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
- `hostedBlocks` in `./browser` and `./server`: complete blocks from the front door's `/api/blocks` in aligned pages,
  bound to headers from an anchor root (verified with csd-light in a window of 45 + `window` headers, `work` counted
  from workRoot, in-window branches by `tryReorg`, lower ones verified from workRoot by the reseed rule; `LESS_WORK`,
  `PIN_OFF_CHAIN`, `BELOW_FLOOR`) or a caller root (`VerifiedHeaders` with `floor`, `origin`, null on an unknown tip
  and `offer`; a caller reorg rolls back to a held hash). A refused page is read once more past edge caches before
  the refusal. `readBlocks` over it reads blocks whose headers the root holds. The tip a step reports is a header
  the root vouches for; the server's claimed height travels as the blocks step's new `reach`, which the loop uses
  only to decide whether to take another step.
- While a rollback is owed to the anchor root (the store's cursor off the window's chain), `hostedBlocks` returns it
  before reading the server and reports no tip above its fork block; a fork block below the activation height less
  one rolls back to that height; a walk from workRoot resumes after a transport error; a fork's header answer that
  fails verification is read again past caches; a caller's fork is placed only where its `at` answered another hash.
- 2026-11-18, a copy: `src/http.ts` holds a copy of csd-client's capped body read, which is private to `CsdClient`.
  Remove it when csd-client exports that read.
- The reader: `open` and `openLog`, the answer types (`Answer`, `At`, `ReadOptions`, `BalanceValue`, `Page`,
  `ReplicaStatus`, `Witness`), the reads `balance` (deep view, `atTip`), `primary` (`SHALLOW`),
  `state` and `events` with `minDepth`, and `advance`, `status`, `subscribe`, `close`. An answer is verified only
  when the input is well formed, the basis is level 3, the gate tables agree at or below the tip (`RULES_DIFFER`;
  `TWO_CORES` noted), the loop is synced at its tip (`NOT_SYNCED`, `BEHIND`, `BRANCH_UNRESOLVED`), the tip is at most
  30 minutes old (`TIP_STALE`), no witness names a plausible higher tip (`TIP_BEHIND_PEER`) and, for an anchor or
  caller root, a witness confirmed the branch within 30 minutes within 12 blocks of its tip (`NOT_WITNESSED`,
  `WITNESS_SILENT`). `open` refuses `BELOW_FLOOR` (`ReplicaConfigError.code`) and a witness on the header source's
  origin. `nodeWitness` and `hostedWitness` in `./browser` and `./server`. The floor rule has one home,
  `floorBreak`, used by `open` and both roots. The loop gives `hashAt`, `rows` and an `onRollback` callback.
- `dryRun(tx, author)`: a Propose or an Attest with its outputs replayed in the block above the cursor, answered with
  `applied`, the code and the note of the applied log. `local({ node, fetch? })` in `./browser` and `./server`.
- The witness rule after review: a witness is compared only at the lower of its tip and the cursor, within 12 blocks
  of the higher, against a hash the replica holds there; a confirmation is stamped when the witness answered and bound
  to the loop's generation, which every change of the chain but an extension moves (`chainExtends` guards the one
  write); a disagreement and a clock read earlier than the last void it; any higher tip with a valid header is
  `TIP_BEHIND_PEER` (no plausibility cap); a witness out of form is silent, noted `WITNESS_MALFORMED` (a new note
  code); `advance()` joins a run in flight; a caller whose headers end below the
  store is an idle step with the caller's tip, so the reader answers `BRANCH_UNRESOLVED`.
- A read and a step's commit: `Loop.committing()` is checked in the turn the read answers in; a read waits for a
  commit in flight at most its `waitMs` or until its signal aborts, then answers `NOT_SYNCED` ("a step's commit is in
  flight") with nothing shown, and `status()` answers `NOT_SYNCED` during a commit. A commit that never settles leaves
  `advance()` pending.
- The loop keeps the block hashes of its cursor and the 12 heights below it (at most 13), emptied whenever the
  generation moves, so a witness within 12 blocks below the cursor is always compared; one the loop cannot yet compare
  (after a restart, reload or rollback) voids the confirmation.
- No value a read returns shares a mutable object with the reader: the basis is frozen at `open`; `events()` pages
  and `status()`'s cursor, last reorg and last error are copies.
- Not yet in the reader: `transfers`, which waits for the core to export an address's token movements; a poll timer
  (the caller drives `advance()` or reads).
- `name(name)`: cairnx-core 0.2.8's `nameView` at the deep view (`NameValue`: `held`, `pending`, `lapsed`, `free`,
  `reserved`, with owner, address, profile and `paidThroughEpoch`), through the verified rule every read shares, and
  `SHALLOW` with the tip view in `shown` when the views differ (one helper with `primary`, which now compares its two
  views the same way). A string that does not match `NAME_RE` is `INPUT_INVALID`: the caller lowercases and drops
  `.csd`. `addressOf` moved to `views.ts`; `balanceOf` takes any state with tokens and balances.
- `./display`: `ourApi({ origin, fetch?, timeoutMs? })` over the front door's `/trade/api/cairnx/name/:name` and
  `/trade/api/cairnx/token/:ticker`, and its own `open({ source })` with `name` and `balance`. Every answer is level 1
  and `verified: false` by type and construction, `why` led by `LEVEL_DISPLAY` from `levelCode`, the level condition
  now exported by `verdict.ts`; `SOURCE_UNAVAILABLE` for no answer or one out of form. It refuses every basis but a
  display. `http.ts` exports its capped JSON read and signal join for it. The minified bundle is pinned under 6 KB
  gzip, not the design's 4 KB: any import from cairnx-core costs 2,290 bytes (measured 2026-11-21).
- `./display` after review: a 200 whose body is JSON `null` is out of form (no longer read as an absent record); an
  owner or address must be a lower-case address string; a 404 is an absent name or ticker only with the resolver's
  exact refusal for that read (`unregistered name`, `unknown ticker`), any other 404 `SOURCE_UNAVAILABLE`. The README
  says `balance` reads the token's whole `holders` map from the legacy route.
- Not yet: a store does not persist the window's `work` and `workRoot`, so a source started over a filled store
  follows any proof-of-work-valid chain from the anchor that reaches the cursor (README, "What a store must keep").
