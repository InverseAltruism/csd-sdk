# Changelog

## 0.1.0 (unreleased)

- `Pin`, `checkPin` and `pinned({ pin, then })`: a release's log below a pin, then a block source above it. The first
  step checks the log's sha256, its canonical form and contract, its events hash, the gate table and its state hash,
  then the pin's block hash against `then`'s root, and commits the log with `then`'s first step; `PIN_MISMATCH`,
  `RULES_DIFFER` and `PIN_OFF_CHAIN` (a reorg or a chain below the pin included) are kept for the source's life and
  reach `why`. `open` and `openLog` throw `ReplicaConfigError` `PIN_MISMATCH` for a pin of another rule.
  `derivePin(fixture)` in `./server`; `local({ node, pin })` and `hosted({ pin, origin, witness })` in `./browser` and
  `./server`. Internal: `StepContext.floor` (the pin, else the activation height less one), where the roots and the
  fork search stop; `floorBreak` takes the floor.

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
  `TransferCursor`, `ReplicaStatus`, `Witness`), the reads `balance` (deep view, `atTip`), `primary` (`SHALLOW`),
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
