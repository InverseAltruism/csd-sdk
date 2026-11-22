# Architecture

Maintainer reference for the workspace: what each package holds, where the CairnX rules live, the gate heights, the
`claimWindowOf` hint and who consumes the packages. `AGENTS.md` keeps the rules; this file keeps the detail behind its
code map. Versions are not listed here: read `packages/*/package.json` (workspace) or
`npm view @inversealtruism/<pkg> version` (published).

## Packages

The workspace is `packages/*` (`pnpm-workspace.yaml`); the root `package.json` is private and names the pnpm version in
`packageManager`. Every package builds with tsup to esm, cjs and dts, except cairnx-replica, which builds to esm and dts, cairnx-pin,
whose build derives its log from recorded blocks and writes one esm module with its types, and csd-anchors, whose build
checks its table and writes one esm module with its types.

| Package | Purpose |
|---|---|
| csd-codec | Consensus codec: bincode fixint-LE, txid, sighash CSD_SIG_V1 (sha256d over taggedHash + CHAIN_ID_HASH), 84-byte header, bits<->target, merkle root/branch/proof, canonicalJson/payloadHash. Only dep: @noble/hashes. |
| csd-crypto | secp256k1 keygen/signDigest (low-S, RFC-6979)/verifyDigest (the node's rule: the 64 bytes read as compact only, never DER; low S; fail-closed), hash160 addresses, addrFromScriptPubkey (the node's address parser), buildScriptSig, authorOf (a tx's author: the owner of the coin input 0 spends, when the scriptSig is that owner's signature). Thin noble wrappers, no hand-rolled crypto. |
| csd-tx | Tx builder: selectInputs (dedupe, unconfirmed-drop, 512 cap), buildSendVerified (takes a verifier such as csd-client verifyInputValues and computes change from the verified input total), buildProposeVerified/buildAttestVerified (DvP value outputs), the deprecated buildSend and unverified buildPropose/buildAttest, signTx, txToNodeJson, feeCap helpers. |
| csd-client | Typed HTTP RPC client; 4xx doesn't spend retry budget; hostile-boundary tested. Transport, plus verifyInputValues (recomputes each input's source txid). Bodies parse with parseJsonExact by default (an integer above 2^53 stays an exact bigint). |
| csd-light | Light client: headers-first sync, client-side PoW + LWMA-45 bits re-derivation + chainwork + MTP/timestamp rules, verifyTxInclusion, bindBlockBody (the one block bind: exact parse, repeated-txid refusal, merkle compare to a verified header, and every tx served as the node writes it: its txid field the id its body hashes to, each hash, address and script as 0x and lower-case hex and the app type None, Propose or Attest, else body-mismatch, because no hash commits the txid field and the codec reads other spellings to the same bytes; bindBlockTxs is the same bind over txs the caller already parsed exactly), syncFromCheckpoint, honest trustLevel on every read (balance is rpc-trusted); tipHeaderPowOk and contenderPlausible, the checks before a non-primary RPC backend may win routing. |
| csd-vectors | Golden conformance vectors from the node's frozen golden_vectors.rs, real on-chain data, and signature encodings with the node secp256k1 crate's verify_sig verdicts (`SIG_VECTORS`). Zero deps. |
| cairnx-core (packages/cairnx) | `resolve(events, tipHeight) -> canonical state`, pure deterministic replay (tokens, names+lease+commit-reveal, offers, bids, fills, fees). Ships the normative CONVENTION.md (section 32 is the v2.9 M4/M5 write-up) + portable vectors + replay-hashes. Modules below. |
| cairnx-core/mm (packages/cairnx/src/mm, export `./mm`) | The market maker's sizing and Sunrise pricing math, shared by the maker service and the site. Not consensus: resolve() reads none of it and the root export does not include it. |
| csd-siwc | Sign in with CSD: audience-bound, replay-resistant wallet auth; own Python ref (siwc_ref.py). |
| cairnx-replica (packages/replica) | A CairnX replica over cairnx-core (a peer dependency): the basis each store is filled from and the level and proof it gives every answer (`checkBasis`, `levelOf`, `proofOf`, `basisKey`), the source and store types, `memoryStore`, and the internal loop (`replicaLoop`: a source's steps checked against the contract and committed to a store, reorgs rolled back, failures backed off; rows read back are checked against the events hash and a rows hash over their full content) with `fullReplay`, the only way to a resolved state, since no state is persisted; `./testing` holds `fixtureSource` and the event factories; `./browser` and `./server` add `nodeBlocks`, complete blocks from one's own node (a loopback address in a page; also private ranges and `CAIRNX_OWN_NODE_HOSTS` on a server) bound to its headers with authors bound by `authorOf`, `hostedBlocks`, complete blocks from the front door's `/api/blocks` bound to headers from an anchor (verified with csd-light in a window, with its reorg and reseed rules) or the caller's `VerifiedHeaders`, and `readBlocks`; the reader, `open` and `openLog`: `name` (cairnx-core's `nameView`), `balance`, `primary`, `state`, `events` and `transfers` (the applied log's token moves), paged by one cursor bound to the events hash below it, and `dryRun` answered `verified` only when the basis is level 3, the gate tables agree, the loop is synced at a fresh tip that no witness's plausible higher tip beats and, for an anchor or caller root, a witness on another origin confirmed the branch within 30 minutes, else `shown` with the codes that failed; `nodeWitness`, `hostedWitness` and `local`; `pinned`, a release's log below a pin checked by its sha256, events hash, gate table and state hash and by the pin's block hash against the root above it, `checkPin`, `derivePin` (`./server`) and the `hosted` preset; `./display`, our API's name and token reads at level 1, never verified, without `resolve()`; `nameHistory` and `appliedIds` (`.`), the resolver's five state reads (`readState`, `readName`, `readResolve`, `readNameHistory`, `readProfile`, with `leaseInfo` and `nameDetailsOf`, `.`) and, in `./server` only, `replicaReads` (those reads from `reader.snapshot()`, withheld with 503 while the replica's state is not one to serve) and the CairnX resolver's indexer `Scanner` with `indexerFeed`, a feed source over it (level 1, or 2 with `verifyInclusion`, whose tip is then the final height), moved from the private resolver (`scripts/move-residual.mjs` prints the residual); the tuple of each boundary the loop holds (`status().tuple`) and the comparison with a reference's tuples (`reference`, `status().compare`, `PIN_DISPUTED`, a recount from blocks in `./server`). Unreleased. |
| cairnx-pin (packages/pin) | The pin for cairnx-replica's `pinned()`: `pin.json` and its log, derived at build from cairnx-core's recorded block fixture and the package's deltas (the blocks above the fixture that hold a record) and refused unless the three hashes match; `scripts/generate-pin.mjs`, run by hand on a host with its own node, makes the next delta and pin from a released header anchor. No runtime dependency. Unreleased (private). |
| csd-anchors (packages/anchors) | The shared block-hash anchors as data: `anchors.json` (one table on the 4,096-block grid with explicit heights, its floor and the CairnX activation root at 29,859) and `ANCHORS`, the same as a deep-frozen module. The build refuses a table that fails its shape rules or is not its own canonical text. `scripts/generate-anchors.mjs`, run by hand on the deploy host, makes the next table from cairn's three-source input by walking headers through csd-light from the committed floor, and `--check` re-walks the committed table and requires each entry canonical at a second RPC (`.github/workflows/anchors-check.yml`, started by hand). `scripts/render-wallet.mjs` renders the wallet's two generated files from the table byte for byte. No runtime dependency and no dependent in this workspace. Unreleased (private). |
| cairnx-api (packages/cairnx-api) | The types and pure handlers of the CairnX read API, version 1, over cairnx-core (an exact peer dependency): the envelope (`At`, `Page`, `Refusal`), the six lists' rows over the core's state types (counts in place of the unbounded `fills` and `offers` arrays), the error codes with their HTTP statuses (`ERRORS`), the closed parameter table of each route (`ROUTE_TABLE`) and `parseQuery`, which refuses any parameter outside it, and the cursor codec of each list order (`CURSORS`); `./handlers` holds `prepareView`, the frozen view of one published state with `rev`, and `answer`, a v1 read of any of the six lists from the views held. No I/O, browser-safe. From 1.0.0 the package is the API's contract (its README): additions in any release, a removal only after six months' notice. |

## cairnx-core modules (`packages/cairnx/src/`)

- `resolve.ts`: the replay as a fold over events in apply order (one step per event; the closing sweep and the
  materialized state at the tip are its only tip-dependent end) and its apply order (`applyOrder`, `eventId`:
  CONVENTION section 33.3); its
  per-record handlers and shared state context live in `resolve/`, whose handlers write each token move (CONVENTION
  section 41) on the applied entry at the line that moves the balance, and `resolve/store.ts` holds the offers, bids, names and recapture reservations with the replay's private indexes (expiry
  queues in `resolve/minqueue.ts`; candidates per owner for the reservation caps, per holder for the live-hold cap, per
  seller and give asset for the bulk cancel, per name for the voids) and the only writes to the fields they key on; its
  sweep applies each expiry at the first height it is due, one batch per such height in ascending order, while every
  height and tip the fold has read is a safe integer, and one batch per sweep from the first that is not (the fold's
  `inDomain` in `resolve.ts`, CONVENTION section 5).
- `replay-context.ts`: the held replay context (`newReplayContext`): `resolve.ts`'s fold kept between tips, fed whole
  blocks in order, answering in place at the last height it was given, refusing (`ReplayContextRefusal`) a height or
  tip outside `isChainHeight` (in `types.ts`, the rule the fold's `inDomain` reads too) and an event whose position
  (`events.ts` `isIndex`) or id is outside `applyOrder`'s domain, keeping a one-level copy of each event it is given,
  and copying in each answer what a later advance writes (open offers, every bid, the log) while freezing what it
  shares.
- `types.ts`: all gate heights, fee constants, regexes, RESERVED_NAMES, and the pure client selectors including
  claimWindowOf.
- `records.ts`: parseRecord, explainRecord (the record code of a refusal) and its per-record key allow-sets; the
  builders, which throw RecordError.
- `codes.ts`: CONVENTION section 40, the reason-code table the applied log and the record checks use (REASON_CODES,
  REASON_CODE_OUTCOME, CAP_CODES); not consensus, since canonicalState leaves the log out.
- `preflight.ts`: previewFill, requiredFillOutputs, buildFeeHeight, fillIsSafe, finalizeWinnerCheck, fillEndorsement,
  fillOutputPlan.
- `verifyfill.ts`: verifyFillSpv + bindOfferTerms, the shared fail-closed fill fund boundary.
- `primary.ts`: pickPrimaryName.
- `forward.ts`: CONVENTION section 35.4, forward resolution: resolveNameIn (the address a name receives at) and nameView
  (the class, owner, address and profile a reader shows); both read `names` only.
- `version.ts`: CAIRNX_CORE_VERSION, the package's version (equal to package.json's).
- `gates.ts`: GATE_HEIGHTS, the gate table (ACTIVATION_HEIGHT and every V<n>_HEIGHT by name), built from the constants of
  `types.ts`.
- `client.ts`: claim-burial depth helpers.
- `paidto.ts`: outputs to paidTo aggregation for ChainEvent builders.
- `events.ts`: CONVENTION section 33, the rule from a block to events (eventOfTx, blockMembers, blockEvents); the
  author is an input the caller binds with csd-crypto authorOf.
- `hashes.ts`: CONVENTION section 34, the state hash and the events hash replicas compare (stateHash,
  eventsHashStep, eventsHash).
- `fillclosed.ts`: whether a buyer's proven fill closed the offer behind its fclaim hold.
- `holdcount.ts`: countOtherHoldsAtGrant, the buyer's other live holds at an fclaim's grant (verifyFillSpv's cap
  input).
- `admission.ts`: provenOfferRefusal, the admission check for a merkle-proven offer Propose (domain, the activation
  height, and the resolver's stateless offer rules, each read from its resolver home).

## conformance/

`cairnx_ref.py` and `siwc_ref.py` (independent Python oracles, written from spec, kept independent), `crosscheck*.mjs`,
`fuzz-resolve.mjs`, the per-gate `v2x-*-crosslang.mjs` files, and the report-only audit tooling: `invariants.mjs` (7
ledger-soundness invariants), `money-safety.mjs` (anchored-then-rejected burn detector), `race-harness.mjs`
(adversarial multi-actor races; P4 JS==Python byte-identity alone exits 1) and `AUDIT.md` (the method).
`moves-check.mjs` checks a result's token moves against its input events and its state (CONVENTION section 41), for the
cairnx-core tests and the seal.
`conformance/README.md` describes the differential.

## Consensus gates

All gate heights live in `packages/cairnx/src/types.ts`, the one home (it also holds V11 to V15); gates are height-pure
and non-retroactive. The list below is a reading aid, in height order.

- V16 = 33,600: fee 1% -> 1.5% + maker rebate.
- V17 = 34,000: claim-to-fill.
- V19 = 36,700: nprofile.
- V20 = 38,400: late-fill fund-loss fix, claim window 15 -> 40 + 5 grace.
- V18 = 40,000: 2-tier name fee.
- V21 = 40,100: offer duration cap 168 epochs.
- V22 = 41,300: cap removed for offers >= V22.
- V24 = 46,400: 4-tier name fee 15/10/5/3 CSD.
- V25 = 46,440: sealed reservation (payment-free reveal, winner-only nfinalize).
- V26 = 46,480: sealed recapture.
- V27 = 46,520: young-name sale embargo 240 -> 8 blocks.
- V23 = 52,000: nset-clear to zero addr.
- V28 = 60,000: fclaim open-lane settlement atomicity (CONVENTION section 31).
- V29 = 88,000: M4 event de-dup + M5 concurrent-hold status filter (v2.9).

Whether a gate is crossed is a live fact: compare its height with the tip from https://cairn-substrate.com/api/rpc/tip
(the `gates` field of /trade/api/cairnx/health lists V24 to V29). History and rollout notes: `CONSENSUS_CHANGES.md`.

RESERVED_NAMES (csd, treasury, admin, official, root, www, support) is defined in `packages/cairnx/src/types.ts`,
enforced by `records.ts` `isName` and mirrored in `conformance/cairnx_ref.py`; `conformance/nprofile-crosslang.mjs`
compares the two lists.

## claimWindowOf

The rule (`AGENTS.md`): claimWindowOf is a depth hint, never a sole fund gate. Why, in detail:

- For an fclaim hold (claimTxid passed) it returns FCLAIM_WINDOW_MIN = 46, the minimum span an fclaimEpochFor-requested
  hold can carry, so the derived grant is normally no earlier than the true grant and depth is under-stated
  (fail-safe).
- An expiry-capped hold (E clamped to the offer's expiry) can carry a true span < 46. There the derived grant is
  earlier than the true grant and claimWindowOf-derived depth over-states burial by (46 - true span) blocks, early in
  the hold. Against the older 40-block inverse this adds at most 6 blocks of over-statement; spans < 40 were
  over-stated under that constant too.
- Consumers gate funds on verifyFillSpv's independently computed merkle burial (`verifyfill.ts` derives depth from the
  proven events and never imports claimWindowOf), as the site swapguard and wallet do.

## Consumers

The chain is the only source of truth; every layer above is a deterministic replay, and this repo is the consensus
mirror the app layer runs on. The Rust node is the upstream oracle and never depends on the SDK.

- npm consumers, exact pins in their `package.json`: cairnx (the trading service), the cairn web server, cairn-sdk,
  csd-indexer and clarvis (the second-source resolver, which runs cairnx-core and must ride every gate bump).
  `node scripts/check-consumer-pins.mjs` reports the cairnx-core pins of cairnx, cairn-sdk and clarvis when their
  checkouts sit beside this one. For those consumers it also fails a cairnx-api pin, in any dependency section, whose
  release tag names another cairnx-core than the one pinned under `dependencies`, or which has no release tag naming
  that version (see `docs/release.md`).
- Bundled consumers: the cairn website ships browser bundles built from a csd-sdk checkout at the commit its
  `PROVENANCE.json` names; cairn-wallet ships an SPV bundle built from the published packages its `package.json` pins,
  with each package's version and registry integrity in its `PROVENANCE.json`. Each repo's `check-vendor-fresh.mjs`
  rebuilds the bundle and compares bytes, and `check-vendor-fresh.mjs --write` in that repo refreshes the bundle's
  provenance after a deliberate rebuild. The shared golden vectors keep both aligned with this core.
- A re-pinned `package.json` is inert until that service restarts, so a coherent pin table is not a coherent fleet:
  confirm each replayer by live query before a gate height, never by reading a manifest.
