// countOtherHoldsAtGrant against the resolver: the buyer's live holds on other offers at each fclaim's grant.
// The scenario is the surface-B triage's p07: three granted holds, then a fourth fclaim the cap denies. The fourth
// is mined after the first three, so it must not count against them (it did in both client counters).
import assert from "node:assert/strict";
import {
  DEPLOY_FEE, LEGACY_HOLD_SUNSET_HEIGHT, MAX_ACTIVE_CLAIMS, SCORE_CLAIM, TREASURY_ADDR, V28_HEIGHT, V29_HEIGHT, countOtherHoldsAtGrant,
  deploy, epochOf, fclaim, fclaimHoldEnd, mint, offer, resolve, verifyFillSpv,
  type ChainEvent, type FillSpvIo, type HoldCandidate, type HoldCount, type ProvenEvent, type ProposeEvent,
} from "../src/index.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => { await fn(); pass++; console.log("  ok", name); };

const SELLER = "0x" + "5e".repeat(20), ME = "0x" + "1a".repeat(20);
const H0 = V29_HEIGHT + 4000, V = "100000000";
const id = (n: string) => "0x" + n.repeat(32);
const PE = (i: string, built: { uri: string; payloadHash: string }, height: number, proposer: string, expiresEpoch: number, pos = 0, paidTo: Record<string, string> = {}): ProposeEvent =>
  ({ kind: "propose", id: i, proposer, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch, height, pos, paidTo });

const events: ChainEvent[] = [
  PE(id("01"), deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H0 - 5, SELLER, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(id("02"), mint({ ticker: "AAA", amount: "1000" }), H0 - 4, SELLER, 9e9),
];
const offers = ["a1", "a2", "a3", "a4"].map((n, i) => {
  const o = PE(id(n), offer({ give: { ticker: "AAA", amount: "10" }, want: { value: V, payto: SELLER } }), H0, SELLER, epochOf(H0) + 200, i);
  events.push(o);
  return o.id;
});
// X and Y share a block (Y later in it), Z in the next block, W (the fourth) two blocks later
const at = [[H0 + 2, 0], [H0 + 2, 1], [H0 + 3, 0], [H0 + 5, 0]] as const;
const fcs = at.map(([h, pos], i) => {
  const e = PE(id(["c1", "c2", "c3", "c4"][i]!), fclaim({ offer: offers[i]! }), h, ME, epochOf(h) + 2, pos);
  events.push(e);
  return e;
});
const candidates: HoldCandidate[] = fcs.map((e) => ({ id: e.id, height: e.height, pos: e.pos, proposer: e.proposer, uri: e.uri, payloadHash: e.payloadHash, expiresEpoch: e.expiresEpoch }));
const targetOf = (i: number) => ({ id: fcs[i]!.id, height: fcs[i]!.height, pos: fcs[i]!.pos, offer: offers[i]! });
const tip = fclaimHoldEnd(fcs[0]!.expiresEpoch) - 5;   // inside the earliest hold, past its claim depth
const st = resolve(events, tip);

await t("premise: the resolver grants X, Y, Z and denies W on the cap", () => {
  assert.deepEqual(fcs.map((e) => st.fclaims[e.id] !== undefined), [true, true, true, false]);
  assert.match(st.events.find((e) => e.id === fcs[3]!.id)?.note ?? "", new RegExp(`max ${MAX_ACTIVE_CLAIMS} live claims`));
});

await t("the count at each grant is the number of earlier holds, in block then position order", () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => countOtherHoldsAtGrant(candidates, targetOf(i), ME)), [0, 1, 2, 3].map((count) => ({ ok: true, count })));
});

// verifyFillSpv over the lane of X (the production call shape: the count passed as myLiveHoldsAtGrant, a refusal
// failing closed)
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
const io = (lane: ChainEvent[]): FillSpvIo => ({
  async tip() { return tip; },
  async offerEventIds() { return lane.map(idOf); },
  async provenEvent(x: string) { const e = lane.find((y) => idOf(y) === x.toLowerCase()); return e ? ({ ...e, depth: tip - e.height + 1 } as ProvenEvent) : null; },
});
const laneOf = (i: number) => [events[0]!, events[1]!, events.find((e) => idOf(e) === offers[i])!, fcs[i]!];
const verdict = async (hc: HoldCount, oid: string, fc: string, io_: FillSpvIo) =>
  hc.ok ? verifyFillSpv(oid, fc, ME, io_, { myLiveHoldsAtGrant: hc.count }) : { safe: false, reason: hc.reason };

await t("the earliest granted hold stays fillable after a later fourth fclaim", async () => {
  const v = await verdict(countOtherHoldsAtGrant(candidates, targetOf(0), ME), offers[0]!, fcs[0]!.id, io(laneOf(0)));
  assert.equal(v.safe, true, v.reason);
});

await t("the cap-denied fourth fclaim is still refused", async () => {
  const v = await verdict(countOtherHoldsAtGrant(candidates, targetOf(3), ME), offers[3]!, fcs[3]!.id, io(laneOf(3)));
  assert.equal(v.safe, false);
  assert.match(v.reason, /max active claims/);
});

// The V28 straddle (second review): three legacy SCORE_CLAIM holds granted at V28 - 1 are still live at V28, so the
// resolver denies an fclaim there on the cap. The counter reads fclaims only, so below LEGACY_HOLD_SUNSET_HEIGHT it
// must refuse instead of returning 0.
{
  const L0 = V28_HEIGHT - 10;
  const lev: ChainEvent[] = [
    PE(id("51"), deploy({ ticker: "LLL", decimals: 0, supply: "1000", mint: "issuer" }), L0 - 2, SELLER, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
    PE(id("52"), mint({ ticker: "LLL", amount: "1000" }), L0 - 1, SELLER, 9e9),
  ];
  const loffers = ["61", "62", "63", "64"].map((n, i) => {
    const o = PE(id(n), offer({ give: { ticker: "LLL", amount: "10" }, want: { value: V, payto: SELLER } }), L0, SELLER, epochOf(L0) + 200, i);
    lev.push(o);
    return o;
  });
  for (let i = 0; i < 3; i++)
    lev.push({ kind: "attest", txid: id(["71", "72", "73"][i]!), proposalId: loffers[i]!.id, attester: ME, score: SCORE_CLAIM, confidence: 0, height: V28_HEIGHT - 1, pos: i, paidTo: {} });
  const fc = PE(id("74"), fclaim({ offer: loffers[3]!.id }), V28_HEIGHT, ME, epochOf(V28_HEIGHT) + 2);
  lev.push(fc);
  const ltip = V28_HEIGHT + 10;
  const lst = resolve(lev, ltip);
  const target = { id: fc.id, height: fc.height, pos: fc.pos, offer: loffers[3]!.id };
  const fcCand: HoldCandidate[] = [{ id: fc.id, height: fc.height, pos: fc.pos, proposer: ME, uri: fc.uri, payloadHash: fc.payloadHash, expiresEpoch: fc.expiresEpoch }];
  const lane = [lev[0]!, lev[1]!, loffers[3]!, fc];
  const lio: FillSpvIo = {
    async tip() { return ltip; },
    async offerEventIds() { return lane.map(idOf); },
    async provenEvent(x: string) { const e = lane.find((y) => idOf(y) === x.toLowerCase()); return e ? ({ ...e, depth: ltip - e.height + 1 } as ProvenEvent) : null; },
  };
  await t("V28 straddle: the full replay denies the fclaim on the cap, and the fill verdict is unsafe", async () => {
    assert.equal(lst.fclaims[fc.id], undefined);
    assert.match(lst.events.find((e) => e.id === fc.id)?.note ?? "", new RegExp(`max ${MAX_ACTIVE_CLAIMS} live claims`));
    const hc = countOtherHoldsAtGrant(fcCand, target, ME);
    assert.equal(hc.ok, false);
    assert.equal((await verdict(hc, target.offer, fc.id, lio)).safe, false);
  });
  await t("the refusal domain ends at LEGACY_HOLD_SUNSET_HEIGHT, the first height past the last legacy hold", () => {
    assert.equal(countOtherHoldsAtGrant([], { ...target, height: LEGACY_HOLD_SUNSET_HEIGHT - 1 }, ME).ok, false);
    assert.deepEqual(countOtherHoldsAtGrant([], { ...target, height: LEGACY_HOLD_SUNSET_HEIGHT }, ME), { ok: true, count: 0 });
  });
}

console.log(`holdcount: ${pass} passed`);
