// The cursor codec of each list order. A cursor is the sort key of a page's last row in a documented grammar, and only
// a position: a handler seeks by comparing keys, never by looking a row up. So a cursor from another list or snapshot
// that fits the grammar is a valid position ("44682:2" is an events cursor and a `newest` names cursor alike).
import { ADDR_RE, HASH_RE, NAME_RE, TICKER_RE } from "@inversealtruism/cairnx-core";
import { deepFreeze } from "./freeze.js";
import { amount, decimal, pair } from "./grammar.js";
import type { EventRow, HolderRow, NameRow, OfferRow, BidRow, TokenRow } from "./rows.js";

export interface CursorCodec<K, Row> {
  encode(key: K): string;
  /** The key a cursor names, or null when it does not fit the grammar. */
  decode(cursor: string): K | null;
  /** The list's order: negative when `a` comes first. Total over the keys `decode` returns. */
  compare(a: K, b: K): number;
  /** A row's key in this order. */
  of(row: Row): K;
}

export interface NameKey { name: string }
export interface NewestKey { height: number; name: string }
export interface LengthKey { length: number; name: string }
export interface AnchorKey { height: number; id: string }
export interface TickerKey { ticker: string }
export interface HolderKey { amount: bigint; address: string }
export interface EventKey { height: number; pos: number }

// Code-unit order; every key string is ASCII by its pattern, so this is the bytewise order.
const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (a: number | bigint, b: number | bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** A `<decimal>:<string>` cursor whose string matches `re`. */
function heightAnd(cursor: string, re: RegExp): [number, string] | null {
  const p = pair(cursor);
  const h = p ? decimal(p[0]) : null;
  return p && h !== null && re.test(p[1]) ? [h, p[1]] : null;
}

const name: CursorCodec<NameKey, NameRow> = {
  encode: (k) => k.name,
  decode: (c) => (NAME_RE.test(c) ? { name: c } : null),
  compare: (a, b) => asc(a.name, b.name),
  of: (r) => ({ name: r.name }),
};

const newest: CursorCodec<NewestKey, NameRow> = {
  encode: (k) => `${k.height}:${k.name}`,
  decode: (c) => { const v = heightAnd(c, NAME_RE); return v && { height: v[0], name: v[1] }; },
  compare: (a, b) => num(b.height, a.height) || asc(a.name, b.name),
  of: (r) => ({ height: r.height, name: r.name }),
};

// The length is the name's own, so a cursor whose length differs from its name's names no key and is refused: a `newest`
// cursor fits this grammar only when its height equals its name's length.
const length: CursorCodec<LengthKey, NameRow> = {
  encode: (k) => `${k.length}:${k.name}`,
  decode: (c) => { const v = heightAnd(c, NAME_RE); return v && v[0] === v[1].length ? { length: v[0], name: v[1] } : null; },
  compare: (a, b) => num(a.length, b.length) || asc(a.name, b.name),
  of: (r) => ({ length: r.name.length, name: r.name }),
};

const anchor: CursorCodec<AnchorKey, OfferRow | BidRow> = {
  encode: (k) => `${k.height}:${k.id}`,
  decode: (c) => { const v = heightAnd(c, HASH_RE); return v && { height: v[0], id: v[1] }; },
  compare: (a, b) => num(b.height, a.height) || asc(a.id, b.id),
  of: (r) => ({ height: r.height, id: r.id }),
};

const ticker: CursorCodec<TickerKey, TokenRow> = {
  encode: (k) => k.ticker,
  decode: (c) => (TICKER_RE.test(c) ? { ticker: c } : null),
  compare: (a, b) => asc(a.ticker, b.ticker),
  of: (r) => ({ ticker: r.ticker }),
};

const holder: CursorCodec<HolderKey, HolderRow> = {
  encode: (k) => `${k.amount}:${k.address}`,
  decode: (c) => {
    const p = pair(c);
    const a = p ? amount(p[0]) : null;
    return p && a !== null && ADDR_RE.test(p[1]) ? { amount: a, address: p[1] } : null;
  },
  compare: (a, b) => num(b.amount, a.amount) || asc(a.address, b.address),
  of: (r) => ({ amount: BigInt(r.available) + BigInt(r.locked), address: r.address }),
};

const event: CursorCodec<EventKey, EventRow> = {
  encode: (k) => `${k.height}:${k.pos}`,
  decode: (c) => {
    const p = pair(c);
    const h = p ? decimal(p[0]) : null, pos = p ? decimal(p[1]) : null;
    return h !== null && pos !== null ? { height: h, pos } : null;
  },
  compare: (a, b) => num(a.height, b.height) || num(a.pos, b.pos),
  of: (r) => ({ height: r.height, pos: r.pos }),
};

/** The codec of each order: names by name; names newest first (height desc, name asc); names shortest first (length
 *  asc, name asc; a name is ASCII, so its length is its byte length); offers and bids (height desc,
 *  id asc); tokens by ticker; holders by balance (available + locked desc, address asc); events in chain position
 *  (height asc, pos asc). */
export const CURSORS = deepFreeze({ name, newest, length, anchor, ticker, holder, event });
