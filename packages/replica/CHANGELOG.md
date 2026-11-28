# Changelog

## 0.2.3

- The open server: `cairnx-replica serve --node <url> --dir <path> [--pin] [--listen <address>] [--port <port>]`, and
  `openServer` with `listen` in `./server`. It serves the paths cairn-wallet sends to a server its user adds, on one
  origin: `/api/rpc/tip`, `/utxos/:addr`, `/utxos-all/:addr`, `/tx/:id`, `/tx/:id/status`, `/block/:hash`,
  `/proposal/:id` and POST `/api/rpc/tx/submit` relayed to one's own node as our front door relays them,
  `/api/headers/:from/:count` built from the node's `/block/height/:h` in the front door's JSON, and
  `/trade/api/cairnx/{name,resolve,name-history}/:name` from `replicaReads`. CORS and `no-store` on every answer, the
  submit's preflight, `Retry-After` exposed, no redirect; parameters held to their shape before any node request, the
  front door's 512 KiB submit cap, a timeout on every node read, and bounds on node requests in flight, with submits
  apart. Loopback is the default bind. README "The open server". Its test runs the front door's wallet contract for
  these routes (copied from cairn at `2331f7ca` with the sha256 of each source file) against a stub node, and the
  command over the recorded node through a socket, the served header range checked by csd-light.
- The open server's socket: header, request, idle and response timeouts and a connection cap (README "The open
  server"), and a body is read only for a submit whose headers pass; any other request carrying a body is answered at
  once and its connection closed (`test/open-server-wire.test.ts`).
- A test that no `Reader` read throws for "not verified" (`test/unverified.test.ts`).
- The capped body read of `http.ts` is shared as `cappedText`; `cappedJson` reads through it, unchanged.

## 0.2.2

- With `verifyInclusion`, an event's position in its block is now proven, not the indexer's word. The position comes
  from the transaction's merkle proof, and csd-codec's `verifyMerkleProof` used to accept a position the transaction
  does not hold: in a block of two, the first at 2; in a block of six, the one at 4 at 6, after the one at 5. A lying
  indexer could so reorder two proven records of one block (which of two mints of a capped token is filled first,
  which of two deploys of a ticker holds it). With the codec that proves the position, such a proof fails the scan as
  a proof that does not fold. A proof position that is not a safe integer >= 0 (negative, fractional, not a number)
  fails it as `SourceError` `SOURCE_MALFORMED` before the fold; before, it became the event's position and reached
  `resolve()` (`test/scan/scan-proof-pos.test.ts`). Honest scans are unchanged.
- README: what a feed trusts the indexer for with `verifyInclusion` (which records exist; it can withhold one, or
  prove the later copy of a transaction the chain holds twice) and without it (everything it reads).
- `cairnx-replica check` prints its usage one line per line; the whole text passed the print boundary as one line,
  which wrote every newline as a literal `\u000a`. The README's and cairnx-pin's install lines no longer carry an
  `@<version>` placeholder, which a shell reads as a redirection.
- `engines.node` is `>=22`, as csd-client's and csd-light's: exact 64-bit parsing of a node body needs `JSON.parse`
  to hand its reviver the source text, which Node 18 and 20 lack. On an older Node a block holding an integer above
  2^53 - 1 (a Propose's `expires_epoch`, which the node does not bound) fails closed: its read is `SOURCE_MALFORMED`,
  so the replica does not step past that block and serves its last state until the source is withheld as failing.
  npm and pnpm warn and install unless the consumer sets a strict engines option; a manager that enforces `engines` refuses the install on an older Node. The README says Node 22 or later.
- `nameHistory` without `check` flags a name `scopedReplaySufficient: false` when an `fclaim` names one of its offers.
  The fill of an fclaim-lane sale attests the fclaim's id, which the selector does not route, so the hints held the
  offer and not the sale, and a replay of them gave the seller as owner while the answer said it was provable. With
  `check` the compare already flagged it. A name with an fclaim on one of its offers is flagged whether or not a fill
  followed. Both real callers pass `check`.
- The name record `nameHistory` compares is read as an own key of the resolved `names`, in the selector and in
  `replicaReads`: `constructor` matches NAME_RE, and a bare `names["constructor"]` read `Object.prototype.constructor`
  for an unregistered name. An unregistered `constructor` is now answered as any unregistered name is (with `check`
  and `fullRecord: undefined` it was flagged insufficient). The route answers 404 for it before the selector runs, so
  no served answer changes; on cairnx-core's replay corpus at 117,000, the route's call shape answers its 140 names
  and `constructor` as before (`test/namehist.test.ts`, "fclaim-lane sale" and "constructor").
- Pins csd-codec 0.1.19, csd-client 0.1.21, csd-crypto 0.1.22 and csd-light 0.1.28, and peers on cairnx-core 0.2.11
  exactly; cairnx-pin 0.1.1's range `^0.2.0` holds this version.

## 0.2.1 (2026-11-23)

- `nameHistory` with `check` no longer serves an address or profile record that a later one supersedes: of a name's
  `nset` records the scoped replay applies only the last stays, and none when an applied `nxfer` or a fill of the
  name's offer follows it (each writes the field whole or clears it); the same for `nprofile`, which replaces the
  whole profile. Each hint costs a wallet two serial reads. On cairnx-core's replay corpus at 117,000, 8 of 114 names
  lose a hint (388 hints in all, now 378). The prune guard still has the last word: when it rejects this prune, the
  earlier prune (of the records neither replay applied) is tried before the whole selection. The selector's apply
  order is cairnx-core's `applyOrder` over the records' own ids, as resolve() orders them (a block's proposals before
  its attests, and the raw id, not the lowercased one, as the tie-break).

## 0.2.0 (2026-11-23)

A minor version because `NoteCode` grows: 0.1.0's types declare `NOTE_CODES` as a closed tuple of 13 codes and its
README says nothing of additions, so a consumer's exhaustive `Record<NoteCode, ...>` or `switch` would break under a
patch. From this release the README and `codes.ts` state that note codes may be added in a minor version and that a
client treats a note it does not know as one that withholds nothing, unless the server withholds. No export's
signature, existing note's meaning, result name or exit code changes. cairnx-pin 0.1.1 moves its peer range to it.

What a consumer receives:
- `NoteCode` gains `SOURCE_FAILING`: the source has been failing, its steps failed with none settled for more than 30
  minutes (`FAILING_MS`, the verdict's `FRESH_MS`) from the first failed step after the last that settled. A replica
  idle for longer whose next step fails once is not failing; `resume()` starts no clock. `replicaReads` withholds it
  (`WITHHELD_NOTES`); before, such a state was served as it aged until the 6-hour `TIP_STALE_LONG`
  (`test/failing.test.ts`). Internal: `LoopStatus.failingSince`.
- A feed waits on 429 and 503: `indexerFeed`'s `next()` and `Source.tip()` wait out a `Retry-After` of up to
  `RETRY_WAIT_MAX_MS` (60 s, our front door's window) and send the same request again, three refusals of one request
  in a row at most, where 0.1.0 failed the step at once. `ScanOptions.waitMaxMs` (new): a whole number from 0 (no wait)
  to 300,000, else `ReplicaConfigError`; the Scanner's default 0 throws on a 429 as before.
- A feed's first sync against a limited host completes. A full pull keeps its answers bound to its tip block,
  confirmed by a read of that block after each wait (another hash refuses the pull as `BRANCH_MOVED`); a pull that
  stops (the deadline, the signal, a request's timeout, a refusal it does not wait out) keeps its confirmed answers,
  and the next scan resumes it there, sending only what it has not read; any other failure drops them, the signal
  aborted or not. A step that ended short of its scan's top hands that scan to the next step, read again only when the
  indexer no longer gives its tip hash, and reuses the last step's tip time for the same block. Over the recorded
  capture a cold sync went from 8,347 requests to 4,980 unlimited; behind a limiter of the front door's shape (scaled
  to a 1 s window) with advances shorter than the pull it completes within 5 percent of that, and no page, attestation
  list or transaction is answered twice (`test/feed-cold.test.ts`; it did not finish before).
- Every step reads a unit (`STEP_UNIT`, 16 new answers of the pull or boundaries) before it honours its deadline, so a
  budget shorter than one request still finishes a cold sync against a host that admits, in one window, a step's tip
  and anchor reads, a unit and its confirming read, at most 21 requests (advances of 1 ms against answers 2 ms late: complete,
  requests within 1.3 of an unlimited run's, `test/feed-cold.test.ts`). A step that its own deadline ended inside a
  pull is no failed step: no error, no backoff, no start of `SOURCE_FAILING`'s clock (`test/failing.test.ts`: 38
  minutes of such stops are served; a real failure then backs off from 1 s).
- What keeps the kept pull: transport (a fetch that rejects, a 502, a 504, a 503, a request's timeout, the signal);
  what drops it: what the indexer answered (a 500, a 404, an answer out of form). Under `verifyInclusion` it keeps each
  transaction's bound info, so a resumed pull asks the node once per transaction (advances of 1 ms: 240 `rawTxAt`, as
  one advance; it was 3,006). With `waitMaxMs`, a scan whose tip block cannot be read is refused at once as
  `BRANCH_MOVED` instead of a pull with no memo and no deadline.
- The deadline: past a step's deadline no wait starts, in the scan, its confirming read or the feed's own reads; a full
  pull with its unit read stops at its next request after the deadline once a read of its tip block confirms what it
  read; a boundary read refused then ends the step at the last boundary read. A step that began before its deadline
  outlasts it by at most one wait begun before it and one request's timeout (70 s at the defaults; measured 1,296 ms
  with a 1,000 ms wait and a 300 ms timeout, `test/scan/scan-deadline.test.ts`), plus the rest of its unit when that
  was not yet read; one that begins past it sends its scan's tip and anchor reads, its unit and the confirming read (or
  a carried scan's tip read, unit of boundaries and tip time), and under `verifyInclusion` the node reads of the unit.
- `Scanner.scan(run?)` takes `{ signal, due }` (`ScanRun`, new, optional, typed from `./server`): the signal reaches
  both fetch sites, a chain-order feed page's body and every wait, so `advance({ signal })` aborted mid-scan ends at
  once, commits nothing, and the next step reads on (`test/feed-steps.test.ts`). Not reached: requests on Node 18 to
  20.2 (no `AbortSignal.any`; each keeps its timeout) and the caller's own reads under `verifyInclusion`. The command's
  5 s grace after its deadline stays as a backstop.
- A pull resumed from its memo names no event above its tip (it could name attestations mined after it began). A fresh
  full pull can still name records of blocks mined while it runs, as in 0.1.0: `indexerFeed` drops them, and a direct
  caller of `Scanner.scan()` filters to the tip it was given. On slice 11's differential (11,450 paths) nothing changed.
- `open()` in `./server` takes `pollMs` (new, off by default): the reader advances at once and again `pollMs` after
  each advance ends, until `close()`; an advance that rejects does not stop it (`test/poll.test.ts`).
- `heldReplay()` (new), over cairnx-core 0.2.10's held replay contexts, is the reader's and the loop's default
  materializer: a step replays only its new events; a row applied at or below a context's height lets go every
  context at or above it; `fallbacks` counts the heights a refusing context left to `resolve()`. Over the replay
  corpus every state the loop asks, and over the capture all 2,904 boundary tuples, equal `fullReplay()`'s, which
  stays exported (`test/held-replay.test.ts`).
- Exported: `READ_ADVANCE_MS`, `FAILING_MS` and `STALE_MAX_MS` from `.`, `RETRY_WAIT_MAX_MS` and `STEP_UNIT` from `./server`.

## 0.1.0 (2026-11-22)

- The command `cairnx-replica check` (`bin`, `src/cli.ts`): a replica in memory on one source (`--node`, `--hosted`
  with `--anchor` or `--pin`, `--feed`), read to its tip, printing the level, the verdict, the tuple at the newest
  final boundary and the comparison with `--reference` or `--expect`; exit 0 only for `equal` (or `held` with neither),
  2 for a usage or configuration error. Progress, each source error and the deadline (result `timeout`, with what it
  waited for) are printed to stderr. Before the first publish: the exit codes are fixed (0 passed, 1 differs, 2 usage,
  3 could not check, `EXIT_OF`); every printed line shows control and bidi characters escaped and source text cut at
  400 characters; the feed's reads refuse redirects; `--feed` and `--reference` take the URL rule of the other sources;
  a repeated flag, a malformed height, `--timeout-ms` out of range and `--pin` without cairnx-pin are usage errors; the
  command exits 5 s after its deadline at the latest; a pinned `RULES_DIFFER` ends the run at once.
- `indexerFeed` with `verifyInclusion` takes its tip and every block hash it holds from the caller's verified headers
  through the new option `headerAt(height)` (`IndexerFeedOptions`), required with inclusion (`ReplicaConfigError`
  without it; an answer timed more than `MAX_FUTURE_DRIFT_SECS` after the clock, as one in milliseconds is, is
  `SOURCE_MALFORMED`): the tip is the final height with the verified hash and time, the indexer's `/block` is not
  read, and the cursor ends where the indexer still gives the verified hash. An indexer that lags reads as `BEHIND`
  (it read as synced at its own tip, so a server answered 200 for a state 20 blocks behind). One on another branch
  than the verified headers is served only up to where they agree while that branch carries no record of its own;
  when it does, every step fails as `SOURCE_UNAVAILABLE` and the last state stays served until the 6-hour cap
  (`TIP_STALE_LONG`). Without inclusion nothing changes.
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
- The resolver's five state reads, moved from the private CairnX resolver with their code unchanged
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
- The tuple book and the comparison: `status().tuple`, the newest boundary's tuple from the loop's
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
  gzip, of which any import from cairnx-core costs 2,290 bytes (measured 2026-11-21).
- `./display` after review: a 200 whose body is JSON `null` is out of form (no longer read as an absent record); an
  owner or address must be a lower-case address string; a 404 is an absent name or ticker only with the resolver's
  exact refusal for that read (`unregistered name`, `unknown ticker`), any other 404 `SOURCE_UNAVAILABLE`. The README
  says `balance` reads the token's whole `holders` map from the legacy route.
- Not yet: a store does not persist the window's `work` and `workRoot`, so a source started over a filled store
  follows any proof-of-work-valid chain from the anchor that reaches the cursor (README, "What a store must keep").
