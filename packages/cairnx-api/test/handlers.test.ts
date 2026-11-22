// answer() and prepareView() on the corpus: each refusal with its status, the choice of a held view by `at`, `rev`,
// `keys`, a cursor whose row was swept, an unknown ticker, offers that give a name, freezing and aliasing,
// determinism, and the byte bound of the largest page.
import { CAIRNX_API_VERSION, type Page, type Refusal } from "../src/index.js";
import { copyData, deepFreeze } from "../src/freeze.js";
import { answer, prepareView, type View } from "../src/handlers/index.js";
import { revOf } from "../src/handlers/view.js";
import { done, ok, show } from "./check.js";
import { rows, state, stateAt, tipHeight } from "./corpus.js";

const H = `0x${"ab".repeat(32)}`, H2 = `0x${"cd".repeat(32)}`;
const src = { height: tipHeight, hash: H, input: "fp-1", core: "0.2.7" };
const view = prepareView(deepFreeze(structuredClone(state)), src);
const page = (held: readonly View[], route: string, q: string) => answer(held, route, q).body as Page<Record<string, unknown>>;
const refused = (held: readonly View[], route: string, q: string) => { const a = answer(held, route, q); return { status: a.status, ...(a.body as Refusal) }; };
const thrown = (f: () => unknown): unknown => { try { f(); return null; } catch (e) { return e; } };

console.log("refusals:");
for (const route of ["tuple", "holder", "constructor", "", "NAMES", "Events"]) {
  const r = refused([view], route, "");
  ok(`route "${route}" is 404 NOT_FOUND, its message quoting no route`, r.status === 404 && r.error.code === "NOT_FOUND" && (route === "" || !r.error.message.includes(route)));
}
const bad = refused([view], "names", "limit=0");
ok("a parser refusal passes through: 400 INVALID_QUERY naming limit", bad.status === 400 && bad.error.code === "INVALID_QUERY" && bad.error.param === "limit");
const twice = refused([view], "names", "keys=alice&keys=bob");
ok("a repeated keys is the parser's 400", twice.status === 400 && twice.error.param === "keys");
const empty = refused([], "names", "");
ok("no held view is 503 NOT_READY", empty.status === 503 && empty.error.code === "NOT_READY" && empty.at === undefined);
// The parser's refusals on the three lists slice 3 serves, each through answer, beside the honest call of each.
const A = `0x${"cd".repeat(20)}`;
for (const [route, q, param] of [["events", "limit=501", "limit"], ["events", "order=position", "order"], ["events", "keys=44682:2", "keys"],
  ["events", "after=1:01", "after"], ["events", `keys=${H}&limit=5`, "limit"], ["holders", "", "ticker"], ["holders", `keys=${A}`, "ticker"],
  ["holders", "ticker=cairn", "ticker"], ["holders", "ticker=CAIRN&ticker=CAIRN", "ticker"], ["holders", `ticker=CAIRN&after=${A}`, "after"],
  ["holders", "ticker=CAIRN&limit=201", "limit"], ["offers", "kind=nft", "kind"], ["offers", "status=done", "status"], ["offers", `keys=${H}&kind=name`, "kind"],
  ["offers", "ticker=CAIRN", "ticker"]] as const) {
  const r = refused([view], route, q);
  ok(`${route}?${q} is 400 INVALID_QUERY naming ${param}`, r.status === 400 && r.error.code === "INVALID_QUERY" && r.error.param === param);
}
for (const [route, q] of [["events", "limit=500"], ["events", `keys=${H}`], ["holders", "ticker=CAIRN"], ["holders", `ticker=CAIRN&keys=${A}`],
  ["offers", "kind=name&status=open"], ["offers", `keys=${H}`]] as const) {
  ok(`the honest ${route}?${q} is 200`, answer([view], route, q).status === 200);
}

console.log("at and rev:");
const reserved = (stateAt(tipHeight).events).filter((e) => e.code === "NAME_RESERVED").map((e) => e.height);
let swept: { h: number; name: string } | null = null;
for (const h of [...new Set(reserved)]) {
  const gone = Object.values(stateAt(h).names).find((n) => n.pending === true && state.names[n.name] === undefined);
  if (gone !== undefined) { swept = { h, name: gone.name }; break; }
}
const older = prepareView(deepFreeze(stateAt(swept!.h)), { height: swept!.h, hash: H2, input: "fp-0", core: "0.2.7" });
const held = [view, older];
const full = `at=${view.at.height}:${H}:${view.at.rev}`;
ok("no at answers from the newest", show(page(held, "names", "").at) === show(view.at));
ok("the full triple of the newest answers from it", page(held, "names", full).ok === true);
ok(`an at naming the older view (height ${swept!.h}) is answered from it`, show(page(held, "names", `at=${swept!.h}:${H2}`).at) === show(older.at)
  && page(held, "names", `at=${swept!.h}:${H2}:${older.at.rev}`).total === Object.keys(stateAt(swept!.h).names).length);
ok("an at without rev matches by height and hash", show(page(held, "names", `at=${tipHeight}:${H}`).at) === show(view.at));
for (const [what, at] of [["a wrong rev", `at=${tipHeight}:${H}:${"0".repeat(16)}`], ["the older rev under the newest block", `at=${tipHeight}:${H}:${older.at.rev}`],
  ["an unheld height", `at=${tipHeight + 1}:${H}`], ["an unheld hash", `at=${tipHeight}:${H2}`]] as const) {
  const r = refused(held, "names", at);
  ok(`${what} is 409 SNAPSHOT_NOT_HELD with the newest at`, r.status === 409 && r.error.code === "SNAPSHOT_NOT_HELD" && show(r.at) === show(view.at));
}
const rev = revOf("fp-1", "0.2.7", CAIRNX_API_VERSION);
ok("rev is the first 16 hex digits of sha256(input, core, package version)", view.at.rev === rev && /^[0-9a-f]{16}$/.test(rev));
ok("rev changes with the input, the core version and the package version", new Set([rev, revOf("fp-2", "0.2.7", CAIRNX_API_VERSION), revOf("fp-1", "0.2.8", CAIRNX_API_VERSION), revOf("fp-1", "0.2.7", `${CAIRNX_API_VERSION}-other`)]).size === 4);
ok("and with nothing else: another state, height and hash under the same input and core keep it",
  prepareView(stateAt(swept!.h), { height: swept!.h, hash: H2, input: "fp-1", core: "0.2.7" }).at.rev === rev);
for (const [what, s] of [["a height that is not the tip", { ...src, height: tipHeight - 1 }], ["a malformed hash", { ...src, hash: H.toUpperCase() }],
  ["an input holding a newline", { ...src, input: "a\nb" }], ["an empty input", { ...src, input: "" }], ["a core that is not a version", { ...src, core: "0.2.7\n" }]] as const) {
  ok(`prepareView throws a TypeError on ${what}`, thrown(() => prepareView(state, s)) instanceof TypeError);
}

console.log("keys and cursors:");
const k = page([view], "names", `keys=zzzz-absent,${byNameLast()},${byNameFirst()}`);
ok("keys return the rows that exist in name order, a missing key absent, total their count, next null",
  show(k.rows.map((r) => r.name)) === show([byNameFirst(), byNameLast()]) && k.total === 2 && k.next === null);
const none = page([view], "bids", `keys=${H}`);
ok("keys matching nothing are 200 with no rows", none.ok === true && none.rows.length === 0 && none.total === 0);
const later = Object.keys(state.names).filter((n) => Buffer.compare(Buffer.from(n), Buffer.from(swept!.name)) > 0).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const afterSwept = page([view], "names", `after=${swept!.name}&limit=200`);
ok(`a cursor naming the swept reservation "${swept!.name}" seeks by comparison: the ${later.length} names after it, none repeated or skipped`,
  state.names[swept!.name] === undefined && show(afterSwept.rows.map((r) => r.name)) === show(later));
const newestAfter = page([view], "names", `order=newest&after=${swept!.h}:${swept!.name}&limit=200`);
const newestWant = rows.names.filter((n) => n.height < swept!.h || (n.height === swept!.h && Buffer.compare(Buffer.from(n.name), Buffer.from(swept!.name)) > 0)).length;
ok("so does its newest cursor", newestAfter.rows.length === newestWant && newestAfter.next === null);
const sl = swept!.name.length;
const lengthAfter = page([view], "names", `order=length&after=${sl}:${swept!.name}&limit=200`);
const lengthWant = rows.names.filter((n) => n.name.length > sl || (n.name.length === sl && Buffer.compare(Buffer.from(n.name), Buffer.from(swept!.name)) > 0)).length;
ok("so does its length cursor", lengthAfter.rows.length === lengthWant && lengthAfter.next === null);
for (const [what, cursor] of [["a name cursor", byNameFirst()], ["a newest cursor", `${swept!.h}:${swept!.name}`]] as const) {
  const r = refused([view], "names", `order=length&after=${cursor}`);
  ok(`${what} on order=length is 400 INVALID_QUERY naming after`, r.status === 400 && r.error.code === "INVALID_QUERY" && r.error.param === "after");
}

console.log("holders and offers:");
const lists = view.lists.holders, listKeys = Object.keys(lists), viewText = show(view);
const unknown = page([view], "holders", "ticker=NOSUCHTICKER");
const unknownKeys = page([view], "holders", `ticker=NOSUCHTICKER&keys=${A}`);
ok("an unknown ticker reads 200 with no rows, next null, total 0, by page and by keys", unknown.ok === true && unknown.rows.length === 0 && unknown.next === null
  && unknown.total === 0 && unknownKeys.ok === true && unknownKeys.rows.length === 0 && unknownKeys.total === 0);
ok("and adds nothing to the view: the same frozen object, the same tickers, the same text, the same rev", view.lists.holders === lists && Object.isFrozen(lists)
  && show(Object.keys(view.lists.holders)) === show(listKeys) && !listKeys.includes("NOSUCHTICKER") && show(view) === viewText && unknown.at.rev === view.at.rev);
const unheld = Object.keys(state.tokens).filter((t) => state.balances[t] === undefined);
ok(`a token without balances (${unheld.length}: ${unheld.join(", ")}) reads empty and has no entry either`,
  unheld.length > 0 && unheld.every((t) => page([view], "holders", `ticker=${t}`).total === 0 && !Object.hasOwn(view.lists.holders, t)));
const cairn = page([view], "holders", "ticker=CAIRN&limit=200");
ok(`a ticker with balances reads its ${Object.keys(state.balances.CAIRN!).length} holders, total their count`, cairn.rows.length === Object.keys(state.balances.CAIRN!).length
  && cairn.total === cairn.rows.length && cairn.rows.every((r) => Object.hasOwn(state.balances.CAIRN!, r.address as string)));
const nameOffers = Object.values(state.offers).filter((o) => "name" in o.give);
ok(`no corpus offer that gives a name has fills (${nameOffers.length} name offers, ${Object.values(state.offers).filter((o) => o.fills !== undefined).length} offers with fills)`,
  nameOffers.length > 0 && nameOffers.every((o) => o.fills === undefined) && Object.values(state.offers).some((o) => o.fills !== undefined));
const listed = page([view], "offers", "kind=name&limit=200");
ok("so a name listing loses nothing: offers?kind=name holds every name offer, each fillCount 0 or 1 by its whole fill", listed.rows.length === nameOffers.length
  && listed.rows.every((r) => "name" in (r.give as object) && r.fillCount === (r.fill === undefined ? 0 : 1)));

console.log("code null and empty offer classes:");
const uncodedLog = state.events.map((e) => { const copy = { ...e }; delete copy.code; return copy; });
const uncoded = prepareView(deepFreeze({ ...structuredClone(state), events: uncodedLog }), { ...src, input: "uncoded" });
const plain = page([uncoded], "events", "limit=500"), plainKeyed = page([uncoded], "events", `keys=${uncodedLog[0]!.id}`);
ok(`log entries without a code are served with code null, an own key (${plain.rows.length} rows by page, ${plainKeyed.rows.length} by keys)`,
  plain.rows.length === 500 && [...plain.rows, ...plainKeyed.rows].every((r) => Object.hasOwn(r, "code") && r.code === null) && JSON.stringify(plain.rows[0]).includes('"code":null'));
const EARLY = 31400, early = stateAt(EARLY);
const earlyView = prepareView(deepFreeze(early), { height: EARLY, hash: H2, input: "early", core: "0.2.7" });
const classes = [null, "open", "filled", "cancelled", "expired"].flatMap((st) => [null, "name", "token"].map((k) => [st, k] as const)).filter(([st, k]) => st !== null || k !== null);
const queryOf = ([st, k]: (typeof classes)[number]) => [st === null ? "" : `status=${st}`, k === null ? "" : `kind=${k}`].filter(Boolean).join("&");
const emptyClasses = classes.filter(([st, k]) => !Object.values(early.offers).some((o) => (st === null || o.status === st) && (k === null || ("name" in o.give) === (k === "name"))))
  .map(queryOf);
ok(`at ${EARLY} the offer classes without rows (${emptyClasses.join(", ")}) read total 0, no rows and next null`, emptyClasses.length > 0
  && emptyClasses.every((q) => { const p = page([earlyView], "offers", q); return p.ok === true && p.total === 0 && p.rows.length === 0 && p.next === null; }));
const fullClass = classes.map(queryOf).find((q) => !emptyClasses.includes(q))!, filled = page([earlyView], "offers", `${fullClass}&limit=200`);
ok(`and a class with rows there (${fullClass}) reads them, total their count`, filled.rows.length > 0 && filled.total === filled.rows.length);

console.log("freezing, aliasing, determinism:");
const frozen = (v: unknown): boolean => typeof v !== "object" || v === null || (Object.isFrozen(v) && Object.values(v).every(frozen));
ok("the view is frozen at every depth, and a write to it throws", frozen(view) && thrown(() => { (view.lists.names.orders.name[0] as { name: string }).name = "x"; }) instanceof TypeError);
ok("prepareView ran on a state frozen at every depth (it writes nothing)", frozen(deepFreeze(structuredClone(state))) && view.lists.names.orders.name.length === rows.names.length);
let reads = 0, counting = false;
const watch = <T extends object>(o: T): T => new Proxy(o, { get: (t, p, r) => { if (counting) reads++; const v = Reflect.get(t, p, r); return typeof v === "object" && v !== null ? watch(v) : v; } });
const watched = prepareView(watch(structuredClone(state)), src);
counting = true;
for (const [route, q] of [["names", ""], ["bids", ""], ["tokens", ""], ["events", ""], ["holders", "ticker=CAIRN&"], ["offers", ""]]) answer([watched], route!, `${q}limit=200`);
ok("the state is not read after prepareView returns", reads === 0);
const a1 = answer([view], "bids", "limit=3"), b1 = a1.body as Page<Record<string, unknown>>;
const before = JSON.stringify(a1);
ok("an answer is not frozen", !Object.isFrozen(b1) && !Object.isFrozen(b1.rows) && !Object.isFrozen(b1.rows[0]) && !Object.isFrozen(b1.at));
b1.rows[0]!.status = "changed"; (b1.rows[0]!.want as Record<string, unknown>).x = 1; b1.at.height = 0; b1.rows.pop();
ok("changing an answer changes neither the view nor the next answer", JSON.stringify(answer([view], "bids", "limit=3")) === before);
const hostile = copyData(JSON.parse('{"profile":{"__proto__":{"polluted":true}}}') as { profile: Record<string, unknown> });
ok("a row key \"__proto__\" is copied as an own key, never as the prototype", Object.hasOwn(hostile.profile, "__proto__")
  && Object.getPrototypeOf(hostile.profile) === Object.prototype && (hostile.profile as { polluted?: unknown }).polluted === undefined);
const twin = prepareView(deepFreeze(structuredClone(state)), { ...src });
const queries = ["", "order=newest&limit=7", "status=held", `keys=${byNameFirst()}`].map((q) => ["names", q]).concat([["bids", "status=open"], ["tokens", "limit=2"],
  ["events", "limit=7&after=44682:1"], ["holders", "ticker=CAIRN&limit=3"], ["offers", "kind=name&status=filled"]]);
ok(`two views of equal input give byte-equal answers (${queries.length} reads)`, queries.every(([r, q]) => JSON.stringify(answer([view], r!, q!)) === JSON.stringify(answer([twin], r!, q!))));

console.log("the largest page:");
for (const route of ["names", "bids", "tokens", "events", "holders", "offers"] as const) {
  const max = route === "events" ? 500 : 200, q = `${route === "holders" ? "ticker=CAIRN&" : ""}limit=${max}`;
  const sizes = (rows[route] as object[]).map((r) => JSON.stringify(r).length).sort((a, b) => b - a).slice(0, max);
  const bytes = JSON.stringify(page([view], route, q)).length - JSON.stringify(page([view], route, q).rows).length + sizes.reduce((a, b) => a + b + 1, 0);
  ok(`${route}: ${max} of its largest corpus rows (largest ${sizes[0]} B) make a page of ${bytes} B, under the 1 MiB mount cap`, bytes < 1_048_576);
}

function byNameFirst(): string { return rows.names.map((n) => n.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[0]!; }
function byNameLast(): string { return rows.names.map((n) => n.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).at(-1)!; }

done("cairnx-api handlers");
