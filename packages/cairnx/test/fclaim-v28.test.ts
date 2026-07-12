// v2.8 fclaim (§31) B2 BEHAVIOR test: the GRANT ladder, fill routing, Corrections 1 & 2, Lane B, the
// SCORE_CLAIM sunset, last-write-wins claimTxid, anti-squat, and the holdEnd boundary, all exercised at
// heights >= V28_HEIGHT. (The below-gate byte-identity is guarded by fclaim.test.ts + vectors.test.ts.)
import assert from "node:assert/strict";
import {
  deploy, mint, offer, offerCancelAll, fclaim, resolve, requiredFillOutputs,
  V28_HEIGHT, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, TREASURY_ADDR, DEPLOY_FEE, SCORE_FILL, SCORE_CANCEL, SCORE_CLAIM, epochOf,
} from "../src/index.js";
import type { ChainEvent, OfferState } from "../src/index.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; };
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const OID = "0x" + "0f".repeat(32);
const id = (n: string) => "0x" + n.repeat(32);
const H0 = V28_HEIGHT; // 100_000

const PE = (i: string, built: { uri: string; payloadHash: string }, height: number, proposer: string, expiresEpoch: number, pos = 0, paidTo: Record<string, string> = {}): ChainEvent =>
  ({ kind: "propose", id: i, proposer, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch, height, pos, paidTo });
const AE = (txid: string, proposalId: string, attester: string, height: number, paidTo: Record<string, string>, score = SCORE_FILL, confidence = 0, pos = 0): ChainEvent =>
  ({ kind: "attest", txid, proposalId, attester, score, confidence, height, pos, paidTo });

// base: A deploys+mints AAA and posts an OPEN CSD-priced offer (10 AAA for 5 CSD to A). Reused by every flow.
const base: ChainEvent[] = [
  PE(id("01"), deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H0, A, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(id("02"), mint({ ticker: "AAA", amount: "1000" }), H0 + 1, A, 9e9),
  PE(OID, offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } }), H0 + 2, A, 9e9),
];
const baseOffer = resolve(base, H0 + 5).offers[OID];
assert.ok(baseOffer && baseOffer.status === "open", "sanity: base offer is open");
const fillOutputs = (o: OfferState, pay: string): Record<string, string> =>
  Object.fromEntries(requiredFillOutputs(o, pay)!.map((x) => [x.to, String(x.value)]));
const paidFor = fillOutputs(baseOffer, "500000000");

// ── 1. GRANT + fclaim FILL delivers ──
const E = epochOf(H0 + 3) + 2;                       // a valid hold-end epoch
const fcTx = id("f1");
const grant = PE(fcTx, fclaim({ offer: OID }), H0 + 3, B, E);
const gState = resolve([...base, grant], H0 + 10);
const held = gState.offers[OID];
ok(held.claimedBy === B && held.claimTxid === fcTx && held.claimUntilHeight === (E + 1) * EPOCH_LEN, "GRANT sets the hold (claimedBy/claimTxid/claimUntilHeight)");
ok(gState.fclaims[fcTx] !== undefined && gState.fclaims[fcTx].offer === OID, "state.fclaims carries the GRANTED fclaim");
const holdEnd = (E + 1) * EPOCH_LEN - 1;
const fillState = resolve([...base, grant, AE(id("11"), fcTx, B, holdEnd, paidFor)], holdEnd + 5);
ok(fillState.offers[OID].status === "filled" && fillState.balances["AAA"][B].available === "10", "fclaim FILL at holdEnd delivers 10 AAA to the buyer");

// ── 2. holdEnd boundary: a fill one block PAST holdEnd is rejected (claim not held) ──
const lateFill = resolve([...base, grant, AE(id("12"), fcTx, B, holdEnd + 1, paidFor)], holdEnd + 5);
ok(lateFill.offers[OID].status === "open", "fclaim fill PAST holdEnd is rejected (hold lapsed)");

// ── 3. Correction 1: an OFFER-TXID fill during the hold is rejected ──
const c1 = resolve([...base, grant, AE(id("13"), OID, B, H0 + 10, paidFor)], H0 + 15);
ok(c1.offers[OID].status === "open" && c1.offers[OID].claimTxid === fcTx, "Correction 1: offer-txid fill during a hold is rejected");

// ── 4. DENIED fclaim (unknown offer) is not materialized; a fill on it delivers nothing ──
const badFc = id("f9");
const denied = resolve([...base, PE(badFc, fclaim({ offer: id("ee") }), H0 + 3, C, E)], H0 + 10);
ok(denied.fclaims[badFc] === undefined, "DENIED fclaim is NOT in state.fclaims (granted-only)");
const denFill = resolve([...base, PE(badFc, fclaim({ offer: id("ee") }), H0 + 3, C, E), AE(id("14"), badFc, C, H0 + 10, { [A]: "500000000" })], H0 + 15);
ok((denFill.balances["AAA"] ?? {})[C] === undefined && denFill.events.some((e) => e.kind === "fill" && !e.ok && /denied-fclaim/.test(e.note ?? "")), "fill on a DENIED fclaim delivers nothing and is audit-noted");

// ── 5. Correction 2 (ocancel): a same-block ocancel (pos 0) then fclaim grant (pos 1) leaves the offer held ──
const c2o = resolve([...base, PE(id("20"), offerCancelAll({}), H0 + 3, A, 9e9, 0), PE(id("f2"), fclaim({ offer: OID }), H0 + 3, B, E, 1)], H0 + 10);
ok(c2o.offers[OID].status === "open" && c2o.offers[OID].claimTxid === id("f2"), "Correction 2 (ocancel): held offer survives the same-block mass-cancel");

// ── 6. Correction 2 (score-0 cancel): a same-block score-0 cancel + fclaim grant leaves the offer held ──
const c2s = resolve([...base, PE(id("f3"), fclaim({ offer: OID }), H0 + 3, B, E, 0), AE(id("21"), OID, A, H0 + 3, {}, SCORE_CANCEL, 0, 0)], H0 + 10);
ok(c2s.offers[OID].status === "open" && c2s.offers[OID].claimTxid === id("f3"), "Correction 2 (score-0): held offer survives the same-block cancel");

// ── 7. Lane B: a taker-bound V28+ offer cannot be cancelled ──
const tOID = id("1f");
const laneB = resolve([...base, PE(tOID, offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "100000000", payto: A }, taker: B }), H0 + 3, A, 9e9), AE(id("22"), tOID, A, H0 + 5, {}, SCORE_CANCEL)], H0 + 10);
ok(laneB.offers[tOID].status === "open", "Lane B: a taker-bound V28+ offer is uncancellable");

// ── 8. SCORE_CLAIM sunset: a legacy claim attest at V28+ grants nothing ──
const sunset = resolve([...base, AE(id("23"), OID, B, H0 + 3, {}, SCORE_CLAIM)], H0 + 10);
ok(sunset.offers[OID].claimedBy === undefined, "SCORE_CLAIM at V28+ is rejected (no legacy claim)");

// ── 9. Last-write-wins: B's hold lapses, C grants, claimTxid moves to C; a fill on B's old fclaim is rejected ──
const bFc = id("fb"), cFc = id("fc");
const bGrant = PE(bFc, fclaim({ offer: OID }), H0 + 3, B, epochOf(H0 + 3)); // minimal hold, lapses fast
const bHoldEnd = (epochOf(H0 + 3) + 1) * EPOCH_LEN - 1;
const cH = bHoldEnd + EPOCH_LEN;                                            // well after B's hold + cooldown
const cGrant = PE(cFc, fclaim({ offer: OID }), cH, C, epochOf(cH));
const lww = resolve([...base, bGrant, cGrant, AE(id("31"), bFc, B, cH + 1, { [A]: "500000000" })], cH + 5);
ok(lww.offers[OID].claimTxid === cFc && lww.offers[OID].claimedBy === C, "last-write-wins: 2nd grant re-assigns claimTxid to C");
ok(lww.offers[OID].status === "open", "a fill on a SUPERSEDED fclaim txid is rejected (offer stays open)");

// ── 10. Anti-squat: an expiry more than FCLAIM_MAX_EPOCH_AHEAD ahead is denied ──
const squatFc = id("f8");
const squat = resolve([...base, PE(squatFc, fclaim({ offer: OID }), H0 + 3, B, epochOf(H0 + 3) + FCLAIM_MAX_EPOCH_AHEAD + 1)], H0 + 10);
ok(squat.offers[OID].claimedBy === undefined && squat.fclaims[squatFc] === undefined, "anti-squat: an over-far expiry is denied");

console.log(`cairnx-core fclaim B2 behavior: ${pass} passed`);
