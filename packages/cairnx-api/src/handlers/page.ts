// One list's prepared rows and the read of a page from them. Rows are sorted once per view by the order's codec; a page
// seeks by comparing keys (a binary search, so a cursor whose row is gone still finds its place), takes `limit` rows
// that match the filter and looks at the next match to decide `next`. A page never ends between two rows of one key:
// the cursor names a key, and a seek past it would skip the rest of the key's rows.
import type { CursorCodec } from "../cursor.js";

/** A list prepared for reads: its rows in each order, each primary key's positions in the default order, and the
 *  counts that answer `total` without a scan (key "" is every row). */
export interface ListView<Row, O extends string = string> {
  readonly orders: Readonly<Record<O, readonly Row[]>>;
  readonly index: Readonly<Record<string, readonly number[]>>;
  readonly counts: Readonly<Record<string, number>>;
}

export interface PageRows<Row> { rows: readonly Row[]; next: string | null; total: number }

/** A frozen-ready record with no prototype, so a key such as "constructor" is an own key or absent. */
export function record<V>(entries: Iterable<readonly [string, V]>): Record<string, V> {
  const out: Record<string, V> = Object.create(null);
  for (const [k, v] of entries) out[k] = v;
  return out;
}

/** Each primary key of `rows` with its positions, ascending. A key has one position in every list but `events`, where
 *  a transaction id the feed repeated has one per log entry. */
export function indexBy<Row>(rows: readonly Row[], key: (r: Row) => string): Record<string, number[]> {
  const out = record<number[]>([]);
  rows.forEach((r, i) => { const k = key(r); if (Object.hasOwn(out, k)) (out[k] as number[]).push(i); else out[k] = [i]; });
  return out;
}

/** A sorted copy of `rows`, in the order `codec` defines; rows of equal keys keep their input order. */
export function sorted<K, Row, R extends Row>(rows: readonly R[], codec: CursorCodec<K, Row>): R[] {
  return rows.map((r) => [codec.of(r), r] as const).sort((a, b) => codec.compare(a[0], b[0])).map(([, r]) => r);
}

/** The first position whose key sorts strictly after `after`. */
function seek<K, Row>(rows: readonly Row[], codec: CursorCodec<K, Row>, after: K): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (codec.compare(codec.of(rows[mid] as Row), after) <= 0) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** A page of `rows` (sorted by `codec`) after `after`, of the rows `match` keeps (all when null): `limit` of them, and
 *  more only when the rows after the limit share the last row's key. `total` is the known count of matching rows, or
 *  null to count them. */
export function pageOf<K, Row, R extends Row>(
  rows: readonly R[], codec: CursorCodec<K, Row>, after: K | null, limit: number, match: ((r: R) => boolean) | null, total: number | null,
): PageRows<R> {
  const out: R[] = [];
  let more = false, lastKey: K | undefined;
  for (let i = after === null ? 0 : seek(rows, codec, after); i < rows.length; i++) {
    const r = rows[i] as R;
    if (match !== null && !match(r)) continue;
    const key = codec.of(r);
    if (out.length >= limit && lastKey !== undefined && codec.compare(key, lastKey) !== 0) { more = true; break; }
    out.push(r);
    lastKey = key;
  }
  return {
    rows: out,
    next: more && lastKey !== undefined ? codec.encode(lastKey) : null,
    total: total ?? (match === null ? rows.length : rows.reduce((n, r) => n + (match(r) ? 1 : 0), 0)),
  };
}

/** The rows of `keys` that exist, every row of each, in the default order. */
export function keyed<Row>(index: ListView<Row>["index"], defaultOrder: readonly Row[], keys: readonly string[]): PageRows<Row> {
  const at = keys.flatMap((k) => (Object.hasOwn(index, k) ? (index[k] as readonly number[]) : [])).sort((a, b) => a - b);
  return { rows: at.map((i) => defaultOrder[i] as Row), next: null, total: at.length };
}
