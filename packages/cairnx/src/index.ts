// @inversealtruism/cairnx-core — the CairnX convention, as a library: tokens, atomic
// delivery-versus-payment trades, and a leased name registry for Compute Substrate, carried
// entirely in the chain's Propose/Attest `uri` payloads (the Ordinals/Runes trust class,
// stated plainly). CONVENTION.md in this package is the normative spec; test/vectors/ is the
// conformance bar — an independent implementation is conformant iff it reproduces every
// vector byte-for-byte and the pinned live-chain replay hashes.
//
//   records  — parseRecord (the validation gate) + canonical builders for every record type
//   resolve  — THE pure deterministic resolver: (events, tipHeight) → CairnXState
//   types    — constants (activation heights, fees, lease parameters) + state/record types
export * from "./types.js";
export * from "./records.js";
export { resolve, canonicalState } from "./resolve.js";
