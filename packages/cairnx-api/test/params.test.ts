// The parameter table of every route, as a table: each accepted form with its parsed value, each refusal with its code
// and the parameter it names. The coverage check at the end fails when a parameter of a route has no accepted case or
// no refusal here.
import { isDeepStrictEqual } from "node:util";
import { BID_STATUSES, NAME_STATUSES, OFFER_KINDS, OFFER_STATUSES, ROUTES, ROUTE_TABLE, isRoute, paramsOf, parseQuery, type Route } from "../src/index.js";
import { done, ok, show } from "./check.js";

const H = `0x${"ab".repeat(32)}`, H2 = `0x${"01".repeat(32)}`, A = `0x${"cd".repeat(20)}`, A2 = `0x${"0e".repeat(20)}`;
const REV = "0123456789abcdef";
const MAX_AMOUNT = ((1n << 96n) - 1n).toString();

const DEFAULTS: Record<Route, Record<string, unknown>> = {
  names: { order: "name", filters: { owner: null, status: null } },
  bids: { order: "newest", filters: { status: null } },
  tokens: { order: "ticker", filters: {} },
  events: { order: "position", filters: {} },
  holders: { order: "balance", filters: { ticker: "CAIRN" } },
  offers: { order: "newest", filters: { status: null, kind: null } },
};
const expected = (route: Route, over: Record<string, unknown>) =>
  ({ route, at: null, limit: 100, keys: null, after: null, ...DEFAULTS[route], ...over });

// [route, query, the fields that differ from the route's defaults]
const ACCEPT: [Route, string, Record<string, unknown>][] = [
  ["names", "", {}],
  ["names", "?limit=1", { limit: 1 }],
  ["names", "limit=200", { limit: 200 }],
  ["names", `at=117000:${H}`, { at: { height: 117000, hash: H, rev: null } }],
  ["names", `at=117000:${H}:${REV}`, { at: { height: 117000, hash: H, rev: REV } }],
  ["names", `at=0:${H}`, { at: { height: 0, hash: H, rev: null } }],
  ["names", `at=999999999999999:${H}`, { at: { height: 999999999999999, hash: H, rev: null } }],
  ["names", "after=alice", { after: { name: "alice" } }],
  ["names", "order=name&after=a-1", { after: { name: "a-1" } }],
  ["names", "order=newest", { order: "newest" }],
  ["names", "order=newest&after=44682:2", { order: "newest", after: { height: 44682, name: "2" } }],
  ["names", "order=length", { order: "length" }],
  ["names", "order=length&after=5:alice", { order: "length", after: { length: 5, name: "alice" } }],
  ["names", `order=length&after=1:9&limit=7&owner=${A}&status=held`, { order: "length", after: { length: 1, name: "9" }, limit: 7, filters: { owner: A, status: "held" } }],
  ["names", `owner=${A}`, { filters: { owner: A, status: null } }],
  ...NAME_STATUSES.map((s): [Route, string, Record<string, unknown>] => ["names", `status=${s}`, { filters: { owner: null, status: s } }]),
  ["names", "keys=alice,bob", { keys: ["alice", "bob"] }],
  ["names", `keys=${Array.from({ length: 32 }, (_, i) => `n${i}`).join(",")}`, { keys: Array.from({ length: 32 }, (_, i) => `n${i}`) }],
  ["names", `keys=alice&at=5:${H}`, { keys: ["alice"], at: { height: 5, hash: H, rev: null } }],
  ["bids", `after=10:${H}`, { after: { height: 10, id: H } }],
  ["bids", `keys=${H},${H2}`, { keys: [H, H2] }],
  ...BID_STATUSES.map((s): [Route, string, Record<string, unknown>] => ["bids", `status=${s}`, { filters: { status: s } }]),
  ["bids", `at=1:${H}&limit=7&status=open&after=0:${H2}`, { at: { height: 1, hash: H, rev: null }, limit: 7, filters: { status: "open" }, after: { height: 0, id: H2 } }],
  ["tokens", "after=CAIRN", { after: { ticker: "CAIRN" } }],
  ["tokens", "keys=CAIRN,XE5XNS&at=3:" + H, { keys: ["CAIRN", "XE5XNS"], at: { height: 3, hash: H, rev: null } }],
  ["tokens", "limit=2", { limit: 2 }],
  ["events", "limit=500", { limit: 500 }],
  ["events", "after=44682:2", { after: { height: 44682, pos: 2 } }],
  ["events", "after=999999999999999:999999999999999", { after: { height: 999999999999999, pos: 999999999999999 } }],
  ["events", `keys=${H}`, { keys: [H] }],
  ["events", `at=44682:${H}:${REV}&after=0:0`, { at: { height: 44682, hash: H, rev: REV }, after: { height: 0, pos: 0 } }],
  ["holders", "ticker=CAIRN", {}],
  ["holders", `ticker=CAIRN&keys=${A},${A2}`, { keys: [A, A2] }],
  ["holders", `ticker=CAIRN&after=100:${A}&limit=3`, { after: { amount: 100n, address: A }, limit: 3 }],
  ["holders", `ticker=CAIRN&after=${MAX_AMOUNT}:${A}`, { after: { amount: (1n << 96n) - 1n, address: A } }],
  ["holders", `keys=${A}&ticker=CAIRN&at=9:${H}`, { keys: [A], at: { height: 9, hash: H, rev: null } }],
  ...OFFER_STATUSES.map((s): [Route, string, Record<string, unknown>] => ["offers", `status=${s}`, { filters: { status: s, kind: null } }]),
  ...OFFER_KINDS.map((k): [Route, string, Record<string, unknown>] => ["offers", `kind=${k}`, { filters: { status: null, kind: k } }]),
  ["offers", `kind=name&status=open&after=7:${H}`, { filters: { status: "open", kind: "name" }, after: { height: 7, id: H } }],
  ["offers", `keys=${H}`, { keys: [H] }],
  ["offers", `at=2:${H}:${REV}&limit=200`, { at: { height: 2, hash: H, rev: REV }, limit: 200 }],
];

// [route, query, the parameter the refusal names]
const REFUSE: [Route, string, string][] = [
  // unknown, including a filter of another route and a parameter in another case
  ["names", "foo=1", "foo"],
  ["names", "Limit=5", "(not shown)"],
  ["names", "ticker=CAIRN", "ticker"],
  ["names", "kind=name", "kind"],
  ["bids", "kind=name", "kind"],
  ["bids", "order=newest", "order"],
  ["bids", `owner=${A}`, "owner"],
  ["tokens", "order=ticker", "order"],
  ["tokens", "status=open", "status"],
  ["events", "order=position", "order"],
  ["events", `owner=${A}`, "owner"],
  ["holders", "ticker=CAIRN&status=open", "status"],
  ["offers", "ticker=CAIRN", "ticker"],
  ["offers", "give=CAIRN", "give"],
  // repeated
  ["names", "limit=1&limit=1", "limit"],
  ["names", "keys=a&keys=b", "keys"],
  ["offers", "status=open&status=open", "status"],
  ["holders", "ticker=CAIRN&ticker=CAIRN", "ticker"],
  ["names", "after=a&after=b", "after"],
  ["names", `at=1:${H}&at=1:${H}`, "at"],
  ["names", "order=name&order=name", "order"],
  // empty
  ["names", "limit=", "limit"],
  ["names", "keys=", "keys"],
  ["names", "at", "at"],
  ["names", "after=", "after"],
  ["names", "owner=", "owner"],
  ["names", "status=", "status"],
  ["names", "order=", "order"],
  ["offers", "kind=", "kind"],
  ["holders", "ticker=", "ticker"],
  ["tokens", "after=", "after"],
  // limit: malformed and out of range, never clamped
  ...["01", "1.5", "-1", "abc", " 1", "1e2", "+5", "0", "201"].map((v): [Route, string, string] => ["names", `limit=${v}`, "limit"]),
  ["bids", "limit=201", "limit"],
  ["events", "limit=501", "limit"],
  ["events", "limit=0", "limit"],
  // every route: a malformed at, and a limit one past its maximum (200, or 500 on events)
  ...ROUTES.flatMap((r): [Route, string, string][] => {
    const ticker = r === "holders" ? "ticker=CAIRN&" : "";
    return [[r, `${ticker}at=1:${H}:`, "at"], [r, `${ticker}limit=${r === "events" ? 501 : 201}`, "limit"]];
  }),
  // at
  ["names", "at=117000", "at"],
  ["names", `at=117000:${H.toUpperCase().replace("0X", "0x")}`, "at"],
  ["names", `at=0117000:${H}`, "at"],
  ["names", `at=117000:${H}:${REV.toUpperCase()}`, "at"],
  ["names", `at=117000:${H}:${REV.slice(1)}`, "at"],
  ["names", `at=117000:${H}:${REV}:x`, "at"],
  ["names", `at=9007199254740992:${H}`, "at"],
  ["names", `at=1000000000000000:${H}`, "at"],
  ["names", `at=1e3:${H}`, "at"],
  ["names", `at=-1:${H}`, "at"],
  ["names", `at=1:${H.slice(0, 65)}`, "at"],
  // keys
  ["names", `keys=${Array.from({ length: 33 }, (_, i) => `n${i}`).join(",")}`, "keys"],
  ["names", "keys=a,,b", "keys"],
  ["names", "keys=a,", "keys"],
  ["names", "keys=a,a", "keys"],
  ["names", "keys=Alice", "keys"],
  ["offers", `keys=${H.toUpperCase().replace("0X", "0x")}`, "keys"],
  ["events", "keys=44682:2", "keys"],
  ["tokens", "keys=cairn", "keys"],
  ["holders", `ticker=CAIRN&keys=${A.toUpperCase().replace("0X", "0x")}`, "keys"],
  ["bids", `keys=${A}`, "keys"],
  // keys excludes every other filter, order, after and limit; holders keeps its required ticker
  ["names", "keys=a&order=newest", "order"],
  ["names", "keys=a&after=b", "after"],
  ["names", `keys=a&owner=${A}`, "owner"],
  ["names", "keys=a&status=held", "status"],
  ["names", "keys=a&limit=5", "limit"],
  ["offers", `keys=${H}&kind=name`, "kind"],
  ["bids", `keys=${H}&status=open`, "status"],
  ["holders", `ticker=CAIRN&keys=${A}&after=1:${A}`, "after"],
  // required
  ["holders", "", "ticker"],
  ["holders", `keys=${A}`, "ticker"],
  ["holders", "limit=5", "ticker"],
  // after: malformed for the list and order it is given to
  ["names", "after=Alice", "after"],
  ["names", "after=44682:2", "after"],
  ["names", "order=newest&after=alice", "after"],
  ["names", "order=newest&after=01:a", "after"],
  ["names", "order=newest&after=1:a:b", "after"],
  ["names", "order=length&after=alice", "after"],
  ["names", "order=length&after=44682:2", "after"],
  ["names", "order=length&after=4:alice", "after"],
  ["offers", `after=10:${H.toUpperCase().replace("0X", "0x")}`, "after"],
  ["offers", `after=${H}:10`, "after"],
  ["bids", `after=10:${A}`, "after"],
  ["holders", `ticker=CAIRN&after=-1:${A}`, "after"],
  ["holders", `ticker=CAIRN&after=${(1n << 96n).toString()}:${A}`, "after"],
  ["holders", `ticker=CAIRN&after=${"9".repeat(4000)}:${A}`, "after"],
  ["holders", `ticker=CAIRN&after=${A}`, "after"],
  ["events", "after=1:2:3", "after"],
  ["events", "after=1:01", "after"],
  ["events", "after=9007199254740992:0", "after"],
  ["events", "after=1000000000000000:0", "after"],
  ["events", "after=0:1000000000000000", "after"],
  ["names", "order=newest&after=1000000000000000:a", "after"],
  ["offers", `after=1000000000000000:${H}`, "after"],
  ["tokens", "after=cairn", "after"],
  // filter values
  ["names", "status=expired", "status"],
  ["names", "order=Length", "order"],
  ["names", "order=Newest", "order"],
  ...["constructor", "toString", "__proto__", "hasOwnProperty"].map((v): [Route, string, string] => ["names", `order=${v}`, "order"]),
  ["names", `owner=${A.toUpperCase().replace("0X", "0x")}`, "owner"],
  ["offers", "status=done", "status"],
  ["offers", "kind=nft", "kind"],
  ["bids", "status=filled", "status"],
  ["holders", "ticker=cairn", "ticker"],
  ["holders", "ticker=C", "ticker"],
];

console.log("the parameter table as built:");
const TABLE: Record<Route, string[]> = {
  names: ["at", "keys", "after", "limit", "order", "owner", "status"],
  bids: ["at", "keys", "after", "limit", "status"],
  tokens: ["at", "keys", "after", "limit"],
  events: ["at", "keys", "after", "limit"],
  holders: ["at", "keys", "after", "limit", "ticker"],
  offers: ["at", "keys", "after", "limit", "status", "kind"],
};
ok("the six routes", isDeepStrictEqual([...ROUTES], ["names", "bids", "tokens", "events", "holders", "offers"]));
for (const r of ROUTES) ok(`${r}: ${TABLE[r].join(", ")}`, isDeepStrictEqual(paramsOf(r), TABLE[r]), show(paramsOf(r)));
/** Every object reachable from `v` is frozen; the patterns, cairnx-core's RegExp objects, are left to the core. */
const deepFrozen = (v: unknown): boolean => typeof v !== "object" || v === null || v instanceof RegExp || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
ok("ROUTE_TABLE is frozen at every depth (routes, orders, codecs, filters, value lists, required lists)", deepFrozen(ROUTE_TABLE) && Object.isFrozen(ROUTE_TABLE.names.filters.status));
ok("isRoute: the six and nothing else", ROUTES.every(isRoute) && !isRoute("tuple") && !isRoute("Names") && !isRoute("constructor"));

console.log("accepted:");
for (const [route, q, over] of ACCEPT) {
  const r = parseQuery(route, q), want = expected(route, over);
  ok(`${route}?${q.replace(/^\?/, "").slice(0, 90)}`, r.ok && isDeepStrictEqual(r.query, want), show(r.ok ? r.query : r.error));
}
const viaParams = parseQuery("names", new URLSearchParams([["order", "newest"], ["limit", "3"]]));
ok("URLSearchParams input parses as its string", viaParams.ok && isDeepStrictEqual(viaParams.query, expected("names", { order: "newest", limit: 3 })));

console.log("refused:");
for (const [route, q, param] of REFUSE) {
  const r = parseQuery(route, q);
  ok(`${route}?${q.slice(0, 80)} -> INVALID_QUERY ${param}`, !r.ok && r.error.code === "INVALID_QUERY" && r.error.param === param && r.error.message !== "",
    show(r.ok ? r.query : r.error));
}

console.log("what a refusal echoes, and what the parser takes:");
const SECRET = "<script>alert(1)</script>";
for (const [what, q] of [["a markup-shaped name", `${encodeURIComponent(SECRET)}=1`], ["a 100,000-character name", `${"x".repeat(100000)}=1`],
  ["an empty name", "=5"], ["a name with a digit", "limit2=1"]] as const) {
  const r = parseQuery("names", q);
  ok(`${what} is refused with param "(not shown)" and no input in the message`,
    !r.ok && r.error.param === "(not shown)" && !r.error.message.includes("script") && !r.error.message.includes("xxxx") && r.error.message.length < 100, show(r.ok ? r.query : { ...r.error, param: r.error.param.slice(0, 40) }));
}
const thrown = (f: () => unknown): unknown => { try { f(); return null; } catch (e) { return e; } };
const quotes = (e: unknown, s: string) => e instanceof Error && e.message.includes(s);
const notRoute = thrown(() => parseQuery("constructor<b>" as Route, ""));
ok("a route outside the six throws a TypeError that does not quote it", notRoute instanceof TypeError && !quotes(notRoute, "constructor"));
for (const [what, q] of [["a record", { keys: ["a", "b"], marker: "zz-input" }], ["a Map", new Map([["owner", ["zz-input"]]])],
  ["an array of pairs", [["limit", "zz-input"]]], ["undefined", undefined]] as const) {
  const e = thrown(() => parseQuery("names", q as unknown as string));
  ok(`${what} as the query throws a TypeError that does not quote it`, e instanceof TypeError && !quotes(e, "zz-input"), String(e));
}
ok("a repeated keys in a raw query string is refused (a record parser would have merged it)", (() => { const r = parseQuery("names", "keys=a&keys=b"); return !r.ok && r.error.param === "keys"; })());
ok("a repeated parameter in URLSearchParams is refused", (() => { const r = parseQuery("names", new URLSearchParams([["keys", "a"], ["keys", "b"]])); return !r.ok && r.error.param === "keys"; })());
ok("a name key that is an Object.prototype name is an ordinary key", (() => { const r = parseQuery("names", "keys=constructor,__proto__"); return !r.ok && r.error.param === "keys"; })()
  && (() => { const r = parseQuery("names", "keys=constructor,tostring"); return r.ok && isDeepStrictEqual(r.query.keys, ["constructor", "tostring"]); })());

console.log("coverage:");
for (const route of ROUTES) {
  const accepted = new Set(ACCEPT.filter((c) => c[0] === route).flatMap((c) => [...new URLSearchParams(c[1]).keys()]));
  const refused = new Set(REFUSE.filter((c) => c[0] === route).map((c) => c[2]));
  const missing = paramsOf(route).filter((p) => !accepted.has(p) || !refused.has(p));
  ok(`${route}: every parameter has an accepted case and a refusal`, missing.length === 0, missing.join(", "));
  ok(`${route}: a parameter of another route or none is refused`, [...refused].some((p) => !paramsOf(route).includes(p)));
}

done("cairnx-api params");
