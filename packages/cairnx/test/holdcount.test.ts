// countOtherHoldsAtGrant against the resolver: the buyer's live holds on other offers at each fclaim's grant.
// The scenario is the surface-B triage's p07: three granted holds, then a fourth fclaim the cap denies. The fourth
// is mined after the first three, so it must not count against them (it did in both client counters).
import assert from "node:assert/strict";
import {
  DEPLOY_FEE, MAX_ACTIVE_CLAIMS, TREASURY_ADDR, V29_HEIGHT, countOtherHoldsAtGrant, deploy, epochOf, fclaim, fclaimHoldEnd, mint, offer,
  resolve, verifyFillSpv, type ChainEvent, type FillSpvIo, type HoldCandidate, type ProvenEvent, type ProposeEvent,
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
  assert.deepEqual([0, 1, 2, 3].map((i) => countOtherHoldsAtGrant(candidates, targetOf(i), ME)), [0, 1, 2, 3]);
});

// verifyFillSpv over the lane of X (the production call shape: the count passed as myLiveHoldsAtGrant)
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
const io = (lane: ChainEvent[]): FillSpvIo => ({
  async tip() { return tip; },
  async offerEventIds() { return lane.map(idOf); },
  async provenEvent(x: string) { const e = lane.find((y) => idOf(y) === x.toLowerCase()); return e ? ({ ...e, depth: tip - e.height + 1 } as ProvenEvent) : null; },
});
const laneOf = (i: number) => [events[0]!, events[1]!, events.find((e) => idOf(e) === offers[i])!, fcs[i]!];

await t("the earliest granted hold stays fillable after a later fourth fclaim", async () => {
  const v = await verifyFillSpv(offers[0]!, fcs[0]!.id, ME, io(laneOf(0)), { myLiveHoldsAtGrant: countOtherHoldsAtGrant(candidates, targetOf(0), ME) });
  assert.equal(v.safe, true, v.reason);
});

await t("the cap-denied fourth fclaim is still refused", async () => {
  const v = await verifyFillSpv(offers[3]!, fcs[3]!.id, ME, io(laneOf(3)), { myLiveHoldsAtGrant: countOtherHoldsAtGrant(candidates, targetOf(3), ME) });
  assert.equal(v.safe, false);
  assert.match(v.reason, /max active claims/);
});

console.log(`holdcount: ${pass} passed`);
