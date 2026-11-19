// @inversealtruism/cairnx-core: the CairnX convention, as a library: tokens, trades (one transaction pays and
// records a fill; the replay decides delivery), and a leased name registry for Compute Substrate, carried
// entirely in the chain's Propose/Attest `uri` payloads (the Ordinals/Runes trust class,
// stated plainly). CONVENTION.md in this package is the normative spec; test/vectors/ is the
// conformance bar — an independent implementation is conformant iff it reproduces every
// vector byte-for-byte and the pinned live-chain replay hashes.
//
//   records  — parseRecord (the validation gate) and explainRecord (its reason code) + canonical builders for every
//              record type (RecordError names the rule they refuse) + the decoy-key allowlists (*_KEYS)
//   resolve  — THE pure deterministic resolver: (events, tipHeight) → CairnXState
//   types    — constants (activation heights, fees, lease parameters) + state/record types + the pure
//              client selectors (claimWindowAt/Of, claimGraceOf, offerExpiryHeightOf, epochOf, fee math)
//   client   - the claim-burial depth a client waits for before paying, sized against a minority miner (requiredClaimDepth)
export * from "./types.js";
export * from "./records.js";
export { resolve, canonicalState, ptAmt, applyOrder, eventId } from "./resolve.js";
export * from "./client.js";
// preflight — the pure "before you sign a value tx" surface (previewFill / fillIsSafe / finalizeWinnerCheck /
// requiredFillOutputs / buildFeeHeight); mirrors the resolver's fill + claim + freeze math so every
// value-bearing builder inherits loss-safety.
export * from "./preflight.js";
// primary — the reverse-resolution (addr→primary name) selector every host must compute identically.
export * from "./primary.js";
// forward: CONVENTION §35.4, the address a name receives at (resolveNameIn) and the view of a name a reader shows (nameView).
export { nameView, resolveNameIn, type NameView, type NameViewState, type ResolvedName } from "./forward.js";
// verifyfill: the shared client-side fill-SPV surface (§31), the fail-closed fund boundary for the
// open-lane fclaim buy. Pure record re-derivation + mandatory grant REPLAY (replayLiveHold) + the offer/
// fclaim/fill-basis depth gate (GAP_NEEDED) over an injected PoW-verified, merkle-proven FillSpvIo seam.
export * from "./verifyfill.js";
export { paidToFromOutputs, burnedPayment } from "./paidto.js";
// events: CONVENTION §33, the rule from a block to the events resolve() replays.
export {
  CAIRNX_EVENT_RULE, blockEvents, blockMembers, eventOfTx, type EventMember, type EventRule, type EventRuleTx, type EventsSoFar,
} from "./events.js";
// hashes: CONVENTION §34, the state hash and the events hash two replicas compare at one block.
export { EVENTS_HASH_START, FINAL_DEPTH, eventsHash, eventsHashStep, stateHash, type HashedEvent } from "./hashes.js";
export { myProvenFillClosedOffer } from "./fillclosed.js";
export { countOtherHoldsAtGrant, LEGACY_HOLD_SUNSET_HEIGHT, type HoldCandidate, type HoldCount, type HoldTarget } from "./holdcount.js";
export { provenOfferRefusal, type ProvenOfferTx } from "./admission.js";
// codes: CONVENTION §40, the stable reason codes of the applied log and of record validation.
export { CAP_CODES, REASON_CODES, REASON_CODE_OUTCOME, type AppliedCode, type ReasonCode, type RecordCode, type RefusalCode } from "./codes.js";
// Re-export the csd-codec primitives the cairnx consumers need so the browser UI / wallet import a SINGLE
// surface (cairnx-core) rather than re-typing canonicalJson or the reward/fee constants. (csd-codec stays
// the canonical home; this is a convenience re-export, not a second copy.)
export {
  canonicalJson,
  payloadHash,
  blockReward,
  INITIAL_REWARD,
  HALVING_INTERVAL,
  MIN_FEE_PROPOSE,
  MIN_FEE_ATTEST,
  EPOCH_LEN,
} from "@inversealtruism/csd-codec";
