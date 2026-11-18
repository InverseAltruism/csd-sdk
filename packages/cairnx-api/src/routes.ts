// The six v1 lists and the closed parameter table of each. A parameter outside a route's table is refused, never
// ignored: that is what lets a later release add one, since an older server answers 400 to it, never a wrong page.
import { ADDR_RE, HASH_RE, NAME_RE, TICKER_RE, type BidStatus, type OfferStatus } from "@inversealtruism/cairnx-core";
import { CURSORS } from "./cursor.js";
import { deepFreeze } from "./freeze.js";

export const ROUTES = Object.freeze(["names", "bids", "tokens", "events", "holders", "offers"] as const);
export type Route = (typeof ROUTES)[number];
export const isRoute = (s: string): s is Route => (ROUTES as readonly string[]).includes(s);

/** `status` on names: `held` has neither flag, `pending` is a reservation, `lapsed` has `expired` set. */
export const NAME_STATUSES = Object.freeze(["held", "pending", "lapsed"] as const);
export const OFFER_STATUSES = Object.freeze(["open", "filled", "cancelled", "expired"] as const satisfies readonly OfferStatus[]);
export const BID_STATUSES = Object.freeze(["open", "cancelled", "expired", "done"] as const satisfies readonly BidStatus[]);
/** `kind` on offers: what the offer gives. */
export const OFFER_KINDS = Object.freeze(["name", "token"] as const);
export type NameStatus = (typeof NAME_STATUSES)[number];
export type OfferKind = (typeof OFFER_KINDS)[number];

// The two status lists cover cairnx-core's unions exactly: a status the core adds fails this compile.
type Covers<U, T extends readonly unknown[]> = [U] extends [T[number]] ? true : false;
type Holds<T extends true> = T;
type StatusListsCoverCore = Holds<Covers<OfferStatus, typeof OFFER_STATUSES> | Covers<BidStatus, typeof BID_STATUSES>>;

/** A filter's value: a pattern, or one of a closed set. */
export type FilterSpec = { readonly re: RegExp } | { readonly values: readonly string[] };

/** The parsed filters of each route; an absent optional filter is null. */
export interface Filters {
  names: { owner: string | null; status: NameStatus | null };
  bids: { status: BidStatus | null };
  tokens: Record<string, never>;
  events: Record<string, never>;
  holders: { ticker: string };
  offers: { status: OfferStatus | null; kind: OfferKind | null };
}

interface RouteSpec<R extends Route> {
  /** The pattern of the list's primary key, which `keys` takes. */
  readonly key: RegExp;
  readonly limitMax: number;
  /** The list's orders and their cursor codecs; the first is the default. `order` is a parameter only where there
   *  are two or more. */
  readonly orders: Readonly<Record<string, unknown>>;
  readonly filters: { readonly [F in keyof Filters[R]]: FilterSpec };
  /** Filters that must be given; they also stand beside `keys`. */
  readonly required: readonly (keyof Filters[R])[];
}

export const LIMIT_DEFAULT = 100;
export const KEYS_MAX = 32;

export const ROUTE_TABLE = deepFreeze({
  names: {
    key: NAME_RE, limitMax: 200, orders: { name: CURSORS.name, newest: CURSORS.newest },
    filters: { owner: { re: ADDR_RE }, status: { values: NAME_STATUSES } }, required: [],
  },
  bids: { key: HASH_RE, limitMax: 200, orders: { newest: CURSORS.anchor }, filters: { status: { values: BID_STATUSES } }, required: [] },
  tokens: { key: TICKER_RE, limitMax: 200, orders: { ticker: CURSORS.ticker }, filters: {}, required: [] },
  events: { key: HASH_RE, limitMax: 500, orders: { position: CURSORS.event }, filters: {}, required: [] },
  holders: { key: ADDR_RE, limitMax: 200, orders: { balance: CURSORS.holder }, filters: { ticker: { re: TICKER_RE } }, required: ["ticker"] },
  offers: {
    key: HASH_RE, limitMax: 200, orders: { newest: CURSORS.anchor },
    filters: { status: { values: OFFER_STATUSES }, kind: { values: OFFER_KINDS } }, required: [],
  },
} as const satisfies { readonly [R in Route]: RouteSpec<R> });

export type Orders = typeof ROUTE_TABLE;
export type OrderOf<R extends Route> = keyof Orders[R]["orders"] & string;

/** Every parameter a route takes, in a fixed order. */
export function paramsOf(route: Route): readonly string[] {
  const spec = ROUTE_TABLE[route];
  const order = Object.keys(spec.orders).length > 1 ? ["order"] : [];
  return ["at", "keys", "after", "limit", ...order, ...Object.keys(spec.filters)];
}
