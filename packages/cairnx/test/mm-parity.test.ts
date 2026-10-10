// The maker's sizer, notional, curve and fee sum live in cairnx-core/mm. These cases are the
// maker's own fixtures (ladder, bids, fills, curve table) run against the moved functions.
import assert from "node:assert/strict";
import { makerRebate, tradeFee, FEE_BPS_V16 } from "../src/index.js";
import {
  acceptBid, expScaled, rfqBuyAllIn, rfqFillAllIn, sizeBid, sunriseCurve, tierFor, tradeNotional,
} from "../src/mm/index.js";

let pass = 0;
const t = (name: string, fn: () => void) => {
  const r = fn() as unknown;
  if (r !== undefined) throw new Error(`test "${name}" returned a value - use assert`);
  pass++; console.log("  ok", name);
};

const UNIT8 = 10n ** 8n;
const ladder = [
  { bps: 0, size: "2000", pricePerUnit: "1010000" },
  { bps: 2500, size: "20000", pricePerUnit: "1250000" },
  { bps: 6000, size: "100000", pricePerUnit: "1600000" },
];
const csd = (disp: string) => {
  const [i, f = ""] = disp.split(".");
  return BigInt(i + (f as string).padEnd(8, "0").slice(0, 8));
};
const have = 13_000_000n * UNIT8;
const accept = (csdBase: bigint, tokBase: string | bigint, extra: { remainingEpochs?: number } = {}) =>
  acceptBid({ csdBase, tokBase, levels: ladder, ref: 1_000_000n, marginBps: 100n, have, remainingEpochs: 6, unit: UNIT8, ...extra });

t("sizeBid: 0.5 / 2.5 / 12.34 / 100 CSD all clear accept on the ladder", () => {
  for (const disp of ["0.5", "2.5", "12.34", "100"]) {
    const sized = sizeBid({ csdBase: csd(disp), decimals: 8, levels: ladder, minBidCsd: 50_000_000n });
    assert.equal(sized.ok, true, `${disp} should size`);
    if (!sized.ok) return;
    const acc = accept(csd(disp), sized.tokBase);
    assert.equal(acc.ok, true, `${disp} must be accepted`);
    assert.ok(BigInt(acc.bidUnit!) >= 1_010_000n, `${disp} bidUnit ${acc.bidUnit}`);
  }
});

t("sizeBid: pinned outputs", () => {
  const r = sizeBid({ csdBase: csd("2.5"), decimals: 8, levels: ladder, minBidCsd: 50_000_000n });
  assert.deepEqual(r, {
    ok: true, tokBase: "24752475247", pricePerUnit: "1010000", bidUnit: "1010000",
    tier: { bps: 0, size: "2000", pricePerUnit: "1010000" },
  });
});

t("sizeBid: a spend just over the first rung keeps the cheaper size", () => {
  const a = sizeBid({ csdBase: csd("20.20"), decimals: 8, levels: ladder, minBidCsd: 50_000_000n });
  const b = sizeBid({ csdBase: csd("20.30"), decimals: 8, levels: ladder, minBidCsd: 50_000_000n });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.ok(BigInt(b.tokBase) >= BigInt(a.tokBase));
  assert.equal(b.tier.size, "2000");
});

t("sizeBid / acceptBid: a spend above the top rung is above-top-tier", () => {
  const sized = sizeBid({ csdBase: csd("200000"), decimals: 8, levels: ladder, minBidCsd: 50_000_000n });
  assert.deepEqual(sized, { ok: false, skip: "above-top-tier" });
  const acc = accept(csd("200000"), 13_000_000n * UNIT8);
  assert.equal(acc.ok, false);
  assert.equal(acc.ok ? "" : acc.skip, "above-top-tier");
});

t("sizeBid then acceptBid over a grid of CSD amounts", () => {
  const amounts = ["0.5", "0.51", "1", "1.3", "2.5", "5", "10", "12.34", "20", "50", "99.99", "100", "250", "500", "1600"];
  for (let i = 50; i <= 200; i++) amounts.push(String(i));
  let sizedCount = 0;
  for (const disp of amounts) {
    const sized = sizeBid({ csdBase: csd(disp), decimals: 8, levels: ladder, minBidCsd: 50_000_000n, inventoryBase: have });
    if (!sized.ok) continue;
    sizedCount++;
    const acc = accept(csd(disp), sized.tokBase);
    assert.equal(acc.ok, true, `${disp} sized ok but accept skipped ${acc.ok ? "" : acc.skip}`);
  }
  assert.ok(sizedCount > 100, `grid sized only ${sizedCount} amounts`);
});

t("acceptBid: below-margin, expiring, below-min-bid", () => {
  const sized = sizeBid({ csdBase: csd("2.5"), decimals: 8, levels: ladder, minBidCsd: 50_000_000n });
  assert.ok(sized.ok);
  if (!sized.ok) return;
  const short = accept(csd("2.5"), BigInt(sized.tokBase) + 2n);
  assert.equal(short.ok ? "" : short.skip, "below-margin");
  assert.equal(accept(csd("2.5"), sized.tokBase, { remainingEpochs: 1 }).ok, false);
  assert.equal(sizeBid({ csdBase: 20_000_000n, decimals: 8, levels: ladder, minBidCsd: 50_000_000n }).ok, false);
});

t("acceptBid: below-tier when the bid clears the margin but not the rung", () => {
  const give = 25_000n * 1_200_000n;
  const acc = acceptBid({ csdBase: give, tokBase: 25_000n * UNIT8, levels: ladder, ref: 1_000_000n, marginBps: 100n, have, remainingEpochs: 6, unit: UNIT8 });
  assert.equal(acc.ok, false);
  assert.equal(acc.ok ? "" : acc.skip, "below-tier");
  assert.equal(tierFor(ladder, 25_000n * UNIT8, UNIT8)?.size, "100000");
});

t("tradeNotional: RFQ rebate on a 2 CSD want is contractual 2.00", () => {
  const SELLER = "0x" + "0d".repeat(20);
  const BUYER = "0x" + "aa".repeat(20);
  const want = 2n * UNIT8;
  const rebate = makerRebate(want);
  assert.equal(want + rebate, 226_000_000n);
  const offer = { seller: SELLER, want: { value: String(want), payto: SELLER }, fill: { paid: String(want + rebate), fee: "0" } };
  const n = tradeNotional(offer, offer.fill, { rebate: makerRebate });
  assert.equal(n.notional, want);
  assert.equal(n.rebate, rebate);
  assert.equal(n.change, 0n);
  assert.equal(n.paidObserved, want + rebate);
  const change = tradeNotional({ seller: SELLER, want: { value: "50000000", payto: BUYER }, fill: { paid: String(50_000_000n + 1000n * UNIT8), fee: "0" } }, null, { rebate: makerRebate });
  assert.equal(change.notional, 50_000_000n);
  assert.equal(change.rebate, 0n);
  assert.equal(change.change, 1000n * UNIT8);
});

t("expScaled and sunriseCurve table", () => {
  assert.equal(expScaled(0n), 1_000_000n);
  const ln2 = expScaled(693_147n);
  assert.ok(ln2 >= 1_998_000n && ln2 <= 2_002_000n, `ln2 got ${ln2}`);
  const P0 = 1_000_000n, E = 100_000n * UNIT8, k = 1_098_612n;
  const at = (q: bigint, epochsElapsed: number, floor: bigint | null = 1n) =>
    sunriseCurve({ p0: P0, rateBps: 2, kScaled: k, E, q, epochsElapsed, capMult: 8, floor });
  assert.equal(at(0n, 0), P0);
  const end = at(E, 0);
  assert.ok(end >= P0 * 3n * 99n / 100n && end <= P0 * 3n * 101n / 100n, `3P0 got ${end}`);
  assert.equal(at(E, 20_000), P0 * 8n);
  assert.equal(sunriseCurve({ p0: 100n, rateBps: 0, kScaled: 0n, E, q: 0n, epochsElapsed: 0, capMult: 8, floor: 1_000_000n }), 1_000_000n);
  let prev = 0n;
  for (const q of [0n, E / 4n, E / 2n, E]) { const p = at(q, 10); assert.ok(p >= prev); prev = p; }
  assert.ok(at(0n, 100) > at(0n, 0));
});

t("sunriseCurve: live state pinned (q 272529 tokens, 18 epochs)", () => {
  const p = sunriseCurve({ p0: 1_000_000n, rateBps: 2, kScaled: 693_147n, E: 4_200_000n * UNIT8, q: 272_529n * UNIT8, epochsElapsed: 18, capMult: 3, floor: 1_000_000n });
  assert.equal(p, 1_049_774n);
});

t("rfqBuyAllIn / rfqFillAllIn: the swap probe pins, and every leg rounds up", () => {
  assert.equal(rfqBuyAllIn(2n * UNIT8), 259_000_000n);
  assert.equal(rfqBuyAllIn(UNIT8), 157_000_000n);
  assert.equal(rfqBuyAllIn(2n * UNIT8) - rfqFillAllIn(2n * UNIT8), 25_000_000n);
  // n = 1: fee ceil(1.5/100) = 1 and rebate 25_000_000 + ceil(0.5/100) = 1 on top of the flat legs.
  assert.equal(tradeFee(1n, FEE_BPS_V16), 1n);
  assert.equal(rfqFillAllIn(1n), 1n + 1n + 25_000_001n + 5_000_000n);
  assert.equal(rfqBuyAllIn(1n), 55_000_003n);
});

console.log(`mm-parity: ${pass} passed`);
