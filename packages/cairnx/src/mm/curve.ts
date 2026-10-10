// Sunrise spot curve: P0 * (1+r)^epochs * e^{k q/E}, integer only. Not consensus.
import type { BigIntish } from "./size.js";

/** The Sunrise curve's fixed parameters (all BigInt()-ed). */
export interface SunriseCurveParams { p0: BigIntish; rateBps: BigIntish; kScaled: BigIntish; E: BigIntish; capMult: BigIntish }

/** The largest exponent the spot curve evaluates (2.2 at scale 1e6); above it expScaled clamps, so a curve
 *  whose k exceeds it would quote a spot price that disagrees with its own order cost. */
export const MAX_EXP_ARG_SCALED = 2_200_000n;

/** e^x at scale 1e6. 12+ Taylor terms; |x| is clamped to MAX_EXP_ARG_SCALED so the series stays honest. */
export function expScaled(xScaled: BigIntish): bigint {
  const S = 1_000_000n;
  xScaled = BigInt(xScaled);
  if (xScaled === 0n) return S;
  if (xScaled < 0n) {
    const p = expScaled(-xScaled);
    return p === 0n ? 0n : (S * S) / p;
  }
  if (xScaled > MAX_EXP_ARG_SCALED) xScaled = MAX_EXP_ARG_SCALED;
  const S2 = 1_000_000_000_000n;
  const x = xScaled * 1_000_000n;
  let sum = S2;
  let term = S2;
  for (let n = 1n; n <= 20n; n++) {
    term = (term * x) / (n * S2);
    sum += term;
    if (term === 0n) break;
  }
  return sum / 1_000_000n;
}

/** (1 + rateBps/10000)^epochs at scale 1e12, flooring each step; epochs is clamped to [0, 20000]. */
export function sunriseTimeMult(rateBps: BigIntish, epochsElapsed: BigIntish): bigint {
  let timeMult = 1_000_000_000_000n;
  const r = BigInt(rateBps);
  const n = Math.min(Math.max(Number(epochsElapsed) || 0, 0), 20000);
  for (let i = 0; i < n; i++) timeMult = (timeMult * (10000n + r)) / 10000n;
  return timeMult;
}

/** Sunrise floor: P0 · (1+r)^epochs · e^{k q/E}, clamped to [floor, P0·capMult]. Integer-only. */
export function sunriseCurve({ p0, rateBps, kScaled, E, q, epochsElapsed, capMult, floor = null }: SunriseCurveParams & {
  q: BigIntish; epochsElapsed: BigIntish; floor?: BigIntish | null;
}): bigint {
  const S1 = 1_000_000n;
  const S2 = 1_000_000_000_000n;
  p0 = BigInt(p0);
  E = BigInt(E);
  q = BigInt(q);
  kScaled = BigInt(kScaled);
  capMult = BigInt(capMult);
  const timeMult = sunriseTimeMult(rateBps, epochsElapsed);
  const qClamped = q < 0n ? 0n : (E > 0n && q > E ? E : q);
  const x = E > 0n ? (kScaled * qClamped) / E : 0n;
  const invMult = expScaled(x);
  let price = (p0 * timeMult * invMult) / (S2 * S1);
  const cap = p0 * capMult;
  if (price > cap) price = cap;
  if (floor != null && price < BigInt(floor)) price = BigInt(floor);
  return price;
}
