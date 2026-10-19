// Checks a service runs before a non-primary RPC backend may win routing on a claimed tip. Both are pure; the
// caller does the I/O (fetching the contender's tip header, reading its own local anchor) and decides what a
// failed read means.
import {
  type BlockHeader, headerHashBytes, hx, powOk, bitsToTarget, targetToBigInt, POW_LIMIT_BITS, TARGET_BLOCK_SECS,
} from "@inversealtruism/csd-codec";

const TIP_HASH = /^0x[0-9a-fA-F]{64}$/;
/** A finite positive x floored and raised to `min`; anything else (NaN, ±Infinity, 0, negative) is `dflt`. */
const opt = (x: unknown, dflt: number, min: number): number => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.floor(n)) : dflt;
};

/**
 * True only when `header` hashes to `claimedTipHash` and meets the PoW of its own `bits`. Any malformed input
 * (no header, non-numeric bits, a claimed hash that is not 32 bytes of 0x-hex) is false.
 */
export function tipHeaderPowOk(header: unknown, claimedTipHash: string | null): boolean {
  try {
    const h = header as Partial<BlockHeader> | null | undefined;
    if (!h || typeof h !== "object") return false;
    if (typeof h.bits !== "number" || !Number.isFinite(h.bits)) return false;
    if (typeof h.prev !== "string" || typeof h.merkle !== "string") return false;
    if (typeof claimedTipHash !== "string" || !TIP_HASH.test(claimedTipHash)) return false;
    const bh: BlockHeader = { version: Number(h.version ?? 0), prev: h.prev, merkle: h.merkle, time: h.time ?? 0, bits: h.bits, nonce: Number(h.nonce ?? 0) };
    const hashBytes = headerHashBytes(bh);
    if (hx(hashBytes) !== claimedTipHash.toLowerCase()) return false;
    return powOk(hashBytes, bh.bits);
  } catch {
    return false; // a header the codec cannot serialize is not a valid winner
  }
}

export interface ContenderPlausibleOpts {
  /** false is the operator's kill switch: every contender passes. */
  enabled: boolean;
  claimedHeight: number;
  /** The `bits` of the contender's tip header. */
  contenderBits: number;
  /** The caller's own finality-gated tip height, not the live primary's. */
  localHeight: number;
  /** Lowest local height that counts as an anchor (an index that starts above genesis passes its start). */
  anchorFloor?: number;
  /** Block time of the local tip, unix seconds. */
  localTime: number;
  nowSecs: number;
  /** Chain block spacing in seconds. */
  blockSecs: number;
  /** expectedBitsFromWindow over the local LWMA window, or null when the caller could not derive it. */
  expectedLocalBits: number | null;
  /** Blocks a contender may claim past the local tip, before the staleness allowance. */
  maxAhead: number;
  /** How many times easier than the expected local target the contender's target may be. */
  maxEase: number;
}

/**
 * Whether a contender whose tip header already passed tipHeaderPowOk is plausible against the caller's own chain:
 * its claimed height within maxAhead (plus the blocks wall-clock time allows since the local tip) of the local tip,
 * and its target no easier than the expected local target times maxEase. No anchor (local tip below anchorFloor)
 * passes, so failover works before the local index exists; an unparseable claim or invalid bits fails.
 *
 * Config contract (a non-finite, zero or negative value always becomes the default):
 * - blockSecs: finite > 0, floored, at least 1; otherwise TARGET_BLOCK_SECS (120).
 * - maxAhead: finite > 0, floored; otherwise 0 (no blocks past the local tip beyond the staleness allowance).
 * - maxEase: finite > 0, floored, at least 1; otherwise 1 (no easier than the expected local target).
 * - anchorFloor: finite > 0, compared as given (not floored, so 10.5 makes 11 the first anchor); otherwise 0.
 * - localTime, nowSecs: either non-finite grants no staleness allowance. localHeight non-finite: no anchor (passes).
 * - claimedHeight or contenderBits non-finite, or bits that decode to no target: fails.
 * - expectedLocalBits null or decoding to no target: the LWMA test is skipped, the delta cap still applies.
 */
export function contenderPlausible(opts: ContenderPlausibleOpts): boolean {
  if (!opts.enabled) return true;
  const lh = Number(opts.localHeight);
  const af = Number(opts.anchorFloor ?? 0);
  if (!Number.isFinite(lh) || lh < (Number.isFinite(af) && af > 0 ? af : 0)) return true;
  const claimed = Number(opts.claimedHeight);
  if (!Number.isFinite(claimed)) return false;
  // A reachable but frozen primary stalls the local anchor while an honest secondary keeps advancing, so the
  // cap grows by the blocks that wall-clock time allows since the local tip.
  const bs = opt(opts.blockSecs, TARGET_BLOCK_SECS, 1);
  const staleBlocks = Number.isFinite(opts.localTime) && Number.isFinite(opts.nowSecs)
    ? Math.max(0, Math.floor((Number(opts.nowSecs) - Number(opts.localTime)) / bs)) : 0;
  if (claimed > lh + opt(opts.maxAhead, 0, 0) + staleBlocks) return false;
  const cbits = Number(opts.contenderBits);
  if (!Number.isFinite(cbits)) return false;
  const contenderTarget = targetToBigInt(bitsToTarget(cbits));
  if (contenderTarget <= 0n) return false;
  if (opts.expectedLocalBits == null) return true;
  const expected = targetToBigInt(bitsToTarget(Number(opts.expectedLocalBits)));
  if (expected <= 0n) return true; // the caller's own anchor is anomalous: the delta cap above still applied
  let threshold = expected * BigInt(opt(opts.maxEase, 1, 1));
  const powLimitTarget = targetToBigInt(bitsToTarget(POW_LIMIT_BITS));
  if (threshold > powLimitTarget) threshold = powLimitTarget;
  return contenderTarget <= threshold;
}
