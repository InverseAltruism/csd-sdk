// Which addresses bought from a maker before. The maker and the site decide "returning buyer" with this one
// rule, so the site can tell a first-time wallet before it pays for a bid the maker will not answer. Not consensus.
import type { OfferState } from "../types.js";

const lower = (a: unknown): string => String(a ?? "").toLowerCase();

/** Lowercased buyers of every fill (partial fills included) of an offer sold by `maker`. A fill of another
 *  seller's offer does not count: it costs a sybil about 0.3 CSD, while a buy from the maker is a real purchase. */
export function priorBuyers(offers: Record<string, OfferState> | readonly OfferState[] | null | undefined, maker: string): Set<string> {
  const me = lower(maker);
  const out = new Set<string>();
  if (!me) return out;
  for (const o of Object.values(offers || {}) as (OfferState | null | undefined)[]) {
    if (!o || lower(o.seller) !== me) continue;
    const rows = o.fills?.length ? o.fills : (o.fill ? [o.fill] : []);
    for (const f of rows) if (f?.buyer) out.add(lower(f.buyer));
  }
  return out;
}
