// The row of each list: cairnx-core's state types, imported. The unbounded arrays (OfferState.fills, BidState.offers)
// are replaced by their counts, so a row's size is bounded by its type. A string union a rule change can grow (a
// status, a mint mode) is Open: a newer server may send a value this release does not name.
import type { AppliedEvent, BalanceState, BidState, BidStatus, NameState, OfferState, OfferStatus, ReasonCode, TokenState } from "@inversealtruism/cairnx-core";

/** A value of an open set: the known values, and any other string a newer server may send. */
export type Open<T extends string> = T | (string & Record<never, never>);

export type NameRow = NameState;
export type TokenRow = Omit<TokenState, "mint"> & { mint: Open<TokenState["mint"]> };
export type OfferRow = Omit<OfferState, "fills" | "status"> & {
  status: Open<OfferStatus>;
  /** The number of fills the resolver applied to the offer: the length of the core's `fills` on a partially fillable
   *  offer (which also sets `fill` to the completing entry), else 1 when the core's `fill` is set (a whole fill), else
   *  0. A filled offer never reads 0. */
  fillCount: number;
};
export type BidRow = Omit<BidState, "offers" | "status"> & {
  status: Open<BidStatus>;
  /** The number of offers anchored in response to the bid: offers whose record names this bid and that were created
   *  while the resolver held it; the length of the core's `offers`. */
  offerCount: number;
};
export type HolderRow = { address: string } & BalanceState;
/** One entry of the applied log, without its note text (which may change in any core release). */
export interface EventRow {
  txid: AppliedEvent["id"];
  height: AppliedEvent["height"];
  pos: AppliedEvent["pos"];
  kind: AppliedEvent["kind"];
  applied: AppliedEvent["ok"];
  /** The rule that decided the record; codes are added in any core release, so class an unknown one by `applied`.
   *  null for a log entry that carries no code. */
  code: Open<ReasonCode> | null;
}

/** The row type of each route. */
export interface RowOf {
  names: NameRow;
  bids: BidRow;
  tokens: TokenRow;
  events: EventRow;
  holders: HolderRow;
  offers: OfferRow;
}
