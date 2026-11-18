// answer() and prepareView() on the corpus: each refusal with its status, the choice of a held view by `at`, `rev`,
// `keys`, a cursor whose row was swept, freezing and aliasing, determinism, and the byte bound of the largest page.
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
for (const route of ["tuple", "events", "constructor", "", "NAMES"]) {
  const r = refused([view], route, "");
  ok(`route "${route}" is 404 NOT_FOUND, its message quoting no route`, r.status === 404 && r.error.code === "NOT_FOUND" && (route === "" || !r.error.message.includes(route)));
}
const bad = refused([view], "names", "limit=0");
ok("a parser refusal passes through: 400 INVALID_QUERY naming limit", bad.status === 400 && bad.error.code === "INVALID_QUERY" && bad.error.param === "limit");
const twice = refused([view], "names", "keys=alice&keys=bob");
ok("a repeated keys is the parser's 400", twice.status === 400 && twice.error.param === "keys");
const empty = refused([], "names", "");
ok("no held view is 503 NOT_READY", empty.status === 503 && empty.error.code === "NOT_READY" && empty.at === undefined);

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
ok("rev changes with the input, the core version and the package version", new Set([rev, revOf("fp-2", "0.2.7", CAIRNX_API_VERSION), revOf("fp-1", "0.2.8", CAIRNX_API_VERSION), revOf("fp-1", "0.2.7", "0.1.1")]).size === 4);
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

console.log("freezing, aliasing, determinism:");
const frozen = (v: unknown): boolean => typeof v !== "object" || v === null || (Object.isFrozen(v) && Object.values(v).every(frozen));
ok("the view is frozen at every depth, and a write to it throws", frozen(view) && thrown(() => { (view.lists.names.orders.name[0] as { name: string }).name = "x"; }) instanceof TypeError);
ok("prepareView ran on a state frozen at every depth (it writes nothing)", frozen(deepFreeze(structuredClone(state))) && view.lists.names.orders.name.length === rows.names.length);
let reads = 0, counting = false;
const watch = <T extends object>(o: T): T => new Proxy(o, { get: (t, p, r) => { if (counting) reads++; const v = Reflect.get(t, p, r); return typeof v === "object" && v !== null ? watch(v) : v; } });
const watched = prepareView(watch(structuredClone(state)), src);
counting = true;
for (const route of ["names", "bids", "tokens"]) answer([watched], route, "limit=200");
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
const queries = ["", "order=newest&limit=7", "status=held", `keys=${byNameFirst()}`].map((q) => ["names", q]).concat([["bids", "status=open"], ["tokens", "limit=2"]]);
ok(`two views of equal input give byte-equal answers (${queries.length} reads)`, queries.every(([r, q]) => JSON.stringify(answer([view], r!, q!)) === JSON.stringify(answer([twin], r!, q!))));

console.log("the largest page:");
for (const route of ["names", "bids", "tokens"] as const) {
  const sizes = (rows[route] as object[]).map((r) => JSON.stringify(r).length).sort((a, b) => b - a).slice(0, 200);
  const bytes = JSON.stringify(page([view], route, "limit=200")).length - JSON.stringify(page([view], route, "limit=200").rows).length + sizes.reduce((a, b) => a + b + 1, 0);
  ok(`${route}: 200 of its largest corpus rows (largest ${sizes[0]} B) make a page of ${bytes} B, under the 1 MiB mount cap`, bytes < 1_048_576);
}

function byNameFirst(): string { return rows.names.map((n) => n.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[0]!; }
function byNameLast(): string { return rows.names.map((n) => n.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).at(-1)!; }

done("cairnx-api handlers");
