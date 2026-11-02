// Aged partial fills and second-order grants (design b', src/fillhistory.ts): verifyFillSpv over part of the chain
// decides only what the heights it read completely decide. A seam modelled on the site's reservation scan (window
// [fclaimHeight - MAX_SCAN, tip], lane events only, the offer and its backing proven alone) drives the real
// verifyFillSpv; the oracle is resolve() over every event, other offers included.
import assert from "node:assert/strict";
import {
  DEPLOY_FEE, FCLAIM_MAX_HOLD_SPAN, FILL_HISTORY_CAP, FILL_HISTORY_SPAN, MAX_ACTIVE_CLAIMS, MAX_SCAN, SCORE_CANCEL, SCORE_FILL,
  TREASURY_ADDR, V29_HEIGHT,
  deploy, epochOf, fclaim, fclaimHoldEnd, mint, offer, parseRecord, planFillHistory, proveListedFills, requiredFillOutputs,
  resolve, tradeFee, verifyFillSpv,
  type ChainEvent, type FillHistoryIo, type FillSpvIo, type FillVerdict, type OfferState, type ProvenEvent,
} from "../src/index.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => { await fn(); pass++; console.log("  ok", name); };

const S = "0x" + "5e".repeat(20), A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const T = "0x" + "77".repeat(20), D = "0x" + "d4".repeat(20), BUY = "0x" + "99".repeat(20);
const HB = 99_000;   // an epoch boundary above V29
assert.ok(HB > V29_HEIGHT && HB % 30 === 0);
let idn = 0x5100;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
type Built = { uri: string; payloadHash: string };
const PE = (b: Built, height: number, proposer: string, expiresEpoch: number, pos = 0, paidTo: Record<string, string> = {}, id = nid()): ChainEvent =>
  ({ kind: "propose", id, proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch, height, pos, paidTo });
const AE = (proposalId: string, attester: string, height: number, paidTo: Record<string, string>, pos = 0, score = SCORE_FILL): ChainEvent =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence: 0, height, pos, paidTo });
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();

const backing = (): ChainEvent[] => [
  PE(deploy({ ticker: "AAA", decimals: 0, supply: "1000000", mint: "issuer" }), HB - 3000, S, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(mint({ ticker: "AAA", amount: "1000000" }), HB - 2999, S, 9e9),
];
const WANT = 50_000_000n, MIN = 10_000_000n;
const partialOffer = (h: number, id = nid(), give = "1000", min = MIN) =>
  PE(offer({ give: { ticker: "AAA", amount: give }, want: { value: String(WANT), payto: S }, min: String(min) }), h, S, epochOf(h) + 500, 0, {}, id);
const wholeOffer = (h: number, id = nid()) =>
  PE(offer({ give: { ticker: "AAA", amount: "1000" }, want: { value: String(WANT), payto: S } }), h, S, epochOf(h) + 500, 0, {}, id);
// a partial fill's outputs for a payment X: X to payto and the fee on X (the resolver clamps X to the remainder)
const partialPay = (x: bigint): Record<string, string> => ({ [S]: String(x), [TREASURY_ADDR]: String(tradeFee(x, 150)) });
const outsOf = (o: OfferState, pay: bigint): Record<string, string> | null => {
  const r = requiredFillOutputs(o, pay);
  return r ? Object.fromEntries(r.map((x) => [x.to, String(x.value)])) : null;
};
// a whole fill's outputs (want, fee, rebate), from the offer as the resolver holds it at `h`
const wholeOuts = (oid: string, all: ChainEvent[], h: number): Record<string, string> => {
  const o = resolve(all, h).offers[oid];
  return (o && outsOf({ ...o, status: "open" }, WANT)) ?? {};
};

// ── the seam: the site's reservation scan over a full event list, with its reads counted ──
interface Counts { ranges: number; heights: number; authors: number }
function seam(all: ChainEvent[], offerId: string, fcId: string, tip: number, floor = 0): { io: FillSpvIo; bare: FillSpvIo; n: Counts } {
  const fc = all.find((e) => e.kind === "propose" && e.id === fcId)!;
  const window = { lo: fc.height - MAX_SCAN, hi: tip };
  const recOf = (e: ChainEvent) => (e.kind === "propose" ? parseRecord(e.uri, e.payloadHash) : null);
  const laneF = (e: ChainEvent) => { const r = recOf(e); return !!r && r.t === "fclaim" && r.offer.toLowerCase() === offerId; };
  const otherF = (e: ChainEvent) => { const r = recOf(e); return !!r && r.t === "fclaim" && r.offer.toLowerCase() !== offerId; };
  const lane = new Set<string>([offerId]);
  const read = new Set<number>();
  const proven = (e: ChainEvent): ProvenEvent => ({ ...e, depth: tip - e.height + 1 }) as ProvenEvent;
  const scan = (r: { lo: number; hi: number }) => {
    const inR = (e: ChainEvent) => e.height >= r.lo && e.height <= r.hi;
    const here = all.filter(inR);
    const found = here.filter(laneF).map((e) => idOf(e));
    for (const x of found) lane.add(x);
    const events = here.filter((e) => e.kind === "propose"
      ? idOf(e) === offerId || laneF(e) || recOf(e)?.t === "ocancel"
      : lane.has(e.proposalId.toLowerCase()));
    // attests read earlier (the window drops those whose fclaim lies below it) that target an fclaim found here
    const above = all.filter((e) => e.kind === "attest" && !inR(e) && read.has(e.height) && found.includes(e.proposalId.toLowerCase()));
    for (let h = r.lo; h <= r.hi; h++) read.add(h);
    const otherFclaims = here.filter(otherF).map((e) => {
      const p = e as Extract<ChainEvent, { kind: "propose" }>;
      return { id: p.id, height: p.height, pos: p.pos, uri: p.uri, payloadHash: p.payloadHash, expiresEpoch: p.expiresEpoch };
    });
    return { events: [...events, ...above].map(proven), otherFclaims };
  };
  const win = scan(window);
  const sparse = all.filter((e) => e.kind === "propose" && (e.height < window.lo || e.height > window.hi)
    && (idOf(e) === offerId || ["deploy", "mint"].includes(recOf(e)?.t ?? "")));
  const byId = new Map<string, ProvenEvent>([...win.events, ...sparse.map(proven)].map((e) => [idOf(e), e]));
  const n: Counts = { ranges: 0, heights: 0, authors: 0 };
  const history: FillHistoryIo = {
    floor, window, windowOtherFclaims: win.otherFclaims,
    async readRange(r) { n.ranges++; n.heights += r.hi - r.lo + 1; return scan(r); },
    async proposerOf(id) {
      n.authors++;
      const e = all.find((x) => idOf(x) === id.toLowerCase());
      return e && e.kind === "propose" ? e.proposer : null;
    },
  };
  const bare: FillSpvIo = {
    async tip() { return tip; },
    async offerEventIds() { return [...byId.keys()]; },
    async provenEvent(id) { return byId.get(id.toLowerCase()) ?? null; },
  };
  return { io: { ...bare, history }, bare, n };
}

const listed = (o: OfferState | undefined) => (o?.fills ?? []).map((f) => ({ txid: f.txid, height: f.height }));
const verify = (io: FillSpvIo, oid: string, fc: string, pay: bigint | undefined, sums: Record<string, string> | null, served: OfferState | undefined, holds = 0) =>
  verifyFillSpv(oid, fc, BUY, io, { myLiveHoldsAtGrant: holds, ...(pay !== undefined ? { pay } : {}), ...(sums ? { sums } : {}), servedFills: listed(served) });

// What the chain does with the buyer's fill: the fclaim's grant at the tip, and the fill's outcome one block later.
function chainOutcome(all: ChainEvent[], oid: string, fc: string, tip: number, sums: Record<string, string>) {
  const st = resolve(all, tip);
  const o = st.offers[oid];
  const granted = st.fclaims[fc] !== undefined && o?.claimTxid === fc && o?.claimedBy === BUY && o.status === "open";
  const fill = AE(fc, BUY, tip + 1, sums);
  const note = resolve([...all, fill], tip + 1).events.find((e) => e.id === idOf(fill));
  return { granted, delivered: !!note?.ok };
}

// ── R1: whenever the verdict is safe, the full resolve() grants that fclaim and the fill with the verified sums
//    delivers ──
// The second-order chain (spec section 1): X at +2850 (E 97) holds to +2940, so Y at +2880 is denied; Z at +2940 is
// granted and holds to +3030, so the buyer at +3000 is denied. The window from +2866 misses X: Y replays granted, Z
// denied and the buyer granted.
function secondOrder() {
  const K = 96_000;   // a multiple of 30, so epochs keep the example's offsets
  const oid = nid();
  const all = [...backing(), wholeOffer(K + 2000, oid)];
  all.push(PE(fclaim({ offer: oid }), K + 2850, A, 3200 + 97));
  all.push(PE(fclaim({ offer: oid }), K + 2880, B, 3200 + 98));
  all.push(PE(fclaim({ offer: oid }), K + 2940, C, 3200 + 100));
  const fcEv = PE(fclaim({ offer: oid }), K + 3000, BUY, epochOf(K + 3000) + 2);
  all.push(fcEv);
  return { all, oid, fc: idOf(fcEv), tip: K + 3010 };
}

// Seeded random histories of one offer over 400 blocks: 2 to 6 lane fclaims by A, B, C and T, each mined near the end
// of the hold before it (so holds chain and grants depend on each other), most followed by a fill of a random size; T
// holds three fclaims on other offers for part of the span; the buyer reserves last.
function rng(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function randomHistory(seed: number) {
  const r = rng(seed), int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const partial = r() < 0.7;
  const oid = nid();
  // a coarse give (3 units for the whole want) makes the delivered amount depend on the earlier fills
  const all = [...backing(), partial ? partialOffer(HB - 400, oid, r() < 0.5 ? "3" : "1000", r() < 0.5 ? MIN : 1_000_000n) : wholeOffer(HB - 400, oid)];
  const others = [nid(), nid(), nid()];
  for (const o of others) all.push(wholeOffer(HB - 400, o));
  const nLane = int(2, 6);
  let h = int(HB - 380, HB - 150);
  const tc = int(h, h + 150);
  others.forEach((o, i) => all.push(PE(fclaim({ offer: o }), tc + i, T, epochOf(tc + i) + 2)));
  for (let i = 0; i < nLane; i++) {
    const who = [A, B, C, T][int(0, 3)]!, E = epochOf(h) + int(0, 2);
    const f = PE(fclaim({ offer: oid }), h, who, E, int(0, 2));
    all.push(f);
    if (r() < 0.7) {
      const fh = Math.min(h + int(0, 40), fclaimHoldEnd(E));
      all.push(AE(idOf(f), who, fh, partial ? partialPay(BigInt(int(8, 50)) * 1_000_000n) : wholeOuts(oid, all, fh), int(0, 2)));
    }
    h = Math.min(fclaimHoldEnd(E) + int(-30, 10), HB - 1);
  }
  const fcH = Math.max(h + int(1, 60), HB - 60);
  const fcEv = PE(fclaim({ offer: oid }), fcH, BUY, epochOf(fcH) + 2, 3);
  all.push(fcEv);
  const tip = Math.min(fcH + int(5, 20), fclaimHoldEnd(epochOf(fcH) + 2) - 5);
  return { all, oid, fc: idOf(fcEv), tip, tail: r() < 0.5 };
}

async function property(cases: { all: ChainEvent[]; oid: string; fc: string; tip: number; tail?: boolean }[]) {
  let safe = 0;
  const bad: string[] = [];
  for (const c of cases) {
    const truth = resolve(c.all, c.tip).offers[c.oid];
    if (!truth || truth.status !== "open") continue;   // the callers' liveness check on the served status
    const remaining = WANT - BigInt(truth.paid ?? "0");
    const pay = truth.min === undefined ? WANT : c.tail ? remaining : (remaining > MIN ? MIN : remaining);   // a tail, or the min
    const sums = outsOf(truth, pay);
    if (!sums) continue;
    const v = await verify(seam(c.all, c.oid, c.fc, c.tip).io, c.oid, c.fc, pay, sums, truth);
    if (!v.safe) continue;
    safe++;
    const out = chainOutcome(c.all, c.oid, c.fc, c.tip, sums);
    if (!out.granted || !out.delivered) bad.push(`${c.fc.slice(-6)} granted=${out.granted} delivered=${out.delivered}`);
  }
  return { safe, bad };
}

await t("R1: the second-order chain is refused (the chain denies the buyer's fclaim)", async () => {
  const c = secondOrder();
  assert.equal(resolve(c.all, c.tip).fclaims[c.fc], undefined, "premise: the chain denies the buyer");
  const { safe, bad } = await property([c]);
  assert.deepEqual(bad, [], `a safe verdict on a fill the chain does not deliver (${safe} safe)`);
  const s = seam(c.all, c.oid, c.fc, c.tip);
  const v = await verify(s.io, c.oid, c.fc, undefined, outsOf(resolve(c.all, c.tip).offers[c.oid]!, WANT), undefined);
  assert.equal(v.code, "not-granted", v.reason);
  assert.equal(s.n.heights, MAX_SCAN, "one extension of MAX_SCAN heights decides Y and Z");
});

await t("R1: random histories: every safe verdict is a fill the full resolve() grants and delivers", async () => {
  const { safe, bad } = await property(Array.from({ length: 1000 }, (_, i) => randomHistory(1000 + i)));
  assert.deepEqual(bad, [], `${bad.length} safe verdicts the chain refuses`);
  assert.ok(safe >= 100, `the property must not be vacuous: ${safe} safe verdicts`);
});

// ── R2: the aged tail: want 50,000,000, min 10,000,000, a fill of 45,000,000 300 blocks back, the buyer pays the
//    5,000,000 tail (below min, so buyable only against the chain's paid) ──
function agedTail(fillAtFloor = false) {
  const oid = nid();
  const fcH = HB + 335, fillH = fillAtFloor ? fcH - MAX_SCAN : HB + 31;   // case D: the fill at the window's floor
  const all = [...backing(), partialOffer(HB, oid)];
  const fcC = PE(fclaim({ offer: oid }), fillH - 1, C, epochOf(fillH - 1) + 2);
  all.push(fcC, AE(idOf(fcC), C, fillH, partialPay(45_000_000n)));
  const fcEv = PE(fclaim({ offer: oid }), fcH, BUY, epochOf(fcH) + 2);
  all.push(fcEv);
  return { all, oid, fc: idOf(fcEv), tip: fcH + 10 };
}
for (const [label, atFloor] of [["300 blocks back", false], ["at the window's floor, its fclaim below it", true]] as const) {
  await t(`R2: the aged tail (fill ${label}) is accepted with the planned range, sums equal to the chain's`, async () => {
    const c = agedTail(atFloor);
    const truth = resolve(c.all, c.tip).offers[c.oid]!;
    assert.equal(truth.paid, "45000000", "premise: the chain holds the earlier fill");
    const sums = outsOf(truth, 5_000_000n)!;
    const s = seam(c.all, c.oid, c.fc, c.tip);
    const windowOnly = await verify(s.bare, c.oid, c.fc, 5_000_000n, sums, truth);
    assert.equal(windowOnly.code, "no-delivery", `the window alone refuses at the delivery gate (${windowOnly.reason})`);
    const v = await verify(s.io, c.oid, c.fc, 5_000_000n, sums, truth);
    assert.equal(v.safe, true, `the honest tail buy is accepted (${v.reason})`);
    assert.ok(s.n.ranges === 1 && s.n.heights > 0 && s.n.heights <= FILL_HISTORY_SPAN, `one planned range (${s.n.heights} heights)`);
    const out = chainOutcome(c.all, c.oid, c.fc, c.tip, sums);
    assert.ok(out.granted && out.delivered, "the chain delivers the tail");
  });
}
// A coarse give (4 units for 50,000,000): the delivered amount is floor(4 * paid / want), so a payment worth less than
// one unit delivers over some earlier paid and not over others. C's 14,000,000 fill is aged out; A's 24,000,000 is in
// the window. The chain holds paid 38,000,000 (3 units delivered), so 1,000,000 more delivers 0; over the window's
// 24,000,000 (1 unit) it delivers 1. The site passes no sums when the served preview cannot size the payment.
function coarse() {
  const oid = nid();
  const all = [...backing(), partialOffer(HB, oid, "4", 1_000_000n)];
  const fcC = PE(fclaim({ offer: oid }), HB + 30, C, epochOf(HB + 30) + 2);
  const fcA = PE(fclaim({ offer: oid }), 99_305, A, epochOf(99_305));   // holds to 99,330
  const fcEv = PE(fclaim({ offer: oid }), 99_335, BUY, epochOf(99_335) + 2);
  all.push(fcC, AE(idOf(fcC), C, HB + 31, partialPay(14_000_000n)), fcA, AE(idOf(fcA), A, 99_306, partialPay(24_000_000n)), fcEv);
  return { all, oid, fc: idOf(fcEv), tip: 99_345 };
}
await t("R2: a coarse partial whose delivery depends on an aged fill reads it, refuses the zero delivery and takes the tail", async () => {
  const c = coarse();
  const truth = resolve(c.all, c.tip).offers[c.oid]!;
  assert.ok(truth.paid === "38000000" && truth.delivered === "3", "premise: the chain holds both fills");
  const pay = 1_000_000n;
  assert.equal(outsOf(truth, pay), null, "premise: over the chain's state the payment delivers nothing");
  const s = seam(c.all, c.oid, c.fc, c.tip);
  assert.equal((await verify(s.bare, c.oid, c.fc, pay, null, truth)).safe, true, "premise: over the window alone it delivers a unit");
  const v = await verify(s.io, c.oid, c.fc, pay, null, truth);
  assert.equal(v.code, "no-delivery", `refused (${v.reason})`);
  assert.equal(s.n.ranges, 1, "the aged fill's range was read");
  // paired: the 12,000,000 tail delivers the last unit on chain; it too depends on the earlier fills, so it reads
  const tail = 12_000_000n, s2 = seam(c.all, c.oid, c.fc, c.tip);
  const ok = await verify(s2.io, c.oid, c.fc, tail, outsOf(truth, tail), truth);
  assert.equal(ok.safe, true, `the tail is accepted (${ok.reason})`);
  assert.ok(s2.n.ranges === 1 && chainOutcome(c.all, c.oid, c.fc, c.tip, outsOf(truth, tail)!).delivered, "after one read, and the chain delivers it");
});
await t("R2: a listed aged fill that is not in its block refuses, with the reads bounded", async () => {
  const c = agedTail();
  const truth = resolve(c.all, c.tip).offers[c.oid]!;
  const fake: OfferState = { ...truth, fills: [{ ...truth.fills![0]!, txid: nid() }] };
  const s = seam(c.all, c.oid, c.fc, c.tip);
  const v = await verify(s.io, c.oid, c.fc, 5_000_000n, outsOf(truth, 5_000_000n), fake);
  assert.equal(v.code, "listed-fill-unproven", v.reason);
  assert.ok(s.n.heights <= FILL_HISTORY_SPAN, `${s.n.heights} heights read`);
});

// ── R3: inflate: B's fclaim is denied by A's live hold inside B's range, B's fill is listed and the served paid counts it ──
function inflate() {
  const oid = nid();
  const all = [...backing(), partialOffer(HB, oid)];
  all.push(PE(fclaim({ offer: oid }), HB + 30, A, epochOf(HB + 30) + 2));   // holds to HB + 120
  const fcB = PE(fclaim({ offer: oid }), HB + 60, B, epochOf(HB + 60) + 2);   // denied: A's hold is live
  const fillB = AE(idOf(fcB), B, HB + 61, partialPay(45_000_000n));
  const fcEv = PE(fclaim({ offer: oid }), HB + 400, BUY, epochOf(HB + 400) + 2);
  all.push(fcB, fillB, fcEv);
  return { all, oid, fc: idOf(fcEv), tip: HB + 410, fillB };
}
await t("R3: a listed fill whose fclaim the chain denied does not inflate the replay: refused", async () => {
  const c = inflate();
  const truth = resolve(c.all, c.tip).offers[c.oid]!;
  assert.equal(truth.paid, "0", "premise: the chain did not credit B's fill");
  const lie: OfferState = { ...truth, paid: "45000000", delivered: "900", fills: [{ buyer: B, txid: idOf(c.fillB), height: HB + 61, paid: "45000000", fee: "675000", got: "900" }] };
  const sums = outsOf(lie, 5_000_000n)!;
  assert.equal(chainOutcome(c.all, c.oid, c.fc, c.tip, sums).delivered, false, "premise: the chain refuses the 5,000,000 tail (below the real min)");
  const v = await verify(seam(c.all, c.oid, c.fc, c.tip).io, c.oid, c.fc, 5_000_000n, sums, lie);
  assert.equal(v.code, "no-delivery", `refused (${v.reason})`);
});

// ── R4: the third-party cap: the holder of three live fclaims on other offers mines an fclaim on this offer ──
function thirdParty(capHolder: string, held = 3) {
  const oid = nid();
  const all = [...backing(), partialOffer(HB, oid)];
  for (let i = 0; i < held; i++) {
    const o = nid();
    all.push(wholeOffer(HB, o), PE(fclaim({ offer: o }), 99_150 + i, capHolder, epochOf(99_150) + 2));
  }
  const fcT = PE(fclaim({ offer: oid }), 99_179, T, epochOf(99_179));   // the epoch's last block: a one-block hold
  all.push(fcT, AE(idOf(fcT), T, 99_179, partialPay(45_000_000n), 1));
  const fcEv = PE(fclaim({ offer: oid }), 99_200, BUY, epochOf(99_200) + 2);
  all.push(fcEv);
  return { all, oid, fc: idOf(fcEv), tip: 99_210, fcT };
}
await t("R4: T holds 3 live fclaims elsewhere at its grant: the branches differ and the verdict refuses", async () => {
  const c = thirdParty(T);
  const truth = resolve(c.all, c.tip);
  assert.equal(truth.fclaims[idOf(c.fcT)], undefined, "premise: the chain denies T's fclaim on the cap");
  const lie: OfferState = { ...truth.offers[c.oid]!, paid: "45000000", delivered: "900" };
  const sums = outsOf(lie, 5_000_000n)!;
  assert.equal(chainOutcome(c.all, c.oid, c.fc, c.tip, sums).delivered, false, "premise: the chain refuses the tail");
  const s = seam(c.all, c.oid, c.fc, c.tip);
  const v = await verify(s.io, c.oid, c.fc, 5_000_000n, sums, lie);
  assert.equal(v.code, "history-undecidable", `refused (${v.reason})`);
  assert.equal(s.n.authors, MAX_ACTIVE_CLAIMS, "the authors are read only at the cap");
});
await t("R4 happy paths: two holds elsewhere read nothing; three held by another address cost three author reads", async () => {
  for (const [holder, held, authors] of [[T, 2, 0], [D, 3, 3]] as const) {
    const c = thirdParty(holder, held);
    const truth = resolve(c.all, c.tip);
    assert.ok(truth.fclaims[idOf(c.fcT)] !== undefined && truth.offers[c.oid]!.paid === "45000000", "premise: T's fill is credited");
    const sums = outsOf(truth.offers[c.oid]!, 5_000_000n)!;
    const s = seam(c.all, c.oid, c.fc, c.tip);
    const v = await verify(s.io, c.oid, c.fc, 5_000_000n, sums, truth.offers[c.oid]);
    assert.equal(v.safe, true, `${held} holds by ${holder.slice(0, 6)}: accepted (${v.reason})`);
    assert.equal(s.n.authors, authors, "author reads");
    assert.ok(chainOutcome(c.all, c.oid, c.fc, c.tip, sums).delivered);
  }
});

// ── R5: the range planner ──
await t("R5: planFillHistory merges, plans for a fill at the floor, refuses past the cap, and skips covered fills", () => {
  const S_ = FILL_HISTORY_SPAN;
  assert.deepEqual(planFillHistory([{ height: 10_000 }, { height: 10_100 }], [], 0), { ok: true, ranges: [{ lo: 10_000 - S_, hi: 10_100 }], heights: 100 + S_ + 1 }, "overlapping ranges merge");
  assert.deepEqual(planFillHistory([{ height: 5_000 }], [{ lo: 5_000, hi: 5_200 }], 0), { ok: true, ranges: [{ lo: 5_000 - S_, hi: 4_999 }], heights: S_ }, "a fill at the floor of the window gets the range below it");
  assert.deepEqual(planFillHistory([{ height: 5_000 }], [{ lo: 0, hi: 9_000 }], 0), { ok: true, ranges: [], heights: 0 }, "a fill inside the read ranges gets none");
  assert.deepEqual(planFillHistory([{ height: 5_000 }], [], 4_950), { ok: true, ranges: [{ lo: 4_950 - FCLAIM_MAX_HOLD_SPAN, hi: 5_000 }], heights: 50 + FCLAIM_MAX_HOLD_SPAN + 1 }, "nothing below the hold span under the offer's anchor");
  const far = planFillHistory([{ height: 10_000 }, { height: 20_000 }, { height: 30_000 }], [], 0);
  assert.equal(far.ok === false && far.code, "history-past-cap", "three distant fills pass the cap");
  const spent = planFillHistory([{ height: 10_000 }], [], 0, { spent: FILL_HISTORY_CAP - S_ });
  assert.equal(spent.ok === false && spent.code, "history-past-cap", "reads already made count against the cap");
  assert.equal(planFillHistory([{ height: 10_000 }], [], 0, { spent: FILL_HISTORY_CAP - S_ - 1 }).ok, true, "exactly at the cap is allowed");
  const low = planFillHistory([{ height: 5_000 }], [], 0, { floor: 4_900 });
  assert.equal(low.ok === false && low.code, "history-below-floor", "below the seam's floor");
});

// ── R6: the paired happy path: with the history seam, every verdict of the verifyfill scenarios is the single-replay
//    verdict and nothing more is read ──
function scenarios() {
  const out: { name: string; all: ChainEvent[]; oid: string; fc: string; tip: number; pay?: bigint; sums?: Record<string, string> | null; served?: OfferState; holds?: number }[] = [];
  const whole = (extra: (oid: string) => { evs: ChainEvent[]; fc: string; tip: number }, name: string, holds = 0) => {
    const oid = nid();
    const base = [...backing(), wholeOffer(HB - 400, oid)];
    const x = extra(oid);
    const all = [...base, ...x.evs];
    out.push({ name, all, oid, fc: x.fc, tip: x.tip, sums: outsOf({ ...resolve(all, x.tip).offers[oid]!, status: "open" }, WANT), holds });
  };
  const E3 = epochOf(HB + 3) + 2;
  const grant = (oid: string, who = BUY, h = HB + 3, E = E3) => PE(fclaim({ offer: oid }), h, who, E);
  whole((o) => { const g = grant(o); return { evs: [g], fc: idOf(g), tip: fclaimHoldEnd(E3) - 5 }; }, "honest whole fill");
  whole((o) => { const g = grant(o); return { evs: [g], fc: idOf(g), tip: HB + 4 }; }, "below depth");
  whole((o) => { const g1 = grant(o), g2 = grant(o, BUY, HB + 5); return { evs: [g1, g2], fc: idOf(g2), tip: fclaimHoldEnd(E3) - 5 }; }, "denied fclaim");
  whole((o) => { const g = grant(o, C); return { evs: [g], fc: idOf(g), tip: fclaimHoldEnd(E3) - 5 }; }, "not the holder");
  whole((o) => {
    const Ex = epochOf(HB + 3), g = grant(o, BUY, HB + 3, Ex);
    return { evs: [g, AE(o, S, fclaimHoldEnd(Ex) + 2, {}, 0, SCORE_CANCEL)], fc: idOf(g), tip: fclaimHoldEnd(Ex) + 5 };
  }, "cancelled after the hold");
  whole((o) => { const g = grant(o); return { evs: [g], fc: idOf(g), tip: fclaimHoldEnd(E3) - 5 }; }, "at the cap", MAX_ACTIVE_CLAIMS);
  // partial offers: an earlier fill inside the window, and one 300 blocks back
  const partial = (name: string, fillH: number, pay: bigint, lie?: (o: OfferState) => OfferState) => {
    const oid = nid();
    const all = [...backing(), partialOffer(HB - 400, oid)];
    const f0 = PE(fclaim({ offer: oid }), fillH - 1, C, epochOf(fillH - 1));   // C's hold ends before the buyer's grant
    const g = grant(oid);
    all.push(f0, AE(idOf(f0), C, fillH, partialPay(20_000_000n)), g);
    const tip = fclaimHoldEnd(epochOf(g.height) + 2) - 5;
    const truth = resolve(all, tip).offers[oid]!;
    const served = lie ? lie(truth) : truth;
    out.push({ name, all, oid, fc: idOf(g), tip, pay, sums: outsOf(served, pay), served });
  };
  partial("partial tail, earlier fill in the window", HB - 20, 30_000_000n);
  partial("partial below min, earlier fill in the window", HB - 20, 5_000_000n);
  partial("partial, a served paid of 0 sizes the whole want (W3)", HB - 20, WANT, (o) => ({ ...o, paid: "0", delivered: "0", fills: [] }));
  partial("partial at min, earlier fill 290 blocks back", HB - 290, MIN);
  return out;
}
await t("R6: each scenario's verdict is the single-replay verdict, and no history is read", async () => {
  for (const c of scenarios()) {
    const s = seam(c.all, c.oid, c.fc, c.tip);
    const plain = await verify(s.bare, c.oid, c.fc, c.pay, c.sums ?? null, c.served, c.holds);
    const v = await verify(s.io, c.oid, c.fc, c.pay, c.sums ?? null, c.served, c.holds);
    const key = (x: FillVerdict) => JSON.stringify([x.safe, x.reason, x.code]);
    assert.equal(key(v), key(plain), `${c.name}: the same verdict`);
    assert.deepEqual(s.n, { ranges: 0, heights: 0, authors: 0 }, `${c.name}: nothing read (${plain.reason})`);
  }
  const verdicts = await Promise.all(scenarios().map(async (c) => (await verify(seam(c.all, c.oid, c.fc, c.tip).io, c.oid, c.fc, c.pay, c.sums ?? null, c.served, c.holds)).code ?? "safe"));
  assert.deepEqual(verdicts, ["safe", "not-buried", "not-granted", "not-held", "not-held", "cap-reached", "safe", "no-delivery", "sums-mismatch", "safe"]);
});

// ── proveListedFills: the listed-fill proof the taker lane runs with sparse reads (no grant decides delivery there) ──
await t("proveListedFills proves each listed fill at its height and refuses one that is not there", async () => {
  const oid = nid();
  const f1 = AE(oid, BUY, HB + 5, partialPay(MIN)), f2 = AE(oid, BUY, HB + 9, partialPay(MIN));
  const cancel = AE(oid, S, HB + 12, {}, 0, SCORE_CANCEL);
  const chain = new Map([f1, f2, cancel].map((e) => [idOf(e), { ...e, depth: 1 } as ProvenEvent]));
  const prove = async (id: string, h: number) => { const e = chain.get(id); return e && e.height === h ? e : null; };
  const ok = await proveListedFills([{ txid: idOf(f1), height: HB + 5 }, { txid: idOf(f2), height: HB + 9 }], prove);
  assert.ok(ok.ok && ok.events.length === 2, "both listed fills prove");
  for (const [label, entry] of [["another height", { txid: idOf(f1), height: HB + 6 }], ["an unknown txid", { txid: nid(), height: HB + 5 }], ["a cancel", { txid: idOf(cancel), height: HB + 12 }]] as const) {
    const r = await proveListedFills([{ txid: idOf(f2), height: HB + 9 }, entry], prove);
    assert.ok(!r.ok && r.code === "listed-fill-unproven", `${label}: refused`);
  }
  const thrown = await proveListedFills([{ txid: idOf(f1), height: HB + 5 }], async () => { throw new Error("read failed"); });
  assert.ok(!thrown.ok && thrown.code === "listed-fill-unproven", "a failed read refuses");
});

console.log(`fillhistory: ${pass} passed`);
