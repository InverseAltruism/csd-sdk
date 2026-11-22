// The comparison with a reference (compare.ts) through open(): each kind of difference a mock reference can show, the
// first differing boundary found by the search, PIN_DISPUTED at a pin and TUPLE_RECORDS above it, the streak before a
// recount acts and its three outcomes, the limit on rebuilds, and a hostile reference (one that lies about a boundary it agreed on, one that
// never answers, one on another chain, answers out of shape or over size, a search held to its request budget). Paired
// throughout: an honest equal reference adds no note, no request in status() and no recount, and a reference on the
// store's own origin is labelled so and changes no level and no verdict.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FINAL_DEPTH } from "@inversealtruism/cairnx-core";
import { memoryStore, open, ReplicaConfigError, replicaLoop, type BlocksSource, type ReplicaStatus, type Source, type Store, type Tuple } from "../src/index.js";
import { open as serverOpen } from "../src/server.js";
import { local } from "../src/browser.js";
import { derivePin } from "../src/server.js";
import { tupleOf } from "../src/tuple.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { cap, NODE, node } from "./node-harness.js";
import { hashAt as capHash, timeAt } from "./reader-harness.js";
import { growing } from "./tuple-harness.js";

const REF = "https://ref.example/trade/api";
type Table = (h: number) => Tuple | null;
/** A reference answering from `table`: by height and block hash only for its own block there, by height its tuple, a
 *  404 of the resolver's form otherwise. `log` records each path read. */
function reference(table: Table, o: { log?: string[]; reply?: (path: string) => Response | Promise<Response> | null } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace("/trade/api", "");
    o.log?.push(path);
    const custom = o.reply?.(path);
    if (custom) return custom;
    const m = /^\/cairnx\/tuple\/([0-9]+)(?::(0x[0-9a-f]{64}))?$/.exec(path), h = Number(m?.[1]), t = m ? table(h) : null;
    if (t !== null && (m![2] === undefined || m![2] === t.blockHash)) return Response.json({ ok: true, ...t });
    return Response.json({ ok: false, error: "not a kept boundary", height: h }, { status: 404 });
  }) as typeof fetch;
}
const notes = (s: ReplicaStatus) => s.notes.map((n) => n.code).filter((c) => c.startsWith("TUPLE_") || c === "DIVERGENCE_CONFIRMED");
const whys = (s: ReplicaStatus) => s.why.map((w) => w.code).join(",");
const flip = (h: string) => "0x" + (h[2] === "a" ? "b" : "a") + h.slice(3);

// The truth: every boundary's tuple of the fixture to TOP, read by a replica of its own.
const TOP = 30_600;
const truthOf = async (f: BlockFixture, top: number): Promise<Map<number, Tuple>> => {
  const l = replicaLoop({ source: growing(f, { now: top }), store: memoryStore(), maxBlocks: 100_000, maxRequests: 100_000 });
  await l.open(); await l.advance();
  const m = new Map(l.boundaryHeights().map((h) => [h, tupleOf(l.boundary(h))!] as const));
  await l.close();
  return m;
};
const truth = await truthOf(fx, TOP + 300);
// The recount reads blocks in production, and open() refuses one whose basis is not blocks; here a fixture source over
// the same records, under a blocks basis, stands in for one.
const asBlocks = (s: Source): BlocksSource =>
  ({ ...s, basis: { kind: "blocks", root: { kind: "own-node", node: "http://127.0.0.1:8789" }, bodies: "http://127.0.0.1:8789" } }) as unknown as BlocksSource;
const heights = [...truth.keys()];
const X = heights[Math.floor(heights.length / 2)]!;   // a boundary well inside the range
// Another chain: the fixture without its records at and above X's epoch, so its tuples differ from X up.
const fxB: BlockFixture = { ...fx, blocks: fx.blocks.filter((b) => b.height <= X - 30 || b.txs.length === 0) };
const truthB = await truthOf(fxB, TOP + 900);
/** A memory store whose reset first calls `before` (which may throw, failing the reset). */
const storeWith = (before: () => void): Store => {
  const mem = memoryStore();
  return { ...mem, open: (k) => mem.open(k), rows: (h) => mem.rows(h), boundaries: () => mem.boundaries(), headerWindow: () => mem.headerWindow(),
    commit: (c) => mem.commit(c), close: () => mem.close(), reset: async () => { before(); return mem.reset(); } };
};
const openAt = (top: { now: number }, table: Table, extra: { log?: string[]; reply?: (p: string) => Response | Promise<Response> | null; feed?: string; base?: string; maxRequests?: number; timeoutMs?: number } = {}) =>
  open({ source: growing(fx, top, { feed: extra.feed ?? "https://feed.example/x" }),
    reference: { base: extra.base ?? REF, fetch: reference(table, extra), ...(extra.maxRequests === undefined ? {} : { maxRequests: extra.maxRequests }),
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) } });

console.log("each kind of comparison:");
{
  const log: string[] = [], r = await openAt({ now: TOP }, (h) => truth.get(h) ?? null, { log });
  const s = await r.advance(), before = log.length;
  for (let i = 0; i < 50; i++) { r.status(); await new Promise((go) => setTimeout(go, 0)); }
  const plain = await open({ source: growing(fx, { now: TOP }, { feed: "https://feed.example/x" }) }), p = await plain.advance();
  ok("an equal reference: kind equal, no note, the verdict of a reader without one", s.compare?.kind === "equal" && s.compare.height === s.tuple?.height &&
    notes(s).length === 0 && whys(s) === whys(p) && s.level === p.level && s.tuple !== null);
  ok("paired: fifty status() calls read the reference no time", log.length === before && before <= 2);
  await r.close(); await plain.close();
}
{
  const r = await openAt({ now: TOP }, (h) => { const t = truth.get(h); return t === undefined ? null : { ...t, blockHash: flip(t.blockHash) }; });
  const s = await r.advance();
  ok("another block hash at the boundary: branch, TUPLE_BRANCH, streak 0", s.compare?.kind === "branch" && notes(s).join() === "TUPLE_BRANCH" && s.compare.streak === 0);
  await r.close();
}
{
  const r = await openAt({ now: TOP }, () => null), s = await r.advance();
  ok("a 404 by hash and by height: missing, no note", s.compare?.kind === "missing" && notes(s).length === 0);
  await r.close();
}
{
  const r = await openAt({ now: TOP }, (h) => { const t = truth.get(h); return t === undefined ? null : h >= X ? { ...t, eventsHash: flip(t.eventsHash) } : t; });
  const s = await r.advance();
  ok(`another events hash from ${X} up: records, the first differing boundary ${X} found, the one below it agreeing`, s.compare?.kind === "records" &&
    s.compare.height === X && s.compare.lastAgreeing === X - 30 && notes(s).join() === "TUPLE_RECORDS" && s.compare.streak === 1, JSON.stringify(s.compare));
  await r.close();
}
{
  const r = await openAt({ now: TOP }, (h) => { const t = truth.get(h); return t === undefined ? null : h >= X ? { ...t, stateHash: flip(t.stateHash) } : t; });
  const s = await r.advance();
  ok("the same events hash and another state hash: rules, with this package's gate table", s.compare?.kind === "rules" && s.compare.height === X &&
    notes(s).join() === "TUPLE_RULES" && s.compare.gates !== null && s.compare.gates.ACTIVATION_HEIGHT === 29_860);
  await r.close();
}

console.log("three runs at one first differing boundary, then the recount:");
const differs: Table = (h) => { const t = truth.get(h); return t === undefined ? null : h >= X ? { ...t, eventsHash: flip(t.eventsHash) } : t; };
/** A recount source over `f` that counts the steps asked of it. */
const counted = (f: BlockFixture, top: { now: number }) => { const s = growing(f, top), n = { steps: 0 }; return { n, src: { ...s, next: (c: Parameters<Source["next"]>[0]) => { n.steps++; return s.next(c); } } as Source }; };
{
  const top = { now: TOP }, rc = counted(fx, top);
  const r = await serverOpen({ source: growing(fx, top), reference: { base: REF, fetch: reference(differs) }, recount: asBlocks(rc.src) });
  const runs: ReplicaStatus[] = [], steps: number[] = [];
  for (let i = 0; i < 4; i++) { runs.push(await r.advance()); steps.push(rc.n.steps); top.now += 30; }
  ok("runs one and two report the difference and recount nothing", runs[0]!.compare?.streak === 1 && runs[1]!.compare?.streak === 2 &&
    runs[1]!.compare?.recount === null && steps[1] === 0, JSON.stringify({ streaks: runs.map((x) => x.compare?.streak), steps }));
  ok("run three recounts once: equal to the replica's own tuple, DIVERGENCE_CONFIRMED, and the replica keeps answering",
    runs[2]!.compare?.recount === "ours" && notes(runs[2]!).includes("DIVERGENCE_CONFIRMED") && runs[2]!.cursor !== null && steps[2]! > 0);
  ok("run four does not recount again", runs[3]!.compare?.streak === 4 && steps[3] === steps[2] && runs[3]!.compare?.recount === "ours");
  await r.close();
}
{
  // The reference is on chain B; a recount over that chain equals the reference, and the store is rebuilt.
  const top = { now: TOP }, r = await serverOpen({ source: growing(fx, top), reference: { base: REF, fetch: reference((h) => truthB.get(h) ?? null) }, recount: asBlocks(growing(fxB, top)) });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 3; i++) { s = await r.advance(); top.now += 30; }
  const rebuilt = r.status();
  ok("equal to the reference's tuple: the store is rebuilt, STORE_UNCONFIRMED while it refills", s?.compare?.recount === "reference" &&
    rebuilt.cursor === null && rebuilt.why.some((w) => w.code === "STORE_UNCONFIRMED"), JSON.stringify({ c: s?.compare, why: whys(rebuilt) }));
  const refilled = await r.advance();
  ok("the next advance refills it to the tip, confirmed", refilled.cursor?.height === top.now && !refilled.why.some((w) => w.code === "STORE_UNCONFIRMED"));
  await r.close();
}
{
  const top = { now: TOP }, r = await open({ source: growing(fx, top), reference: { base: REF, fetch: reference(differs) } });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 5; i++) { s = await r.advance(); top.now += 30; }
  ok("without a recount source: five runs report the difference and nothing acts", s?.compare?.streak === 5 && s.compare.recount === null && s.cursor !== null);
  await r.close();
}
{
  // A reference that differs from X up and a recount source that is down: the recount gives nothing, so it sides with
  // neither, and the store stays as it is.
  let resets = 0;
  const top = { now: TOP }, down: Source = { ...growing(fx, top), next: async () => ({ kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "down", retryAfterMs: 0 }) };
  const r = await serverOpen({ source: growing(fx, top), store: storeWith(() => { resets++; }), reference: { base: REF, fetch: reference(differs) }, recount: asBlocks(down) });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 6; i++) { s = await r.advance(); top.now += 30; }
  ok("a recount that sides with neither: no store reset over six runs, the replica keeps its cursor", s?.compare?.recount === "neither" && resets === 0 &&
    s.cursor?.height === top.now - 30 && !s.why.some((w) => w.code === "STORE_UNCONFIRMED"), JSON.stringify({ c: s?.compare, resets }));
  await r.close();
}

console.log("rebuilds stop while the store's source refills what the recount and the reference disagree with:");
{
  // The store's source serves chain A, the recount and the reference chain B: each rebuild refills A, and the difference
  // forms again three boundaries later.
  let resets = 0, table: Table = (h) => truthB.get(h) ?? null;
  const top = { now: TOP }, r = await serverOpen({ source: growing(fx, top), store: storeWith(() => { resets++; }),
    reference: { base: REF, fetch: reference((h) => table(h)) }, recount: asBlocks(growing(fxB, top)) });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 14; i++) { s = await r.advance(); top.now += 30; }
  const why = s === null ? [] : s.why.map((w) => w.code), note = s?.notes.find((n) => n.code === "SOURCES_DISAGREE");
  ok(`two rebuilds in fourteen runs, then none: STORE_UNCONFIRMED and SOURCES_DISAGREE (${resets} resets)`, resets === 2 && why.includes("STORE_UNCONFIRMED") &&
    note !== undefined && /recount and the reference/.test(note.detail ?? "") && s?.cursor?.height === top.now - 30 && s.compare?.recount === "reference",
    JSON.stringify({ resets, why, c: s?.compare }));
  const truthA = await truthOf(fx, TOP + 900);
  table = (h) => truthA.get(h) ?? null;
  const eq = await r.advance();
  top.now += 30;
  ok("an equal comparison lifts both", eq.compare?.kind === "equal" && !eq.why.some((w) => w.code === "STORE_UNCONFIRMED") && !eq.notes.some((n) => n.code === "SOURCES_DISAGREE"));
  table = (h) => truthB.get(h) ?? null;
  for (let i = 0; i < 4; i++) { s = await r.advance(); top.now += 30; }
  ok("and clears the count: the next recount that sides with the reference rebuilds again", resets === 3, String(resets));
  await r.close();
}
{
  const top = { now: TOP }, rc = counted(fx, top);
  const r = await serverOpen({ source: growing(fx, top), reference: { base: REF, fetch: reference((h) => truth.get(h) ?? null) }, recount: asBlocks(rc.src) });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 5; i++) { s = await r.advance(); top.now += 30; }
  ok("paired: an honest equal reference over five runs recounts nothing and rebuilds nothing", s?.compare?.kind === "equal" && rc.n.steps === 0 &&
    s.cursor?.height === top.now - 30 && notes(s).length === 0);
  await r.close();
}

console.log("a pin: PIN_DISPUTED at its boundary, TUPLE_RECORDS above it:");
{
  const P = 30_000, TIP = cap.to, clock = () => timeAt(TIP) * 1000 + 60_000;
  const upTo: BlockFixture = { ...fx, to: P, toHash: capHash(P), blocks: fx.blocks.filter((b) => b.height <= P) };
  const d = await derivePin(upTo), pin = { ...d.pin, log: async () => d.log };
  const plainR = await open({ ...local({ node: NODE, pin, fetch: node({ answers: cap.answers }).f }), clock }), honest = await plainR.advance();
  const top = honest.tuple!;
  await plainR.close();
  const at = (pinTuple: Tuple, newest: Tuple): Table => (h) => (h === P ? pinTuple : h === newest.height ? newest : null);
  const pinT: Tuple = { height: P, blockHash: d.pin.blockHash, eventsHash: d.pin.eventsHash, stateHash: d.pin.stateHash };
  const r1 = await open({ ...local({ node: NODE, pin, fetch: node({ answers: cap.answers }).f }), clock, reference: { base: REF, fetch: reference(at({ ...pinT, eventsHash: flip(pinT.eventsHash) }, top)) } });
  const s1 = await r1.advance();
  ok("the pin's block with another events hash at the pin: PIN_DISPUTED, not verified", s1.why.some((w) => w.code === "PIN_DISPUTED") && !s1.verified && honest.verified);
  await r1.close();
  const r2 = await open({ ...local({ node: NODE, pin, fetch: node({ answers: cap.answers }).f }), clock, reference: { base: REF, fetch: reference(at(pinT, { ...top, eventsHash: flip(top.eventsHash) })) } });
  const s2 = await r2.advance();
  ok(`a difference first seen above the pin (${top.height}): TUPLE_RECORDS and verified unchanged`, s2.verified && notes(s2).join() === "TUPLE_RECORDS" &&
    !s2.why.some((w) => w.code === "PIN_DISPUTED") && s2.compare?.height === top.height, JSON.stringify(s2.compare));
  await r2.close();
}

console.log("a hostile reference:");
{
  // Equal at the first run; from the second it says every boundary from the one it agreed on differs.
  let lying = false;
  const top = { now: TOP }, log: string[] = [];
  const table: Table = (h) => { const t = truth.get(h); return t === undefined ? null : lying ? { ...t, eventsHash: flip(t.eventsHash) } : t; };
  const r = await serverOpen({ source: growing(fx, top), reference: { base: REF, fetch: reference(table, { log }), maxRequests: 6 }, recount: asBlocks(growing(fx, top)) });
  await r.advance(); lying = true;
  const perRun: number[] = [];
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 4; i++) { top.now += 30; const n = log.length; s = await r.advance(); perRun.push(log.length - n); }
  ok("one that turns on a boundary it agreed on: reported, its own recount confirms the replica, nothing rebuilt", s?.compare?.recount === "ours" &&
    notes(s).includes("DIVERGENCE_CONFIRMED") && s.cursor?.height === top.now && perRun.every((n) => n <= 6), perRun.join(","));
  await r.close();
}
{
  const t0 = Date.now(), r = await openAt({ now: TOP }, () => null, { timeoutMs: 50, reply: () => new Promise<Response>(() => undefined) as unknown as Response });
  const s = await r.advance();
  ok("one that never answers: the advance ends within its time bound, unavailable, the replica synced", s.compare?.kind === "unavailable" && Date.now() - t0 < 5_000 &&
    s.cursor?.height === TOP && notes(s).length === 0, `${Date.now() - t0} ms`);
  await r.close();
}
{
  const top = { now: TOP }, rc = counted(fx, top);
  const other: Table = (h) => { const t = truth.get(h); return t === undefined ? null : { ...t, blockHash: flip(t.blockHash), eventsHash: flip(t.eventsHash) }; };
  const r = await serverOpen({ source: growing(fx, top), reference: { base: REF, fetch: reference(other) }, recount: asBlocks(rc.src) });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 5; i++) { s = await r.advance(); top.now += 30; }
  ok("one that answers another chain: a branch each run, never a difference, no streak, no recount", s?.compare?.kind === "branch" && s.compare.streak === 0 && rc.n.steps === 0);
  await r.close();
}
for (const [what, reply] of [
  ["an extra key", (p: string) => { const h = Number(/tuple\/([0-9]+)/.exec(p)?.[1]), t = truth.get(h); return t ? Response.json({ ok: true, ...t, extra: 1 }) : null; }],
  ["another block hash than the one asked", (p: string) => { const h = Number(/tuple\/([0-9]+)/.exec(p)?.[1]), t = truth.get(h); return t ? Response.json({ ok: true, ...t, blockHash: flip(t.blockHash) }) : null; }],
  ["another height", (p: string) => { const h = Number(/tuple\/([0-9]+)/.exec(p)?.[1]), t = truth.get(h); return t ? Response.json({ ok: true, ...t, height: h + 30 }) : null; }],
  ["a 404 that is not the resolver's", () => new Response("<html>not found</html>", { status: 404 })],
  ["a refusal by hash of the block it then gives by height", (p: string) => (p.includes(":") ? Response.json({ ok: false, error: "not this host's block at that height", height: Number(/tuple\/([0-9]+)/.exec(p)?.[1]) }, { status: 404 }) : null)],
  ["an answer over 4,096 bytes", (p: string) => { const h = Number(/tuple\/([0-9]+)/.exec(p)?.[1]), t = truth.get(h); return t ? new Response(JSON.stringify({ ok: true, ...t }) + " ".repeat(5_000), { status: 200 }) : null; }],
] as const) {
  const log: string[] = [], r = await openAt({ now: TOP }, (h) => truth.get(h) ?? null, { reply, log });
  const s = await r.advance(), n = log.length;
  for (let i = 0; i < 20; i++) { r.status(); await new Promise((go) => setTimeout(go, 0)); }
  ok(`an answer with ${what}: unavailable, no difference, and status() reads nothing to retry it`, s.compare?.kind === "unavailable" && notes(s).length === 0 &&
    log.length === n, s.compare?.detail ?? "");
  await r.close();
}
{
  const log: string[] = [], r = await openAt({ now: TOP }, (h) => { const t = truth.get(h); return t === undefined ? null : { ...t, eventsHash: flip(t.eventsHash) }; }, { log, maxRequests: 4 });
  const s = await r.advance();
  ok("a search over every held boundary stops at its request budget and reports what it found", log.length <= 4 && s.compare?.kind === "records", `${log.length} reads`);
  await r.close();
}

{
  // Over real HTTP on 127.0.0.1: an answer that declares a body over the cap is refused before its body is read, and
  // its connection is let go at once, not left open until a garbage collection. Paired: the same server answering the
  // tuple is read equal.
  let huge = true, sockets = 0;
  const server = createServer((q, res) => {
    const h = Number(/tuple\/([0-9]+)/.exec(q.url ?? "")?.[1]), t = truth.get(h);
    if (huge) { res.writeHead(200, { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) }); res.write("{"); return; }
    if (t === undefined) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "not a kept boundary", height: h })); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, ...t }));
  });
  server.on("connection", (c) => { sockets++; c.on("close", () => { sockets--; }); });
  await new Promise<void>((go) => server.listen(0, "127.0.0.1", go));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/trade/api`;
  const r = await open({ source: growing(fx, { now: TOP }, { feed: "https://feed.example/x" }), reference: { base } });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 10; i++) s = await r.advance();
  await new Promise((go) => setTimeout(go, 200));
  ok(`ten answers over the cap by their Content-Length: unavailable each time, ${sockets} connections left open`, s?.compare?.kind === "unavailable" &&
    /over 4096 bytes/.test(s.compare.detail ?? "") && sockets === 0, s?.compare?.detail ?? "");
  huge = false;
  const honest = await r.advance();
  ok("paired: the same server answering the tuple is read equal", honest.compare?.kind === "equal", JSON.stringify(honest.compare));
  await r.close();
  server.closeAllConnections();
  await new Promise((go) => server.close(go));
}

console.log("a reference on the store's own origin:");
{
  const base = "https://feed.example/trade/api", table: Table = (h) => truth.get(h) ?? null;
  const same = await openAt({ now: TOP }, table, { base }), s = await same.advance();
  const plain = await open({ source: growing(fx, { now: TOP }, { feed: "https://feed.example/x" }) }), p = await plain.advance();
  ok("equal tuples from the same origin: labelled so, the level and the verdict as without it, no witness confirmation", s.compare?.kind === "equal" &&
    s.compare.sameOrigin && s.level === p.level && whys(s) === whys(p) && s.witnessed === null && p.witnessed === null);
  const other = await openAt({ now: TOP }, table), o = await other.advance();
  ok("paired: another origin is not labelled same-origin", o.compare?.sameOrigin === false);
  await same.close(); await plain.close(); await other.close();
}

console.log("the pin read again until an equal answer:");
{
  const P = 30_000, served = { answers: cap.answers, tip: 30_150 }, clock = () => timeAt(served.tip) * 1000 + 60_000;
  const upTo: BlockFixture = { ...fx, to: P, toHash: capHash(P), blocks: fx.blocks.filter((b) => b.height <= P) };
  const d = await derivePin(upTo), pin = { ...d.pin, log: async () => d.log };
  const pinT: Tuple = { height: P, blockHash: d.pin.blockHash, eventsHash: d.pin.eventsHash, stateHash: d.pin.stateHash };
  let wrong = true;
  const log: string[] = [], pinReads = () => log.filter((x) => x.includes(`/${P}:`)).length;
  const r = await open({ ...local({ node: NODE, pin, fetch: node(served).f }), clock, reference: { base: REF, fetch: reference((h) => (h === P ? (wrong ? { ...pinT, eventsHash: flip(pinT.eventsHash) } : pinT) : null), { log }) } });
  const first = await r.advance();
  wrong = false;
  const after: ReplicaStatus[] = [];
  for (let i = 0; i < 5; i++) { served.tip += 30; after.push(await r.advance()); }
  ok("wrong at the pin once: PIN_DISPUTED, then right at the next new boundary: verified again", first.why.some((w) => w.code === "PIN_DISPUTED") &&
    !first.verified && after.every((x) => x.verified && !x.why.some((w) => w.code === "PIN_DISPUTED")), after.map((x) => whys(x)).join(" | "));
  ok("an equal answer is kept: two pin reads in six advances", pinReads() === 2, String(pinReads()));
  await r.close();
  const log2: string[] = [], at = { answers: cap.answers, tip: cap.to };
  const r2 = await open({ ...local({ node: NODE, pin, fetch: node(at).f }), clock: () => timeAt(cap.to) * 1000 + 60_000, reference: { base: REF, fetch: reference(() => null, { log: log2 }) } });
  for (let i = 0; i < 10; i++) await r2.advance();
  ok("a reference that answers 404 at the pin: one read in ten advances at one tip, verified unchanged", log2.filter((x) => x.includes(`/${P}:`)).length === 1 &&
    r2.status().verified, String(log2.length));
  await r2.close();
}

console.log("the streak counts new boundaries:");
{
  const top = { now: TOP }, r = await open({ source: growing(fx, top), reference: { base: REF, fetch: reference(differs) } }), st: number[] = [];
  for (let i = 0; i < 5; i++) st.push((await r.advance()).compare!.streak);
  top.now += 30; st.push((await r.advance()).compare!.streak);
  ok("five advances at one tip leave it at 1; the next boundary makes it 2", st.join() === "1,1,1,1,1,2", st.join());
  await r.close();
}

console.log("reads do not wait on a reference:");
{
  const r = await openAt({ now: TOP }, () => null, { reply: () => new Promise<Response>(() => undefined) as unknown as Response });
  const t0 = Date.now(), a = await r.name("alice", { waitMs: 3_000 }), ms = Date.now() - t0;
  ok("a read with waitMs 3,000 against a reference that never answers returns once the step is committed", ms < 500 && a.at !== null, `${ms} ms`);
  await r.close();
}

console.log("the recount: a block source, ended by an abort or close():");
{
  let thrown: unknown = null;
  await serverOpen({ source: growing(fx, { now: TOP }), reference: { base: REF, fetch: reference(differs) }, recount: growing(fx, { now: TOP }) as unknown as BlocksSource }).catch((e: unknown) => { thrown = e; });
  ok("a feed given as recount is refused at open", thrown instanceof ReplicaConfigError && /block source/.test((thrown as Error).message));
  // A recount source whose every step waits for its signal or two seconds.
  const top = { now: TOP }, base = growing(fx, top);
  const slow = asBlocks({ ...base, next: (c) => new Promise((go, no) => { const t = setTimeout(() => go(base.next(c)), 2_000); c.signal.addEventListener("abort", () => { clearTimeout(t); no(c.signal.reason); }, { once: true }); }) });
  const r = await serverOpen({ source: growing(fx, top), reference: { base: REF, fetch: reference(differs) }, recount: slow });
  await r.advance(); top.now += 30; await r.advance(); top.now += 30;
  const c = new AbortController(), third = r.advance({ signal: c.signal });
  await new Promise((go) => setTimeout(go, 100));
  c.abort("stop");
  const t0 = Date.now(), s3 = await third, ms = Date.now() - t0;
  ok("the advance's abort ends a recount at once and settles nothing", ms < 500 && s3.compare?.recount === null, `${ms} ms, recount ${s3.compare?.recount}`);
  top.now += 30;
  const again = r.advance();
  await new Promise((go) => setTimeout(go, 100));
  const t1 = Date.now();
  await r.close();
  ok("close() during a recount returns without waiting it out", Date.now() - t1 < 500, `${Date.now() - t1} ms`);
  await again.catch(() => undefined);
}

console.log("the recount finds the store wrong and its reset throws:");
{
  let broken = true;
  const store = storeWith(() => { if (broken) throw new Error("EIO"); });
  const top = { now: TOP }, r = await serverOpen({ source: growing(fx, top), store, reference: { base: REF, fetch: reference((h) => truthB.get(h) ?? null) }, recount: asBlocks(growing(fxB, top)) });
  let s: ReplicaStatus | null = null;
  for (let i = 0; i < 4; i++) { s = await r.advance(); top.now += 30; }
  ok("STORE_UNCONFIRMED while the reset is owed, through later advances", s !== null && s.why.some((w) => w.code === "STORE_UNCONFIRMED") && s.cursor !== null &&
    /reset failed/.test(s.compare?.detail ?? ""), JSON.stringify({ why: s && whys(s), d: s?.compare?.detail }));
  broken = false;
  const fixed = await r.advance(), refilled = await r.advance();
  ok("tried again at the next boundary: the store is reset, then refilled and confirmed", fixed.cursor === null && fixed.why.some((w) => w.code === "STORE_UNCONFIRMED") &&
    refilled.cursor?.height === top.now && !refilled.why.some((w) => w.code === "STORE_UNCONFIRMED"), JSON.stringify({ c: fixed.cursor?.height, w: whys(refilled) }));
  await r.close();
}

console.log("an abort with a reason that is not an Error:");
{
  const hang = (_p: string) => new Promise<Response>(() => undefined) as unknown as Response;
  const r = await openAt({ now: TOP }, () => null, { reply: hang }), plain = await open({ source: growing(fx, { now: TOP }) });
  const c = new AbortController(), c2 = new AbortController();
  setTimeout(() => { c.abort("stop"); c2.abort("stop"); }, 50);
  const a = await r.advance({ signal: c.signal }).then(() => "resolves", (e: unknown) => `rejects ${String(e)}`);
  const b = await plain.advance({ signal: c2.signal }).then(() => "resolves", (e: unknown) => `rejects ${String(e)}`);
  ok("advance() resolves with a reference as without one, and the abort concludes no comparison", a === "resolves" && b === "resolves" && r.status().compare === null,
    `${a} / ${b} / ${JSON.stringify(r.status().compare)}`);
  await r.close(); await plain.close();
}

void FINAL_DEPTH;
done("cairnx-replica compare");
