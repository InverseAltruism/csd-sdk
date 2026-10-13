// What a Sunrise (RFQ) trade costs in total, from the bid or answer value alone. Fee math and
// constants come from the convention and codec; this file only sums them. Not consensus.
import { MIN_FEE_ATTEST, MIN_FEE_PROPOSE } from "@inversealtruism/csd-codec";
import { FEE_BPS_V16, makerRebate, tradeFee } from "../types.js";

/** What the taker pays to fill an answer worth n: the value, the treasury fee at `feeBps` (the offer's
 *  `feeBps`; FEE_BPS_V16 when absent), the maker fee and the fill attest. */
export function rfqFillAllIn(n: bigint, feeBps?: number | null): bigint {
  return n + tradeFee(n, feeBps ?? FEE_BPS_V16) + makerRebate(n) + BigInt(MIN_FEE_ATTEST);
}

/** The buyer's total for a bid at value n: rfqFillAllIn(n) plus the propose that anchors the bid. */
export function rfqBuyAllIn(n: bigint): bigint {
  return rfqFillAllIn(n) + BigInt(MIN_FEE_PROPOSE);
}
