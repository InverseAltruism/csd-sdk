# Consensus changes

This file tracks every released change to the **byte-level consensus surface** of the SDK:
anything that alters what bytes a transaction/sighash/header serializes to, what the LWMA or
chainwork math computes, what a merkle proof accepts, or what the CairnX replay derives. If a
release is not listed here, it did not touch consensus behavior.

## Why this exists, and the rule for consumers

The packages are released on **independent cadence**: `@inversealtruism/cairnx-core` tracks consensus
activation heights and bumps ahead of the stable `@inversealtruism/csd-*` primitives, which move on
their own; they need **not** share a version. Inter-package dependencies are published as **exact
versions** (no `^`/`~`: `workspace:*` is converted to the dependency's exact current version when the
dependent publishes). A dependent published BEFORE its dependency moved keeps the old pin, so a dependency
bump must bump every workspace dependent too. CI enforces `workspace:*`, published pins equal to the
current workspace versions, a published version's tarball dist equal to this tree's build, and
dist-freshness (`scripts/check-lockstep.mjs`); cross-package
byte-identity is enforced separately by the conformance job (the REAL guard).

**If you build on these packages, pin exact versions and let your lockfile resolve the matching
inter-deps.** A lockfile that
mixes, say, `csd-codec@0.1.4` under `csd-tx` with `csd-codec@0.1.6` under `csd-light` can sign
with one byte-encoding and verify with another. The packages themselves can't fully prevent a
consumer lockfile from holding two codec copies; uniform exact pins in *your* `package.json` do.

```json
"dependencies": {
  "@inversealtruism/csd-codec":  "0.1.5",
  "@inversealtruism/csd-crypto": "0.1.5",
  "@inversealtruism/csd-tx":     "0.1.5",
  "@inversealtruism/csd-client": "0.1.5",
  "@inversealtruism/csd-light":  "0.1.5"
}
```

Consensus-critical packages: **codec** (serialization, canonical JSON, merkle), **crypto**
(sighash `CSD_SIG_V1`, RFC-6979/low-S, p2pkh), **tx** (transaction construction), **light**
(header validation, LWMA-45, chainwork), **vectors** (the golden contract all of the above must
match). `client` is transport (consensus-relevant only in what it passes through);
`cairnx-core` carries its own determinism contract (state-replay hashes + conformance vectors
in the package).

## Auditing a resolver / consensus change (directive)

Before releasing any change to `cairnx-core` resolver behavior (`packages/cairnx/src/*`) or adding a
consensus gate, run the money-safety audit tooling in addition to `test:crosslang`:

```
pnpm run audit:all     # record citations + ledger-soundness invariants + money-safety + adversarial races
```

`test:crosslang` proves JS and Python agree byte-for-byte, but two implementations can AGREE and both
be unsound (a burn, a mint-from-nothing, a leaked lock). `audit:all` checks the ledger stays sound and
that no honest-user money is burned. CI's conformance job runs it, and its invariant and money-safety
findings are report-only there (printed, exit 0; a stale citation, a failed self-test or a JS/Python
divergence fails the job), so read its output before a merge. When a
change adds a feature the audit fuel does not exercise, extend the fuel first (see
`conformance/AUDIT.md`, "Standing practice"). A clean run with a thin coverage line is a weak signal.

## History

## csd-codec 0.1.19, csd-client 0.1.21, csd-crypto 0.1.22, csd-light 0.1.28, csd-tx 0.1.25, csd-siwc 0.1.23, cairnx-core 0.2.11, cairnx-api 1.0.1, cairnx-replica 0.2.2 (2026-11-24 to 2026-11-28, Plan 91 closing review; unreleased; reject-more in the merkle proof check, no consensus-surface change) - a merkle proof proves the position

No replay output changes in this wave. Against db9e0fa (the last merge before it), `resolve()` over the recorded replay
corpus at each of its block heights (state hash, events hash, canonical state and log) and over every case file of
db9e0fa's vectors gives byte-equal output, the held replay context equals `resolve()` at every one of those heights,
the tuple tests print the same, and `pnpm test:crosslang` is byte-identical in every mode. csd-crypto and csd-siwc
only pin the new csd-codec; csd-tx's `txToNodeJson` decodes hex through csd-codec's `hb` (a direct call with a field
that is not hex now throws), and the bytes a builder signs and submits are unchanged.

csd-codec `verifyMerkleProof` returned true for a position the transaction does not hold, three ways: a position
above the level count (`pos + k * 2^levels`), a non-integer or non-number position (`4.5`, `"4"`, read through
`idx & 1`), and, inside the level count, a position that reads an odd row's duplicated last node from the right
(in a block of 6 transactions the one at 4 also verified at 6, after the one at 5). It now returns false for a
`pos` that is not a safe integer in `[0, 2^levels)`, for a level at which the node is the right child of a sibling
equal to it, and for a branch of more than 32 levels. The last is a sanity bound, not the chain's block cap, so a
wallet that keeps this code for years still verifies blocks larger than today's (2^32 transactions of at least 28
bytes is over 100 GiB, and below it every position is an exact integer); the position rests on the other two. An honest proof has no such level: an odd row pairs its last node as the left
child of its own copy, and two equal adjacent subtrees would hold one txid twice, which the node refuses in a block
(compute-substrate `src/state/utxo.rs`, "duplicate txid within block"; CONVENTION section 33.2). A true answer now
proves membership and position; it still does not prove that the value is a transaction id (an inner node folds
with the shorter branch above it) or that the root's header is on the chain.

No honest proof is refused: every transaction of the 684 distinct recorded node blocks in this repo (789
transactions, the largest block 8), of synthetic blocks of 1 to 40 transactions (820), and of blocks of 2,000 (11
levels) and 5,000 (13 levels) verifies at its position; of the other positions below `2^levels`, the old check
accepted 18 in the recorded blocks, 375 in the blocks of 1 to 40, 48 in the block of 2,000 and 3,192 in the block of
5,000, the new one 0. `merkleRoot`, `merkleBranch`,
txids, sighashes, headers and `resolve()` are unchanged; `resolve()` reads no merkle proof.

cairnx-replica's Scanner, with `verifyInclusion` on, takes each event's position in its block from that proof, so a
lying indexer could reorder two proven records of one block; with the codec above such a proof fails the scan. A
proof position that is not a safe integer >= 0 fails it as `SOURCE_MALFORMED` before the fold, through cairnx-core's
`isIndex`, now exported from the root; before, such a position became the event's and reached `resolve()`.

cairnx-core's `fillEndorsement`, a helper `resolve()` does not read, refuses from `LEGACY_HOLD_SUNSET_HEIGHT` a fill
of an open CSD offer whose target is the offer id, which `resolve()` refuses at those heights whatever claim a
resolver serves (the package CHANGELOG has the matrix against `resolve()`).

csd-client, transport only: the error a request throws for a non-2xx answer also carries `status` and, when the body
arrives within 1 second or the request's remaining time if less, `body`, the first 4,096 bytes as text
(`ERROR_BODY_MAX_BYTES`, `HttpErrorFields`), so a caller can tell why a node or proxy refused a transaction. Its
message, its `terminal` flag and the retry rules are unchanged: a 5xx within the retry budget is retried without
reading its body. A body that is late or cannot be read is not waited for further and leaves no `body`, so a refusal
is thrown at most 1 second later than its status arrived.

csd-client, csd-light and cairnx-replica declare `engines.node` `>=22` (the others keep `>=18`). `parseJsonExact`
keeps an integer above 2^53 - 1 exact only where `JSON.parse` hands its reviver the source text, which Node 18 and 20
lack; there such a value comes back rounded, so a block holding one (a Propose's `expires_epoch`, which the node does
not bound) fails closed: csd-light refuses to bind it (`malformed`) and the replica does not step past it. npm only
warns about `engines` unless the consumer sets `engine-strict`.

## cairnx-core 0.2.10, cairnx-api 1.0.0 (2026-11-22, Plan 91 G6 slice 2; published 2026-11-22; consensus-surface files edited, no rule change, new exports) - a held replay context

No rule changes. New root exports: `newReplayContext`, the type `ReplayContext`, `ReplayContextRefusal` (with its code
type) and `isChainHeight`. CONVENTION.md section 5 gains one paragraph: a resolver may hold its replay between tips and
answer in place inside the domain. `resolve.ts` exports `createFold` and `events.ts` exports `isIndex` to
`src/replay-context.ts` only (neither from the root), and the fold's `inDomain` now reads `isChainHeight` (`types.ts`,
exactly `Number.isSafeInteger`), the rule the context's refusal reads too; `resolve()` performs the same operations as
in 0.2.9.

A held context runs the fold between tips: `advance(toHeight, events)` applies the whole blocks above its height in
apply order, and `stateAt(t)`, at that height, runs the fold's end in place (the last flush, the closing sweep at `t +
1`, the materialized state). Inside the domain this is a full replay's answer: the answer's sweep at `t + 1` is one
more sweep height, the exact-height sweep's effect sequence does not depend on sweep heights (0.2.9's entry), and the
next block's flush and sweep follow the answer as they would follow the block before. Outside the domain the fold's
single batches depend on where sweeps run, so the context refuses ("domain") and the caller replays. It refuses
("domain") too an event whose position is not a safe integer >= 0 (`isIndex`) or whose id is not a string: there
`applyOrder` is no consistent order (a NaN key compares equal), and a sort of one block alone can order it unlike
`resolve()`'s sort of the whole stream. `advance` reads its argument once into one array of one-level copies of the
events: a block's deferred cancels read their event's height, position and id again at the next flush, which a
caller's later write into the event would otherwise reach; `paidTo`, not copied, is read during the call only. The
other refusals are "order" (a new context stands at -1, so a negative height is refused), "tip", "broken" (after the
replay threw inside `advance` or `stateAt`) and "sloppy" (a build running the module in sloppy mode), each thrown
before any write. An answer shares nothing a later advance writes: open offers and every bid are copied one level deep
(an offer that answers a bid is pushed onto its offers, closed or not), the log is sliced, and the parts it shares
(closed offers, their nested records, log entries, profiles) are frozen, so a write the fold made there would throw
and break the context instead of changing an earlier answer.

What is claimed: for inputs made of plain values (what JSON carries) whose tips and event heights are safe integers,
whose event positions are safe integers >= 0 and whose event ids are strings (the context refuses any other), the
context's answer at t equals `resolve()` over the same events at t, including the whole result, and an answer handed
out earlier does not change later, nor does a write into an event after it was given; where `resolve()` throws inside
the replay over the same events (in a handler, or at the end at the tip), the context throws that error (from
`advance`, or from `stateAt` for a throw at the tip) and refuses every later call ("broken"). A throw while `advance`
reads its argument (one that is not iterable) is `resolve()`'s throw too and leaves the context as it was. A getter or
a conversion with side effects is outside the claim, as for `resolve()`.

The proof is `scripts/seal-differential.mjs cairnx-core-0.2.4 cairnx-core-0.2.9`, each baseline bound to npm.
`resolve()` is state-neutral: its whole result, codes and moves included, is identical to 0.2.9's and `canonicalState`
byte-identical to 0.2.4's over the inputs of 0.2.9's proof (the 97 cases of the case files, the replay corpus at 795
heights, 20,000 fuzz sequences, 3,000 `--expiry` and 3,000 `--malformed` sequences, the latter compared with 0.2.9
alone (122 threw alike; 0.2.4 and 0.2.9 differ on 9), the 145 resolve cases of `codes.json`, the 14 of `forward.json`
and the 13 of `moves.json`, 65 stream inputs, and the dense walk's 6,012 walks and 1,699,031 tips). The seal's new
step (i) walks a held context through 26,303 of those inputs (the case files, the fuzz and the vector cases at each
event height and the tip; both fuzz modes and the sweep streams at the dense walk's tips; the growth streams at full
size, one of them holding 20,000 open bids, at their tips and 20 event heights each): 1,270,287 answers, each equal to
`resolve()` over the same prefix at that tip and each re-read unchanged at the end; 2,274 refusals, 1,852 "domain"
exactly where a height or the tip fails `isChainHeight` and 422 "order" exactly where a negative height or tip meets a
new context; no answer that differs. Check mode is clean on 24,357 inputs, the token moves of 28,607 inputs check,
`parseRecord` is equal over 275,166 records, 1,418 client-surface checks agree, and crosslang is green.
`packages/cairnx/test/replay-context.test.ts` walks every height of the sweep streams (D at its dense tips), every
event height of the replay corpus with the heights below them and the pinned heights, and the growth streams at 500,
with answers at seeded random steps against one step per block, answers written over, a reorg, each refusal with the
context unchanged (positions and ids outside the domain among them), a fed event written over after `advance`, a
generator as the events, an answer's name profile written over, and the sloppy-mode refusal. cairnx-api 1.0.0 (0.1.3
was never published) adds `order=length` on `names`, takes this core as its exact peer and is the read API's contract.

## cairnx-core 0.2.9, cairnx-api 0.1.2 (2026-11-21, Plan 91 G6 slice 1; published 2026-11-22; consensus-surface files edited, no rule change) - the replay as a fold, and the expiry sweep by due height

No rule changes. `resolve.ts` runs the replay as a fold: one step per event in apply order, and an end at the tip
(the last flush of deferred cancels, the closing sweep at `tipHeight + 1`, the materialized state) that is the only
step reading the tip. No export and no type changed; `dist/index.d.ts` differs from 0.2.8's by two colons in
`canonicalState`'s comment, where em dashes were, and by the version literal of `CAIRNX_CORE_VERSION`.

`resolve/store.ts` sweeps by due height. Before the batch at its own height a sweep runs one batch at each lower
height at which the head of an expiry queue falls due, in ascending order: an offer or bid keyed k from
`(k + 1) * EPOCH_LEN`, a reservation or recapture reservation from `finalizeBy + 1`, and V21 while no sweep has
reached it, where offers and bids anchored below V22 take their capped keys. Each item thus expires at the first
height it is due, and the sequence of expiry effects does not depend on the heights at which sweeps run. 0.2.8 and
`cairnx_ref.py` apply every due expiry in one batch before each event; for the heights a chain produces the two give
the same state because expiry effects commute: what is due only grows with height, whether an item is due reads that
item alone, each effect is an addition to one seller's balance, an idempotent unlock, a status write on the item
itself or the deletion of one key, and a sweep writes no log entry. CONVENTION.md section 5 now states the property.
Check mode asserts each batch against the walk at its height and, while sweeps split, that no item of a batch was due
one height lower.

A later change breaks the property, and needs the sweep's order proved again, if it writes a log entry per expiry,
records on an item when it expired, lets one expiry close or change another item (a bid's end voiding its answers, a
reservation's end touching offers, a lapse applied by the sweep), makes a release other than an addition, or makes
being due depend on another item. Each also makes a replay depend on events that write nothing. What catches that is
the reference side of `conformance/fuzz-resolve.mjs --expiry`: the Python reference sweeps before each event and
resolves each sequence again with events that write nothing added. The JS side does not go red there, since
cairnx-core's sweep runs the same batches with or without them, and a log entry per expiry would not show at all, the
gate comparing canonical state.

Inputs no chain produces broke the equality twice in review (the other vendor's two passes). An offer whose event
height is NaN has a NaN cap from V21 on, so it is due below V21 and at no height from V21 on: a batch at its raw due
height expired it where 0.2.8 keeps it open. A commit at the string height "90000" gives a reservation the deadline
"90000820": the next due height read it as the number 900008201 and a batch deleted the reservation, where 0.2.8's
sweep at the string height "1000000001" compares text and keeps it, and with three such reservations a fourth reveal
passed the cap 0.2.8 refuses. A first fix recognised the NaN-height offer as it entered the store; the string deadline
came through a reservation, so recognising items kind by kind does not close the class. The batches at due heights now
run only inside the domain they are proven for: every event height and the tip a safe integer. `resolve.ts` holds the
one predicate, `inDomain`, applied to each event's height before its sweep and to the tip before the closing sweep;
the first value outside ends the batches for the rest of the replay (`endSplit`), and from then on each sweep is the
single batch, whose code is 0.2.8's sweep. By the lines cited here, every other value that reaches a due test or a
queue key is a safe integer already or follows from a height: an offer's `expiresEpoch` is refused unless a safe
integer (`packages/cairnx/src/resolve/market.ts` :175, `Number.isSafeInteger(`), a bid's likewise (:77), and each
`finalizeBy` is an event height plus `REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS`
(`packages/cairnx/src/resolve/names.ts` :86 and :120), from the reveal's height or a commit's (:32,
`commits.set(rec.commit, ev.height)`). Inside the domain the NaN-height condition could not fire, so it is removed.
Sweep streams X, X2, Y and Y2 pin the four cases against 0.2.8, and the seal's step (d3) compares the sequences of
`fuzz-resolve.mjs --malformed` (values of every type on every kind and on the tip) with 0.2.8. Check mode, whose index
reads as the plain walk only inside the domain (0.2.8's own check mode throws on a string deadline), runs on the
sequences inside it. Outside the domain the released versions already disagree: on a string deadline 0.2.7's indexes
read differently from 0.2.6's walk (the tree before the store, a805573^, equals 0.2.4 on each of the nine widened
sequences that show it, the 0.2.7 tag differs on each), and 0.2.8 and this version follow 0.2.7. No chain produces
such an input, so the seal's step (d3) compares with 0.2.8 alone and prints how many inputs 0.2.4 and 0.2.8 disagree
on.

What is claimed, and over what. For inputs made of plain values (what JSON carries) 0.2.9 returns what 0.2.8 returns
and throws where 0.2.8 throws: 0.2.8 read each event's height and id in a pass before its first handler and 0.2.9
reads each event when it applies it, which reaches the same first throw as long as each event is an object. Two inputs
outside plain values are known to differ: an event whose `height` is a getter that answers differently on later reads
(0.2.8 applies the event, 0.2.9 skips it, since the fold reads the height once more, in `inDomain`), and an events
array with an `undefined` entry after an event whose handler throws (both throw a TypeError, the texts differ;
`packages/cairnx/test/fold.test.ts`). An accessor or a conversion with side effects is outside the claim. Heights and
the tip are consensus only as a chain produces them, non-negative integers below 2^53: outside that, released cores
answer differently (0.2.4 and 0.2.7 on a string deadline, above) and the Python reference differs on NaN and the
infinities, so a caller validates both before the call.

The proof is `scripts/seal-differential.mjs cairnx-core-0.2.4 cairnx-core-0.2.8`, each baseline bound to npm:
`canonicalState` byte-identical to 0.2.4 and the whole result identical to 0.2.8 including codes and moves over the 97
cases of the case files, the replay corpus at 795 heights, 20,000 fuzz sequences, the 145 resolve cases of
`codes.json`, the 14 of `forward.json` and the 13 of `moves.json`, 65 stream inputs (the growth streams at full size
and the twelve of `conformance/sweep-streams.mjs`), and the 3,000 sequences of the new `fuzz-resolve.mjs --expiry`
mode (an expired offer with a later event in 2,170 of them, a bid in 1,744, a swept reservation in 1,398, a swept
recapture reservation in 301, an expiry under the V21 cap in 403; floor 60 each, read from 0.2.8), each also resolved
with 842,620 events that write nothing added in all, none changing a result. The 3,000 sequences of `--malformed` are
compared with 0.2.8 alone, whole result or the same throw (122 threw alike; 0.2.4 and 0.2.8 differ on 9): a malformed
field met on an offer in 1,867, a bid in 1,002, a reservation in 611, a recapture reservation in 234; a tip outside
the domain in 786, 225 of them with every height inside; 1,395 crossing V21 and 1,032 wholly above it; a NaN-height
offer open past V21 though its raw expiry fell due below it in 349; a reservation with a string deadline in 349; each
of the 13 types in at least 151; floor 60 each. A dense walk over the sequences of both modes and the sweep streams,
6,012 walks and 1,699,031 tips, each equal to 0.2.8's answer; check mode clean on 24,357 inputs (2,745 malformed ones
outside the domain left to the differential); the token moves of 28,607 inputs; `parseRecord` equal over 275,166
records; 1,418 client-surface checks; crosslang green, with the inert-event check in the three fuzz modes. cairnx-api
0.1.2 is a peer-only step onto this core.

## csd-light 0.1.27 (2026-11-19, Plan 91 wallet audit F4; published 2026-11-19; reject-more in the block bind, no consensus-surface change) - a block binds only in the node's text form

`bindBlockTxs`, and with it `bindBlockBody` and `verifyTxInclusion`, refuses as `body-mismatch` a served tx whose
`txid` field is absent or not exactly the id its body hashes to, whose `prev_txid`, `script_sig`, `script_pubkey`,
`payload_hash` or `proposal_id` is not `0x` and lower-case hex, or whose app type is not exactly `None`, `Propose` or
`Attest`; the reason names the tx and the field. No hash commits the `txid` field, and `verifyTxInclusion` returns the
served JSON, so a body that kept a tx's bytes and replaced its `txid` was proven with the replaced id in
`result.tx.txid`; every tx of the node's `/block` and `/tx` answers carries its txid (576 of 576 block txs and 21 of 21
`/tx` answers in cairnx-replica's capture), so an absent one is refused too. The node writes every
one of these fields as `format!("0x{}", hex::encode(..))` (compute-substrate `src/api/mod.rs`, `app_payload_json`
and the `/block` handler, at cairn-v0.1.17). The codec reads a hex field with or without `0x` and in any case to the
same bytes, and `rpcTxToTx` rebuilds every app type other than `None` and `Propose` as an Attest, so a body served in
such a spelling hashed to the honest merkle root while a consumer that compares the field as text (a record's payload
hash, an offer id) dropped the record from its replay: a block source could remove a name transfer, an offer cancel
or a competing claim with every hash check passing. Over cairnx-replica's node capture (486 blocks, 29,815 to
30,300, 576 txs), each `payload_hash` and `proposal_id` in three spellings (129 bodies) bound under the previous bind
and 89 of the 126 whose record a consumer keeps were dropped by that consumer's text check (cairnx-core `parseRecord`
for a Propose, id equality for an Attest); none binds now. The same 486 blocks bind byte-identically before and after
and give the same 41 events in the same order (CONVENTION section 33 `blockEvents`, authors by `authorOf`).
`rpcTxToTx`, the codec and the builders accept what they accepted: a source tx read by txid is unaffected, and its
only fields consumers use are the spent output's `script_pubkey` (through `authorOf`, which returns the address in
the node's form) and values. Txids, sighashes, signatures and replay output are unchanged. csd-light gets a
CHANGELOG listed in `files`. Its one workspace dependent, cairnx-replica, is private and has no published version,
so it keeps 0.1.0 and packs with csd-light 0.1.27.

## cairnx-core 0.2.8, cairnx-api 0.1.1 (2026-11-21, Plan 91; published 2026-11-21; consensus-surface files edited, no state change) - forward resolution, token moves in the log, the version and the gate table; the convention text follows the code

New root exports, each in a new file, none of which writes state: `resolveNameIn(names, name)` and `nameView(names,
name)` in `src/forward.ts`, forward resolution moved from the reference service without a change to its body (the
`nset` address, else the owner; null for an absent name or a pending reservation; `lapsed` from the name's `expired`)
and the class, owner, address and profile a reader shows, both reading only `names` of a `resolve()` result;
`CAIRNX_CORE_VERSION` in `src/version.ts`; `GATE_HEIGHTS` in `src/gates.ts`, the gate constants as one frozen table built
from those of `types.ts`; that part changed none of `resolve.ts`, `resolve/`, `records.ts` and `types.ts`.
CONVENTION.md section 35.4 states forward resolution and `test/vectors/forward.json` pins it.

Token moves (CONVENTION section 41, no gate). An applied entry of the log whose record moved tokens carries `moves`,
each `{ leg, ticker, from, to, amount }` (`TokenMove` in `types.ts`): a mint's credit (`mint`, from null), a transfer
(`xfer`), and a fill's sale to `want.payto`, its fee to the treasury and its give to the buyer (`sale`, `fee`, `fill`).
`resolve/tokens.ts` and `resolve/attest.ts` build each move from the amount the balance line applies; `resolve/context.ts`
writes them on applied entries only, as the entry's last key, and writes no zero amount. `resolve.ts` and `records.ts`
are byte-identical to 0.2.7 (`git diff edc20e9` over them prints nothing, `edc20e9` being the commit 0.2.7 was
published from). The log is outside canonical state, so `stateHash`, `eventsHash`, every pinned vector and
`replay-hashes.json` are unchanged. `test/vectors/moves.json` (13 cases, `conformance/gen-moves-vectors.mjs`) pins the
moves, and `conformance/moves-check.mjs` checks them against the input events and the state: for every ticker and
address, received less sent equals available plus locked; a ticker's mint moves sum to `minted`; each transfer's move
is its own record's (ticker, proposer, `to`, amount) and each mint's carries its record's ticker and its proposer as
`to`; each fill's moves are what its fill record gives. `types.ts` and `resolve/` changed, so `scripts/check-consumer-pins.mjs` grades a consumer pinned to 0.2.7 as
consensus-surface drift. cairnx-api's event rows name their fields and carry no `moves`.

The proof. `scripts/seal-differential.mjs cairnx-core-0.2.4 edc20e9` passes, with each baseline build bound to npm
(csd-codec 0.1.18 and cairnx-core 0.2.4 and 0.2.7: every `dist/` file byte-identical to npm's tarball of that version,
after its sha512 integrity check): `canonicalState` byte-identical to 0.2.4 and the whole result identical once `code`
and `moves` are left out, and identical to 0.2.7 with `code` once `moves` is left out, over the 97 cases of the case
files, the replay corpus at 795 heights, 20,000 fuzz sequences, the 145 resolve cases of `codes.json`, the 14 cases of
`forward.json` and the 13 of `moves.json`, and the 53 growth-stream inputs; check mode clean on 21,090 inputs; the
moves of 22,717 inputs pass `moves-check.mjs` (identity on 45,059 ticker and address pairs; 8,418 xfer, 51,308 mint,
43,990 fill, 1,398 sale and 1,398 fee moves); `parseRecord` equal over 200,991 records; 1,418 client-surface checks;
crosslang green. cairnx-api 0.1.1 is a peer-only step onto this core.

The convention text. Documentation, vectors and a test: `resolve()`, canonical state and every pinned replay hash are
unchanged (that change touched neither `src/` nor `dist/`; `scripts/seal-differential.mjs` against cairnx-core 0.2.4
passed). CONVENTION.md now states
ten rules it left out or contradicted (the pending reservation, the expiry sweep at `tipHeight + 1`, the
zero-delivery partial fill, the commit height, the salt and hash forms, the bid link and `done`, the contest key, the
zero token price, the recapture premium staircase and the recaptured record's anchor) and corrects its sentences on
`feesPaid`, a whole fill's `paid`, the claim fields, `feeBps` below V11, the same-block re-post after an `ocancel`,
reservation expiry and duplicate feeds below V29. Sixteen new vectors (`cases-convention.json`,
`conformance/gen-convention-vectors.mjs`) pin them in JS and Python; no rule changed.

## cairnx-core 0.2.7 (2026-11-18, Plan 91 G1; published 2026-11-18; consensus-surface files edited, no state change) - replay cost

No state change; replay cost. The replay's walks that grew with total state leave the per-event path: before each
event the sweep walked every open offer, open bid, pending reservation and recapture reservation, and each reveal
walked every name (the reservation cap) or every recapture reservation (the recapture cap), so a stream of cheap
records (a bid costs its 0.25 CSD anchor and locks nothing) made replay quadratic in them. `src/resolve/store.ts`
now holds those four maps with private indexes: expiry queues (offers and bids by effective expiry epoch,
reservations and recaptures by `finalizeBy`), per-owner candidate sets for the two caps, and the offers per holder (the
live-hold cap of sections 20, 31 and 32), per seller and give asset (the bulk cancel of section 12b) and per name (the
void at a displacement or recapture). An index holds a superset
of what the walk would match and a read evaluates the walk's own predicate over it, so the read equals the walk while
every write to an indexed field goes through the store, which the internal types enforce (the fields are readonly to
every other module). A batch of expiries is applied in the walk's order. The V21 cap that changes an offer's effective
expiry with the sweep height (section 24) is met by re-keying, at the first sweep at V21 or above, every open offer
and bid anchored below V22. A sweep at a height below an earlier sweep's, which only NaN heights produce (the sort's
comparator is inconsistent there), takes the walk, and so does a hold count at a height below an earlier count's,
since a candidate whose hold has ended is dropped. The indexes are built per `resolve()` call and are not in the
returned state, `canonicalState` or the exports. The sort `resolve()` applies (section 3) and the id its V29 drop
keys on move out of its body into the root exports `applyOrder` and `eventId`, which `resolve()` calls: the same
comparison, so a reader that lists events in apply order imports it; `dist/index.d.ts` differs from 0.2.6's by those
two declarations and their two names in the export list.

The proof is `scripts/seal-differential.mjs cairnx-core-0.2.4 fc6e081` (fc6e081 being the tree with 0.2.6's source):
`canonicalState` byte-identical to 0.2.4 and the whole result identical once `code` is left out, and identical to
0.2.6 including `code`, over the 81 cases, the replay corpus at 795 heights, 20,000 fuzz sequences, the 145 resolve
cases of `codes.json` and the 53 inputs of `conformance/growth-streams.mjs` at full size (16,000 registrations; 20,000
open bids, offers with holds, live reservations, live recaptures; 2,000 bulk cancels and 2,000 displacements over
20,000 offers; the V21 crossing at every event height; the edges), each with expectations that every cap both refused
and admitted; the replay's check mode (the walks beside every indexed read, the index invariants asserted after events)
clean over those 21,074 inputs. The Python reference keeps its walks, every pinned vector file is unchanged, and the
drift flag `check-consumer-pins.mjs` raises for a consumer pinned to 0.2.4 to 0.2.6 is accepted as for 0.2.6: such a
replayer derives the same state. Two behaviours of 0.2.4 are kept, as the rule is no state change: a bulk cancel still
visits the seller's matching offers that a live fclaim hold freezes, on each cancel while the hold lasts (a fill comes at
most `FCLAIM_MAX_HOLD_SPAN`, 89 blocks, after its grant); and below V29 a duplicated offer id applied after a same-block bulk cancel leaves the new
copy open with its id out of the open set, so it never expires (only a feed that repeats an event can produce it).

## cairnx-core 0.2.6 (2026-11-18, Plan 91 codes; not published as 0.2.6, first on npm in 0.2.7, published 2026-11-18; consensus-surface files edited, no state change) - stable reason codes

`CONVENTION.md` section 40 adds a reason code to every entry of the applied log and to every record refusal
(`explainRecord`, `RecordError`), from a table of 113 in `src/codes.ts`. The log is outside canonical state (section
5), so no state moves: the replay hashes, `cases*.json`, `replay-corpus.json`, `replay-hashes.json`,
`wa-parity-corpus.json`, `VECTORS.md`, `events.json`, `hashes.json` and `fixtures/events-blocks.json` are
byte-identical to cairnx-core 0.2.4, and the Python reference writes no codes. A replica that writes no codes conforms
at every level of section 38.

The change does edit the files `scripts/check-consumer-pins.mjs` grades as the consensus surface (`resolve.ts`,
`resolve/`, `records.ts`, `types.ts`): every handler writes its code, `records.ts` returns the code of the first rule a
record breaks in the order it has always checked them, and `types.ts` gains the optional `code` field. The proof that
these edits are state-neutral is `scripts/seal-differential.mjs`, which builds cairnx-core 0.2.4 from its tag and
compares it with this tree: `canonicalState` byte-identical and the whole result identical once `code` is left out over
the 81 cases of the three case files, the replay corpus at 795 heights, 20,000 seeded fuzz sequences and the 145
resolve cases of `codes.json`; `parseRecord` accepting exactly what 0.2.4 accepts over 72,657 records (20,000 of them
mutations); the client helpers equal over 1,418 checks. Every input agreed. So the drift flag
`check-consumer-pins.mjs` now raises for a graded consumer pinned to 0.2.4 or 0.2.5 ("CONSENSUS-SURFACE DRIFT, a live
replayer on it forks") is accepted for this release: such a replayer derives the same state, and re-pinning it brings
the codes, not convergence.

## cairnx-core 0.2.5 (2026-11-18, Plan 91 events-rule-a; not published as 0.2.5, first on npm in 0.2.7, published 2026-11-18; `resolve()` unchanged, its input form made normative) - the rule from a block to events

The input of the replay is written down: `CONVENTION.md` section 33 states which transactions of a block are events
for a domain and an activation height, at which occurrence, in which order, with which field forms and author, and the
byte form of an event list. cairnx-core implements it as `eventOfTx`, `blockMembers` and `blockEvents`, the Python
reference independently, and `test/vectors/events.json` pins both (`conformance/events-crosslang.mjs` in
`test:crosslang`). `resolve()`, `records.ts` and `types.ts` are byte-identical to 0.2.4, and every pinned vector and
replay hash is unchanged.

Section 33.2 makes normative the input form the reference service's feed has always had: the first occurrence of a
transaction id at every height (csd-indexer keeps it, and the service's scanner reads that feed). A reader that feeds
`resolve()` every copy of a re-mined transaction can differ from the reference when a copy lies below V29: a
transaction mined at 87,999 and again at 88,001 is one event under section 33, while `resolve()` fed both copies
applies both, because section 32's M4 drop applies only at heights at or above V29 (`test/events.test.ts` pins both
results). For history the case is empty: a scan of every block from 29,860 to 144,400 (block hash
0x0000000000001874564bd8df5a5893040b0981d96c646e132e3598488d0411b5) on 2026-11-18 read 114,541 blocks and 148,395
transactions with 148,395 distinct transaction ids, so no transaction id has been mined twice since activation. The
scan is `conformance/scan-repeated-txids.mjs` (`--to 144400` reproduces those counts and that hash).

The other forms the rule fixes where earlier readers differed (an expiry above 2^53 - 1, a `uri` holding U+0000) give
the same state either way. Section 32's "there is no straddle case" is corrected: a transaction can be mined in two
blocks, and `resolve()` fed both copies drops the later one only when both are at or above V29; the rule keeps the
first.

Section 34 (Plan 91 hashes) adds two hashes outside canonical state, so no state moves: `stateHash`, sha256 of the
UTF-8 bytes of `canonicalState` (the digest `replay-hashes.json` pins, now written with `0x`), and `eventsHash`, a
running sha256 from 32 zero bytes over each event-holding block: its height (8 bytes big endian), then per event in
ascending position the position (4 bytes big endian), the transaction id (32 bytes) and the author (20 bytes).
`test/vectors/hashes.json` pins both, over synthetic cases and over the replay corpus at its 21 pinned heights.

## cairnx-core 0.2.4 (2026-11-02, Plan 90 SDK2; published 2026-11-06; no consensus-surface change) - records, tests and docs

Client-side and docs only: `resolve()`, canonical state and every `verifyFillSpv` verdict are unchanged (the
vectors, the 21 pinned replay heights and the fuzz are byte-identical). `verifyFillSpv`'s contract says what its
window replay decides and names the known limits below the window; reading that history (design b') is a Plan 87
later item. Five new vectors (`cases-rules.json`) pin three existing resolver rules in JS and Python (the
within-block order, the canonical uri, the same-ticker offer); no rule changed. New exports `offerFillTooLate`, the offer-id
lanes' expiry predicate, and `FCLAIM_MAX_HOLD_SPAN` (89, the longest fclaim hold; `GAP_NEEDED` keeps its value).

## csd-crypto 0.1.21, csd-siwc 0.1.22, csd-tx 0.1.24, csd-vectors 0.1.17 (2026-11-02, Plan 90 SDK1; published 2026-11-06; signature acceptance aligned with the node) - verifyDigest reads compact signatures only

`verifyDigest` passes `format: "compact"` to noble's `secp256k1.verify`, so the 64 signature bytes are read as
r || s only, as the node reads them (compute-substrate `src/crypto/mod.rs` `verify_sig`: `Signature::from_compact`,
low S, `verify_ecdsa`). Without a format, noble 1.9.7 tries a DER parse first and falls back to compact only on a DER
structure error, so two kinds of 64 bytes got a verdict other than the node's: a valid compact low-S signature whose
bytes are also DER-shaped (`30 3e 02 L`, L bytes, `02`, 58 - L, the rest) was refused, and `recoverSigner` and
`authorOf` returned null for a tx the node mined; a valid 64-byte DER signature, whose compact reading is no
signature, was accepted. Both now get the node's verdict. csd-vectors 0.1.17 exports two vectors of the first
kind and one of the second as `SIG_VECTORS`, each with the verdict of the node's crate (secp256k1 0.29.1,
`verify_sig`'s steps): ok, ok and "signature failed verification"; `packages/crypto/test/crypto.test.ts` checks
`verifyDigest`, `recoverSigner` and `authorOf` against them. Signatures from `signDigest` are compact by
construction and verify as before. csd-siwc and csd-tx bump as dependents of csd-crypto; `verifySiwc` takes the
same acceptance set. The site and wallet bundles take the change when re-vendored, cairnx and cairn-sdk when
re-pinned. Publish order (pnpm only): (1) `csd-vectors`, `csd-crypto`; (2) `csd-tx`, `csd-siwc`. No byte, txid,
sighash, LWMA, chainwork or replay change.

## cairnx-core 0.2.3, csd-client 0.1.20, csd-light 0.1.26 (2026-10-24, Plan 85 23.1; published 2026-10-26, npm window 5; no consensus-surface change) - the admission check's two activation gates, the node's answer types

`provenOfferRefusal` refuses an offer anchored below `ACTIVATION_HEIGHT` (29,860) and a name offer anchored below
`V11_HEIGHT` (29,960), the two record-only rules it lacked (client-side; `resolve()` does not call it). Each rule has
one home that both read: the new export `beforeActivation(height)` (`src/types.ts`), which the replay loop in
`src/resolve.ts` calls in place of its `ev.height < ACTIVATION_HEIGHT` compare, and `offerEnvelopeRefusal`
(`src/resolve/market.ts`), which now ends with the name-offer v1.1 rule that `applyOffer` checked right after calling
it, with the same note. No state change sits between the two, so the first refusal note is unchanged for every
record: the 76 vectors, the 21 pinned replay heights and the 1,500-sequence fuzz are byte-identical, and an
old-against-new `resolve()` comparison over 3,500 offer records at heights 29,858 to 41,302 (every gate from
activation to V22, plus or minus two blocks; full output and canonical state) differed on none.

csd-client types four answers as the node sends them (compute-substrate `src/api/mod.rs` at 0eca9e0): `proposal()`
returns `{ ok, proposal: RpcProposalRecord }` (`proposal_get`; the record carries `proposal_id`, `created_height`,
`created_epoch` and `fee`, and no `txid`, `height` or `attestations`), `proposals()` returns `RpcProposals`
(`RecentProposalsResp`, rows without a proposer) instead of an array, `domains()` returns `RpcDomains`
(`DomainsResp`) instead of `string[]`, and `RpcHealth` lists `HealthResp`'s fields (`peer_count` and
`mempool_tx_count`; `peers` and `mempool_len` never existed). Types only: the requests and the parse are unchanged,
so code that cast around the old types keeps working, and code that read the old field names compiled against
fields the node never sent. csd-light bumps as a dependent of csd-client and exports `bindBlockTxs`, the block bind
`bindBlockBody` and `verifyTxInclusion` already run, for a caller that parses the body with its own exact parser;
no behaviour change.

## csd-client 0.1.19, csd-light 0.1.25, csd-crypto 0.1.20, csd-tx 0.1.23, csd-siwc 0.1.21, cairnx-core 0.2.2 (2026-10-23, Plan 85 22.1 to 22.3; published 2026-10-23, npm window 4; no consensus-surface change) - each verification rule in one home

csd-client parses node bodies with `parseJsonExact` by default and exports it: an integer literal outside the safe
JS range (a Propose's `expires_epoch` is an unbounded u64) comes back as an exact bigint read from its source text,
every other value as `JSON.parse` returns it, so a block holding such a value binds to its merkle root instead of
failing the codec's u64 check. A float literal stays a number. A caller passing its own `parseJson` keeps it. The
u64 fields of `RpcTxJson` and `RpcProposal` are typed `number | bigint`. csd-light bumps because it depends on
csd-client.

csd-light exports `bindBlockBody(text, verifiedHeader)`, the one block bind: the body parsed exactly, every txid
re-derived from its body, a repeated txid refused before the merkle compare (a body repeating its odd last tx
hashes to the honest root), and the set compared with the verified header's merkle root. Bound bodies type their
scriptSigs `UnprovenScriptSig`. `verifyTxInclusion` runs through the same bind, so it now also refuses a body that
repeats a txid. csd-crypto exports `authorOf(tx, prevoutScriptPubkey)`: the author is the owner of the coin input 0
spends, returned only when input 0's scriptSig is that owner's valid signature over the sighash. The txid and
sighash strip scriptSigs, so `recoverSigner` alone attributes a body re-signed by another key to that key; the node
accepts an input only when hash160 of its pubkey equals the spent output's script_pubkey (compute-substrate
`src/state/utxo.rs` `validate_tx_inputs_outputs`), and names the proposer from input 0's pubkey (`src/state/app_state.rs`
`sender_h160_from_tx`), so that owner is the author. csd-tx and csd-siwc bump as dependents of csd-crypto.

cairnx-core: `verifyFillSpv` refuses when an enumerated event cannot be proven instead of replaying without it
(client-side fill boundary; `resolve()` does not call it). New export `countOtherHoldsAtGrant`, the buyer's other
holds at an fclaim's grant in apply order, for `verifyFillSpv`'s cap input; not read by `resolve()`. It refuses grants
below `LEGACY_HOLD_SUNSET_HEIGHT`, where a legacy claim from before V28 can still be live. `finalizeWinnerCheck`
refuses a supplied tip that is not a non-negative safe integer. New export `provenOfferRefusal`, the proven-offer
admission check (domain, then the offer's stateless creation rules). Those rules moved out of `applyOffer` into
`offerEnvelopeRefusal` (`src/resolve/market.ts`), which `applyOffer` calls, in the same order with the same notes:
the 76 vectors, the 21 pinned replay heights and the 1,500-sequence fuzz are byte-identical, and an old-against-new
`resolve()` comparison over 1,056 offer records across the V12 to V22 boundaries (full state and event log)
differed on none. Three citations in the MF-20 entry below moved with the code.
`bindOfferTerms` binds a token want's ticker and amount under its wantType leg (reject-more; `scripts/seal-differential.mjs`
passes, and `conformance/proven-terms-classification.mjs` now lists both fields as bound).
`MAX_TOKEN_DECIMALS` (8) is exported from `types.ts` and read by `parseRecord`'s deploy branch in place of the literal;
the parse is unchanged.

No byte, txid, sighash, LWMA, chainwork or replay change.

## csd-light 0.1.24, csd-crypto 0.1.19, csd-tx 0.1.22, csd-siwc 0.1.20 (2026-10-19, Plan 85 13b.1; published 2026-10-20, publish window 3; no consensus-surface change) - shared route checks and script address

csd-light adds `tipHeaderPowOk` and `contenderPlausible`, the checks cairn and csd-indexer each carry before a
non-primary RPC backend may win routing; csd-crypto adds `addrFromScriptPubkey`, the node's address parser
(compute-substrate `src/api/mod.rs` `parse_addr20` at tag cairn-v0.1.14) returning the lowercase 0x form. Both
are added API that `resolve()` and the codec do not call: no byte, txid, sighash, LWMA, chainwork or replay
change, and the golden vectors are unchanged. csd-tx and csd-siwc bump because they depend on csd-crypto.
Publish order (pnpm only): (1) `csd-crypto`, `csd-light`; (2) `csd-tx`, `csd-siwc`. cairnx-core 0.2.1 (below)
rides the same window.

## csd-registry removed (2026-10-19, Plan 85 P-5; no consensus-surface change)

`packages/registry` is deleted from the workspace; 0.1.20 stays its last published version, and later publish windows drop it from their order.

## csd-codec 0.1.18, csd-tx 0.1.21, csd-client 0.1.18 and their dependents (2026-10-17, Plan 85 18.3; published 2026-10-18, publish window 2; reject-more except one content check) - input canon

Every change but one refuses input that was accepted before. The exception is `verifyContentBytes`, which
now accepts the expected hash written without `0x`: it compares the same sha256 digest, so it removes a
false refusal of genuine bytes; it is a content check that `resolve()` does not call. No honest byte,
txid, sighash or replay output moves: the golden vectors are unchanged, the replay corpus reproduces 21 of
21 pinned heights, and `scripts/seal-differential.mjs` passes.

- csd-codec `serialize`, `txid` and `sighash` throw on a Propose domain or uri with an unpaired surrogate.
  `utf8ToBytes` mapped one to U+FFFD, so two different strings serialized to the same bytes; the Python
  oracle's `str.encode("utf-8")` raises. The node holds these fields as UTF-8 strings, so a mined tx has
  none, and the vectors and replay corpus confirm no historical txid moves. The predicate (`isWellFormedUtf16`) now lives in csd-codec once;
  cairnx-core `records.ts` and csd-siwc import it instead of their own copies (same semantics).
  csd-codec also exports `utf8Strict(s, field)`, the encoder that throws on a lone surrogate (added API).
- csd-codec `verifyMerkleProof` requires the txid, every sibling and the root to be 32 bytes. An empty
  txid, branch and root verified, and a short sibling was zero-padded into the hash buffer.
- csd-codec `canonicalJson` (and `payloadHash`) throw on a Map, Set, Date, typed array, class instance,
  function, symbol or array hole. Plain objects, including null-prototype, cross-realm and `JSON.parse`
  output, hash as before.
- csd-codec `verifyContentBytes` accepts the expected hash without `0x` (it returned false before): the one
  accept-more change, for the same digest only.
- csd-tx `selectInputs` dedupes an outpoint served with and without `0x` (it selected it twice); an
  `exclude` key in either spelling skips the coin. `buildPropose` returns `ok:false` for a lone surrogate
  instead of throwing from the codec. `buildSend` is marked `@deprecated` in favour of `buildSendVerified`.
- csd-client: a non-finite `maxResponseBytes` or `retries` falls back to that option's default (16 MiB, 0
  retries); NaN disabled the byte cap and made the retry bound never trip.
  A fractional `retries` is floored (`1.5` allowed 2 retries before, 1 now).

Because codec moved, every workspace package that depends on it bumps: csd-crypto 0.1.18, csd-client
0.1.18, csd-tx 0.1.21, csd-light 0.1.23, csd-registry 0.1.20, csd-siwc 0.1.19 and cairnx-core 0.2.0 (which
also carries 12.1b below). csd-vectors and csd-indexwire are unchanged. Publish order (pnpm only):
(1) `csd-codec`; (2) `csd-crypto`, `csd-client`; (3) `csd-tx`, `csd-light`, `csd-registry`, `csd-siwc`,
`cairnx-core` in any order.

## cairnx-core 0.2.1 (2026-10-19, Plan 85 12.5; published 2026-10-20, publish window 3; no consensus-surface change) - `resolve.ts` split into handlers

`resolve()` keeps the sort, the V29 de-dup, the replay loop, the block-boundary cancel flush and the
materialization in `src/resolve.ts`; each record kind's apply step moved verbatim into `src/resolve/`
(`tokens.ts`, `names.ts`, `market.ts`, `attest.ts`) over one state context (`context.ts`). A branch's
`continue` became its handler's `return`; nothing else in the moved code changed. The two textually identical
concurrent-hold cap loops (the fclaim ladder and the legacy SCORE_CLAIM) are then one counter, `liveHoldCount`
in `context.ts`, called from both. No byte, math, gate or replay change. Checked against the 0.2.0 tree (`origin/master` 275de8e) by resolving the same 21,090 inputs with both
builds and comparing `canonicalState` and the full returned state (event log, recaptures, fclaims, key order):
identical for the 76 golden vectors, the 21 pinned replay heights, 993 heights of the full on-chain event set
captured 2026-10-19 (1,398 events to height 122,800; `canonicalState` sha256 `6bddf30f...56183f1` at that tip)
and 20,000 generated fuzz sequences. `test:crosslang` output is identical and `audit:all` differs only in the four
ledger citations that moved with the code. `scripts/check-consumer-pins.mjs` now counts `src/resolve/` as
consensus surface. Consumers may stay on 0.2.0.

## cairnx-core 0.2.0 (2026-10-17, Plan 85 12.1b; published 2026-10-18, publish window 2; no consensus-surface change) - `bindOfferTerms` give and wantType legs on by default

`bindOfferTerms` is the shared client-side fill fund boundary (the wallet, the site and cairn-sdk call it); it
is not read by `resolve()`. Its give and wantType legs, opt-in since 0.1.39, are now on unless the caller passes
`{ give: false, wantType: false }`, which returns the earlier two-argument verdict on every input. Reject-more
only: the legs add refusals and remove none. The in-stack callers already pass both legs on with minted terms,
so their verdicts do not move. No bytes, math, gate or replay change: `scripts/seal-differential.mjs` step 5
now compares the 0.1.38 baseline against the opted-out call, checks that the default legs never accept an
input the baseline refused, refuse each give and want-type lie, and accept honest served offers. The minor
version moves (0.2.0) because hand-built terms with the two-argument call are now a compile error in
TypeScript and a refusal at runtime; `packages/cairnx/CHANGELOG.md` lists the consumers that move with it.

## csd-codec + csd-light record primitives (2026-10-13, Plan 86 S1; published 2026-10-14 in csd-codec 0.1.17 and csd-light 0.1.22, publish window 1; no consensus-surface change)

csd-codec adds `deserializeHeader` (the inverse of `serializeHeader`) and `HEADER_BYTES`; csd-light adds
`verifyLinkedRecords`, `LightClient.fromRecords` and `toRecords`. No byte, LWMA, chainwork, PoW or merkle change:
`fromRecords` verifies through the existing `seedTrusted` and `ingest` checks, unchanged, and equals
`fromSnapshot` on the fixture.

## csd-codec 0.1.17 + cairnx-core 0.1.44 and their dependents (2026-10-13, Plan 85 12.1; published 2026-10-14, publish window 1; no consensus-surface change) - shared helpers in one home

`epochOf` moved into `csd-codec` next to `EPOCH_LEN` (same formula); cairnx-core and csd-registry import it
instead of defining it. `csd-crypto` imports `strip0x`, `hb` and `hx` from codec instead of its own identical
copies. cairnx-core adds `ptAmt`, `burnedPayment` and `myProvenFillClosedOffer` to the root export and a fee
rate argument to `rfqFillAllIn`; none of them is read by `resolve()`. No bytes, math, gate or replay change:
replay corpus 21/21 byte-identical and the golden vectors unchanged. Because codec moved, every workspace
package that depends on it bumps: csd-crypto 0.1.17, csd-client 0.1.17, csd-tx 0.1.20, csd-light 0.1.22,
csd-registry 0.1.19, csd-siwc 0.1.18, cairnx-core 0.1.44, and csd-vectors 0.1.16 (12.0's pinned Propose and
Attest vectors; a dev dependency of codec, crypto, client and tx). csd-indexwire is unchanged.

Publish order (pnpm only): (1) `csd-codec`; (2) `csd-crypto`, `csd-client`; (3) `csd-tx`, `csd-light`,
`csd-registry`, `csd-siwc`, `cairnx-core` in any order. If `packages/registry` is deleted before the publish
(Plan 85 P-5), drop it from step 3.

## csd-crypto 0.1.16 + csd-tx 0.1.19 + csd-registry 0.1.18 + csd-siwc 0.1.17 (2026-10-09, Plan 83 W2; published 2026-10-10; no consensus-surface change) - one csd-codec in the published graph

Published `csd-crypto@0.1.15` pins `csd-codec@0.1.15`, while every other package pins `csd-codec@0.1.16`, so
any consumer of crypto (directly or through `csd-tx@0.1.18`, `csd-registry@0.1.17`, `csd-siwc@0.1.16`, which
pin `csd-crypto@0.1.15`) installs two codec copies. Cause: codec moved to 0.1.16 without a crypto bump, and
`workspace:*` only fixes a dependent's pins when the dependent itself publishes. This release republishes the
four packages with no source change: their built `dist/` is byte-identical to the currently published tarballs
(diffed 2026-10-09); only the manifest pins move (crypto -> codec 0.1.16; tx/registry/siwc -> crypto 0.1.16).
No bytes, math, gate or replay change. `scripts/check-lockstep.mjs` now fails when a package version already
on npm pins a dependency version other than the current workspace one, which is the check that would have
caught this.

Publish order (pnpm only, from the repo root): (1) `csd-crypto` 0.1.16; then (2) `csd-tx` 0.1.19,
`csd-registry` 0.1.18, `csd-siwc` 0.1.17 in any order. `csd-codec` 0.1.16 is already published. After
publish, re-pin: cairnx (`csd-crypto` 0.1.16, `csd-tx` 0.1.19, `csd-client` 0.1.16), cairn-cli (`csd-crypto`
0.1.16, `csd-registry` 0.1.18), cairn-sdk (`csd-crypto` 0.1.16, `csd-tx` 0.1.19, `csd-registry` 0.1.18,
`csd-siwc` 0.1.17, then its own patch release), csd-indexer (`csd-crypto` 0.1.16, `csd-registry` 0.1.18,
`csd-light` 0.1.21).

## cairnx-core 0.1.42 (2026-09-25, Plan 80 G3 / CX-17; UNGATED, replay byte-identical) - expiry without rescanning closed history

`resolve()` keeps private indexes of open offers, open bids and pending name reservations, so the per-event
expiry sweep walks only live rows instead of every offer, bid and name ever recorded (commit `4c94527`,
test `packages/cairnx/test/expiry-index.test.ts`). Every status write goes through `setOfferStatus` /
`setBidStatus`, every name write through `putName`, and new open offers and bids enter the index at
creation; closed rows never reopen, so the sweep expires the same rows in the same order. No rule changes,
no new gate height: canonical state is byte-identical to 0.1.41 at every height. Evidence at release:
package suite, `test:crosslang` (JS against the Python oracle, incl. the resolve fuzz), `audit:all`, and the
real-chain replay pins (`cairnx scripts/conformance.mjs`, JS against Python on the live chain) with the
0.1.42 tarball installed. The cairn site already vendors this source (PROVENANCE `csdSdkCommit` 4c94527).


## cairnx-core (Plan 75 P75-4, branch plan75/csd-sdk; UNGATED reject-more; live-differential-proven replay-identical) - fclaim grant safe-integer guard (MF-20)

The fclaim GRANT branch of `resolve.ts` lacked the `Number.isSafeInteger(` guard on the expiry epoch that its
sibling offer and bid Propose branches already carry (`packages/cairnx/src/resolve/market.ts` :175 offer, :77 bid). MF-20 adds
it, plus the Python mirror in `conformance/cairnx_ref.py`. The guard tests the same predicate as the
offer branch but not in the same form: the fclaim ladder records every denial in the `fclaims` map, so
the rung calls the ladder's `deny()` rather than `note()` directly (the REG-1 correction below). As
shipped, now in its own handler (the 12.5 split turned each rung's `continue` into `return`) and, since
cairnx-core 0.2.6, with its reason code, at `packages/cairnx/src/resolve/market.ts` :138:

    if (!Number.isSafeInteger(E)) { deny("EXPIRY_UNSAFE", "expiresEpoch out of safe-integer range"); return; }

Python mirror, `conformance/cairnx_ref.py` :828, the first rung of the same ladder and calling the same
`deny()` for the same reason (`is_safe_int(None)` is False, matching `Number.isSafeInteger(undefined)`):

    if not is_safe_int(E): deny(); continue

**UNGATED, for three reasons:**
1. It is reject-MORE only for values an honest node cannot produce. `expires_epoch` is a u64 decoded
   from chain JSON; the 2^53-and-above range is grant-UNREACHABLE via the later `E > effExpiry` leg
   (a stored offer's own `expiresEpoch` is safe-integer-gated at creation). A 19-value boundary
   differential (pre-guard vs guarded, canonicalState hashed) measured EXACTLY three shapes whose
   verdict moves, and none is chain-derivable: `NaN`, a MISSING field, and a STRING-typed
   `"2184"`. Note `Infinity` is NOT among them (it is denied on both sides), and the live wire
   confirms the premise: over the whole indexer scan, string-typed `expires_epoch` = 0 and
   non-safe-after-`Number()` = 0. For every safe-integer `expiresEpoch` the guard is a pure
   pass-through, so canonical state is byte-identical for every safe-integer input. On every
   chain-derivable stream the guard denies nothing new; it only removes the branch's dependence on a
   later leg's coincidental bound (the disconnected-defenses class), restoring three-way parity with the
   offer/bid guards and the Python oracle.
2. Replay identity is PROVEN, not argued. `replay-corpus.json` carried ZERO fclaim at the time (the
   2026-10-13 extension added the chain's four), so ITS
   zero-movement says nothing about this branch (`cases.json` is different: it carries six fclaim
   vectors, two of them grant-positive, and those ARE pinned and unmoved, so the pinned vector surface
   does exercise the guarded branch). The proof is a live [pins..tip] differential: the
   pre-MF-20 baseline dist vs the guarded dist, run over the SAME real indexer-scanned event stream
   including the FIRST granted on-chain fclaim `0x43e9c34f...51c6d2c6` (mined 65,507, offer
   `0xa11cb429...9de9547a`). `canonicalState` is sha256-identical at all 20 pinned heights AND at tip
   (both `86300aabcef1e09db4ea...`), the granted fclaim entry serializes identically on both builds, and
   every pinned height reproduces `replay-hashes.json` exactly (the anchor proving the live scan IS the
   canonical stream). Archived in the private evidence folder (mf20-live-differential.txt).
3. A height gate would add a LIVE consensus branch carrying fleet-wide adoption-coordination cost for
   zero behavioral delta on any real stream. Reject-more for chain-impossible values needs no gate.

**The golden pin does NOT live in the frozen corpus.** Seal policy (`scripts/seal-differential.mjs`
steps 2 and 2b) forbids touching `cases.json` / `replay-corpus.json` / `replay-hashes.json`, and those
carried no fclaim at the time. The behavior is pinned by `packages/cairnx/test/fclaim-v28.test.ts` case 11 (a
NaN `E` grants nothing; an unsafe-int `E` grants nothing; the rejection is cut AT the guard leg, not a
later ladder leg) plus the archived live differential. JS/Python parity is pinned by the full fclaim
crosslang suite (v28-fclaim, v28-namegive-fclaim, v29-mux), which exercises the guarded branch against
the mirrored oracle.

**JS-API-only hazard it closes:** pre-guard, a direct `resolve()` consumer feeding a `propose` fclaim
with `expiresEpoch: NaN` slid past every comparison leg (NaN compares false everywhere) and GRANTED a
hold with `claimUntilHeight` NaN, which `canonicalState` serializes as `null`. JSON cannot carry NaN so
the chain cannot produce it, but any JS-API caller could; the guard closes it. Measured pre-guard:
`claimedBy` set, `"claimUntilHeight":null` in canonicalState (`evidence/before-MF20-red.txt`).

**Proof artifacts:** red-first `evidence/before-MF20-red.txt`; live differential
`evidence/mf20-live-differential.txt`; per-leg branch sweep `evidence/mf20-per-leg-sweep.txt` (14 legs of
the grant ladder, each with >= 1 executed red on the fclaim substrates: vectors/cases + fclaim-v28 +
fork-lens-v29 + the three fclaim crosslang runs, NEVER scored against the fclaim-free replay corpus).
CORRECTION, from the gate's independent review: the Python mirror was declared a "known survivor" with
no state-observable red. THAT CLAIM IS FALSE. A purpose-built crosslang differential over the same
boundary matrix, with ONLY the fclaim mirror removed, diverges JS against Python on three wire shapes
(a MISSING field, `null`, and a STRING), because `is_safe_int(None) == False` mirrors
`Number.isSafeInteger(undefined) === false` and that is a real, checkable parity. The mirror is
LOAD-BEARING and IS killable by a mutation; the batch simply shipped no test that kills it, so it is
currently enforced by review rather than gated. Recorded here rather than quietly dropped, and a
crosslang row covering one of those three shapes should be added on the next vehicle.

**Release:** SHIPPED as cairnx-core **0.1.41**, published to npm 2026-07-31 (git tag
`cairnx-core-0.1.41`, release commit `2a07668`), alongside csd-codec 0.1.16, csd-light 0.1.19,
csd-registry 0.1.17 and csd-siwc 0.1.16. `pnpm run audit:all` green on the settled post-MF-20 tree
(fclaim/partialFill/v28plus coverage counters all > 0); full package suite + `test:crosslang` green;
the five pinned vector artifacts byte-identical throughout.

## cairnx-core 0.1.40 (2026-07-21, PUBLISHED; V29 ACTIVATED at 88,000, crossed 2026-08-31) - V29 event de-dup + concurrent-hold status filter (CONVENTION v2.9, REBIND B9)

**Consensus change (gated, non-retroactive): `V29_HEIGHT` = 88,000** (set 2026-07-20 by operator decision;
tip was ~58.3k). Two resolve()-side corrections that both move canonical state, so both ride the ONE gate,
each keyed on the EVENT's OWN height (`>= V29_HEIGHT`), never the tip (non-retroactive, fork-safe; a
mixed-version fleet does not fork below the gate). Version note: 0.1.39 (tag `cairnx-core-0.1.39`) is the B6
CLIENT-additive surface (opt-in `bindOfferTerms` give/want-type legs + the `MintedProvenOfferTerms` brand,
`fillEndorsement`/`fillOutputPlan`, fclaim-aware `claimWindowOf`, the M13 publish-guard test gate) and made
NO consensus change: the B6-SEAL differential (`scripts/seal-differential.mjs`) proved canonical state
byte-identical to 0.1.38 with every opt-in off. 0.1.40 = that surface + this gate.

- **M4 (event de-dup; reject-more, but it moves canonical state):** resolve()'s consensus ordering step sorts
  but never de-duplicated, so a double-fed transaction (an overlapping scanner page) applied twice and
  double-credited `o.paid`/`o.delivered` on the partial-fill path. At an event height >= V29 a duplicate
  (same propose `id` / attest `txid`) is dropped before apply; the first in consensus order is kept
  (`resolve.ts` `eventId`/`seenIds`). The identity is the L1 tx hash (sha256d), not attacker-choosable, and a
  duplicate pair shares one txid == one block, so both copies always land on the SAME side of the gate. The
  cairnx-SERVICE-side de-dup on the attestation pull (its `scan.ts`) is a separate, un-gated defensive
  change; only the resolve() half is gated here.
- **M5 (concurrent-hold status filter; RELAXATION):** `claimHeld` is status-independent and the last-write-wins
  claim fields (`claimedBy`/`claimUntilHeight`/`claimTxid`, never cleared by the section-31 invariant) survive a
  fill, so a FILLED offer kept consuming one of the holder's `MAX_ACTIVE_CLAIMS` slots until its hold window
  lapsed: three completed fclaim buys wrongly denied a fourth honest claim. At an event height >= V29 the cap
  counts only holds on OPEN offers (`ev.height < V29_HEIGHT || x.status === "open"`, the fclaim grant ladder).
  The post-V29 count is a strict SUBSET of the pre-V29 count, so the change can only GRANT more, never newly
  deny. The legacy SCORE_CLAIM path calls the same counter (`liveHoldCount`, `packages/cairnx/src/resolve/store.ts` :287), where the clause is inert by design (SCORE_CLAIM at
  height >= V28 is rejected before it, and V29 > V28); it is kept for symmetry and documented as unreachable.

**Byte-identity below the gate:** `scripts/v29-below-gate-differential.mjs` exits 0 (canonical state
byte-identical to the B6 tree for EVERY event/tip < 88,000, with named coverage floors across
offers/grants/fills/partials/legacy claims/duplicates); golden vectors 76/76 (72 B6-era + 4 new v29); the
fork-lens fixture (`packages/cairnx/test/fork-lens-v29.test.ts`) pins the divergence height at exactly 88,000
for BOTH M4 and M5; crosslang straddle 13/13 (heights 87,997..88,002, JS == Python, the oracle independently
derived from the spec).

**Adoption discipline (HARD gate, sharper than V28 because M5 is a relaxation):** a stale replayer DENIES a
claim the chain GRANTS (view divergence; no fund loss, the stale side strands rather than burns). EVERY
replayer (the cairnx svc, clarvis, the vendored site + wallet bundles, cairn-sdk, cairn-cli, csd-indexer, the
Python oracle) MUST run the v2.9 core and be confirmed RUNNING by live query before the tip crosses 88,000,
never "publish and hope". The demonstrated weak link is the CWS field wallet (store review queue no one here
controls): the height stays movable UNTIL 0.1.40 publishes (a pre-publish go/no-go), with a mid-rollout
checkpoint at ~tip 80,000 and a 0.1.41 re-pin escape hatch if adoption lags.

**Rollout checklist deltas for this gate (on top of the V28+ checklist at the bottom of this file):**
1. **Replay-hash RE-PIN is a POST-CROSSING step.** The `replay-hashes.json` V29 entry can only be generated
   once the tip is past 88,000 (the generator needs the live indexer reachable into the V29 region). NEVER
   re-pin from a guessed hash. (B8-hash, executed 2026-07-23 at the V28 crossing, made the artifact
   load-bearing early: replay-corpus.json + the V28-inclusive baseline are committed and vectors.test.ts
   asserts them; the B9 step ADDS the V29 entry to that same corpus + pin set post-crossing.) Stop rule:
   regenerating the EXISTING pinned heights must reproduce them byte-identical FIRST; any divergence there
   is an incident (stop, page the operator), never a reason to edit a pin.
   EXECUTED 2026-10-13: replay-corpus.json re-captured with the cairnx Scanner and truncated at the
   finalized height 117,000 (tip 118,331 at capture; 1,133 events, 744 at or above V28, 731 at or above
   V29, 4 fclaim). All 20 earlier pins, including the retired tip-of-record 60,425, reproduced
   byte-identically; the 88,000 and 117,000 entries were added. `REPLAY_CORPUS_PIN` restated in the
   same commit; the Python oracle agrees at all 21 pinned heights (`conformance/replay-corpus-crosslang.mjs`).
2. ~~CONVENTION.md still reads v2.8~~ CLOSED 2026-07-23: CONVENTION.md section 32 is the normative v2.9
   write-up (M4 duplicate-event drop + M5 open-holds cap count, both keyed on the event's own height
   `>= V29_HEIGHT`), drafted from `types.ts`/`resolve.ts` and cross-checked against the independent
   `conformance/cairnx_ref.py`; the header/status ladder now reads v2.9 pending activation at 88,000.

## cairnx-core 0.1.38 + csd-tx 0.1.17 (2026-07-17, Plan 70 R2) - fill-boundary consolidation + L1 cushion + verified builders (CLIENT reject-more; resolve() byte-identical)

NOT a canonicalState change: `resolve.ts` and `replay-hashes.json` are byte-identical to 0.1.37 (72/72 golden vectors + crosslang + 1000-seq fuzz unchanged; the WA-PARITY 3-seam corpus proves the fill-boundary behavior is preserved). This is CLIENT-side reject-more + additive, non-retroactive, needs NO height gate: a stale verifier keeps the old (still fund-safe) behavior, no fork.

- cairnx-core: exported `bindOfferTerms(servedOffer, provenTerms)` + `bindProvenOffer` (Plan 70 Option B) - the ONE shared fill-boundary term-mismatch predicate the site (swapguard) and wallet (fillspv) seams now both call instead of three R1 hand-copies (which were already behaviourally identical). And **L1**: `FILL_TIP_MARGIN` 2 -> 4 (the client fclaim fill-deadline cushion; a fail-safe reject-more that declines only near the hold deadline as a no-op, reducing stranded fills under congestion). No `resolve()` path uses `FILL_TIP_MARGIN`, so canonical state is untouched.
- csd-tx: added `buildProposeVerified` / `buildAttestVerified` (F9-C) - input-value-VERIFIED twins of `buildPropose`/`buildAttest` (re-derive change from a chain-verified input total via the `InputVerifier` callback, exactly like `buildSendVerified`). Additive; no existing builder's output bytes change.

Rollout: re-vendor the two bundles (done, PROVENANCE re-pinned), re-pin the npm consumers (cli/sdk/svc) to 0.1.38 at publish, grep the ecosystem for FILL_TIP_MARGIN literals (only vendored bundles + parity grids), CF-purge cairn `/vendor/cairnx-core.js`. Full sequencing in cairn/docs/handoffs/71.

## cairnx-core 0.1.37 (2026-07-12, PUBLISHED 2026-07-13; V28 ACTIVATED at 60,000, crossed 2026-07-23) - V28 fclaim open-lane settlement atomicity (CONVENTION v2.8, §31)

**Consensus change (gated, non-retroactive): `V28_HEIGHT` = 60,000.** (Set 55,000 on 2026-07-12; bumped to
60,000 on 2026-07-13 for a ~9-10 day deploy runway; tip was ~53.1k at the bump.) The largest CairnX replay change since the
gate ladder began. It closes the cross-block "pay without delivery" flaw on the open-lane marketplace buy
(CX-DVP-CROSSBLOCK-1): Half A (seller cancels in block N, buyer fills in N+1 - L0 satisfied, overlay rejects
delivery) and Half B (a fill delayed past the overlay hold but before offer expiry). Neither half is closable
app-layer-only (Half A's burn lands after the buyer signs; Half B has no client-enforceable expiry since L0 does
not enforce locktime), so the fix is a resolver rule change, which in this architecture is a coordinated
height-gated replayer upgrade, NOT an L0 hard fork (the Rust node is untouched; the independent miners are
unaffected).

At an event height >= V28 the following apply (all in `packages/cairnx/src/{resolve,types,records,preflight}.ts`,
mirrored in `conformance/cairnx_ref.py`):
- The open-lane claim becomes a short-expiry **`fclaim` Propose** (`{v,t:"fclaim",offer}`, FCLAIM_KEYS), and the
  open-lane fill **Attests that fclaim's txid** (not the offer id). L0's own attest-existence + attest-after-
  `expires_epoch` invalidity rules THEN ARE the hold deadline, so the overlay hold deadline == the L0 minability
  deadline and the cross-block window is removed by construction.
- **Grant ladder**: an fclaim is GRANTED as the offer's live hold only if the offer is open, CSD-priced, not
  taker-bound, not already held, past `CLAIM_COOLDOWN_BLOCKS`, with `E in [epochOf(h), epochOf(h)+
  FCLAIM_MAX_EPOCH_AHEAD]` (anti-squat) and under `MAX_ACTIVE_CLAIMS`; else DENIED. Denials are recorded
  `granted:false` in an internal `fclaims` map that is materialized GRANTED-only and **excluded from
  `canonicalState`** (so it never enters the replay hash - byte-identity preserved).
- **Correction 1**: an offer-txid fill during a live fclaim hold is rejected (openFillReject; both whole + partial).
- **Correction 2**: an offer cancel (ocancel or a score-0 cancel) landing during a live hold is FROZEN (no-op),
  keyed on the cancel's OWN captured block height, evaluated live on the offer object. This IS the Half A closure.
- **Lane B**: taker-bound V28+ offers are uncancellable (kills Half A for firm RFQ quotes).
- **SCORE_CLAIM sunset**: legacy claim Attests stop granting holds at V28 (self-sunsetting, no-height-literal
  predicate; otherwise legacy claims would keep minting Half-B-vulnerable holds forever). A pre-V28 legacy hold's
  fill is still HONORED after V28 until the hold lapses (no fork on the honored fill).
- **Last-write-wins `claimTxid`**: re-assigned on every grant, never cleared (a stale claimTxid = a second-holder
  burn).
- New client fund boundary **`verifyFillSpv`** (`verifyfill.ts`): the shared, fail-closed fill-SPV surface the
  site + wallet run before building an open-lane fill (grant replay over merkle-proven events; refuses a denied /
  superseded fclaim, a forged-holder fill, a below-depth fill, a cross-offer `MAX_ACTIVE_CLAIMS` over-cap, and a
  past-deadline strand). New selectors `fclaimHoldEnd`/`fclaimEpochFor`; `GAP_NEEDED`=104, `MAX_SCAN`=134.

New constants: `V28_HEIGHT`=60,000, `FCLAIM_MAX_EPOCH_AHEAD`=2, `FILL_TIP_MARGIN`=2.

**Byte-identity**: every pre-V28 canonical-state replay hash is byte-identical (`vectors.test.ts` 71/71; all
pinned real-chain heights <= 45,959 < 60,000). Only events at height >= 60,000 see the new rules; the live tip
was ~53.1k at the bump, so nothing is active yet. `resolve.ts` grew only ~+111 lines and `cairnx_ref.py` ~+76;
7 new `v28-*` golden vectors in `cases.json` (regenerated relative to V28_HEIGHT). This release also cherry-picks
the csd-light SG-CONTENT-BIND-1 merkle re-derive-txid change (see the csd-light 0.1.18 entry below), so the site
fill-SPV binds an offer record to the on-chain commitment, not a resolver-served /proposal.

**Adoption discipline (HARD gate, both directions)**: this is a fund-safety rule change, so EVERY PRIMARY replayer
(the cairnx svc, cairn-cli, cairn-sdk, and the vendored cairn-site + cairn-wallet bundles) MUST be on this core
before the tip reaches 60,000, or a stale replayer forks the app layer (stale clients strand, never burn - the
fail direction is safe). clarvis is a STRICTLY-OPTIONAL second source (the wallet's clarvis paths are all
fail-soft: a clarvis 404/timeout/unreachable PROCEEDS, only a value conflict from a REACHABLE clarvis refuses),
so a stale clarvis degrades to single-source verification, never a burn; upgrade clarvis when convenient but do
NOT gate the launch on it. The D2 service alias on the PRIMARY resolver (cairnx svc) is the one availability hard
requirement - it bridges the stale CWS field wallet so its `GET /cairnx/offer/{fclaimTxid}` does not 404 into an
open-lane outage; D2 on clarvis is optional (only relevant to a wallet whose configured primary is clarvis, or a
primary-down failover). STRONG COMPANION: the node reorg ghost-UTXO fix (finding-9, `cairn-node-v0.1.4`) must
land BEFORE V28 - V28 sharpens its trigger (a reorg-orphaned short-lived fclaim Propose plus a payment-bearing
fill Attest hits the app-phase existence/expiry bail mid-apply). 60,000 is legally BUMP-able (a coordinated
same-day re-pin of every verifier) if the rollout needs more runway.

**Audit**: `test:crosslang` v28 26/26 (JS==Python at 55k, incl. below-gate inertness) + all v20-v27 grids +
fuzz 1500 + regex 2301; `audit:all` money-safety --selftest green (v2.8 honest fclaim fill silent, every known
misbehaving-client burn re-surfaced); 4,800 newly-authored fclaim fuzz scenarios (0 zero-delivery accepts) + a
3-agent red-team (found + fixed 3 client-side burns; the consensus core resisted every attack, no break).
DEDUP DEBT noted for follow-up: the client fill-SPV evidence layer (scan + prevout bind + cap count + give-backing
synthesis) is hand-implemented TWICE (site swapguard.js + wallet fillspv.ts) with divergent algorithms and no
shared vector; consolidate into a shared cairnx-core evidence helper before the next such change. Rollout order:
follow "Rollout checklist for a NEW GATE" below (this is a rule change, not just a fee tier, so step 2 adds the
crosslang cases + re-pins nothing that resolve() did not change - all pre-V28 hashes stayed identical).

## csd-light 0.1.18 (2026-07-13, rides the V28 rollout) - SG-CONTENT-BIND-1: verifyTxInclusion re-derives txid + surfaces the proven tx

`LightClient.verifyTxInclusion` (`packages/light/src/index.ts`) now folds the merkle branch over a txid
RE-DERIVED from each tx BODY (`codecTxid(rpcTxToTx(body))`), never the server-reported `.txid` field, and on a
proven inclusion SURFACES the proven `tx` plus (for a Propose) its committed `appPayloadHash` on the
`InclusionResult`. This closes SG-CONTENT-BIND-1: a caller (the cairn site swapguard `verifyOfferContent`) can now
bind an offer record to the ON-CHAIN commitment instead of the resolver-served `/proposal` (which the same routed
backend controls). A lying read path that swaps a tx body while keeping the reported `.txid` re-derives to a
different id and fails closed (it matches neither the requested txid nor the PoW-verified merkle root). Reject-more
only: every honest inclusion that verified before still verifies (the re-derived id of an honest body equals its
reported id); the added `tx`/`appPayloadHash` fields are additive (no existing `InclusionResult` consumer breaks).
NO consensus-byte change, no height gate; it rides the V28 wave because the V28 site fill-SPV depends on the
surfaced fields. Pinned by `packages/light/test/content-bind.test.ts` (the forged-record attack rejected; deleting
the bind lets the old server-txid fold accept the forgery). Mirrors the shipped `verifyClaimSPV` block
re-derivation, made canonical in the SDK for the A1/B4 fill-SPV surface.

## cairnx-core 0.1.36 (2026-07-10) - finalizeWinnerCheck gains the finalize-window checks (client helper only, replay untouched)

`packages/cairnx/src/preflight.ts` completes `finalizeWinnerCheck` with the N-2 finalize-window
checks: an optional `tip` parameter adds BOTH the freeze-window ("too early") and expiry ("window
closed") refusals, mirroring the resolver's authoritative nfinalize gates (`resolve.ts`: rejects
unless `ev.height > effHeight + REG_COMMIT_MAX_BLOCKS`; rejects when `ev.height > finalizeBy`) with
the client-side `FINALIZE_TIP_MARGIN` band the site's `finalizeReady` already applies. Callers that
omit `tip` keep the exact winner-only semantics (backward compatible). The window is derived PURELY
from the caller's pinned `commitHeight` (`= effectiveHeight`), NEVER from the resolver-supplied
`finalizeBy` (the true deadline is always `eff + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS`),
so a hostile resolver returning an inflated `finalizeBy` cannot widen the safe band into a fee burn --
preserving the module's "no resolver value can induce a loss" invariant. The consensus surface is
UNTOUCHED: the `resolve.ts`/`records.ts`/`types.ts` diff for this release is empty, no serialization,
gate, constant, or replay byte changes, so replayers on 0.1.35 compute byte-identical canonical
state. Pinned by a 10-case window grid in `test/preflight.test.ts` (the refusal + lying-finalizeBy
cases fail on 0.1.35). No height gate needed (additive client-selector logic).

## csd-light 0.1.17 (2026-07-10) - snapshot anchor containment + restore-time timestamp rules (reject-more only)

`LightClient.fromSnapshot` (`packages/light/src/index.ts`) hardens the restore path in two
reject-more-never-accept-different ways. (1) Anchor containment: a checkpoint-configured client now
refuses any snapshot unless a pinned checkpoint COVERS the whole trusted seed prefix, i.e. some
configured `cp` with `baseHeight + LWMA_WINDOW - 1 <= cp <= last` (genesis-rooted snapshots stay
exempt, anchored by the H4 genesis check; honest wallet snapshots seed `baseHeight = cp - LWMA_WINDOW`
so they pass with zero false-reject). The restored `trusted` seed prefix (first `LWMA_WINDOW` headers)
skips LWMA/time re-derivation, so it is only safe when a checkpoint's hash-pin sits at/above its top
and the backward prev-chain forces every prefix header real. Without this a poisoned snapshot could
place forged min-difficulty headers inside the prefix and restore them as verified (grindable at
POW_LIMIT; requires storage-write + a hostile RPC). This supersedes the initial "must contain the
lowest checkpoint" rule, which still left a poisoning BAND (`baseHeight` within `LWMA_WINDOW` of the
checkpoint) open -- closed here and pinned by a dedicated band test. (2) The H3 timestamp rules
(min-spacing, MTP, future-drift) now also run on restore for
exactly the headers whose LWMA window is re-derived, in `verifyOne`'s check order (time before bits
before PoW, as the node does). Deterministic for min-spacing/MTP and the wall-clock bound only
loosens with time, so an honestly-synced snapshot can never regress on restore. Forward-sync
(`sync`/`ingest`/`verifyOne`), LWMA math, header bytes: untouched. Every accepted header set for
honest chains is identical; only forged/unanchored snapshots are newly rejected. Pinned by the C1/H1
containment + band + H3-on-restore mutation tests in `light-offline.test.ts` (each fails on 0.1.16).
No height gate needed (client-local trust hardening, no consensus-byte change).

## csd-light 0.1.16 (2026-07-10) - LWMA bits->target memo (perf only, byte-identical)

`packages/light/src/lwma.ts` gains a module-scope memo of the pure `targetToBigInt(bitsToTarget(bits))`
composition (capped Map, clear-at-cap 4096; invalid encodings cache as `0n` and still throw exactly
where the old all-zero-bytes check threw). ZERO math changes: every accepted/rejected `bits` and every
derived target is identical; the sliding 45-header window just stops re-converting the same header's
bits up to 45 times. Motivation: a wallet-scale `LightClient.fromSnapshot` restore measured ~85% LWMA
re-derivation; the memo cuts restore cost ~4x (192 -> 47 us/header on the real-header fixture).
Byte-identity pinned by the new `packages/light/test/lwma-memo.test.ts` (memoized impl vs an
unmemoized raw-codec reference on every real fixture window + edge encodings + forced cap eviction)
and by the unchanged `light-offline.test.ts` golden (real mainnet headers incl. the H4 poison vector).
No height gate needed (no behavior change).

## 0.1.33 (2026-07-03) - activation heights pulled in (no rule changes)

`V24_HEIGHT` 49,200 -> 46,400 · `V25_HEIGHT` 51,000 -> 46,440 · `V26_HEIGHT` 51,200 -> 46,480 ·
`V27_HEIGHT` 52,500 -> 46,520 (tip was ~46,071 at edit). ZERO byte-level rule changes: the same
gates activate sooner. Safe ONLY as a coordinated same-day re-pin of every verifier (cairnx svc,
mm, website vendor bundle, wallet vendored SPV, cli, clarvis) BEFORE the tip crosses 46,400 -
operator-approved private-alpha compression of the adoption windows (the wallet is being
resubmitted to CWS anyway). All recorded history (<= tip at edit) is below every new height, so
pre-gate replay stays byte-identical and the pinned conformance corpus is unaffected.

## 0.1.32: V27 young-name sale-embargo relaxation + polish (2026-07-03)
- **Consensus change (gated, non-retroactive): V27_HEIGHT = 52,500.** At an offer's anchor height >= V27 the
  young-name SALE embargo shrinks from `COMMIT_MAX_BLOCKS` (240 blocks, ~8h) to `REG_COMMIT_MAX_BLOCKS` (8
  blocks, ~16min): `saleEmbargo = ev.height >= V27_HEIGHT ? REG_COMMIT_MAX_BLOCKS : COMMIT_MAX_BLOCKS`
  (resolve.ts offer branch; mirrored in cairnx_ref.py). Provably redundant under the V25 sealed model (an
  offer requires a finalized/non-pending name, and finalize requires the displacement freeze
  `ev.height > effHeight + REG_COMMIT_MAX_BLOCKS` to have passed, so every window-valid displacer's reveal
  deadline is closed by the time any sale can exist; displacement of a finalized name is arithmetically
  impossible). Below V27: byte-identical (the 240-block rule). This is a RELAXATION, so it is a HARD ADOPTION
  GATE: every replayer (the reference resolver, clarvis, the vendored UI/wallet bundles) MUST run 0.1.32 before the tip
  crosses 52,500, else a stale one rejects an offer the chain accepts (view divergence, no fund loss). Set
  past V26 (51,200) and the unrelated V23 nset-clear gate (also 52,000) so no two activations share a block.
  Pinned by conformance/v27-sale-embargo-crosslang.mjs (straddle, both languages) + a money-safety
  sealed-sale scenario (0 burns); non-retroactivity proven by 64/64 unchanged vectors + fuzz 1500/1500 +
  an independent old-0.1.31-vs-new-0.1.32 differential (1000/1000 byte-identical) + a live 269-event replay.
- **Behavior-preserving polish (byte-identical below AND at every prior gate; proven by the same suites):**
  the comment-truth pass (V18-V26 stale "placeholder/dormant" wording corrected to their active heights);
  `delete n.pending/finalizeBy` instead of `= undefined` (removes the one JS/Python present-undefined-vs-pop
  asymmetry); extracted `voidOpenNameOffers` (from 4 inline copies) and `earlierAnchor` (from 3 displacement
  contests); dropped a dead `isName` import; documented the tip+1 closing sweep and the
  unreachable-under-production-constants pay-now reclaim. **CONVENTION.md §5.1 A2:** documented the
  numeric-key trap CORRECTLY for BOTH hash paths. `canonicalJson` (record/payload) sorts pure code-unit
  (`"10"` before `"2"`), but `canonicalState` inherits `JSON.stringify`'s enumeration (integer-index keys
  ascending-numeric FIRST, then code-unit, so `"2"` before `"10"`). A third-party impl MUST reproduce both;
  a review caught the first draft had it inverted for canonicalState (a genuine fork trap for numeric names).
- Bumped **only** cairnx-core (0.1.31 -> 0.1.32); csd-* stay 0.1.15.
- (History note: 0.1.15-0.1.31 shipped V20-V26: late-fill fix, duration cap add/remove, nset-clear,
  length-graded fee, and the V25/V26 sealed reservation/recapture. Those bumps were logged in their plan
  docs + handoffs rather than here; this entry re-establishes the per-gate History convention.)

### 0.1.14: quality/AI-slop pass (2026-06-20)
- **No consensus-surface or runtime-behavior change** (the forward-codec + resolver differential vs the live
  node stays at 0; all suites byte-identical). Maintainability only: corrected over-claiming consensus comments
  to name what is *guarded* vs *asserted* (resolve.ts header, records.ts onlyKeys, conformance/README META-1);
  type hygiene (`verifyInputValues` typed input, `health(): RpcHealth`, generic `getJson<T>`, `txToNodeJson():
  NodeTxJson`, `Signed.nodeJson` typed); added the `siwc` README. (Deferred: `TREASURY_ADDR` single-sourcing,
  guarded by the new consts-parity check, and the 600-line `resolve.ts` structural split.)

### 0.1.13: security remediation (2026-06-20)
> Bytes differ from npm `0.1.12` by the entire Phase-1 remediation below, hence the version bump (M4:
> never the same version with different bytes). Published lockstep; `cairn-sdk` exact-pins this version.
- **Consensus-surface conformance hardening (no change to live acceptance, one reference correction):**
  - **C1 (reference correction):** the Python reference `cairnx_ref.py` validated the 6 schema regexes with
    `re.match(…$)`, which accepts a trailing `\n` the JS `.test(/…$/)` rejects: a latent cross-language fork.
    Changed all to `re.fullmatch`. The authoritative JS resolver already rejected these, so **no live state
    changes**; this converges the reference to the live resolver. New `conformance/crosscheck-regex.mjs`
    (regex-vs-regex differential) + a parse-gate corpus pin it.
  - **NEW-1 (PoW-limit gate):** `powOk`/`workForBits` now reject `bits` whose target is easier than
    `POW_LIMIT_BITS` (mirrors the node's `bits_within_pow_limit`). Reject-more; honest headers unaffected.
  - **NEW-2 / L10 (codec):** `deserialize` now rejects invalid UTF-8 in `domain`/`uri` (`TextDecoder fatal:true`),
    matching the node's bincode + restoring the byte round-trip. Reject-more; on-chain data is always valid UTF-8.
  - **L16:** truncated reads throw the documented "unexpected end of bytes" (not a native `RangeError`).
  - **H3 (light):** `verifyOne` enforces MTP / min-spacing / future-drift (the node's timestamp rules).
  - **H4 (light):** `fromSnapshot` re-derives LWMA for any header with a full window regardless of the
    attacker-controllable `trusted` flag; a genesis-rooted snapshot must start at the real genesis.
  - Non-consensus fund-safety/robustness: `verifyInputValues` wired via `buildSendVerified` (H2);
    `verifyDigest` fail-closed (M1); 32-byte digest enforced (L14); NaN/∞ confirmations rejected (L4);
    `EPOCH_LEN` single-sourced from `codec` (M5); SIWC zoneless-timestamp + future-skew hardening (L2/L3/L17).
- **Forward codec executed-verified** against the live `csd` node (serialize/txid/sighash/sign/header/merkle/
  bits↔target byte-identical JS == Python == Rust). The vendored bundles (`cairn/public/vendor/csd-light.js`,
  `cairn-wallet/src/vendor/cairnx-spv.js`) were rebuilt from this dist (H6).

### 0.1.6 – 0.1.11 (V16–V19: height-gated CairnX convention bumps)
- **V16 (`V16_HEIGHT=33600`):** trade fee 1%→1.5% + maker rebate on the resting-liquidity lane (height-gated;
  pre-V16 replay byte-identical).
- **V17 (`V17_HEIGHT=34000`):** open-ask claim-to-fill (payment-free first-claim exclusivity; height-gated).
- **V18 (`V18_HEIGHT=40000`):** simplified 2-tier `.csd` name registration fee (≤4ch / ≥5ch; height-gated, dormant).
- **V19 / nprofile (`V19_HEIGHT=36700`, ACTIVE on-chain):** ENS-class inline identity (`nprofile`), owner-gated
  profile map, last-write-wins, cleared on transfer; tip-gated materialization (pre-V19 replay byte-identical).
  JS⇄Python byte-identical over 50k+ differential cases; now wired into `test:crosslang` + CI
  (`nprofile-crosslang.mjs` with cross-impl constant PARITY + the fuzzer emits nprofile).

### 0.1.5 (unpublished lockstep, on `master`)
- **No consensus-surface changes.** `buildPropose`/`buildAttest` gained optional DvP value
  outputs (new *capability*, existing byte encodings unchanged; an attest with value outputs
  was always valid chain-side); client retries/types; light snapshots/batch. Existing vectors
  unchanged and green.
- `@inversealtruism/cairnx-core` extracted as a package. Its replay-hash contract is pinned by
  the CairnX conformance artifact (16 vectors + replay hashes); any change to those is a
  CairnX convention version bump (activation-height gated), never a silent edit.

### 0.1.4
- **No consensus-surface changes.** Hardening only: `deserialize` MAX_TX guards (C-S1),
  chainwork u128 clamp (A-S4), both reject-more, never accept-different; `buildSend` refuses
  >2^53 values it would previously have silently truncated (C-S2: fail-loud on inputs that
  could never have produced a valid tx).

### 0.1.3
- **No consensus-surface changes.** u64 precision/negative guards + `canonicalJson`
  undefined/DoS guards (reject-more), merkle root normalization (0x/case: accepts equivalent
  encodings of the *same* root).

### 0.1.2
- **light**: checkpoint-start + reorg handling + full-range LWMA-45 (validated 401/401 against
  the live chain). First release where header validation is complete.

### 0.1.0–0.1.1
- Initial release of the consensus surface: codec serialization byte-identical to the Rust
  node's `golden_vectors.rs`, `CSD_SIG_V1` sighash verified against real on-chain signatures
  (67/67), SDK-built transactions accepted by the live node.

## Release checklist for a consensus-touching change

1. Land the change with updated/extended golden vectors in `csd-vectors`; never change
   behavior without a vector that pins it.
2. Bump the package(s) you changed and every workspace package that depends on them (independent cadence:
   numbers need not match). A published version keeps the exact pins it shipped with, so an unbumped
   dependent keeps the old dependency in the published graph; `scripts/check-lockstep.mjs` fails on that.
3. Add an entry here describing exactly what bytes/math changed and why.
4. Run the full suite against a live node (oracle + light full-range) before the npm window
   (`node scripts/npm-window.mjs`, check mode first).

## Rollout checklist for a NEW GATE or FEE TIER (V28+)

Since the 2026-07-06 promotions, a new name-fee tier is a ONE-FILE core change; the rest is
mechanical refresh. In order:

0. Write the gate's own file, `docs/gates/<gate>.md`, from `docs/gates/TEMPLATE.md`, and link it from the gate's
   entry in this file (CONVENTION.md §39). `scripts/check-consensus-citations.mjs` checks its citations and fails
   while it is unlinked; its rollout table records the live observation of each consumer in steps 4 and 5.
1. Add the gate height to `packages/cairnx/src/types.ts` and, for a fee tier, add it to
   `NAME_FEE_GATES` in `packages/cairnx/src/preflight.ts` (buildFeeHeight owns the list; the
   wallet and the trade UI import it, so no hand edit exists anywhere else).
2. Vectors + conformance: extend `packages/cairnx/test/preflight.test.ts` (gate +/- margin grid),
   add the crosslang case if the change affects canonical state, re-pin replay hashes if (and
   only if) resolve() behavior changed.
2b. Run `node conformance/proven-terms-classification.mjs` (also in `test:crosslang`). If the gate
   added ANY field to a served offer, this fails until the field is classified as BOUND or
   DELIBERATELY_UNBOUND_WITH_REASON - classify it in the SAME change. This is the executable
   tripwire against the 2026-07-19 theme (a served field nothing binds and nobody decided about:
   the W1/W2/W3/W7/W10 class).
3. Bump `packages/cairnx` version, `pnpm -r build`, then the npm window `node scripts/npm-window.mjs` (it runs the publish guard and verify-tarball on each tarball).
4. Re-pin the npm consumers: cairnx svc + cairn-sdk package.json, `node scripts/check-consumer-pins.mjs`,
   reinstall, restart the cairnx service off-peak (never during a gate crossing).
5. Re-vendor the bundled consumers: wallet `bash scripts/build-spv-vendor.sh` +
   `node scripts/check-vendor-fresh.mjs --write`; cairn `bash scripts/build-trade-vendor.sh` +
   `node scripts/check-vendor-fresh.mjs --write`. Land these promptly: neither gate follows csd-sdk
   HEAD (cairn's vendor job rebuilds from the commit its `PROVENANCE.json` pins, and the wallet builds from the
   pinned npm packages), so their CI stays green on the old pin and only this step moves a bundled consumer
   onto the new core.
6. Grep the ecosystem for the new height as a raw literal; the only hits should be vendored
   bundles and parity-test expectation grids.
7. Purge Cloudflare for cairn (`/vendor/cairnx-core.js` + the usual .js/.css) after deploy.
