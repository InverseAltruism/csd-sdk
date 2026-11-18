// The answer to one v1 list read from the views a host holds. Every body is a fresh plain object: rows are copied out
// of the frozen view, so a caller may change an answer without changing the view or a later answer.
import type { Answer, At } from "../envelope.js";
import { ERRORS, type ErrorCode } from "../errors.js";
import { copyData } from "../freeze.js";
import { parseQuery, type AtQuery, type Query } from "../params.js";
import type { RowOf } from "../rows.js";
import { LISTS, isServed } from "./lists.js";
import type { PageRows } from "./page.js";
import type { View } from "./view.js";

export interface Answered { status: number; body: Answer<RowOf[keyof RowOf]> }

const refusal = (code: ErrorCode, message: string, at?: At): Answered =>
  ({ status: ERRORS[code].status, body: { ok: false, error: { code, message }, ...(at === undefined ? {} : { at: { ...at } }) } });

/** The held view `at` names: the newest without one; else the newest with its height and hash, and its `rev` when
 *  given. */
const pick = (held: readonly View[], at: AtQuery | null): View | undefined =>
  at === null ? held[0] : held.find((v) => v.at.height === at.height && v.at.hash === at.hash && (at.rev === null || at.rev === v.at.rev));

/** Answer `route` with `query` (the raw query string or `URL.searchParams`) from `held`, the views held, newest first. */
export function answer(held: readonly View[], route: string, query: string | URLSearchParams): Answered {
  if (typeof route !== "string" || !isServed(route)) return refusal("NOT_FOUND", "no such list under v1");
  const parsed = parseQuery(route, query);
  if (!parsed.ok) return { status: ERRORS.INVALID_QUERY.status, body: { ok: false, error: parsed.error } };
  const newest = held[0];
  if (newest === undefined) return refusal("NOT_READY", "no state published yet");
  const view = pick(held, parsed.query.at);
  if (view === undefined) return refusal("SNAPSHOT_NOT_HELD", "the snapshot asked for is not held; the newest held is in at", newest.at);
  // `route` and the query come from one parse, so the list and its query agree.
  const read = LISTS[route].read as (v: unknown, q: Query) => PageRows<RowOf[keyof RowOf]>;
  const page = read(view.lists[route], parsed.query);
  return { status: 200, body: { ok: true, level: 1, at: { ...view.at }, rows: page.rows.map(copyData), next: page.next, total: page.total } };
}
