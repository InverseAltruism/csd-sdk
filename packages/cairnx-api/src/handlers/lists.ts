// Each served list: how its rows are prepared from a state, once per view, and how a page is read from them. A list
// added here is served by `answer` and built by `prepareView` with no change to either signature.
import { isNameGive, type AppliedEvent, type CairnXState } from "@inversealtruism/cairnx-core";
import { CURSORS } from "../cursor.js";
import { deepFreeze, copyData } from "../freeze.js";
import type { Query } from "../params.js";
import type { OfferKind, Route } from "../routes.js";
import type { BidRow, EventRow, HolderRow, NameRow, OfferRow, RowOf, TokenRow } from "../rows.js";
import { indexBy, keyed, pageOf, record, sorted, type ListView, type PageRows } from "./page.js";

/** A list: its prepared form V, built from a state it copies and never keeps, and the read of a page from V. */
export interface List<R extends Route, V, Row> {
  build(state: CairnXState): V;
  read(view: V, q: Query<R>): PageRows<Row>;
}

const counts = <Row>(rows: readonly Row[], classes: Readonly<Record<string, (r: Row) => boolean>>): Record<string, number> =>
  record([["", rows.length], ...Object.entries(classes).map(([k, f]): [string, number] => [k, rows.filter(f).length])]);

const NAME_STATUS = { held: (r: NameRow) => !r.pending && !r.expired, pending: (r: NameRow) => r.pending === true, lapsed: (r: NameRow) => r.expired === true };

const names: List<"names", ListView<NameRow, "name" | "newest">, NameRow> = {
  build(state) {
    const rows = Object.values(state.names).map((n) => copyData(n));
    const byName = sorted(rows, CURSORS.name);
    return {
      orders: { name: byName, newest: sorted(rows, CURSORS.newest) },
      index: indexBy(byName, (r) => r.name),
      counts: counts(byName, Object.fromEntries(Object.entries(NAME_STATUS).map(([s, f]) => [`status=${s}`, f]))),
    };
  },
  read(v, q) {
    if (q.keys !== null) return keyed(v.index, v.orders.name, q.keys);
    const { owner, status } = q.filters;
    const match = owner === null && status === null ? null
      : (r: NameRow) => (owner === null || r.owner === owner) && (status === null || NAME_STATUS[status](r));
    const total = owner === null ? (v.counts[status === null ? "" : `status=${status}`] ?? null) : null;
    return q.order === "newest" ? pageOf(v.orders.newest, CURSORS.newest, q.after, q.limit, match, total)
      : pageOf(v.orders.name, CURSORS.name, q.after, q.limit, match, total);
  },
};

const bids: List<"bids", ListView<BidRow, "newest">, BidRow> = {
  build(state) {
    const rows = Object.values(state.bids).map((b): BidRow => {
      const { offers, ...rest } = copyData(b);
      return { ...rest, offerCount: offers.length };
    });
    const byNewest = sorted(rows, CURSORS.anchor);
    const statuses = [...new Set(rows.map((r) => r.status))];
    return {
      orders: { newest: byNewest },
      index: indexBy(byNewest, (r) => r.id),
      counts: counts(byNewest, Object.fromEntries(statuses.map((s) => [`status=${s}`, (r: BidRow) => r.status === s]))),
    };
  },
  read(v, q) {
    if (q.keys !== null) return keyed(v.index, v.orders.newest, q.keys);
    const { status } = q.filters;
    const match = status === null ? null : (r: BidRow) => r.status === status;
    return pageOf(v.orders.newest, CURSORS.anchor, q.after, q.limit, match, v.counts[status === null ? "" : `status=${status}`] ?? 0);
  },
};

const tokens: List<"tokens", ListView<TokenRow, "ticker">, TokenRow> = {
  build(state) {
    const byTicker = sorted(Object.values(state.tokens).map((t) => copyData(t)), CURSORS.ticker);
    return { orders: { ticker: byTicker }, index: indexBy(byTicker, (r) => r.ticker), counts: record([["", byTicker.length]]) };
  },
  read(v, q) {
    if (q.keys !== null) return keyed(v.index, v.orders.ticker, q.keys);
    return pageOf(v.orders.ticker, CURSORS.ticker, q.after, q.limit, null, v.orders.ticker.length);
  },
};

const eventRow = (e: AppliedEvent): EventRow =>
  ({ txid: e.id, height: e.height, pos: e.pos, kind: e.kind, applied: e.ok, code: e.code ?? null });

// The log array is in apply order, not key order (a block's Proposes first, deferred cancels at the block's end), so
// the feed is the log sorted by (height, pos); entries of one key, a repeated event below V29, keep their log order.
const events: List<"events", ListView<EventRow, "position">, EventRow> = {
  build(state) {
    const byPosition = sorted(state.events.map(eventRow), CURSORS.event);
    return { orders: { position: byPosition }, index: indexBy(byPosition, (r) => r.txid), counts: record([["", byPosition.length]]) };
  },
  read(v, q) {
    if (q.keys !== null) return keyed(v.index, v.orders.position, q.keys);
    return pageOf(v.orders.position, CURSORS.event, q.after, q.limit, null, v.orders.position.length);
  },
};

type HolderList = ListView<HolderRow, "balance">;
// The read of a ticker with no balances. Shared and frozen: an unknown ticker creates nothing, since TICKER_RE admits
// far more tickers than a view could hold.
const NO_HOLDERS: HolderList = deepFreeze({ orders: { balance: [] }, index: record([]), counts: record([["", 0]]) });

const holders: List<"holders", Readonly<Record<string, HolderList>>, HolderRow> = {
  build(state) {
    return record(Object.entries(state.balances).map(([ticker, m]): [string, HolderList] => {
      const byBalance = sorted(Object.entries(m).map(([address, b]): HolderRow => ({ address, available: b.available, locked: b.locked })), CURSORS.holder);
      return [ticker, { orders: { balance: byBalance }, index: indexBy(byBalance, (r) => r.address), counts: record([["", byBalance.length]]) }];
    }));
  },
  read(v, q) {
    const { ticker } = q.filters;
    const list = Object.hasOwn(v, ticker) ? (v[ticker] as HolderList) : NO_HOLDERS;
    if (q.keys !== null) return keyed(list.index, list.orders.balance, q.keys);
    return pageOf(list.orders.balance, CURSORS.holder, q.after, q.limit, null, list.orders.balance.length);
  },
};

/** `kind` on offers: what the offer gives. Give is a name or a token amount, so a token offer is one that gives no name. */
const OFFER_KIND: Readonly<Record<OfferKind, (r: OfferRow) => boolean>> = { name: (r) => isNameGive(r.give), token: (r) => !isNameGive(r.give) };
/** The offers a status and a kind select (null: any), and the key of their count. */
const offerClass = (status: string | null, kind: OfferKind | null): string =>
  [status === null ? "" : `status=${status}`, kind === null ? "" : `kind=${kind}`].filter((s) => s !== "").join("&");
const offerMatch = (status: string | null, kind: OfferKind | null) => (r: OfferRow): boolean =>
  (status === null || r.status === status) && (kind === null || OFFER_KIND[kind](r));

const offers: List<"offers", ListView<OfferRow, "newest">, OfferRow> = {
  build(state) {
    const rows = Object.values(state.offers).map((o): OfferRow => {
      const { fills, ...rest } = copyData(o);
      return { ...rest, fillCount: fills !== undefined ? fills.length : rest.fill !== undefined ? 1 : 0 };
    });
    const byNewest = sorted(rows, CURSORS.anchor);
    const statuses = [null, ...new Set(rows.map((r) => r.status))], kinds = [null, ...(Object.keys(OFFER_KIND) as OfferKind[])];
    const classes = statuses.flatMap((s) => kinds.filter((k) => s !== null || k !== null).map((k) => [offerClass(s, k), offerMatch(s, k)] as const));
    return { orders: { newest: byNewest }, index: indexBy(byNewest, (r) => r.id), counts: counts(byNewest, Object.fromEntries(classes)) };
  },
  read(v, q) {
    if (q.keys !== null) return keyed(v.index, v.orders.newest, q.keys);
    const { status, kind } = q.filters;
    const match = status === null && kind === null ? null : offerMatch(status, kind);
    return pageOf(v.orders.newest, CURSORS.anchor, q.after, q.limit, match, v.counts[offerClass(status, kind)] ?? 0);
  },
};

/** The list of each v1 route. */
export const LISTS = { names, bids, tokens, events, holders, offers } satisfies { [R in Route]: List<R, unknown, RowOf[R]> };
