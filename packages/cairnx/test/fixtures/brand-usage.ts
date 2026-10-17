// COMPILE-GATE FIXTURE for the ProvenOfferTerms brand (B6a rider; LTS amendment re-routing the G6
// "different-file hand copy" cure into csd-sdk). This file is NEVER executed - test/brand.test.ts runs
// `tsc --noEmit` over it and asserts a CLEAN compile. The clean compile proves BOTH directions at once:
//   1. every legitimate use below still compiles (the brand is additive and default-safe), and
//   2. every `@ts-expect-error` line REALLY errors - if the brand is ever weakened so a hand-built object
//      literal satisfies the minted bindOfferTerms overload, tsc reports "Unused '@ts-expect-error'
//      directive" and the compile (and therefore brand.test.ts) goes RED.
import {
  bindOfferTerms, provenOfferTerms, unsafeMintProvenOfferTerms,
  type ProvenOfferTerms, type MintedProvenOfferTerms, type OfferRecord,
} from "../../src/index.js";

const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: "0x" + "a1".repeat(20) } } as unknown as OfferRecord;

// 1. the canonical producer mints the brand; minted terms take the default legs or explicit switches (must compile)
const minted: MintedProvenOfferTerms = provenOfferTerms(rec, 60_002);
void bindOfferTerms({}, minted);
void bindOfferTerms({}, minted, { give: true, wantType: true });
void bindOfferTerms({}, minted, { give: false });

// 2. a hand-built ProvenOfferTerms compiles only with both legs explicitly off (the pre-B6 verdict)
const hand: ProvenOfferTerms = { height: 60_002, feeBps: 150, value: "500000000" };
void bindOfferTerms({}, hand, { give: false, wantType: false });

// 3. the brand: a hand-built variable CANNOT take the default legs (the W2 defect class, a compile error)
// @ts-expect-error a hand-built ProvenOfferTerms does not carry the mint brand
void bindOfferTerms({}, hand);
// @ts-expect-error nor an explicit leg
void bindOfferTerms({}, hand, { give: true });
// @ts-expect-error nor a single opt-out (the other leg stays on)
void bindOfferTerms({}, hand, { give: false });

// 4. the brand: an inline object literal cannot take a leg either (the "sixth producer" tripwire)
// @ts-expect-error an object literal cannot mint the brand
void bindOfferTerms({}, { height: 60_002, feeBps: 150 }, { give: true });

// 5. the documented tests-only escape hatch mints explicitly (must compile)
void bindOfferTerms({}, unsafeMintProvenOfferTerms(hand), { give: true });
