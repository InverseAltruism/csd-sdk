// The page of `transfers` (design section 5): the token moves of the applied log (CONVENTION section 41) in the deep
// view, each move one row with the deploy id the same state gives its ticker. Amounts are the moves' own, so no rule
// that decides an amount (a mint's cap, a fill's delivery, the fee) is restated here.
//
// The cursor binds the replica's events hash at its height, which covers every event at or below it. The moves at or
// below a height follow from the events at or below it (each entry is written as its event applies, in height order),
// so while that hash is the replica's, every row a caller read before its cursor is still the chain's and none it has
// not read lies at or below it. When the hash is no longer the replica's, the read refuses the cursor (reader.ts gives
// CURSOR_OFF_BRANCH) instead of answering from a position on a branch it no longer holds.
import { parseRecord, type AppliedEvent, type CairnXState, type ChainEvent, type TokenMove } from "@inversealtruism/cairnx-core";
import type { BoundCursor, Page, Transfer } from "./answer.js";
import type { BlockRow } from "./types.js";

export interface Bound { readonly height: number; readonly pos: number; readonly hash: string }
const BOUND = /^(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(0x[0-9a-f]{64})$/;
/** The position a cursor names: null for none, undefined for a cursor out of form. */
export function boundOf(c: unknown): Bound | null | undefined {
  if (c === null) return null;
  const m = typeof c === "string" ? BOUND.exec(c) : null;
  if (m === null) return undefined;
  const height = Number(m[1]), pos = Number(m[2]);
  return Number.isSafeInteger(height) && Number.isSafeInteger(pos) ? { height, pos, hash: m[3]! } : undefined;
}

export interface MovesQuery {
  /** The deep view, at `deepHeight`, and the height of the replica's cursor. */
  readonly deep: CairnXState; readonly deepHeight: number; readonly cursorHeight: number;
  eventsHashAt(height: number): string | null;
  /** The held rows at or above a height, ascending (Loop.rows). */
  rows(fromHeight: number): readonly BlockRow[];
  /** The receiving address, or null for every address; the ticker, or null for every ticker. */
  readonly to: string | null; readonly ticker: string | null;
  readonly since: Bound | null; readonly limit: number;
}
export type MovesPage = { readonly kind: "page"; readonly page: Page<Transfer, BoundCursor>; readonly aboveTip: boolean } | { readonly kind: "off-branch" };
type Entry = { readonly e: AppliedEvent; readonly moves: readonly TokenMove[] };

const cursorAt = (q: MovesQuery, height: number, pos: number): BoundCursor => {
  const hash = q.eventsHashAt(height);
  // Every height a cursor is made at lies at or below the deep height, which the loop holds whenever a deep view exists.
  if (hash === null) throw new Error(`transfers: no events hash held at ${height}`);
  return `${height}:${pos}:${hash}`;
};

/** The page after `since`: whole entries in (height, position) order, at most `limit` rows unless the first entry alone
 *  has more; nothing above the deep height. A cursor above the replica's cursor cannot be checked yet: an empty page
 *  that keeps it. */
export function movesPage(q: MovesQuery): MovesPage {
  const s = q.since;
  if (s !== null && s.height > q.cursorHeight) return { kind: "page", page: { items: [], next: `${s.height}:${s.pos}:${s.hash}`, more: false }, aboveTip: true };
  if (s !== null && q.eventsHashAt(s.height) !== s.hash) return { kind: "off-branch" };
  // The deep view's log holds the entries at or below the deep height only: it is resolve() over those events.
  const found: Entry[] = [];
  for (const e of q.deep.events) {
    if (e.moves === undefined || (s !== null && (e.height < s.height || (e.height === s.height && e.pos <= s.pos)))) continue;
    const moves = e.moves.filter((m) => (q.to === null || m.to === q.to) && (q.ticker === null || m.ticker === q.ticker));
    if (moves.length > 0) found.push({ e, moves });
  }
  // The log is in apply order, where a block's Proposes precede its Attests; the cursor's order is by position.
  found.sort((a, b) => a.e.height - b.e.height || a.e.pos - b.e.pos);
  const page: Entry[] = [];
  let rows = 0, more = false;
  for (let k = 0; k < found.length;) {
    const { height, pos } = found[k]!.e;
    let j = k, n = 0;
    for (; j < found.length && found[j]!.e.height === height && found[j]!.e.pos === pos; j++) n += found[j]!.moves.length;
    if (rows > 0 && rows + n > q.limit) { more = true; break; }
    page.push(...found.slice(k, j));
    rows += n;
    k = j;
  }
  const items = page.length === 0 ? [] : rowsOf(q, page), last = page.at(-1)?.e;
  const next = more && last !== undefined ? cursorAt(q, last.height, last.pos)
    : s !== null && s.height > q.deepHeight ? `${s.height}:${s.pos}:${s.hash}` as BoundCursor
    : cursorAt(q, q.deepHeight, Number.MAX_SAFE_INTEGER);
  return { kind: "page", page: { items, next, more }, aboveTip: false };
}

function rowsOf(q: MovesQuery, page: readonly Entry[]): Transfer[] {
  const low = page[0]!.e.height, high = page.at(-1)!.e.height, held = new Map<string, ChainEvent>();
  for (const r of q.rows(low)) {
    if (r.height > high) break;
    for (const ev of r.events) held.set(`${ev.height}:${ev.pos}`, ev);
  }
  const memoOf = (e: AppliedEvent): string | null => {
    const ev = held.get(`${e.height}:${e.pos}`);
    if (ev?.kind !== "propose" || ev.id !== e.id) return null;
    const r = parseRecord(ev.uri, ev.payloadHash);
    return r !== null && "memo" in r && typeof r.memo === "string" ? r.memo : null;
  };
  return page.flatMap(({ e, moves }) => {
    const memo = memoOf(e);
    return moves.map((m): Transfer => {
      const deployId = q.deep.tokens[m.ticker]?.deployId;
      if (deployId === undefined) throw new Error(`transfers: a move of ${m.ticker}, which the state does not list`);
      return { txid: e.id, height: e.height, pos: e.pos, leg: m.leg, ticker: m.ticker, deployId, from: m.from, to: m.to, amount: m.amount, memo, applied: true, code: e.code ?? null };
    });
  });
}
