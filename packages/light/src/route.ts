// Checks a service runs before a non-primary RPC backend may win routing on a claimed tip. Both are pure; the
// caller does the I/O (fetching the contender's tip header, reading its own local anchor) and decides what a
// failed read means.
import {
  type BlockHeader, headerHashBytes, hx, powOk, bitsToTarget, targetToBigInt, POW_LIMIT_BITS, TARGET_BLOCK_SECS,
} from "@inversealtruism/csd-codec";

const TIP_HASH = /^0x[0-9a-fA-F]{64}$/;
/** floor(x) clamped to at least `min`; a non-numeric x reads as `min`. */
const atLeast = (x: number, min: number): number => (Number.isFinite(x) ? Math.max(min, Math.floor(x)) : min);

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
  /** Lowest local height that counts as an anchor (an index that starts above genesis passes its start). Default 0. */
  anchorFloor?: number;
  /** Block time of the local tip, unix seconds. */
  localTime: number;
  nowSecs: number;
  /** Chain block spacing in seconds; 0 or non-numeric falls back to TARGET_BLOCK_SECS. */
  blockSecs: number;
  /** expectedBitsFromWindow over the local LWMA window, or null when the caller could not derive it. */
  expectedLocalBits: number | null;
  /** Blocks a contender may claim past the local tip, before the staleness allowance; non-numeric reads as 0. */
  maxAhead: number;
  /** How many times easier than the expected local target the contender's target may be; non-numeric reads as 1. */
  maxEase: number;
}

/**
 * Whether a contender whose tip header already passed tipHeaderPowOk is plausible against the caller's own chain:
 * its claimed height within maxAhead (plus the blocks wall-clock time allows since the local tip) of the local tip,
 * and its target no easier than the expected local target times maxEase. No anchor (local tip below anchorFloor)
 * passes, so failover works before the local index exists; an unparseable claim or invalid bits fails.
 */
export function contenderPlausible(opts: ContenderPlausibleOpts): boolean {
  if (!opts.enabled) return true;
  const lh = Number(opts.localHeight);
  if (!Number.isFinite(lh) || lh < atLeast(Number(opts.anchorFloor ?? 0), 0)) return true;
  const claimed = Number(opts.claimedHeight);
  if (!Number.isFinite(claimed)) return false;
  // A reachable but frozen primary stalls the local anchor while an honest secondary keeps advancing, so the
  // cap grows by the blocks that wall-clock time allows since the local tip.
  const bs = atLeast(Number(opts.blockSecs) || TARGET_BLOCK_SECS, 1);
  const staleBlocks = Number.isFinite(opts.localTime) && Number.isFinite(opts.nowSecs)
    ? Math.max(0, Math.floor((Number(opts.nowSecs) - Number(opts.localTime)) / bs)) : 0;
  if (claimed > lh + atLeast(Number(opts.maxAhead), 0) + staleBlocks) return false;
  const cbits = Number(opts.contenderBits);
  if (!Number.isFinite(cbits)) return false;
  const contenderTarget = targetToBigInt(bitsToTarget(cbits));
  if (contenderTarget <= 0n) return false;
  if (opts.expectedLocalBits == null) return true;
  const expected = targetToBigInt(bitsToTarget(Number(opts.expectedLocalBits)));
  if (expected <= 0n) return true; // the caller's own anchor is anomalous: the delta cap above still applied
  let threshold = expected * BigInt(atLeast(Number(opts.maxEase), 1));
  const powLimitTarget = targetToBigInt(bitsToTarget(POW_LIMIT_BITS));
  if (threshold > powLimitTarget) threshold = powLimitTarget;
  return contenderTarget <= threshold;
}
