// Sunrise order pricing: an order of n tokens costs the integral of the spot curve from q to q+n,
// times a flat margin. Integer only; not consensus.
//
// Units: prices are CSD base units per whole token; q, n and E are token base units; one whole
// token is U = 10^decimals base units. The spot price is min(C, A * e^{k x / E}) with
// A = P0 * timeMult(epochs), k = kScaled / 1e6 and C = P0 * capMult. It is flat past x = E, the
// way sunriseCurve clamps q.
//
// Cost is ceil((V(q+n) - V(q)) / D) for one integer-valued antiderivative V and a fixed D, so
// two orders cost at least as much as the one order that spans them (test/mm-sunrise-price.test.ts).
import { sunriseTimeMult, type SunriseCurveParams } from "./curve.js";
import type { BigIntish } from "./size.js";

/** The curve parameters plus the token's decimals (default 8). */
export interface SunriseOrderParams extends SunriseCurveParams { decimals?: number }

const FIX = 10n ** 18n;
const FIX30 = 10n ** 30n;
const TIME_SCALE = 10n ** 12n;
const MAX_K_SCALED = 10_000_000n;
const MAX_EXPM1_ARG = 20n * FIX;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** e^z - 1 at scale 1e18 for 0 <= z <= 20e18. Summed from the series directly, so small z keeps every digit. */
export function expm1Scaled(z: bigint): bigint {
  if (z < 0n || z > MAX_EXPM1_ARG) throw new RangeError("expm1Scaled: z outside [0, 20e18]");
  let sum = 0n;
  let term = FIX;
  for (let i = 1n; ; i++) {
    term = (term * z) / (i * FIX);
    if (term === 0n) return sum;
    sum += term;
  }
}

function checkedParams(params: SunriseOrderParams) {
  const p0 = BigInt(params.p0);
  const kScaled = BigInt(params.kScaled);
  const E = BigInt(params.E);
  const capMult = BigInt(params.capMult);
  const decimals = params.decimals ?? 8;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("sunrise: decimals must be an integer in [0, 18]");
  if (p0 < 0n || capMult < 0n || E < 0n) throw new RangeError("sunrise: p0, capMult and E must be non-negative");
  if (kScaled < 0n || kScaled > MAX_K_SCALED) throw new RangeError("sunrise: kScaled must be in [0, 10_000_000]");
  return { p0, kScaled, E, capMult, rateBps: params.rateBps, U: 10n ** BigInt(decimals) };
}

/** Cost in base units of n token base units starting at q, before margin. Rounds up. */
function costFn(params: SunriseOrderParams, q: BigIntish, epochsElapsed: BigIntish): (n: bigint) => bigint {
  const { p0, kScaled, E, capMult, rateBps, U } = checkedParams(params);
  const aNum = p0 * sunriseTimeMult(rateBps, epochsElapsed);
  const capNum = p0 * capMult * TIME_SCALE;
  let lo = BigInt(q);
  if (lo < 0n) lo = 0n;

  if (kScaled === 0n || E === 0n) {
    const flat = aNum < capNum ? aNum : capNum;
    return (n) => (n <= 0n ? 0n : ceilDiv(flat * n, TIME_SCALE * U));
  }

  const g = (y: bigint): bigint => expm1Scaled((kScaled * y * TIME_SCALE) / E);
  const priceNum = (y: bigint): bigint => aNum * (FIX + g(y));
  const capNum30 = capNum * FIX;

  // s is where the flat part starts: the first x at which the curve reaches the cap, else E.
  let s = E;
  let flatNum = priceNum(E);
  if (flatNum >= capNum30) {
    flatNum = capNum30;
    let a = 0n;
    let b = E;
    while (a < b) {
      const mid = (a + b) / 2n;
      if (priceNum(mid) >= capNum30) b = mid; else a = mid + 1n;
    }
    s = a;
  }

  const curveScale = aNum * E * 1_000_000n;
  const flatScale = flatNum * kScaled;
  const antiderivative = (x: bigint): bigint => (x <= s
    ? curveScale * g(x)
    : curveScale * g(s) + flatScale * (x - s));
  const base = antiderivative(lo);
  const denom = kScaled * U * FIX30;
  return (n) => {
    if (n <= 0n) return 0n;
    const d = antiderivative(lo + n) - base;
    return d <= 0n ? 0n : ceilDiv(d, denom);
  };
}

/** Price an answer from its curve cost, the margin, and a per-whole-token floor that bounds the price from below. */
function answerFn(params: SunriseOrderParams, q: BigIntish, epochsElapsed: BigIntish, marginBps: BigIntish, floorPerToken: BigIntish | null | undefined): (n: bigint) => bigint {
  const { U } = checkedParams(params);
  const margin = BigInt(marginBps);
  if (margin < 0n) throw new RangeError("sunrise: marginBps must be non-negative");
  const floor = floorPerToken == null ? 0n : BigInt(floorPerToken);
  if (floor < 0n) throw new RangeError("sunrise: floorPerToken must be non-negative");
  const cost = costFn(params, q, epochsElapsed);
  const mult = 10000n + margin;
  return (n) => {
    if (n <= 0n) return 0n;
    const fromCurve = ceilDiv(cost(n) * mult, 10000n);
    const fromFloor = ceilDiv(floor * n * mult, U * 10000n);
    return fromCurve > fromFloor ? fromCurve : fromFloor;
  };
}

/** Integral of the spot curve over [q, q+n], in CSD base units, rounded up. */
export function sunriseOrderCost(params: SunriseOrderParams, q: BigIntish, n: BigIntish, epochsElapsed: BigIntish): bigint {
  return costFn(params, q, epochsElapsed)(BigInt(n));
}

/** What the maker asks for n tokens: max(order cost, floor cost) times (1 + margin), rounded up. */
export function sunriseAnswerPrice(params: SunriseOrderParams, q: BigIntish, n: BigIntish, epochsElapsed: BigIntish, marginBps: BigIntish, floorPerToken: BigIntish | null | undefined): bigint {
  return answerFn(params, q, epochsElapsed, marginBps, floorPerToken)(BigInt(n));
}

/** The largest n in [0, room] whose answer price is <= budget (the inverse of sunriseAnswerPrice). */
export function sunriseTokensFor(params: SunriseOrderParams, q: BigIntish, budget: BigIntish, epochsElapsed: BigIntish, marginBps: BigIntish, floorPerToken: BigIntish | null | undefined, room: BigIntish): bigint {
  const price = answerFn(params, q, epochsElapsed, marginBps, floorPerToken);
  const cap = BigInt(budget);
  let lo = 0n;
  let hi = BigInt(room);
  if (cap < 0n || hi <= 0n) return 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (price(mid) <= cap) lo = mid; else hi = mid - 1n;
  }
  return lo;
}
