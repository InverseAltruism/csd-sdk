// The query parser. Every parameter is checked against its route's table: an unknown, repeated, empty, malformed or
// out-of-range parameter is refused as INVALID_QUERY with the parameter named. One refusal names one parameter; which
// one, when several are wrong, is not promised.
import { HASH_RE } from "@inversealtruism/cairnx-core";
import type { CursorCodec } from "./cursor.js";
import { REV_RE, decimal } from "./grammar.js";
import { KEYS_MAX, LIMIT_DEFAULT, ROUTE_TABLE, isRoute, paramsOf, type FilterSpec, type Filters, type OrderOf, type Orders, type Route } from "./routes.js";

/** `at` as asked: a block, and the state under it when `rev` is given. */
export interface AtQuery { height: number; hash: string; rev: string | null }

type KeyOf<C> = C extends CursorCodec<infer K, never> ? K : never;
type Ordered<R extends Route> = {
  [O in OrderOf<R>]: {
    route: R;
    at: AtQuery | null;
    limit: number;
    /** 1 to KEYS_MAX distinct primary keys, or null. With keys, `order` is the default, `after` is null and only
     *  the required filters are set. */
    keys: readonly string[] | null;
    order: O;
    after: KeyOf<Orders[R]["orders"][O]> | null;
    filters: Filters[R];
  };
}[OrderOf<R>];
/** A parsed query of route R. */
export type Query<R extends Route = Route> = R extends Route ? Ordered<R> : never;

export interface QueryError { code: "INVALID_QUERY"; message: string; param: string }
export type ParseResult<R extends Route> = { ok: true; query: Query<R> } | { ok: false; error: QueryError };

// A refusal echoes a parameter name only in the shape of the table's own names; any other name is reported as
// PARAM_NOT_SHOWN. No input reaches `message`.
const PARAM_SHAPE = /^[a-z]{1,16}$/;
const PARAM_NOT_SHOWN = "(not shown)";
const refuse = (param: string, message: string): { ok: false; error: QueryError } =>
  ({ ok: false, error: { code: "INVALID_QUERY", message, param: PARAM_SHAPE.test(param) ? param : PARAM_NOT_SHOWN } });

function parseAt(v: string): AtQuery | null {
  const parts = v.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [h, hash, rev] = parts as [string, string, string | undefined];
  const height = decimal(h);
  if (height === null || !HASH_RE.test(hash) || (rev !== undefined && !REV_RE.test(rev))) return null;
  return { height, hash, rev: rev ?? null };
}

function parseKeys(v: string, re: RegExp): string[] | string {
  const keys = v.split(",");
  if (keys.length > KEYS_MAX) return `at most ${KEYS_MAX} keys`;
  if (keys.some((k) => !re.test(k))) return "an empty or malformed key";
  if (new Set(keys).size !== keys.length) return "a repeated key";
  return keys;
}

const fits = (spec: FilterSpec, v: string): boolean => ("re" in spec ? spec.re.test(v) : spec.values.includes(v));

/** The raw values, each a parameter of the route given once, or the refusal of the first that is not. An empty value
 *  is refused later by its grammar: none admits "". */
function collect(route: Route, search: URLSearchParams): Map<string, string> | { ok: false; error: QueryError } {
  const known = paramsOf(route), raw = new Map<string, string>();
  for (const [name, value] of search) {
    if (!known.includes(name)) return refuse(name, `not a parameter of ${route}`);
    if (raw.has(name)) return refuse(name, "given more than once");
    raw.set(name, value);
  }
  return raw;
}

/** Parse the query of a v1 list read. `query` is the raw query string (with or without its "?") or `URL.searchParams`,
 *  never a record from a query parser, which merges a repeated parameter that must be refused. Any other `query`, or
 *  a `route` outside the six, is the caller's error and throws a TypeError that does not quote it. */
export function parseQuery<R extends Route>(route: R, query: string | URLSearchParams): ParseResult<R> {
  if (typeof route !== "string" || !isRoute(route)) throw new TypeError("parseQuery: route is not a v1 route");
  if (typeof query !== "string" && !(query instanceof URLSearchParams)) throw new TypeError("parseQuery: query is not a string or URLSearchParams");
  const spec = ROUTE_TABLE[route as Route];
  const raw = collect(route, typeof query === "string" ? new URLSearchParams(query) : query);
  if (!(raw instanceof Map)) return raw;

  const filterSpecs: Readonly<Record<string, FilterSpec>> = spec.filters;
  const required: readonly string[] = spec.required;
  if (raw.has("keys")) {
    for (const name of raw.keys()) {
      if (name !== "keys" && name !== "at" && !required.includes(name)) return refuse(name, "not allowed with keys");
    }
  }
  for (const name of required) if (!raw.has(name)) return refuse(name, "required");

  const atRaw = raw.get("at");
  const at = atRaw === undefined ? null : parseAt(atRaw);
  if (atRaw !== undefined && at === null) return refuse("at", "must be <height>:<hash> or <height>:<hash>:<rev>, lowercase hex");

  const limitRaw = raw.get("limit");
  const limit = limitRaw === undefined ? LIMIT_DEFAULT : decimal(limitRaw);
  if (limit === null || limit < 1 || limit > spec.limitMax) return refuse("limit", `must be an integer from 1 to ${spec.limitMax}`);

  const orders: Readonly<Record<string, CursorCodec<unknown, never>>> = spec.orders;
  const order = raw.get("order") ?? (Object.keys(orders)[0] as string);
  const codec = Object.hasOwn(orders, order) ? orders[order] : undefined;
  if (codec === undefined) return refuse("order", `must be one of ${Object.keys(orders).join(", ")}`);

  const keysRaw = raw.get("keys");
  const keys = keysRaw === undefined ? null : parseKeys(keysRaw, spec.key);
  if (typeof keys === "string") return refuse("keys", keys);

  const afterRaw = raw.get("after");
  const after = afterRaw === undefined ? null : codec.decode(afterRaw);
  if (afterRaw !== undefined && after === null) return refuse("after", `not a cursor of ${route} in order ${order}`);

  const filters: Record<string, string | null> = {};
  for (const [name, fs] of Object.entries(filterSpecs)) {
    const v = raw.get(name);
    if (v !== undefined && !fits(fs, v)) return refuse(name, "re" in fs ? "malformed" : `must be one of ${fs.values.join(", ")}`);
    filters[name] = v ?? null;
  }
  // The parse boundary: every field above was checked against ROUTE_TABLE[route], the table Query<R> is derived from.
  const parsed = { route, at, limit, keys, order, after, filters };
  return { ok: true, query: parsed as unknown as Query<R> };
}
