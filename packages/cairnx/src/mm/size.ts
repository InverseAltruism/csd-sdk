// Shared BigInt RFQ sizer: the maker's accept check and the site's "tokens for this CSD" use the
// same integers. Not consensus: nothing here is read by resolve().
//
// A float toFixed sizer and an integer floor sizer disagreed by 1-2 base units, so half of
// one-field bids landed under the accept threshold and were silently skipped.

/** Anything BigInt() accepts on the wire: base-unit strings, numbers, bigints. */
export type BigIntish = bigint | number | string;
/** One indicative ladder rung as published (size in whole tokens, price per whole token in base CSD). */
export interface LevelIn { bps?: number | string; size: BigIntish; pricePerUnit: BigIntish }
interface Level { bps: number; size: bigint; pricePerUnit: bigint }
export interface Tier { bps: number; size: string; pricePerUnit: string }
export type SizeBidResult =
  | { ok: true; tokBase: string; pricePerUnit: string; bidUnit: string; tier: Tier }
  | { ok: false; skip: string };
export type AcceptBidResult =
  | { ok: true; tier: Tier; bidUnit: string; needUnit: string }
  | { ok: false; skip: string; bidUnit?: string; needUnit?: string; tier?: Tier };

function asLevels(levels: readonly LevelIn[] | null | undefined): Level[] {
  const out: Level[] = [];
  for (const l of levels || []) {
    const size = BigInt(l.size);
    const pricePerUnit = BigInt(l.pricePerUnit);
    if (size <= 0n || pricePerUnit <= 0n) continue;
    out.push({ bps: Number(l.bps || 0), size, pricePerUnit });
  }
  return out;
}

function packTier(l: Level): Tier {
  return { bps: l.bps, size: l.size.toString(), pricePerUnit: l.pricePerUnit.toString() };
}

/** Cheapest (first) indicative tier whose size covers tokBase, or null if above the top rung. */
export function tierFor(levels: readonly LevelIn[] | null | undefined, tokBase: BigIntish, unit: BigIntish): Tier | null {
  tokBase = BigInt(tokBase);
  unit = BigInt(unit);
  if (tokBase <= 0n || unit <= 0n) return null;
  for (const l of asLevels(levels)) {
    if (l.size * unit >= tokBase) return packTier(l);
  }
  return null;
}

/**
 * Size a CSD spend across the indicative ladder.
 * tok = floor(csdBase * 10^decimals / price_k); first tier with tok ≤ size_k wins.
 * → { ok, tokBase, pricePerUnit, bidUnit, tier } | { ok:false, skip }
 */
export function sizeBid({ csdBase, decimals, levels, minBidCsd, inventoryBase }: {
  csdBase: BigIntish; decimals: number | string; levels: readonly LevelIn[] | null | undefined;
  minBidCsd?: BigIntish | null; inventoryBase?: BigIntish | null;
}): SizeBidResult {
  try { csdBase = BigInt(csdBase); } catch { return { ok: false, skip: "zero" }; }
  if (csdBase <= 0n) return { ok: false, skip: "zero" };
  if (minBidCsd != null && minBidCsd !== "" && csdBase < BigInt(minBidCsd)) return { ok: false, skip: "below-min-bid" };
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) return { ok: false, skip: "zero" };
  const unit = 10n ** BigInt(dec);
  const lvls = asLevels(levels);
  if (!lvls.length) return { ok: false, skip: "above-top-tier" };
  const exact: { tok: bigint; l: Level }[] = [];
  const overflow: { tok: bigint; l: Level }[] = [];
  for (const l of lvls) {
    const cap = l.size * unit;
    const tok = (csdBase * unit) / l.pricePerUnit;
    if (tok <= 0n) return { ok: false, skip: "zero" };
    if (tok <= cap) exact.push({ tok, l });
    else if ((csdBase * unit) / cap >= l.pricePerUnit) overflow.push({ tok: cap, l });
  }
  // Prefer the most tokens. Overflow of a cheaper rung beats an exact fit on a
  // steeper one (20.21 CSD → 2000 @ +1%, not 1616 @ +25%). If NOTHING exact-fits
  // (the spend buys more than the top rung even at the top price) refuse;
  // do not silently cap and overpay.
  if (!exact.length) return { ok: false, skip: "above-top-tier" };
  let best = exact[0]!;
  for (const c of exact.concat(overflow)) if (c.tok > best.tok) best = c;
  if (inventoryBase != null && inventoryBase !== "" && best.tok > BigInt(inventoryBase)) return { ok: false, skip: "no-inventory" };
  const bidUnit = (csdBase * unit) / best.tok;
  return { ok: true, tokBase: best.tok.toString(), pricePerUnit: best.l.pricePerUnit.toString(), bidUnit: bidUnit.toString(), tier: packTier(best.l) };
}

/**
 * Bot-side accept of an already-posted bid (csdBase paid, tokBase wanted).
 * Enforces floor+margin, the size-tier price, inventory, and a 2-epoch expiry floor.
 */
export function acceptBid({ csdBase, tokBase, levels, ref, marginBps, have, remainingEpochs, unit }: {
  csdBase: BigIntish; tokBase: BigIntish; levels: readonly LevelIn[] | null | undefined; ref: BigIntish;
  marginBps: BigIntish; have?: BigIntish | null; remainingEpochs?: number | null; unit: BigIntish;
}): AcceptBidResult {
  try {
    csdBase = BigInt(csdBase);
    tokBase = BigInt(tokBase);
    unit = BigInt(unit);
    ref = BigInt(ref);
    marginBps = BigInt(marginBps);
  } catch { return { ok: false, skip: "zero" }; }
  if (tokBase <= 0n || csdBase <= 0n || unit <= 0n) return { ok: false, skip: "zero" };
  if (remainingEpochs != null && Number(remainingEpochs) < 2) return { ok: false, skip: "expiring" };
  if (have != null && have !== "" && tokBase > BigInt(have)) return { ok: false, skip: "no-inventory" };
  const bidUnit = (csdBase * unit) / tokBase;
  const floorAccept = ref + (ref * marginBps) / 10000n;
  if (bidUnit < floorAccept) return { ok: false, skip: "below-margin", bidUnit: bidUnit.toString(), needUnit: floorAccept.toString() };
  const tier = tierFor(levels, tokBase, unit);
  if (!tier) return { ok: false, skip: "above-top-tier", bidUnit: bidUnit.toString() };
  const tierPrice = BigInt(tier.pricePerUnit);
  const needUnit = tierPrice > floorAccept ? tierPrice : floorAccept;
  if (bidUnit < needUnit) return { ok: false, skip: "below-tier", bidUnit: bidUnit.toString(), needUnit: needUnit.toString(), tier };
  return { ok: true, tier, bidUnit: bidUnit.toString(), needUnit: needUnit.toString() };
}
