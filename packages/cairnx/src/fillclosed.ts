// Whether a buyer's own merkle-proven fill closed the offer behind one of its fclaim holds. Past V29 the
// resolver counts only holds on open offers toward MAX_ACTIVE_CLAIMS, so a fill client that counts the buyer's
// other live holds may skip a hold this proves closed. Not consensus: nothing here is read by resolve().
import { SCORE_FILL, V29_HEIGHT, type OfferState } from "./types.js";
import { requiredFillOutputs } from "./preflight.js";
import { ptAmt } from "./resolve.js";
import { bindProvenOffer, type ProvenEvent } from "./verifyfill.js";

const lc = (v: unknown): string => String(v).toLowerCase();

/**
 * True only when `fill` proves `me`'s own fill CLOSED the offer behind `fclaim` before `grantHeight`, so a
 * resolver at a grant height >= V29_HEIGHT no longer counts that hold. `fill` and `offerEv` must be
 * merkle-proven and prevout-bound by the caller. The fill must be a SCORE_FILL by `me` on exactly this fclaim,
 * mined strictly after the fclaim and strictly before the grant, and carry every output of a FULL fill of the
 * proven offer (want.value to payto, the fee, the maker rebate), read as the resolver reads them (ptAmt).
 * A partial-lane offer closed by a remainder fill stays counted: the remainder depends on the served `paid`.
 */
export function myProvenFillClosedOffer(
  fill: ProvenEvent | null, fclaim: { id: string; height: number; offer: string },
  offerEv: ProvenEvent | null, me: string, grantHeight: number,
): boolean {
  if (!(grantHeight >= V29_HEIGHT)) return false;
  if (!fill || fill.kind !== "attest" || fill.score !== SCORE_FILL) return false;
  if (lc(fill.attester) !== lc(me) || lc(fill.proposalId) !== lc(fclaim.id)) return false;
  if (!(fill.height > fclaim.height && fill.height < grantHeight)) return false;
  if (!offerEv || offerEv.kind !== "propose" || lc(offerEv.id) !== lc(fclaim.offer)) return false;
  const bound = bindProvenOffer(offerEv);
  const value = bound?.terms.value;
  if (!bound || value === undefined) return false;   // a token-priced want carries no value
  const t = bound.terms;
  const state: OfferState = {
    id: lc(offerEv.id), seller: bound.seller,
    give: t.giveName !== undefined ? { name: t.giveName } : { ticker: String(t.giveTicker ?? ""), amount: String(t.giveAmount ?? "") },
    want: { value, payto: bound.payto },
    status: "open", expiresEpoch: offerEv.expiresEpoch, height: t.height, feeBps: t.feeBps,
    taker: t.taker, bid: t.bid, min: t.min, paid: "0", delivered: "0",
  };
  let need: { to: string; value: bigint }[] | null;
  try { need = requiredFillOutputs(state, BigInt(value)); } catch { return false; }   // malformed proven value: not proven closed
  if (!need) return false;
  return need.every((leg) => ptAmt(fill.paidTo?.[lc(leg.to)]) >= leg.value);
}
