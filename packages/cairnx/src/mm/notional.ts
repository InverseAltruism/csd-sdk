// Contractual CSD notional of a fill, for volume display. Not consensus: resolve() keeps
// fill.paid as the payto sum.
//
// Whole fill: want.value. Partial: capped x already stored in entry.paid.
// Rebate, change and protocol fee are not volume.

type Amount = bigint | number | string | null | undefined;
interface FillAmounts { paid?: Amount; fee?: Amount }
/** The fields read from an offer row (a resolver OfferState fits). */
export interface NotionalOffer {
  seller?: string;
  want?: { value?: Amount; payto?: string };
  fill?: FillAmounts | null;
}
export interface TradeNotional { notional: bigint; rebate: bigint; change: bigint; fee: bigint; extra: bigint; paidObserved: bigint }

/**
 * Contractual CSD of one fill row.
 * `opts.rebate(want)` is optional; when payto===seller the extra above want
 * is split into rebate vs change. Without it, extra stays lumped in `change`.
 */
export function tradeNotional(
  offer: NotionalOffer | null | undefined,
  entry?: FillAmounts | null,
  opts?: { rebate?: (want: bigint) => bigint | number | string } | null,
): TradeNotional {
  const wantRaw = offer?.want && "value" in offer.want ? offer.want.value : 0;
  let want = 0n, paidObserved = 0n, fee = 0n;
  try { want = BigInt(wantRaw ?? 0); } catch { want = 0n; }
  const src: FillAmounts = entry || offer?.fill || {};
  try { paidObserved = BigInt(src.paid ?? 0); } catch { paidObserved = 0n; }
  try { fee = BigInt(src.fee ?? 0); } catch { fee = 0n; }
  if (want < 0n) want = 0n;
  if (paidObserved < 0n) paidObserved = 0n;
  if (fee < 0n) fee = 0n;
  const notional = want > 0n && paidObserved > want ? want : paidObserved;
  const extra = paidObserved > notional ? paidObserved - notional : 0n;
  let rebate = 0n;
  if (extra > 0n && typeof opts?.rebate === "function") {
    const payto = String(offer?.want?.payto || "").toLowerCase();
    const seller = String(offer?.seller || "").toLowerCase();
    if (payto && payto === seller) {
      try { rebate = BigInt(opts.rebate(want)); } catch { rebate = 0n; }
      if (rebate < 0n) rebate = 0n;
      if (rebate > extra) rebate = extra;
    }
  }
  const change = extra > rebate ? extra - rebate : 0n;
  return { notional, rebate, change, fee, extra, paidObserved };
}
