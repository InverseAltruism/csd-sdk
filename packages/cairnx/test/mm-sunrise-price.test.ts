// Sunrise order pricing: the integral of the spot curve over an order, its margin and floor, and
// the inverse. References are double-precision closed forms computed here, independent of the
// BigInt fixed-point code under test.
import assert from "node:assert/strict";
import {
  expm1Scaled, sunriseAnswerPrice, sunriseCurve, sunriseOrderCost, sunriseTimeMult, sunriseTokensFor, type SunriseOrderParams,
} from "../src/mm/index.js";

let pass = 0;
const t = (name: string, fn: () => void) => {
  const r = fn() as unknown;
  if (r !== undefined) throw new Error(`test "${name}" returned a value - use assert`);
  pass++; console.log("  ok", name);
};

const U = 10n ** 8n;
const E = 4_200_000n * U;
const LIVE: SunriseOrderParams = { p0: 1_000_000n, rateBps: 2, kScaled: 693_147n, E, capMult: 3 };
const Q_LIVE = 272_529n * U;
const TOKENS = (n: number) => BigInt(n) * U;

// Double-precision reference: (1/U) * integral over [q, q+n] of min(C, A e^{k x / E}) dx, flat past E.
function refCost(p: SunriseOrderParams, q: bigint, n: bigint, epochs: number): number {
  const P0 = Number(p.p0), k = Number(p.kScaled) / 1e6, Ef = Number(p.E), Uf = Number(U);
  const A = P0 * Math.pow(1 + Number(p.rateBps) / 1e4, epochs);
  const C = P0 * Number(p.capMult);
  const lo = Number(q), hi = Number(q + n);
  const price = (x: number) => A * Math.exp(k * Math.min(x, Ef) / Ef);
  // x* is where the curve reaches the cap, from the closed form; flat beyond min(x*, E).
  const xStar = A >= C ? 0 : (price(Ef) >= C ? (Ef / k) * Math.log(C / A) : Infinity);
  const split = Math.min(xStar, Ef);
  const flat = xStar <= Ef ? C : price(Ef);
  const curve = (a: number, b: number) => (b <= a ? 0 : (A * Ef / (k * Uf)) * Math.exp(k * a / Ef) * Math.expm1(k * (b - a) / Ef));
  const curvePart = curve(Math.min(lo, split), Math.min(hi, split));
  const flatPart = (flat / Uf) * (hi - Math.max(lo, split) > 0 ? hi - Math.max(lo, split) : 0);
  return curvePart + flatPart;
}
const close = (got: bigint, ref: number, label: string) => {
  const diff = Math.abs(Number(got) - ref);
  assert.ok(diff <= Math.max(1, 1e-9 * ref), `${label}: got ${got}, reference ${ref}, off by ${diff}`);
};

t("expm1Scaled keeps every digit of a small argument", () => {
  for (const z of [1e-9, 1.65e-3, 1e-2, 0.25, 1, 2.2, 6.9]) {
    const got = Number(expm1Scaled(BigInt(Math.round(z * 1e9)) * 10n ** 9n)) / 1e18;
    const ref = Math.expm1(Math.round(z * 1e9) / 1e9);
    assert.ok(Math.abs(got - ref) <= 2e-18 + 1e-13 * ref, `z=${z}: ${got} vs ${ref}`);
  }
  assert.equal(expm1Scaled(0n), 0n);
  assert.throws(() => expm1Scaled(-1n), RangeError);
});

t("sunriseOrderCost matches the closed form at the live state", () => {
  for (const tokens of [1, 10_000, 50_000, 60_000, 420_000]) {
    const n = TOKENS(tokens);
    close(sunriseOrderCost(LIVE, Q_LIVE, n, 18), refCost(LIVE, Q_LIVE, n, 18), `${tokens} tokens`);
  }
  // 10k tokens: k n / E = 0.00165, where a 1e-6-scale exp difference is off by 0.06%.
  const n10k = TOKENS(10_000);
  const cost = sunriseOrderCost(LIVE, Q_LIVE, n10k, 18);
  const spotTotal = Number(sunriseCurve({ ...LIVE, q: Q_LIVE, epochsElapsed: 18, floor: 1n })) * 10_000;
  assert.ok(cost > BigInt(Math.floor(spotTotal)), "an order costs more than its first token's price times n");
});

t("sunriseOrderCost: a 10k-token order is exact to 1e-9, not to the 1e-6 of the spot curve's exp", () => {
  const n = TOKENS(10_000);
  const ref = refCost(LIVE, Q_LIVE, n, 18);
  const got = sunriseOrderCost(LIVE, Q_LIVE, n, 18);
  assert.ok(Math.abs(Number(got) - ref) <= 1, `got ${got}, reference ${ref}`);
});

t("sunriseOrderCost: a price-times-n shortcut is not the integral", () => {
  const n = TOKENS(420_000);
  const spot = sunriseCurve({ ...LIVE, q: Q_LIVE, epochsElapsed: 18, floor: 1n });
  const naive = spot * 420_000n;
  const cost = sunriseOrderCost(LIVE, Q_LIVE, n, 18);
  // average factor 1 + k n / (2E) = 1.0347 for the 420k order
  assert.ok(Number(cost) / Number(naive) > 1.03 && Number(cost) / Number(naive) < 1.04, `ratio ${Number(cost) / Number(naive)}`);
});

t("sunriseOrderCost: cap binding mid-order, fully above the cap, and past E", () => {
  const capped: SunriseOrderParams = { ...LIVE };
  const epochs = 2340;
  // With 2340 epochs the curve reaches 3 * P0 at about 0.91 E.
  const cases: [string, bigint, bigint][] = [
    ["crosses the cap point", (E * 80n) / 100n, (E * 15n) / 100n],
    ["starts above the cap point", (E * 95n) / 100n, (E * 4n) / 100n],
    ["extends past E", (E * 95n) / 100n, (E * 10n) / 100n],
    ["starts at zero", 0n, E],
  ];
  for (const [label, q, n] of cases) close(sunriseOrderCost(capped, q, n, epochs), refCost(capped, q, n, epochs), label);
  const above = sunriseOrderCost(capped, (E * 95n) / 100n, (E * 4n) / 100n, epochs);
  assert.equal(above, BigInt(Math.ceil((3_000_000 * Number((E * 4n) / 100n)) / 1e8)), "fully capped is C times n");
});

t("sunriseOrderCost: the price is flat past E, so an order beyond E is not free", () => {
  const q = (E * 99n) / 100n;
  const n = (E * 5n) / 100n;
  close(sunriseOrderCost(LIVE, q, n, 18), refCost(LIVE, q, n, 18), "past E uncapped");
  const toE = sunriseOrderCost(LIVE, q, E - q, 18);
  const beyond = sunriseOrderCost(LIVE, E, (E * 4n) / 100n, 18);
  assert.ok(beyond > 0n);
  assert.ok(sunriseOrderCost(LIVE, q, n, 18) >= toE + beyond);
});

t("sunriseOrderCost: zero and negative sizes, and a flat curve", () => {
  assert.equal(sunriseOrderCost(LIVE, Q_LIVE, 0n, 18), 0n);
  assert.equal(sunriseOrderCost(LIVE, Q_LIVE, -5n, 18), 0n);
  const flat = { ...LIVE, kScaled: 0n };
  const T = sunriseTimeMult(2, 18);
  assert.equal(sunriseOrderCost(flat, Q_LIVE, TOKENS(1000), 18), (1_000_000n * T * 1000n + 10n ** 12n - 1n) / 10n ** 12n);
  assert.throws(() => sunriseOrderCost({ ...LIVE, kScaled: 11_000_000n }, 0n, 1n, 0), RangeError);
});

t("kScaled is bounded by the spot curve's exponent clamp, so spot and order cost agree up to q = E", () => {
  assert.throws(() => sunriseOrderCost({ ...LIVE, kScaled: 2_200_001n }, 0n, 1n, 0), RangeError, "red-first: a k above the clamp is refused");
  const steep = { ...LIVE, kScaled: 2_200_000n, capMult: 100 };
  const q = E - TOKENS(1);
  const spot = sunriseCurve({ ...steep, q, epochsElapsed: 0 });
  const perToken = sunriseOrderCost(steep, q, U, 0);
  assert.ok(Number(perToken > spot ? perToken - spot : spot - perToken) / Number(spot) < 2e-6, `paired: at the largest k the spot ${spot} and the one-token cost ${perToken} agree near q = E`);
});

const GRIDS: [string, SunriseOrderParams, number][] = [
  ["live", LIVE, 18],
  ["cap binds", LIVE, 2340],
  ["no time growth", { ...LIVE, rateBps: 0 }, 0],
  ["flat", { ...LIVE, kScaled: 0n }, 18],
];

t("an order is never cheaper split: cost(q,a) + cost(q+a,b) - cost(q,a+b) is 0, 1 or 2", () => {
  const qs = [0n, 1n, Q_LIVE, E / 2n, (E * 9n) / 10n, E - 1n, E];
  const sizes = [1n, 7n, U, 123_456_789n, TOKENS(1_000), 5_000_000_000_000n, TOKENS(100_000), TOKENS(2_000_000)];
  let checked = 0;
  for (const [name, params, epochs] of GRIDS) {
    for (const q of qs) for (const a of sizes) for (const b of sizes) {
      const d = sunriseOrderCost(params, q, a, epochs) + sunriseOrderCost(params, q + a, b, epochs) - sunriseOrderCost(params, q, a + b, epochs);
      assert.ok(d >= 0n && d <= 2n, `${name} q=${q} a=${a} b=${b}: split minus whole = ${d}`);
      checked++;
    }
  }
  assert.equal(checked, GRIDS.length * qs.length * sizes.length * sizes.length);
});

t("an order of one base unit still costs at least one base unit", () => {
  for (const [, params, epochs] of GRIDS) for (const q of [0n, Q_LIVE, E]) {
    assert.ok(sunriseOrderCost(params, q, 1n, epochs) >= 1n);
  }
});

// The spot curve is exp at scale 1e6 with floors, so it is itself only good to about 1.6e-6 relative
// (the order cost is checked against the closed form to 1e-9 above); the bound here is 2e-6.
t("cost(q,n)/n approaches the spot price for a small order", () => {
  const rich: SunriseOrderParams = { ...LIVE, p0: 1_000_000_000n };
  for (const [q, epochs] of [[0n, 0], [Q_LIVE, 18], [E / 2n, 400], [(E * 9n) / 10n, 18]] as [bigint, number][]) {
    const n = U;
    const spot = Number(sunriseCurve({ ...rich, q, epochsElapsed: epochs, floor: 1n }));
    const avg = Number(sunriseOrderCost(rich, q, n, epochs));
    assert.ok(Math.abs(avg - spot) / spot < 2e-6, `q=${q} epochs=${epochs}: ${avg} vs ${spot}`);
  }
});

const MARGIN = 200;
const ans = (n: bigint, floor: bigint | null = null, q = Q_LIVE, epochs = 18) => sunriseAnswerPrice(LIVE, q, n, epochs, MARGIN, floor);

t("answer price: the margin applies to the order cost and rounds up", () => {
  for (const tokens of [1, 777, 10_000, 50_000, 420_000]) {
    const n = TOKENS(tokens);
    const cost = sunriseOrderCost(LIVE, Q_LIVE, n, 18);
    assert.equal(ans(n), (cost * 10200n + 9999n) / 10000n, `${tokens} tokens`);
    assert.ok(ans(n) > cost);
  }
  assert.equal(ans(0n), 0n);
});

t("answer price: a floor above the curve wins and carries the margin; a floor below changes nothing", () => {
  const n = TOKENS(50_000);
  const spot = sunriseCurve({ ...LIVE, q: Q_LIVE, epochsElapsed: 18, floor: 1n });
  const high = spot * 2n;
  assert.equal(ans(n, high), (high * 50_000n * 10200n + 9999n) / 10000n);
  assert.equal(ans(n, 1_000_000n), ans(n), "P0 is below the curve at the live state");
  assert.equal(ans(n, 0n), ans(n));
  assert.equal(ans(n, null), ans(n));
  assert.throws(() => sunriseAnswerPrice(LIVE, Q_LIVE, n, 18, -1, null), RangeError);
});

t("sunriseTokensFor inverts the answer price", () => {
  const room = E - Q_LIVE;
  const floors = [null, 1_000_000n, 1_200_000n];
  let checked = 0;
  for (const floor of floors) {
    for (const n of [1n, 99n, U, TOKENS(10), TOKENS(10_000), TOKENS(50_000), TOKENS(420_000), room - 1n]) {
      const price = ans(n, floor);
      const got = sunriseTokensFor(LIVE, Q_LIVE, price, 18, MARGIN, floor, room);
      assert.ok(got >= n, `floor ${floor} n=${n}: budget ${price} bought only ${got}`);
      assert.ok(ans(got, floor) <= price);
      assert.ok(got === room || ans(got + 1n, floor) > price, `floor ${floor} n=${n}: ${got} is not the largest`);
      const short = sunriseTokensFor(LIVE, Q_LIVE, price - 1n, 18, MARGIN, floor, room);
      assert.ok(short < n || ans(short, floor) <= price - 1n);
      assert.ok(short === room || ans(short + 1n, floor) > price - 1n);
      checked++;
    }
  }
  assert.equal(checked, floors.length * 8);
});

t("sunriseTokensFor: room, an empty budget and a zero room", () => {
  const room = TOKENS(1_000);
  assert.equal(sunriseTokensFor(LIVE, Q_LIVE, 10n ** 18n, 18, MARGIN, null, room), room);
  assert.equal(sunriseTokensFor(LIVE, Q_LIVE, ans(room), 18, MARGIN, null, room), room);
  assert.equal(sunriseTokensFor(LIVE, Q_LIVE, 0n, 18, MARGIN, null, room), 0n);
  assert.equal(sunriseTokensFor(LIVE, Q_LIVE, -1n, 18, MARGIN, null, room), 0n);
  assert.equal(sunriseTokensFor(LIVE, Q_LIVE, 10n ** 18n, 18, MARGIN, null, 0n), 0n);
});

t("honest path: a buyer who budgets exactly the quoted price for n gets n", () => {
  for (const tokens of [1, 10_000, 50_000, 100_000]) {
    const n = TOKENS(tokens);
    const price = ans(n, 1_000_000n);
    assert.equal(sunriseTokensFor(LIVE, Q_LIVE, price, 18, MARGIN, 1_000_000n, E - Q_LIVE) >= n, true);
  }
});

console.log(`mm-sunrise-price: ${pass} passed`);
