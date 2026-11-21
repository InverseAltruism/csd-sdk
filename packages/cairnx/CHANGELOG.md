# Changelog

## Unreleased

- The replay runs as a fold (one step per event, an end at the tip that alone reads the tip) and its expiry sweep
  applies each expiry at the first height it is due, one batch per such height in ascending order, where 0.2.8
  applied every due expiry in one batch before each event; from the first offer held with a NaN height (an input no
  chain produces, whose expiry rises across V21) it runs one batch per sweep, as 0.2.8 does. No rule changed:
  `scripts/seal-differential.mjs` finds the whole result, codes and moves included, identical to npm's 0.2.8 on every
  input, among them 3,000 sequences built so that offers, bids, reservations and recapture reservations end between
  events, 3,000 whose heights and expiries no chain produces, and a dense walk of 1,966,138 tips; no export changed.
  CONVENTION.md section 5 states that the state at a tip does not depend on the heights at which sweeps ran, for the
  heights a chain produces, and the NaN-height case; `conformance/fuzz-resolve.mjs` checks the property in the Python
  reference by adding events that write nothing, and gains `--expiry` and `--malformed` with a floor per kind;
  `test/sweep.test.ts` pins ten constructed streams; check mode asserts that each expiry lands at the first height it
  is due.

## 0.2.8

- Token moves in the applied log (CONVENTION section 41, no gate): an applied mint, transfer or fill that moved tokens
  carries `moves`, each `{ leg, ticker, from, to, amount }` (`TokenMove`, legs `mint`, `xfer`, `sale`, `fee` and
  `fill`), written by the line that applies the balance change in `src/resolve/tokens.ts` and `src/resolve/attest.ts`.
  A server that credits token deposits, or a replica that lists transfers, reads a capped mint's credit, a partial
  fill's delivered units, a sale and its fee from the log instead of restating the rules that decide them. A zero
  amount writes no move, a refused entry none, and `moves` is an entry's last key. No rule changed: canonical state,
  `stateHash`, `eventsHash`, every pinned vector and `replay-hashes.json` are unchanged, and the log with `moves` left
  out is 0.2.7's (`scripts/seal-differential.mjs` against npm's 0.2.7 and 0.2.4). `test/vectors/moves.json` (13 cases,
  `conformance/gen-moves-vectors.mjs`, expectations written by hand) pins them; `conformance/moves-check.mjs` checks,
  from the input events and the result, the identity (for every ticker and address, received less sent equals
  available plus locked), each transfer's and mint's move against its own record and each fill's moves against its
  fill record, run by `test/moves.test.ts` over the replay corpus at every pinned height and every case file, and by
  the seal over every input of its differential.
- `CAIRNX_CORE_VERSION` (`src/version.ts`), this package's version, kept equal to package.json's by
  `test/version.test.ts`: a host hands it to cairnx-api's `prepareView` without reading the manifest at run time.
- `GATE_HEIGHTS` (`src/gates.ts`), the gate table as frozen data: `ACTIVATION_HEIGHT` and every `V<n>_HEIGHT` by its
  exported name, built from the constants of `types.ts`, which are unchanged; `test/gates.test.ts` keeps it equal to
  the individual exports and complete. A reader that compares gate tables (the replica, a witness) imports it.
- Forward resolution is a root export, moved from the reference service without a change to its body: `resolveNameIn(names,
  name)` answers `{ name, addr, via, lapsed, owner }` for the name's `nset` address, else its owner, with `lapsed` from
  the name's `expired`, and null for an absent name or a pending reservation; `nameView(names, name)` gives the class a
  reader shows (`held`, `pending`, `lapsed`, `free`, `reserved`), the owner, and a held name's address and profile
  (CONVENTION section 35.3), or null for a string that is not a name. Both live in `src/forward.ts` and read `names`
  only; that change left `resolve.ts`, `resolve/`, `records.ts` and `types.ts` as they were in 0.2.7. CONVENTION.md section 35.4
  states the rule, and section 36.3 now says a name pays to its `addr`, else its owner, which is what the reference
  service answers. `test/vectors/forward.json` (14 cases, `conformance/gen-forward-vectors.mjs`, expectations written
  by hand) pins both functions; `test/forward.test.ts` replays it and compares the service's call shape with an oracle
  over every name of the replay corpus at each pinned height.
- CONVENTION.md corrected to match the implementation; no behaviour changed (that change touched neither `src/` nor
  `dist/`; every pinned replay hash and existing vector byte-identical). It now states: what a pending reservation refuses and how
  it is materialized (sections 9, 17, 22, 28); the expiry sweep before each event and at `tipHeight + 1`, and that a
  name's `expired` is read at the tip's epoch (section 5); the zero-delivery partial fill (12); the commit height as
  the first anchoring of its hash, the salt form and the reveal's own position and id as the contest key (9, 28, 29);
  the lowercase form of record hashes (3, 13, 18); the bid link and `done` (13); a token-priced offer's `"0"` price
  (3, 11); the recapture premium as the integer staircase `1 + floor(19 * (720 - e) / 720)` and the recaptured
  record's anchor (17, 29). Corrected sentences: `feesPaid` counts the fees applied records owed (10); a whole fill's
  `paid` is what it paid to payto, and a completed partial offer's `fill` carries `got` (5, A3); the claim fields stay
  after the hold and the offer end (20, A4); offers below 29 960 carry `feeBps` 0 (19); a same-block re-post of what
  an `ocancel` releases is refused from V14, and section 16 no longer says the case cannot occur on chain (12b, 16);
  the fclaim grant checks the expiry's 2^53 bound first and its order decides only the reason code (31); a list
  holding a transaction id at two places with the first copy below V29 is not a list section 33 produces, no
  conformance level covers it and the two reference implementations differ there (32); an un-finalized reservation
  is gone from the state at a tip equal to `finalizeBy` (28); one key can anchor several records in one block (6,
  16); the state's key order puts array-index keys first (5), the field lists of section 5 and A3/A4 are complete,
  and `FILL_UNDERPAID`, `FILL_REBATE_UNPAID` and `TREASURY_FEE_UNPAID` say what they mean on the rebate lane (40.4).
  README.md gives the recapture premium as 19x stepping down to 1x over about 28 days, where it said 20x to 1x over
  about 30.
- `test/vectors/cases-convention.json` (16 vectors, `conformance/gen-convention-vectors.mjs`) pins those rules and
  three the text stated that no vector pinned (`feeBps` 0 below 29 960, a CSD-priced offer wanting `"0"`, and a bid
  anchored after the offer that names it ending `done` with empty `offers`), each in a vector an implementation of
  the earlier text fails; replayed by `test/vectors.test.ts`, against the Python
  reference by `conformance/crosscheck-resolve.mjs`, and by the seal, which pins the file's sha256. A file of its own
  keeps the three case files the seal freezes at their bytes.
- `test/holdcount.test.ts`: the honest path of `countOtherHoldsAtGrant`'s skip of the buyer's closed holds, with the
  call shape the site and wallet send (`closed` from `myProvenFillClosedOffer`, the count into `verifyFillSpv`): three
  completed fclaim buys inside one hold window, then a fourth, counted 0 and safe to fill. No test passed `closed`
  before.

## 0.2.7

- No state change; replay cost. `resolve()` no longer copies and walks every open offer, open bid, pending reservation
  and recapture reservation before each event, nor every name or recapture reservation at each reveal for the
  per-address reservation caps, nor every offer at each claim for the live-hold cap, at each bulk cancel and at each
  displacement or recapture that voids a name's offers. `src/resolve/store.ts` holds those maps with private expiry
  queues (`minqueue.ts`) and candidate sets (per owner, per holder, per seller and give asset, per name), and is the
  only writer of the fields they key on (readonly to the handlers by type); each read evaluates the old walk's own
  predicate over its candidates and applies a batch in the walk's order. The first sweep at V21 or above re-keys the
  offers and bids anchored below V22 at their capped expiry. A sweep or a hold count at a height below an earlier
  one's (only NaN heights reorder the replay) takes the old walk, which also serves as the reference of a check mode
  the tests and the seal run. Nothing of it reaches the resolved state or the root exports.
- New root exports `applyOrder(a, b)`, the apply order of CONVENTION.md sections 3 and 33.3 (height, a block's Proposes
  before its Attests, position, the ordinal order of the id), and `eventId(e)`, a Propose's id or an Attest's txid.
  `resolve()` sorts with `applyOrder` and drops section 32's duplicates by `eventId`: the same comparison it made
  before, moved out of its body, so a reader that must list events in apply order (the replica) imports it instead of
  copying it.
- One run on the seal's streams on a loaded host, cairnx-core 0.2.4 against this release, in ms: 16,000 registrations
  5,061 / 1,000; 20,000 open bids 3,494 / 364; 20,000 offers with holds 31,683 / 887; 20,000 live reservations
  15,600 / 618; 20,000 live recaptures 22,508 / 1,872; 2,000 bulk cancels over 20,000 offers 14,230 / 523; 2,000
  displacements over 20,000 offers 20,636 / 567. Entries visited per event stay flat as a stream doubles.
- Kept as 0.2.4 has them: a bulk cancel still visits the seller's matching offers a live fclaim hold freezes, on each
  cancel while the hold lasts; below V29 a duplicated offer id applied after a same-block bulk cancel leaves the new
  copy open with its id out of the open set, so it never expires (only a feed that repeats an event can produce it).
- The output does not move: `scripts/seal-differential.mjs cairnx-core-0.2.4 fc6e081` finds `canonicalState`
  byte-identical to 0.2.4 and the whole result identical once `code` is left out, and identical to 0.2.6 with `code`,
  over every input it had and the streams of `conformance/growth-streams.mjs` at full size.

## 0.2.6

- Stable reason codes, CONVENTION.md section 40: each entry of the applied log gains `code`, the rule that decided the
  record, from a table of 113 (26 applied, 87 refused, 28 of them record codes; 3 caps). A code is never renamed,
  reused or removed; the note text beside it may change, and a reader treats a code it does not know by the entry's
  `ok`. New root exports `REASON_CODES`, `REASON_CODE_OUTCOME`, `CAP_CODES` and the types `ReasonCode`, `AppliedCode`,
  `RefusalCode`, `RecordCode` (`src/codes.ts`). Every entry `resolve()` writes carries a code; an unparseable record's
  entry carries its record code. Four codes guard states no event reaches (section 40.4 says why). The note texts are
  unchanged, so a consumer that matches them keeps working; `provenOfferRefusal` returns the same strings as before.
- `test/vectors/codes.json`: 145 resolve cases and 50 record cases whose expected codes are written by hand in
  `conformance/gen-codes-vectors.mjs`; together they reach the 109 codes an event can reach. The Python reference
  writes no codes.
- `explainRecord(uri, payloadHash)`: `{ ok: true, record }` or `{ ok: false, code }`, the first record rule the uri
  breaks. `parseRecord` keeps its signature and answers and shares one implementation with it. A builder that refuses
  throws `RecordError`, an `Error` with `code`; its message is "record does not validate against CONVENTION.md (<code>)",
  which until now ended at "CONVENTION.md".
- No state moves: `scripts/seal-differential.mjs` against cairnx-core 0.2.4 finds `canonicalState` byte-identical, the
  whole result identical once `code` is left out, and `parseRecord` accepting exactly what it accepted.

## 0.2.5

- CONVENTION.md section 33, "From a block to events": the rule that turns the chain's blocks into the events
  `resolve()` replays (membership from the activation height, first occurrence, order, field forms, the author as the
  owner of the coin the first input spends, the byte form of an event list). It also accepts a sparse block: every
  transaction with an app payload at its true position. Section 32's "there is no straddle case" is corrected (a
  transaction can be mined again, in two blocks), and C3, section 3 and section 5 point at section 33.
- New root exports `eventOfTx`, `blockMembers`, `blockEvents` and `CAIRNX_EVENT_RULE`, with
  `test/vectors/events.json` (40 transaction and 25 block vectors, `conformance/gen-events-vectors.mjs`), checked by
  `test/events.test.ts` and against the Python reference by `conformance/events-crosslang.mjs`. In JavaScript a u64
  input is a bigint in [0, 2^64) or a number that is an integer in [0, 2^53]; a number above 2^53 is refused.
- `resolve()`, `records.ts` and `types.ts` are unchanged, and every pinned vector and replay hash is byte-identical.
  Section 33.2 makes normative the input form the reference service's feed has always had: the first occurrence of a
  transaction id at every height. A reader that feeds `resolve()` every copy of a re-mined transaction can differ from
  the reference when a copy lies below V29: a transaction mined at 87,999 and again at 88,001 is one event under
  section 33 and two applied records under `resolve()` fed both copies. For history the case is empty: a scan of every
  block from 29,860 to 144,400 (block hash 0x0000000000001874564bd8df5a5893040b0981d96c646e132e3598488d0411b5) on
  2026-11-18 read 114,541 blocks and 148,395 transactions with 148,395 distinct transaction ids, so no transaction id
  has been mined twice since activation. The script for that scan ships with the block fixture in the next slice
  (events-rule-b).
- A reader that switches to `eventOfTx` sees two forms change, neither of which moves state: an expiry above 2^53 - 1
  becomes 2^53 (resolve() refuses both alike for offers, bids and fclaims, and reads it for nothing else), and a `uri`
  holding U+0000 has it written as U+0001 (neither form is JSON, so neither is a record).
- CONVENTION.md section 34, "State hash and events hash": the two hashes replicas compare at one block, and what a
  difference in each means. New root exports `stateHash` (sha256 of `canonicalState`'s UTF-8 bytes, the digest
  `replay-hashes.json` already pins), `eventsHashStep`, `eventsHash` and `EVENTS_HASH_START`: a running sha256 over
  each event-holding block's height and its events' positions, transaction ids and authors. Vectors in
  `test/vectors/hashes.json` (43 cases, and both hashes over the replay corpus at its 21 pinned heights,
  `conformance/gen-hashes-vectors.mjs`), checked by `test/hashes.test.ts` and against the Python reference by
  `conformance/hashes-crosslang.mjs`; the replay-hash test and `replay-corpus-crosslang.mjs` call `stateHash`.
- New root export `FINAL_DEPTH` = 12: how far below its tip a replica holds an epoch boundary before it publishes or
  compares the tuple of section 34.3 there. Section 38 names it; the thresholds of section 3 (3 and 6) are display
  conventions and are not this depth.
- CONVENTION.md sections 35 to 39, with no gate: other applications (record types under `cairnx:v1` reserved, an
  application's own domain, the profile as the place for data about a name), the profile-key registry with its caps,
  keys, reader rules and byte budget (`scripts/profile-budget.mjs` prints it), what a result proves at each of the
  three levels, conformance, and how the rules change. No package code and no state change.
- cairnx-core now declares `@noble/hashes` 1.8.0, the release csd-codec already pins, for its sha256 (csd-codec
  exports none): no new package enters an install.

## 0.2.4

- `verifyFillSpv`'s contract and comments say what its window replay decides. A grant depends on the holds granted
  in the `GAP_NEEDED` (104) blocks before it and on the proposer's live holds on other offers, so a window decides an
  fclaim only when its low end is quiet. The comments no longer say a proven event "only moves the replay toward
  truth" or that the replayed `paid` is the chain's, and its doc lists what it refuses over a window that holds the
  offer's history, including one honest case: the cap count includes the buyer's earlier fclaims on other offers the
  chain denied, so three denied ones refuse a later fill the chain granted. A "Known limits" list names, by step, what a
  window without it gets wrong, first for a caller that uses only `verifyFillSpv` and then with the site's and the
  wallet's own checks: the grant replay (a hold chain from below the window can grant the caller's own fclaim the
  chain denied, with an honest resolver; the site's served-hold check and the wallet's second-source read bound it),
  aged fills at delivery (an honest tail below `min` is refused; for a coarse give the delivery check can disagree
  with the chain's either way, so a caller refuses a payment its served offer computes as undeliverable) and the
  sums bind (a served offer that omits such a fill and serves a lower `paid` passes it; for the site and the wallet
  that needs the project's resolver to lie). The `FillSpvIo` contract names the offer and its give-backing among the
  events the replay needs, and says backing a seam synthesizes (the site and the wallet do) is not proven and makes
  the grant verdict conditional on the offer's resolver-trusted admission. Reading the history below the window is
  not implemented. CONVENTION.md section 31's client policy says the same and gives `FILL_TIP_MARGIN` as 4 (it
  said 2). Comments and docs only.
- The `FillSpvIo.provenEvent` contract says `proposer` and `attester` are the prevout-bound author (csd-crypto
  `authorOf`), never the signer read from the scriptSig, which the txid does not commit, and that an event whose
  author cannot be bound is null. A seam that took the author from the scriptSig let a body server move a hold or
  a fill to another address. The site's and the wallet's seams already bind it.
- `test/vectors/cases-rules.json` (5 vectors pinning 3 rules, `conformance/gen-rule-vectors.mjs`), replayed by
  `test/vectors.test.ts` and against the Python oracle by `conformance/crosscheck-resolve.mjs`: a same-block fclaim
  fill (the fill at the lower position and in the natural order) and a same-block seller cancel at the lower position
  (proposals apply before attests within a block), a deploy whose uri is not its canonical JSON but whose payload
  hash is the canonical form's (invalid), and a token offer giving and wanting one ticker (invalid). Removing or
  reversing the order key, the canonical-uri check or the same-ticker refusal, in either implementation, now fails them.
- New root export `offerFillTooLate(expiresAt, tip)`, beside `offerExpiryHeightOf`: a policy refusal once fewer than
  `FILL_TIP_MARGIN` (4) blocks of cushion remain before the offer's last live block (`expiresAt - 1 < tip +
  FILL_TIP_MARGIN`). It does not mean the fill cannot mine (expiry 100, tip 96 returns true; inclusion at 97 to 99 is
  possible). A fill not mined by that block is refused by the node: for an offer anchored at V22 or later it strands
  and moves no payment; for one anchored before V22 whose expiry the v2.1 cap shortened, the resolver expires it while
  the node still mines its attests, so a late fill there pays and delivers nothing. It was the wallet's own
  predicate; the wallet, the site and cairn-sdk import this one. `fillEndorsement` was already a root export; both
  are now pinned in the export-surface test.
- `requiredClaimDepth`'s doc and `CLAIM_ATTACKER_Q`'s comment no longer call the dominant block producer trusted or
  the wait reorg-safe: the depth makes a reorg by a minority miner (20% of the hashrate) unlikely, and the external
  pool that produces most blocks is outside the model. The depths are unchanged.
- Docs (README, CONVENTION.md's overview and section 4.5, MAKERS.md, the package description) no longer call
  a fill atomic delivery-versus-payment or say a buyer cannot lose more than the anchor fee. One transaction pays and
  records a fill and the replay decides delivery: a CSD-paid fill it refuses keeps the payment; a token-for-token
  fill is atomic.
- README: the registration lifecycle and records table describe the v2.5 sealed reservation (a payment-free reveal
  within 8 blocks, the fee at `nfinalize`), the open lane is the v2.8 `fclaim` reservation, the version table gains
  v2.8 and v2.9 and drops a stale "pending" note, the conformance steps name every vector file, and cairn-cli
  (deprecated) and the indexer's storage backend are no longer described.
- README: forward name resolution no longer says the wallet refuses a send whose sources disagree or cannot be
  proven. It sends to the SPV-proven address with a "sources disagree" warning, shows an unprovable name as not
  chain-verified with the served address and a caution, and refuses only an unresolved or lapsed name and a change
  between review and confirm (the wallet's SECURITY.md).
- MAKERS.md's configuration table follows the reference bot: `MM_FILL_BIDS` defaults to 0 (fills and bid posts
  off until set; with 1 and `MM_VERIFY_INCLUSION` off the bot alerts and publishes `build.fillsWithoutInclusion`),
  and new rows for `MM_MAX_BALANCE_READS` (20 bidder balance reads a pass), `MM_SUNRISE_START_TIP` and
  `MM_SKIM_TO` (the one address a live skim may send to; `MM_ISSUER_ADDR` is not the skim destination).
- New root export `FCLAIM_MAX_HOLD_SPAN` (89): the longest fclaim hold, so a fill at height f has its fclaim in
  `[f - FCLAIM_MAX_HOLD_SPAN, f]`. `GAP_NEEDED` is now written as `FCLAIM_MAX_HOLD_SPAN + CLAIM_COOLDOWN_BLOCKS`, same
  value (104). The site's refusal before the reservation fee needs it to tell which listed fills may lie below the
  window its fill check reads; the wallet held a copy of it.
- `resolve()`, canonical state and every `verifyFillSpv` verdict are byte-identical to 0.2.3.

## 0.2.3

- `provenOfferRefusal` refuses the two record-only activation gates it lacked. An offer anchored below
  `ACTIVATION_HEIGHT` (29,860), where `resolve()` skips every event, is refused with "anchored before CairnX
  activation (block 29860)"; a name offer anchored below `V11_HEIGHT` (29,960) with the resolver's own note "name
  offers need v1.1". Before, a canonical name offer proven at 29,959 returned no refusal. Correction to 0.2.2: its
  entry said `provenOfferRefusal` returns the resolver's note "for every rule that needs no chain state"; it covered
  only the rules in `offerEnvelopeRefusal`, without these two.
- The name-offer v1.1 rule moved from `applyOffer` into `offerEnvelopeRefusal`, after the rules already there, which
  is where `applyOffer` checked it. New root export `beforeActivation(height)`, which `resolve()` reads to skip
  events below `ACTIVATION_HEIGHT` and `provenOfferRefusal` reads to refuse them.
- `resolve()` and canonical state are byte-identical to 0.2.2.

## 0.2.2

- `verifyFillSpv` fails closed when any id `offerEventIds` returns cannot be proven: `provenEvent` throws,
  returns null, or returns an event under another id. It used to drop that event from the grant replay, so a
  seller cancel whose block read failed replayed the offer as open. New refusal text: "an event on this offer
  could not be merkle-proven (<id>) - refusing, the replay would miss it"; the offer and fclaim keep their
  existing texts. The site's and the wallet's io return only ids they proved, so their honest fills do not move.
- New root export `countOtherHoldsAtGrant(candidates, target, me, closed?)`: the buyer's live holds on other
  offers at an fclaim's grant, the `myLiveHoldsAtGrant` count for `verifyFillSpv`. It counts only fclaims applied
  before the target (height, then position in the block), distinct offers, holds live at the grant height, and
  skips the `closed` set. The site and the wallet counted later fclaims too, so a buyer's fourth reservation
  (denied on the cap) made every earlier granted hold unfillable. An earlier fclaim the resolver denied is still
  counted (an over-count, which only refuses). It returns `HoldCount` (`{ ok: true, count }` or
  `{ ok: false, reason }`, which a caller treats as unsafe). Its domain is grants at or above
  `LEGACY_HOLD_SUNSET_HEIGHT` (exported, 60,044: the last legacy claim at V28 - 1 plus its window and grace);
  below it a legacy SCORE_CLAIM hold can still count against the cap and the counter does not read those, so it
  refuses ("this reservation was granted at <h>, before block 60044, while claims made before V28 could still
  count against the cap; it cannot be checked here").
- `finalizeWinnerCheck` refuses a supplied `tip` that is not a non-negative safe integer ("the chain tip given
  (<tip>) is not a block height, so the finalize window cannot be checked"). A NaN, Infinity or fractional tip
  used to skip or pass both window comparisons and return safe. An omitted or null tip keeps the winner-only check.
- New root export `provenOfferRefusal(rec, { domain, height, expiresEpoch, seller })`: the admission check for a
  merkle-proven offer Propose. It refuses a domain other than `cairnx:v1` ("not a cairnx:v1 Propose (domain
  "<domain>")") and then returns the resolver's own creation note for every rule that needs no chain state
  (v1.2 shape before activation, the V13 to V17 open CSD offer ban, a treasury payee, an expiry outside the safe
  integer range or already past at the anchor, the V21 to V22 duration cap). `applyOffer` now reads those rules
  from the same function (`offerEnvelopeRefusal` in `src/resolve/market.ts`), in the same order with the same
  notes. The give's backing is chain state and is not checked.
- `bindOfferTerms`'s wantType leg (on by default) also binds a token want's price: for a proven token want the
  served `want.ticker` and `want.amount` must equal the record's, verbatim. `provenOfferTerms` carries them as
  `wantTicker` and `wantAmount`. Before, a token-priced offer served with another ticker or amount passed, and
  each caller (the site, cairn-sdk `preverifyOffer`) compared the price itself. Callers opting out with
  `{ give: false, wantType: false }` keep the earlier verdict.
- New root export `MAX_TOKEN_DECIMALS` (8), the bound `parseRecord` applies to a deploy's `decimals`; the parser
  reads it, so a consumer validating a served token's decimals uses the same number.
- `resolve()` and canonical state are byte-identical to 0.2.1.

## 0.2.1

- Internal split, no behaviour change: `src/resolve.ts` keeps the replay loop and dispatches each record to
  handlers in `src/resolve/` (tokens, names, market, attest) over one shared state context. The exported names
  and their types are unchanged, and `resolve()` returns the same state, event log included, for the same input.
  Every consumer may stay on 0.2.0.

## 0.2.0

Breaking for callers that hand-build `ProvenOfferTerms` or rely on the old two-argument verdict; see Migration.

- `bindOfferTerms` checks the give and wantType legs by default. A served offer whose `give` (ticker, amount
  or name) or want type differs from the merkle-proven offer now counts as a mismatch with the two-argument
  call too. To opt out, pass `{ give: false, wantType: false }`: that returns the 0.1.44 two-argument verdict
  on every input. Opting out of one leg leaves the other on.
- Type change: with a leg on, the terms must come from `provenOfferTerms` or `bindProvenOffer` (the
  `MintedProvenOfferTerms` brand). A hand-built `ProvenOfferTerms` compiles only with both legs off (the new
  `LegacyBindOpts` type). At runtime, hand-built terms passed without the opt-out lack the give and wantType
  fields and are refused (the predicate returns `true`).
- Callers that already pass `{ give: true, wantType: true }` with minted terms get the same verdicts as before.
- Depends on csd-codec 0.1.18 (reject-more input canon, see `CONSENSUS_CHANGES.md`); `records.ts` imports
  the codec's well-formed UTF-16 predicate instead of its own copy, with the same verdicts.
- `resolve()` and canonical state are byte-identical to 0.1.44.

Migration. Callers that already pass `{ give: true, wantType: true }` with minted terms need no change (the
site's `swapguard.js`, the wallet's `wallet.ts` and cairn-sdk's `fillverify.ts` production path). These move
together with the 0.2.0 pin:
- cairn-sdk `test/fillverify.test.ts`: the two-argument assertions on hand-built terms expect the old default
  (the inflated give passing); pass `{ give: false, wantType: false }` there or expect the refusal.
- cairn-sdk `src/fillverify.ts`: the result's `terms` field is typed `ProvenOfferTerms`, which drops the mint
  brand, so a dApp passing it back to `bindOfferTerms` without the opt-out no longer compiles; type it
  `MintedProvenOfferTerms`.
- cairn `test/b7a-flip.test.mjs`: its two-argument call asserts the give leg is off; it now refuses.
- cairn-wallet `src/vendor/cairnx-spv.js` and `cairnx-spv.d.ts`: the vendored bundle keeps the 0.1.x
  contract (legs opt-in) until it is re-vendored from 0.2.0.

## 0.1.44

- `rfqFillAllIn(n, feeBps?)` (`cairnx-core/mm`) takes the offer's fee rate; omitted or null keeps
  `FEE_BPS_V16`, so every existing one-argument call returns the same number.
- `epochOf` now lives in `csd-codec` next to `EPOCH_LEN` and is re-exported from the root unchanged.
- New root exports, none read by `resolve()`: `ptAmt` (the resolver's own paidTo amount reader),
  `burnedPayment` (what a refused record paid to the treasury, and for a fill to the offer's seller and payto,
  never counting the payer) and `myProvenFillClosedOffer` (whether a buyer's own merkle-proven full fill closed
  the offer behind one of its fclaim holds, for the V29 cross-offer hold count).
- `resolve()` and canonical state are byte-identical to 0.1.43.

## 0.1.43

- New subpath `@inversealtruism/cairnx-core/mm` (ESM and CJS, built to `dist/mm/`). The root export, the
  resolver and every consensus file are unchanged; `dist/index.*` is byte-identical to 0.1.42.
- `mm` holds the market maker's non-consensus math in one place for the maker service and the site:
  `sizeBid`, `acceptBid`, `tierFor` (bid sizing against the indicative ladder), `tradeNotional` (contractual
  volume of a fill), `expScaled`, `sunriseTimeMult` and `sunriseCurve` (the Sunrise spot curve), and the
  RFQ all-in sums `rfqBuyAllIn` and `rfqFillAllIn`, and `priorBuyers` (the returning-buyer rule: buyers of fills
  of offers the maker sold) (built from `tradeFee`, `makerRebate`, `FEE_BPS_V16` and the
  codec's minimum fees).
- New Sunrise order pricing: `sunriseOrderCost` is the integral of the spot curve over an order, rounded up;
  `sunriseAnswerPrice` adds a flat margin and a per-token floor; `sunriseTokensFor` inverts it for a budget.
  `expm1Scaled` is the fixed-point e^z - 1 behind it (scale 1e18).
