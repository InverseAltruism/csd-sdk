// @inversealtruism/cairnx-core — the CairnX convention, as a library: tokens, atomic
// delivery-versus-payment trades, and a leased name registry for Compute Substrate, carried
// entirely in the chain's Propose/Attest `uri` payloads (the Ordinals/Runes trust class,
// stated plainly). CONVENTION.md in this package is the normative spec; test/vectors/ is the
// conformance bar — an independent implementation is conformant iff it reproduces every
// vector byte-for-byte and the pinned live-chain replay hashes.
//
//   records  — parseRecord (the validation gate) + canonical builders for every record type + the
//              decoy-key allowlists (*_KEYS)
//   resolve  — THE pure deterministic resolver: (events, tipHeight) → CairnXState
//   types    — constants (activation heights, fees, lease parameters) + state/record types + the pure
//              client selectors (claimWindowAt/Of, claimGraceOf, offerExpiryHeightOf, epochOf, fee math)
//   client   — reorg-safety helpers a client must apply before paying (requiredClaimDepth)
export * from "./types.js";
export * from "./records.js";
export { resolve, canonicalState } from "./resolve.js";
export * from "./client.js";
// preflight — the pure "before you sign a value tx" surface (previewFill / fillIsSafe / finalizeWinnerCheck);
// mirrors the resolver's fill + claim + freeze math so every value-bearing builder inherits loss-safety.
export * from "./preflight.js";
export { paidToFromOutputs } from "./paidto.js";
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
