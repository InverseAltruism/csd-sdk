// v2.8 fclaim (§31) B4 EXIT-CRITERION test for verifyfill.ts (the shared client-side fill-SPV surface, the
// fail-closed FUND boundary). A synthetic in-memory FillSpvIo (PoW/merkle-proof pre-satisfied, like the
// namespv test injection) drives the pure surface with no chain. The HARD gate: a FORGED-CANCEL-HOLDER
// (a hold routed to someone else / a cancelled offer) AND a DENIED-FCLAIM fill (a fclaim on a taken offer a
// lying resolver calls "granted") BOTH get safe:false, and EACH guard is MUTATION-VERIFIED ONCE (the guard
// is physically removed from the source, the same forgery is re-run, and it then PASSES, proving the guard
// is the sole rejecter). Also: honest fills pass (no false refusal), a below-depth fill refuses, cancels are
// caught, the A1 merkle bind fails closed, and the GAP_NEEDED epoch-boundary arithmetic is pinned.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  deploy, mint, offer, fclaim, requiredFillOutputs, resolve,
  verifyFillSpv, replayLiveHold, GAP_NEEDED, MAX_SCAN,
  bindOfferTerms, provenOfferTerms, bindProvenOffer, feeBpsAt,
  V28_HEIGHT, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, CLAIM_COOLDOWN_BLOCKS, FILL_TIP_MARGIN, MAX_ACTIVE_CLAIMS,
  V11_HEIGHT, V16_HEIGHT, FEE_BPS, FEE_BPS_V16,
  TREASURY_ADDR, DEPLOY_FEE, SCORE_FILL, SCORE_CANCEL, epochOf, fclaimHoldEnd,
} from "../src/index.js";
import type { ChainEvent, OfferState, ProvenEvent, ProvenPropose, FillSpvIo } from "../src/index.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; };
// wrapper that injects the (required) cap count; the honest scenarios have 0 other live holds.
const vfs = (oid: string, fc: string, me: string, io: FillSpvIo, opts: { myLiveHoldsAtGrant?: number; pay?: bigint | string | number } = {}) =>
  verifyFillSpv(oid, fc, me, io, { myLiveHoldsAtGrant: 0, ...opts });

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const OID = "0x" + "0f".repeat(32);
const id = (n: string) => "0x" + n.repeat(32);
const H0 = V28_HEIGHT; // 100_000

const PE = (i: string, built: { uri: string; payloadHash: string }, height: number, proposer: string, expiresEpoch: number, pos = 0, paidTo: Record<string, string> = {}): ChainEvent =>
  ({ kind: "propose", id: i, proposer, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch, height, pos, paidTo });
const AE = (txid: string, proposalId: string, attester: string, height: number, paidTo: Record<string, string>, score = SCORE_FILL, confidence = 0, pos = 0): ChainEvent =>
  ({ kind: "attest", txid, proposalId, attester, score, confidence, height, pos, paidTo });

// base backing: A deploys+mints AAA and posts an OPEN CSD-priced offer (10 AAA for 5 CSD to A).
const base: ChainEvent[] = [
  PE(id("01"), deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H0, A, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(id("02"), mint({ ticker: "AAA", amount: "1000" }), H0 + 1, A, 9e9),
  PE(OID, offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } }), H0 + 2, A, 9e9),
];

// The synthetic seam: PoW/merkle already satisfied. depth = tip - height + 1 (the verified burial). A lying
// hint list can only ADD ids; here we surface the full event set + tip so the pure surface does the rest.
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
function makeIo(events: ChainEvent[], tip: number): FillSpvIo {
  return {
    async tip() { return tip; },
    async offerEventIds() { return events.map(idOf); },
    async provenEvent(x: string) {
      const e = events.find((y) => idOf(y) === String(x).toLowerCase());
      return e ? ({ ...e, depth: tip - e.height + 1 } as ProvenEvent) : null;
    },
  };
}

// ── GAP_NEEDED symbolic + epoch-boundary arithmetic (FUND-SAFETY, not latency) ──
ok(GAP_NEEDED === EPOCH_LEN * (FCLAIM_MAX_EPOCH_AHEAD + 1) - 1 + CLAIM_COOLDOWN_BLOCKS, "GAP_NEEDED matches the symbolic form");
ok(GAP_NEEDED === 104, `GAP_NEEDED = 30*(2+1)-1+15 = 104 (got ${GAP_NEEDED})`);
ok(MAX_SCAN === GAP_NEEDED + EPOCH_LEN, "MAX_SCAN rounds GAP_NEEDED up by a full-epoch cushion");
// epoch-boundary: a grant at the FIRST block of an epoch with ee = epochOf(h)+2 holds the LONGEST.
const firstOfEpoch = epochOf(H0) * EPOCH_LEN;      // the exact first block of H0's epoch
const eeMax = epochOf(firstOfEpoch) + FCLAIM_MAX_EPOCH_AHEAD;
const holdEndMax = fclaimHoldEnd(eeMax);
ok(holdEndMax === firstOfEpoch + EPOCH_LEN * (FCLAIM_MAX_EPOCH_AHEAD + 1) - 1, "holdEnd(first-of-epoch, ee+2) = h + 89 (the 90-block inclusive span)");
ok(holdEndMax - firstOfEpoch === 89, "the max hold spans exactly 89 blocks past the grant (inclusive last minable height)");
// the deepest prior grant that still denies (via cooldown) a fclaim at h_fc sits at h_fc - GAP_NEEDED.

// ── 1. HONEST fill PASSES (no false refusal) ──
const E = epochOf(H0 + 3) + 2;
const fcTx = id("f1");
const grant = PE(fcTx, fclaim({ offer: OID }), H0 + 3, B, E);
const holdEnd = fclaimHoldEnd(E);
{
  const tip = holdEnd - 5;                          // within the hold, offer + fclaim well buried
  const v = await vfs(OID, fcTx, B, makeIo([...base, grant], tip));
  ok(v.safe === true, `honest fclaim fill is ACCEPTED (${v.reason})`);
}

// ── 2. BELOW-DEPTH fill REFUSES (not-yet-buried) ──
{
  const tip = H0 + 4;                              // fclaim mined at H0+3 -> depth 2 < requiredClaimDepth
  const v = await vfs(OID, fcTx, B, makeIo([...base, grant], tip));
  ok(v.safe === false && /buried/.test(v.reason), `below-depth fill is REFUSED (${v.reason})`);
}

// ── 3. EXIT CRITERION A - DENIED-FCLAIM (fclaim on a taken offer, lying resolver asserts granted) ──
// B holds fc1 (granted); B posts fc2 while fc1's hold is live -> the resolver DENIES fc2 ("already claimed").
// A lying resolver aliases fc2 as granted. Filling fc2 would attest an L0-valid but DELIVERY-LESS target.
const fc1 = id("fa"), fc2 = id("fb");
const g1 = PE(fc1, fclaim({ offer: OID }), H0 + 3, B, E);
const g2 = PE(fc2, fclaim({ offer: OID }), H0 + 5, B, E);   // DENIED: fc1 hold still live
const deniedEvents: ChainEvent[] = [...base, g1, g2];
const tipDenied = holdEnd - 5;                              // within fc1's hold; fc2 well buried
{
  // sanity: the resolver really denies fc2 (fc1 remains the routing target)
  const st = resolve(deniedEvents, tipDenied);
  ok(st.fclaims[fc1] !== undefined && st.fclaims[fc2] === undefined && st.offers[OID].claimTxid === fc1,
    "sanity: fc2 is DENIED (fc1 stays the live routing target)");
  const v = await vfs(OID, fc2, B, makeIo(deniedEvents, tipDenied));
  ok(v.safe === false, `EXIT-A: denied-fclaim fill is REFUSED (${v.reason})`);
}

// ── 4. EXIT CRITERION B - FORGED-CANCEL-HOLDER (me is not the holder) ──
// C holds a valid fclaim fcC; B forges holdership and tries to fill fcC. The resolver would reject the
// payment (who !== claimedBy), burning it.
const fcC = id("fc");
const gC = PE(fcC, fclaim({ offer: OID }), H0 + 3, C, E);
const holderEvents: ChainEvent[] = [...base, gC];
const tipHolder = holdEnd - 5;
{
  const st = resolve(holderEvents, tipHolder);
  ok(st.offers[OID].claimedBy === C && st.offers[OID].claimTxid === fcC, "sanity: C is the live holder of fcC");
  const v = await vfs(OID, fcC, B, makeIo(holderEvents, tipHolder));
  ok(v.safe === false, `EXIT-B: forged-cancel-holder (me is not the holder) is REFUSED (${v.reason})`);
}

// ── 5. cancels are CAUGHT: a hold that lapsed then the offer was cancelled ──
{
  const Ex = epochOf(H0 + 3);                       // minimal hold, lapses fast
  const fcx = id("fd");
  const gx = PE(fcx, fclaim({ offer: OID }), H0 + 3, B, Ex);
  const holdEndX = fclaimHoldEnd(Ex);
  const cancel = AE(id("2c"), OID, A, holdEndX + 2, {}, SCORE_CANCEL);   // after the hold lapsed -> not frozen
  const tipCancel = holdEndX + 5;
  const st = resolve([...base, gx, cancel], tipCancel);
  ok(st.offers[OID].status === "cancelled", "sanity: the offer is cancelled after the hold lapsed");
  const v = await vfs(OID, fcx, B, makeIo([...base, gx, cancel], tipCancel));
  ok(v.safe === false, `cancelled offer is CAUGHT by the grant replay (${v.reason})`);
}

// ── 6. A1 merkle bind fails CLOSED: a tampered offer body (payloadHash mismatch) ──
{
  const tip = holdEnd - 5;
  const io = makeIo([...base, grant], tip);
  const tampered: FillSpvIo = {
    tip: io.tip,
    offerEventIds: io.offerEventIds,
    async provenEvent(x: string) {
      const e = await io.provenEvent(x);
      if (e && e.kind === "propose" && e.id.toLowerCase() === OID.toLowerCase()) return { ...e, payloadHash: id("de") };
      return e;
    },
  };
  const v = await vfs(OID, fcTx, B, tampered);
  ok(v.safe === false && /bind/.test(v.reason), `A1 bind fails CLOSED on a tampered offer body (${v.reason})`);
}

// ── 7. seam cannot prove the offer -> fail CLOSED ──
{
  const blind: FillSpvIo = { async tip() { return holdEnd - 5; }, async offerEventIds() { return []; }, async provenEvent() { return null; } };
  const v = await vfs(OID, fcTx, B, blind);
  ok(v.safe === false && /merkle-proven/.test(v.reason), `unprovable offer fails CLOSED (${v.reason})`);
}

// ── 8. earlier FILL-BASIS burial is ENFORCED (the partial tail-flip bound) ──
{
  const POID = id("0e");
  const pOffer = PE(POID, offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A }, min: "100000000" }), H0 + 2, A, 9e9);
  const pBase: ChainEvent[] = [base[0], base[1], pOffer];
  const Ep = epochOf(H0 + 3) + 2;
  const pFc = id("f5");
  const pGrant = PE(pFc, fclaim({ offer: POID }), H0 + 3, B, Ep);
  const pOfferState = resolve([...pBase, pGrant], H0 + 5).offers[POID];
  const outs = Object.fromEntries(requiredFillOutputs(pOfferState, "200000000")!.map((o) => [o.to, String(o.value)]));
  const priorFill = AE(id("3f"), pFc, B, H0 + 6, outs, SCORE_FILL);     // an earlier partial fill (fill-basis)
  const holdEndP = fclaimHoldEnd(Ep);
  // shallow fill-basis: offer + fclaim buried, but the earlier partial fill (H0+6) is NOT
  {
    const tip = H0 + 7;                            // priorFill depth = 2 < need; offer/fclaim depth >= need
    const v = await vfs(POID, pFc, B, makeIo([...pBase, pGrant, priorFill], tip));
    ok(v.safe === false && /fill-basis/.test(v.reason), `shallow earlier fill-basis is REFUSED (${v.reason})`);
  }
  // once the fill-basis is buried too, the tail fill is accepted (no false refusal). tip = holdEnd - 5 sits
  // clear of the FILL_TIP_MARGIN deadline cushion (widened 2->4 in Plan 70 R2 L1), so this exercises the DEPTH
  // gate (the property under test), not the deadline; holdEnd - 3 would now trip the wider cushion.
  {
    const tip = holdEndP - 5;
    const v = await vfs(POID, pFc, B, makeIo([...pBase, pGrant, priorFill], tip));
    ok(v.safe === true, `buried earlier fill-basis -> tail fill ACCEPTED (${v.reason})`);
  }
}

// ── 9. replayLiveHold surfaces the grant/hold outcome directly (unit) ──
{
  const proven: ProvenEvent[] = [...base, grant].map((e) => ({ ...e, depth: 50 } as ProvenEvent));
  const r = replayLiveHold(proven, OID, fcTx, B, holdEnd - 5);
  ok(r.granted && r.routed && r.heldByMe, "replayLiveHold: honest grant is granted + routed + heldByMe");
  const rNotMine = replayLiveHold(proven, OID, fcTx, C, holdEnd - 5);
  ok(rNotMine.granted && rNotMine.routed && !rNotMine.heldByMe, "replayLiveHold: not-the-holder is granted+routed but NOT heldByMe");
}

// ── 10. MUTATION VERIFICATION: remove each exit guard from the SOURCE and confirm the forgery then PASSES ──
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src", "verifyfill.ts");
async function withGuardRemoved<T>(marker: string, run: (mod: typeof import("../src/verifyfill.js")) => Promise<T>): Promise<T> {
  const src = readFileSync(SRC, "utf8");
  const lines = src.split("\n");
  const kept = lines.filter((l) => !l.includes(marker));
  assert.equal(kept.length, lines.length - 1, `mutation marker ${marker} must match exactly one line`);
  const tmp = path.join(here, "..", "src", `__mutant_${marker}_${Date.now()}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try {
    const mod = await import(pathToFileURL(tmp).href);
    return await run(mod as typeof import("../src/verifyfill.js"));
  } finally { unlinkSync(tmp); }
}

// Guard R removed -> the DENIED-FCLAIM forgery must PASS (proves Guard R is the sole rejecter of it).
const mutR = await withGuardRemoved("MUTATE_GUARD_R", async (mod) =>
  mod.verifyFillSpv(OID, fc2, B, makeIo(deniedEvents, tipDenied), { myLiveHoldsAtGrant: 0 }));
ok(mutR.safe === true, `MUTATION[Guard R removed]: denied-fclaim forgery now PASSES (safe:${mutR.safe}) -> Guard R is the sole rejecter`);

// Guard H removed -> the FORGED-CANCEL-HOLDER forgery must PASS (proves Guard H is the sole rejecter of it).
const mutH = await withGuardRemoved("MUTATE_GUARD_H", async (mod) =>
  mod.verifyFillSpv(OID, fcC, B, makeIo(holderEvents, tipHolder), { myLiveHoldsAtGrant: 0 }));
ok(mutH.safe === true, `MUTATION[Guard H removed]: forged-cancel-holder forgery now PASSES (safe:${mutH.safe}) -> Guard H is the sole rejecter`);

// ── 11. Cross-offer MAX_ACTIVE_CLAIMS cap (adversarial Finding 1): the lane replay under-counts the cap, so
//    the caller MUST assert its other-offer live-hold count; >= MAX_ACTIVE_CLAIMS means the resolver DENIED it.
{
  const tip = holdEnd - 5, io = makeIo([...base, grant], tip);
  const vCap = await verifyFillSpv(OID, fcTx, B, io, { myLiveHoldsAtGrant: MAX_ACTIVE_CLAIMS });
  ok(vCap.safe === false && /cap/.test(vCap.reason), `cap: >= MAX_ACTIVE_CLAIMS other holds is REFUSED (${vCap.reason})`);
  const vUnder = await verifyFillSpv(OID, fcTx, B, io, { myLiveHoldsAtGrant: MAX_ACTIVE_CLAIMS - 1 });
  ok(vUnder.safe === true, `cap: under the cap is ACCEPTED (${vUnder.reason})`);
  const vBad = await verifyFillSpv(OID, fcTx, B, io, { myLiveHoldsAtGrant: -1 });
  ok(vBad.safe === false && /cap/.test(vBad.reason), `cap: an invalid/unasserted count fails CLOSED (${vBad.reason})`);
}

// Cap guard removed -> an AT-CAP fill must PASS (proves the cap guard is the sole rejecter, like Guards R/H).
const mutCap = await withGuardRemoved("MUTATE_GUARD_CAP", async (mod) =>
  mod.verifyFillSpv(OID, fcTx, B, makeIo([...base, grant], holdEnd - 5), { myLiveHoldsAtGrant: MAX_ACTIVE_CLAIMS }));
ok(mutCap.safe === true, `MUTATION[cap guard removed]: at-cap fill now PASSES (safe:${mutCap.safe}) -> the cap guard is the sole rejecter`);

// ── 12. NaN depth from an off-contract seam must fail CLOSED at the depth gate (the `!(x >= need)` inversion;
//    a plain `x < need` slips a NaN through since NaN < need is false) ──
{
  const tip = holdEnd - 5;
  const honest = makeIo([...base, grant], tip);
  const nanIo: FillSpvIo = {
    tip: honest.tip,
    offerEventIds: honest.offerEventIds,
    async provenEvent(x: string) {
      const e = await honest.provenEvent(x);
      if (e && (e.kind === "propose" ? e.id : e.txid).toLowerCase() === fcTx.toLowerCase())
        return { ...e, depth: NaN as unknown as number };
      return e;
    },
  };
  const v = await verifyFillSpv(OID, fcTx, B, nanIo, { myLiveHoldsAtGrant: 0 });
  ok(v.safe === false && /buried/.test(v.reason), `NaN depth fails CLOSED at the depth gate (${v.reason})`);
}

// ── 10. bindOfferTerms / provenOfferTerms / bindProvenOffer / feeBpsAt (Plan 70 R2: the single-sourced
// fill-boundary TERM bind that replaces the three R1 hand-copies). Pin the exact mismatch verdict the seams
// rely on so a future edit here reds the corpus AND these units. ──
{
  ok(feeBpsAt(V11_HEIGHT - 1) === 0, "feeBpsAt below V11 = 0");
  ok(feeBpsAt(V11_HEIGHT) === FEE_BPS && feeBpsAt(V16_HEIGHT - 1) === FEE_BPS, "feeBpsAt in [V11,V16) = FEE_BPS (100)");
  ok(feeBpsAt(V16_HEIGHT) === FEE_BPS_V16, "feeBpsAt at/above V16 = FEE_BPS_V16 (150)");

  const H = H0 + 2;                       // a >= V16 creation height (feeBps 150)
  const t = provenOfferTerms({ v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } } as never, H);
  ok(t.height === H && t.feeBps === 150 && t.value === "500000000" && t.min === undefined && t.taker === undefined && t.bid === undefined,
    "provenOfferTerms derives {height, feeBps=150, value, no min/taker/bid} from a whole-fill CSD offer");

  // the honest served offer matches every proven field -> NO mismatch (no false refuse)
  const served = { height: H, feeBps: 150, want: { value: "500000000" }, taker: undefined, bid: undefined, min: undefined };
  ok(bindOfferTerms(served, t) === false, "bindOfferTerms: honest served offer == proven terms -> no mismatch");
  // each single-field lie flips to mismatch (true)
  ok(bindOfferTerms({ ...served, height: H + 1 }, t) === true, "bindOfferTerms: wrong height -> mismatch");
  ok(bindOfferTerms({ ...served, feeBps: 0 }, t) === true, "bindOfferTerms: deflated feeBps -> mismatch");
  ok(bindOfferTerms({ ...served, want: { value: "1" } }, t) === true, "bindOfferTerms: wrong value -> mismatch");
  ok(bindOfferTerms({ ...served, taker: C }, t) === true, "bindOfferTerms: spurious taker -> mismatch");
  ok(bindOfferTerms({ ...served, bid: id("bb") }, t) === true, "bindOfferTerms: spurious bid -> mismatch");
  ok(bindOfferTerms({ ...served, min: "1" }, t) === true, "bindOfferTerms: spurious min added to a whole-fill offer -> mismatch (rebate-drop burn averted)");
  // a genuine partial offer: presence must match AND value must match
  const tPartial = provenOfferTerms({ v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A }, min: "100000000" } as never, H);
  ok(bindOfferTerms({ ...served, min: "100000000" }, tPartial) === false, "bindOfferTerms: matching min -> no mismatch");
  ok(bindOfferTerms({ ...served, min: "1" }, tPartial) === true, "bindOfferTerms: deflated min -> mismatch");
  ok(bindOfferTerms({ ...served, min: undefined }, tPartial) === true, "bindOfferTerms: absent served min vs proven partial -> mismatch");
  // taker/bid are case-insensitive and undefined/null == "" (no false refuse on case or nullish)
  ok(bindOfferTerms({ ...served, taker: null }, t) === false, "bindOfferTerms: served taker null == proven undefined");

  // bindProvenOffer derives {payto, seller, terms} from a merkle-proven offer event; payto defaults to the
  // author when the record has no want.payto, and returns null for a non-offer record.
  const offerEv = base[2] as ProvenPropose;             // the OPEN offer (proposer = A, want.payto = A)
  const bo = bindProvenOffer(offerEv);
  ok(bo !== null && bo.seller === A && bo.payto === A && bo.terms.feeBps === 150 && bo.terms.value === "500000000",
    "bindProvenOffer: seller=author, payto=want.payto, terms derived");
  const paytoLessEv = { kind: "propose", id: OID, proposer: A, ...offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000" } }), expiresEpoch: 9e9, height: H, pos: 0, paidTo: {} } as ProvenPropose;
  const boPL = bindProvenOffer(paytoLessEv);
  ok(boPL !== null && boPL.payto === A, "bindProvenOffer: payto-less record defaults payto to the proven author");
  const notOffer = { kind: "propose", id: OID, proposer: A, ...fclaim({ offer: OID }), expiresEpoch: 9e9, height: H, pos: 0, paidTo: {} } as ProvenPropose;
  ok(bindProvenOffer(notOffer) === null, "bindProvenOffer: a non-offer record fails closed (null)");
}

console.log(`cairnx-core verifyfill B4 (fill-SPV fund boundary): ${pass} passed`);
