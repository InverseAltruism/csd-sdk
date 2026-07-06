// preflight.test.ts — pins the shared pre-flight helpers (previewFill / fillIsSafe / finalizeWinnerCheck)
// against the REAL resolver, so a client that calls them gates EXACTLY as the chain does. The central
// property (deep-review 2026-07-03 §5): previewFill's delivered `got` equals the resolver's own delivered
// amount at and around the C3 zero-delivery boundary — the case prior suites never constructed.
import assert from "node:assert/strict";
import {
  resolve, offer, deploy, mint, previewFill, fillIsSafe, finalizeWinnerCheck,
  requiredFillOutputs, buildFeeHeight, FEE_GATE_MARGIN_BLOCKS,
  tradeFee, makerRebate, nameCommit, nameCommitRecord, nameClaim, nameFinalize, nameRegFee,
  TREASURY_ADDR, FEE_BPS_V16, SCORE_CLAIM, SCORE_FILL, V27_HEIGHT, V25_HEIGHT, V24_HEIGHT, V18_HEIGHT,
  REG_COMMIT_MAX_BLOCKS, epochOf,
  type ChainEvent, type OfferState, type NameState,
} from "../src/index.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`); };
let nextId = 1;
const nid = () => "0x" + (nextId++).toString(16).padStart(64, "0");
const A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20), C = "0x" + "cc".repeat(20);
const T = TREASURY_ADDR;
const prop = (who: string, rec: { uri: string; payloadHash: string }, h: number, paidTo: Record<string, string> = {}, pos = 1, exp = 9e15): ChainEvent =>
  ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos, expiresEpoch: exp, paidTo });
const att = (who: string, proposalId: string, h: number, paidTo: Record<string, string> = {}, score = 100, pos = 1, confidence = 0): ChainEvent =>
  ({ kind: "attest", txid: nid(), proposalId, attester: who, score, confidence, height: h, pos, paidTo });

// ── C3 boundary: previewFill.got == the resolver's delivered `got`, for a partial CSD offer ──
// give 10 RARE, want 100 CSD → 10 CSD/token. To deliver 1 token a single fill must pay >= 10 CSD.
console.log("previewFill == resolver delivered `got` at the C3 zero-delivery boundary:");
{
  const h0 = V27_HEIGHT + 800;
  const G = 10n, W = 100_00000000n, priceUnit = W / G; // 10 CSD per token
  // helper: resolve a single fill of `pay` on a fresh partial offer and read what it delivered
  const deliveredByResolver = (pay: bigint): bigint => {
    const dep = prop(A, deploy({ ticker: "RARE", decimals: 0, supply: G.toString(), mint: "issuer" }), h0, { [T]: "100000000" });
    const mintEv = prop(A, mint({ ticker: "RARE", amount: G.toString() }), h0 + 1);
    const offRec = offer({ give: { ticker: "RARE", amount: G.toString() }, want: { value: W.toString() }, min: priceUnit.toString(), taker: B });
    const offEv = prop(A, offRec, h0 + 2, {});
    const fee = tradeFee(pay < W ? pay : W, FEE_BPS_V16);
    const fillEv = att(B, offEv.id, h0 + 4, { [A]: pay.toString(), [T]: fee.toString() });
    const st = resolve([dep, mintEv, offEv, fillEv], h0 + 40);
    const o = st.offers[offEv.id];
    const f = o?.fills?.[0];
    return f?.got ? BigInt(f.got) : 0n;   // no fill entry ⇒ 0 delivered (rejected)
  };
  // the OfferState a client would preview against (fresh, unfilled)
  const freshOffer = (): OfferState => {
    const offRec = offer({ give: { ticker: "RARE", amount: G.toString() }, want: { value: W.toString() }, min: priceUnit.toString(), taker: B });
    const offEv = prop(A, offRec, h0 + 2, {});
    const st = resolve([
      prop(A, deploy({ ticker: "RARE", decimals: 0, supply: G.toString(), mint: "issuer" }), h0, { [T]: "100000000" }),
      prop(A, mint({ ticker: "RARE", amount: G.toString() }), h0 + 1),
      offEv,
    ], h0 + 3);
    return st.offers[offEv.id];
  };
  const o = freshOffer();

  // exactly one token-unit price: delivers exactly 1
  const atMin = previewFill(o, priceUnit);
  ok("at min (10 CSD): previewFill got == 1 and deliverable", atMin.got === 1n && atMin.deliverable);
  ok("at min: matches resolver delivered got", atMin.got === deliveredByResolver(priceUnit));
  // one below the min: the resolver rejects "payment below offer min"; previewFill refuses
  const below = previewFill(o, priceUnit - 1n);
  ok("below min (10 CSD − 1): previewFill refuses (below-min) and resolver delivers 0", !below.deliverable && deliveredByResolver(priceUnit - 1n) === 0n);
  // a value strictly between min and 2×min still floors to exactly 1 token (pro-rata floor)
  const mid = priceUnit + priceUnit / 2n; // 15 CSD
  const midP = previewFill(o, mid);
  ok("15 CSD floors to 1 token (pro-rata) and matches resolver", midP.got === 1n && midP.got === deliveredByResolver(mid));
  // full payment delivers all 10, matches resolver
  const fullP = previewFill(o, W);
  ok("full 100 CSD delivers all 10 tokens and matches resolver", fullP.got === G && fullP.got === deliveredByResolver(W));

  // the pure C3 trap shape (give 1, want huge): ANY partial < want delivers 0 → previewFill refuses
  const trapOff: OfferState = { id: nid(), seller: A, give: { ticker: "RARE", amount: "1" } as OfferState["give"],
    want: { value: "100000000000", payto: A } as OfferState["want"], status: "open", expiresEpoch: 9e15, height: h0, feeBps: FEE_BPS_V16, min: "100000000" };
  const trap = previewFill(trapOff, 50000000000n); // pay 500 of 1000 CSD → floor(1*500/1000)=0
  ok("C3 trap: 500-of-1000 CSD on a 1-token offer → previewFill refuses (zero-delivery)", !trap.deliverable && trap.reason === "zero-delivery");
  // boundary invariant giveTotal*min >= want: min = want exactly delivers 1
  const trapEdge: OfferState = { ...trapOff, min: "100000000000" };  // min == want (give=1 ⇒ boundary)
  ok("C3 boundary: min==want delivers exactly 1 (giveTotal*min == want)", previewFill(trapEdge, 100000000000n).got === 1n);
  // feeBps=0 (a pre-v1.1-era offer): the resolver's `o.feeBps ? tradeFee : 0n` charges NOTHING — the
  // preview must quote 0 too, never a fallback constant (an over-quote makes the taker overpay treasury)
  const freeEraPartial: OfferState = { ...trapEdge, feeBps: 0 };
  const freeP = previewFill(freeEraPartial, 100000000000n);
  ok("feeBps=0 partial: previewFill quotes fee 0n (resolver falsy-means-free, exact mirror)", freeP.deliverable && freeP.fee === 0n);
  const freeEraWhole: OfferState = { id: nid(), seller: A, give: { ticker: "RARE", amount: "3" } as OfferState["give"],
    want: { value: "100000000", payto: A } as OfferState["want"], status: "open", expiresEpoch: 9e15, height: h0, feeBps: 0, taker: B };
  const freeW = previewFill(freeEraWhole, 100000000n);
  ok("feeBps=0 whole fill: previewFill quotes fee 0n", freeW.deliverable && freeW.fee === 0n);
}

// ── fillIsSafe: C2/C4 open-CSD live-claim gate + taker match ──
console.log("\nfillIsSafe — open-CSD claim gate + taker match:");
{
  const tip = V27_HEIGHT + 1200;
  const val = 100000000n;
  // an OPEN (untaken) CSD token offer, unclaimed
  const openUnclaimed: OfferState = { id: nid(), seller: A, give: { ticker: "TKN", amount: "5" } as OfferState["give"],
    want: { value: val.toString(), payto: A } as OfferState["want"], status: "open", expiresEpoch: 9e15, height: V27_HEIGHT, feeBps: FEE_BPS_V16 };
  ok("open CSD offer, no claim by me → NOT safe (would lose the payment)", fillIsSafe(openUnclaimed, B, val, tip).safe === false);
  // same offer, live claim held by me
  const claimed: OfferState = { ...openUnclaimed, claimedBy: B, claimUntilHeight: tip + 30 };
  ok("open CSD offer with my live claim → safe", fillIsSafe(claimed, B, val, tip).safe === true);
  // claim held by someone else
  ok("open CSD offer claimed by another → NOT safe for me", fillIsSafe(claimed, C, val, tip).safe === false);
  // expired claim (past window+grace)
  const stale: OfferState = { ...openUnclaimed, claimedBy: B, claimUntilHeight: tip - 100 };
  ok("expired claim → NOT safe (claim no longer live)", fillIsSafe(stale, B, val, tip).safe === false);
  // taker-bound offer: no claim needed, but only the taker may fill
  const takerBound: OfferState = { ...openUnclaimed, taker: B };
  ok("taker-bound offer → safe for the taker (no claim needed)", fillIsSafe(takerBound, B, val, tip).safe === true);
  ok("taker-bound offer → NOT safe for a non-taker", fillIsSafe(takerBound, C, val, tip).safe === false);
  // a filled offer is never safe
  ok("already-filled offer → NOT safe", fillIsSafe({ ...takerBound, status: "filled" }, B, val, tip).safe === false);
}

// ── finalizeWinnerCheck: C1 ──
console.log("\nfinalizeWinnerCheck — the C1 registration-finalize gate:");
{
  const commitHeight = V25_HEIGHT + 500;
  const mine: NameState = { name: "gm", owner: A, claimId: nid(), height: commitHeight, effectiveHeight: commitHeight, locked: false, pending: true };
  ok("still my live pending reservation at my commit height → safe", finalizeWinnerCheck(mine, A, commitHeight).safe === true);
  ok("null (displaced/swept/404) → NOT safe (a finalize would burn the fee)", finalizeWinnerCheck(null, A, commitHeight).safe === false);
  ok("owned by someone else → NOT safe (outbid)", finalizeWinnerCheck({ ...mine, owner: B }, A, commitHeight).safe === false);
  ok("effective height changed (displaced) → NOT safe", finalizeWinnerCheck({ ...mine, effectiveHeight: commitHeight + 1 }, A, commitHeight).safe === false);
  ok("already finalized to me (pending cleared) → NOT safe (no second fee needed)", finalizeWinnerCheck({ ...mine, pending: undefined }, A, commitHeight).safe === false);
}

// ── end-to-end: fillIsSafe agrees with the resolver on the C2 non-claimant burn sequence ──
console.log("\nend-to-end: fillIsSafe refuses exactly the fill the resolver would burn (C2):");
{
  const H = V27_HEIGHT + 200, salt = "d".repeat(32), cH = H, rH = H + 2, fH = H + REG_COMMIT_MAX_BLOCKS + 2;
  const listH = fH + 300, exp = epochOf(listH) + 50, val = 100000000n, fee = tradeFee(val, FEE_BPS_V16), reb = makerRebate(val);
  const offEv = { ...prop(A, offer({ give: { name: "alicexyz" }, want: { value: val.toString() } }), listH, {}), expiresEpoch: exp };
  const ev: ChainEvent[] = [
    prop(A, nameCommitRecord({ commit: nameCommit("alicexyz", salt, A) }), cH),
    prop(A, nameClaim({ name: "alicexyz", salt }), rH),
    prop(A, nameFinalize({ name: "alicexyz", salt }), fH, { [T]: nameRegFee("alicexyz", fH).toString() }),
    offEv,
    att(B, offEv.id, listH + 5, {}, SCORE_CLAIM, 0),   // B claims → wins
  ];
  const st = resolve(ev, listH + 6);
  const o = st.offers[offEv.id];
  // C (no claim) is about to fill → the preflight must refuse BEFORE C signs (matching the on-chain reject)
  ok("C is refused by fillIsSafe (no live claim) — the burn the resolver would take", fillIsSafe(o, C, val + reb, listH + 6).safe === false);
  ok("B (the live claimant) is allowed by fillIsSafe", fillIsSafe(o, B, val + reb, listH + 6).safe === true);
}

// ── requiredFillOutputs: the output list it sizes is ACCEPTED by the real resolver, and any
// single-unit per-address underpayment is REFUSED (the pay-without-delivery burn class this
// function now single-sources for the wallet, the cairnx service, and the cairn UI) ──
console.log("\nrequiredFillOutputs — resolver-accepted at par, resolver-refused one unit under:");
{
  const outsToPaidTo = (outs: { to: string; value: bigint }[], dropOne?: string): Record<string, string> =>
    Object.fromEntries(outs.map((o) => [o.to, (dropOne === o.to ? o.value - 1n : o.value).toString()]));

  // WHOLE fill on an OPEN v1.7 name ask (claim-to-fill lane) — payto defaults to the seller, so the
  // want and the maker rebate land on ONE address and must be ACCUMULATED (the resolver sums them).
  const H = V27_HEIGHT + 2000, salt = "e".repeat(32);
  const val = 100000000n, reb = makerRebate(val);
  const mkEvents = (paidTo: Record<string, string>): { ev: ChainEvent[]; offId: string } => {
    const offEv = { ...prop(A, offer({ give: { name: "bobcatxyz" }, want: { value: val.toString() } }), H + 300, {}), expiresEpoch: epochOf(H + 300) + 50 };
    return {
      offId: offEv.id,
      ev: [
        prop(A, nameCommitRecord({ commit: nameCommit("bobcatxyz", salt, A) }), H),
        prop(A, nameClaim({ name: "bobcatxyz", salt }), H + 2),
        prop(A, nameFinalize({ name: "bobcatxyz", salt }), H + REG_COMMIT_MAX_BLOCKS + 2, { [T]: nameRegFee("bobcatxyz", H + REG_COMMIT_MAX_BLOCKS + 2).toString() }),
        offEv,
        att(B, offEv.id, H + 305, {}, SCORE_CLAIM, 0),
        att(B, offEv.id, H + 306, paidTo, SCORE_FILL, 2),
      ],
    };
  };
  const { ev: probeEv, offId: probeId } = mkEvents({});
  const openOffer = resolve(probeEv.slice(0, 5), H + 305).offers[probeId];
  const outs = requiredFillOutputs(openOffer, val)!;
  ok("open-ask whole fill: 2 outputs (payto==seller ACCUMULATED with rebate, + treasury)", outs.length === 2 && outs[0].to === A && outs[0].value === val + reb && outs[1].to === T);
  const filledAt = (paidTo: Record<string, string>): boolean => {
    const { ev, offId } = mkEvents(paidTo);
    return resolve(ev, H + 307).offers[offId]?.status === "filled";
  };
  ok("resolver ACCEPTS exactly these outputs (name delivered)", filledAt(outsToPaidTo(outs)) === true);
  ok("one unit under on the seller leg → resolver REFUSES the fill", filledAt(outsToPaidTo(outs, A)) === false);
  ok("one unit under on the treasury leg → resolver REFUSES the fill", filledAt(outsToPaidTo(outs, T)) === false);

  // PARTIAL fill (taker-bound token offer): pay + fee(clamped), NO rebate leg
  const G2 = 10n, W2 = 100_00000000n, unit = W2 / G2;
  const partialOffer = (): { o: OfferState; base: ChainEvent[]; offId: string } => {
    const dep = prop(A, deploy({ ticker: "PART", decimals: 0, supply: G2.toString(), mint: "issuer" }), H, { [T]: "100000000" });
    const mintEv = prop(A, mint({ ticker: "PART", amount: G2.toString() }), H + 1);
    const offEv = prop(A, offer({ give: { ticker: "PART", amount: G2.toString() }, want: { value: W2.toString() }, min: unit.toString(), taker: B }), H + 2, {});
    return { o: resolve([dep, mintEv, offEv], H + 3).offers[offEv.id], base: [dep, mintEv, offEv], offId: offEv.id };
  };
  const { o: po, base, offId } = partialOffer();
  const pouts = requiredFillOutputs(po, unit)!;
  ok("partial fill: 2 outputs (clamped pay + fee), NO rebate leg", pouts.length === 2 && pouts[0].value === unit && pouts[1].to === T && pouts[1].value === tradeFee(unit, FEE_BPS_V16));
  const partialFills = (paidTo: Record<string, string>): boolean => {
    const st = resolve([...base, att(B, offId, H + 4, paidTo, SCORE_FILL, 2)], H + 5);
    return (st.offers[offId]?.fills?.length ?? 0) > 0;
  };
  ok("resolver ACCEPTS the partial at par", partialFills(outsToPaidTo(pouts)) === true);
  ok("one unit under the min on the pay leg → resolver REFUSES", partialFills(outsToPaidTo(pouts, A)) === false);
  ok("one unit under on the fee leg → resolver REFUSES", partialFills(outsToPaidTo(pouts, T)) === false);

  // shape contract: token-priced ⇒ [] (no CSD outputs); undeliverable ⇒ null; feeBps=0 ⇒ no treasury leg
  const tokenPriced: OfferState = { id: nid(), seller: A, give: { ticker: "PART", amount: "1" } as OfferState["give"],
    want: { ticker: "OTHER", amount: "5", payto: A } as unknown as OfferState["want"], status: "open", expiresEpoch: 9e15, height: H, feeBps: FEE_BPS_V16 };
  ok("token-priced offer → [] (a token fill carries no CSD outputs)", requiredFillOutputs(tokenPriced, 1n)?.length === 0);
  ok("undeliverable (below min) → null", requiredFillOutputs(po, unit - 1n) === null);
  const freeEra: OfferState = { ...po, feeBps: 0 };
  const fouts = requiredFillOutputs(freeEra, unit)!;
  ok("feeBps=0 era → single pay output, no treasury leg", fouts.length === 1 && fouts[0].to === A);
}

// ── buildFeeHeight: the approach-the-gate build heuristic, pinned at every gate ± margin ──
console.log("\nbuildFeeHeight — margin behavior at every name-fee gate:");
{
  ok("FEE_GATE_MARGIN_BLOCKS is 5 (the value both UI copies carried)", FEE_GATE_MARGIN_BLOCKS === 5);
  for (const g of [V18_HEIGHT, V24_HEIGHT]) {
    ok(`gate ${g}: just outside the margin (g-6) builds at tip`, buildFeeHeight(g - 6) === g - 6);
    ok(`gate ${g}: margin edge (g-5) builds at the GATE (overpay-safe)`, buildFeeHeight(g - 5) === g);
    ok(`gate ${g}: one below (g-1) builds at the GATE`, buildFeeHeight(g - 1) === g);
    ok(`gate ${g}: at the gate builds at tip (tier already live)`, buildFeeHeight(g) === g);
    ok(`gate ${g}: past the gate builds at tip`, buildFeeHeight(g + 1) === g + 1);
  }
}

console.log(`\npreflight: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
