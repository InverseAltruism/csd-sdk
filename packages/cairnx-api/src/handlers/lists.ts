// Each served list: how its rows are prepared from a state, once per view, and how a page is read from them. A list
// added here is served by `answer` and built by `prepareView` with no change to either signature.
import type { CairnXState } from "@inversealtruism/cairnx-core";
import { CURSORS } from "../cursor.js";
import { copyData } from "../freeze.js";
import type { Query } from "../params.js";
import type { Route } from "../routes.js";
import type { BidRow, NameRow, TokenRow } from "../rows.js";
import { keyed, pageOf, record, sorted, type ListView, type PageRows } from "./page.js";

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
      index: record(byName.map((r, i) => [r.name, i] as const)),
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
      index: record(byNewest.map((r, i) => [r.id, i] as const)),
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
    return { orders: { ticker: byTicker }, index: record(byTicker.map((r, i) => [r.ticker, i] as const)), counts: record([["", byTicker.length]]) };
  },
  read(v, q) {
    if (q.keys !== null) return keyed(v.index, v.orders.ticker, q.keys);
    return pageOf(v.orders.ticker, CURSORS.ticker, q.after, q.limit, null, v.orders.ticker.length);
  },
};

/** The lists this release serves. */
export const LISTS = { names, bids, tokens };
export type Served = keyof typeof LISTS;
export const isServed = (route: string): route is Served => Object.hasOwn(LISTS, route);
