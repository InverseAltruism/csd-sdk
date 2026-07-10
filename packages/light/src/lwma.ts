// LWMA difficulty re-derivation — a faithful port of pow.rs `expected_bits_strict`. The light
// client re-derives every header's `bits` from the preceding window so a server cannot feed a
// low-difficulty fork (the header chain alone, with PoW + LWMA + max-chainwork, is the trust root).
import {
  type BlockHeader, bitsToTarget, targetToBigInt, bigIntToTarget, targetToBits,
  INITIAL_BITS, POW_LIMIT_BITS, LWMA_WINDOW, LWMA_SOLVETIME_MAX_FACTOR, TARGET_BLOCK_SECS,
} from "@inversealtruism/csd-codec";

// Memoized bits -> target as a BigInt. `targetToBigInt(bitsToTarget(bits))` is a pure function of
// the u32 `bits`, and LWMA windows slide one header at a time, so a linear sync/restore re-converts
// the SAME header's bits in up to LWMA_WINDOW consecutive windows (~45x each; measured ~85% of a
// LightClient.fromSnapshot restore). Every invalid compact encoding (exp 0, mant 0, sign bit,
// exp>32, overflow) decodes to the all-zero target, i.e. 0n — callers treat a 0n result as invalid,
// which is byte-identical to the old `tb.every(b => b === 0)` check. The map is capped: real chains
// add at most ~1 new bits value per block, but a hostile snapshot could feed arbitrary distinct
// values; clear-at-cap keeps it bounded, and the 45-header window locality restores a ~98% hit rate
// within one window even right after a clear. Values are cached BigInts (immutable), so a hit can
// never differ from a fresh computation (pinned by test/lwma-memo.test.ts against the raw codec).
const TARGET_MEMO_CAP = 4096;
const targetMemo = new Map<number, bigint>();
function bitsToTargetBigInt(bits: number): bigint {
  const hit = targetMemo.get(bits);
  if (hit !== undefined) return hit;
  const v = targetToBigInt(bitsToTarget(bits));
  if (targetMemo.size >= TARGET_MEMO_CAP) targetMemo.clear();
  targetMemo.set(bits, v);
  return v;
}

const POW_LIMIT_TARGET = bitsToTargetBigInt(POW_LIMIT_BITS);

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
    const tg = bitsToTargetBigInt(h.bits); // memoized; 0n === the all-zero (invalid) target
    if (tg === 0n) throw new Error("expectedBits: invalid compact bits in window");
    times.push(BigInt(h.time));
    targets.push(tg);
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
  if (bitsToTargetBigInt(bits) > POW_LIMIT_TARGET) return POW_LIMIT_BITS;
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
