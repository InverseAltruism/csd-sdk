// LWMA difficulty re-derivation — a faithful port of pow.rs `expected_bits_strict`. The light
// client re-derives every header's `bits` from the preceding window so a server cannot feed a
// low-difficulty fork (the header chain alone, with PoW + LWMA + max-chainwork, is the trust root).
import {
  type BlockHeader, bitsToTarget, targetToBigInt, bigIntToTarget, targetToBits,
  INITIAL_BITS, POW_LIMIT_BITS, LWMA_WINDOW, LWMA_SOLVETIME_MAX_FACTOR, TARGET_BLOCK_SECS,
} from "@inversealtruism/csd-codec";

const POW_LIMIT_TARGET = targetToBigInt(bitsToTarget(POW_LIMIT_BITS));

/**
 * Expected `bits` for the block at `height`, given the CHRONOLOGICAL window of the (up to
 * LWMA_WINDOW) headers immediately preceding it — `window[last]` is the parent (height-1).
 * This is the core; works for any height with only a 45-header window (cheap spot-checks /
 * checkpoint-start, no full chain needed). Mirrors expected_bits_strict exactly.
 */
export function expectedBitsFromWindow(window: BlockHeader[], height: number): number {
  if (height === 0) return INITIAL_BITS;
  const parent = window[window.length - 1];
  if (!parent) throw new Error(`expectedBits: empty window for height ${height}`);
  if (height < 2) return parent.bits;

  // n = min(LWMA_WINDOW, height); take the last n of the supplied window (chronological).
  const n = Math.min(LWMA_WINDOW, height, window.length);
  if (n < 2) return parent.bits;
  const w = window.slice(window.length - n); // chronological, length n, last = parent

  const times: bigint[] = [];
  const targets: bigint[] = [];
  for (const h of w) {
    const tb = bitsToTarget(h.bits);
    if (tb.every((b) => b === 0)) throw new Error("expectedBits: invalid compact bits in window");
    times.push(BigInt(h.time));
    targets.push(targetToBigInt(tb));
  }
  if (times.length < 2) return parent.bits;
  const m = times.length;

  const t = BigInt(Math.max(TARGET_BLOCK_SECS, 1));
  const maxSolve = BigInt(Math.max(LWMA_SOLVETIME_MAX_FACTOR, 1) * Math.max(TARGET_BLOCK_SECS, 1));

  let weightedSum = 0n, denom = 0n;
  for (let i = 1; i < m; i++) {
    let dt = times[i]! - times[i - 1]!;
    if (dt < 0n) dt = 0n; // saturating_sub
    const st = dt < 1n ? 1n : dt > maxSolve ? maxSolve : dt; // clamp(1, maxSolve)
    const ww = BigInt(i);
    weightedSum += st * ww;
    denom += ww;
  }
  if (denom === 0n) return parent.bits;

  const avgSolvetime = weightedSum / denom; // integer division
  let sumTarget = 0n;
  for (const tg of targets) sumTarget += tg;
  const avgTarget = sumTarget / BigInt(m);

  let nextTarget = (avgTarget * avgSolvetime) / t;
  if (nextTarget > POW_LIMIT_TARGET) nextTarget = POW_LIMIT_TARGET;
  if (nextTarget === 0n || nextTarget >= 1n << 256n) return POW_LIMIT_BITS;

  const bits = targetToBits(bigIntToTarget(nextTarget));
  if (targetToBigInt(bitsToTarget(bits)) > POW_LIMIT_TARGET) return POW_LIMIT_BITS;
  return bits;
}

/**
 * Expected `bits` for the block at `height`, given the canonical chain `headers[0..=parent]`
 * (index = height). Convenience wrapper over expectedBitsFromWindow.
 */
export function expectedBits(headers: BlockHeader[], height: number): number {
  if (height === 0) return INITIAL_BITS;
  const n = Math.min(LWMA_WINDOW, height);
  const window = headers.slice(height - n, height);
  return expectedBitsFromWindow(window, height);
}
