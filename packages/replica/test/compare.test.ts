// The comparison with a reference (compare.ts) through open(): each kind of difference a mock reference can show, the
// first differing boundary found by the search, PIN_DISPUTED at a pin and TUPLE_RECORDS above it, S4's streak before a
// recount acts and both of its outcomes, and a hostile reference (one that lies about a boundary it agreed on, one that
// never answers, one on another chain, answers out of shape or over size, a search held to its request budget). Paired
// throughout: an honest equal reference adds no note, no request in status() and no recount, and a reference on the
// store's own origin is labelled so and changes no level and no verdict.
import { FINAL_DEPTH } from "@inversealtruism/cairnx-core";
import { memoryStore, open, replicaLoop, type BlocksSource, type ReplicaStatus, type Source, type Tuple } from "../src/index.js";
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
// The recount reads blocks in production; here a fixture source over the same records stands in for it.
const asBlocks = (s: Source): BlocksSource => s as unknown as BlocksSource;
const heights = [...truth.keys()];
const X = heights[Math.floor(heights.length / 2)]!;   // a boundary well inside the range
const openAt = (top: { now: number }, table: Table, extra: { log?: string[]; reply?: (p: string) => Response | Promise<Response> | null; feed?: string; base?: string; maxRequests?: number; timeoutMs?: number } = {}) =>
  open({ source: growing(fx, top, { feed: extra.feed ?? "https://feed.example/x" }),
    reference: { base: extra.base ?? REF, fetch: reference(table, extra), ...(extra.maxRequests === undefined ? {} : { maxRequests: extra.maxRequests }),
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) } });

console.log("each kind of comparison:");
{
  const log: string[] = [], r = await openAt({ now: TOP }, (h) => truth.get(h) ?? null, { log });
  const s = await r.advance(), before = log.length;
  for (let i = 0; i < 50; i++) r.status();
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

console.log("S4: three runs at one first differing boundary, then the recount:");
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
  // The reference's chain: the fixture without its records at and above X's epoch, so its tuples differ from X up; a
  // recount over that chain equals the reference, and the store is rebuilt.
  const fxB: BlockFixture = { ...fx, blocks: fx.blocks.filter((b) => b.height <= X - 30 || b.txs.length === 0) };
  const truthB = await truthOf(fxB, TOP + 300);
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
  ["an extra key", (p: string) => (p.includes(":") ? Response.json({ ok: true, height: 0, blockHash: "", eventsHash: "", stateHash: "", extra: 1 }) : null)],
  ["another height", (p: string) => { const h = Number(/tuple\/([0-9]+)/.exec(p)?.[1]), t = truth.get(h); return t ? Response.json({ ok: true, ...t, height: h + 30 }) : null; }],
  ["a 404 that is not the resolver's", () => new Response("<html>not found</html>", { status: 404 })],
  ["a refusal by hash of the block it then gives by height", (p: string) => (p.includes(":") ? Response.json({ ok: false, error: "not this host's block at that height", height: Number(/tuple\/([0-9]+)/.exec(p)?.[1]) }, { status: 404 }) : null)],
  ["an answer over 4,096 bytes", (p: string) => { const h = Number(/tuple\/([0-9]+)/.exec(p)?.[1]), t = truth.get(h); return t ? new Response(JSON.stringify({ ok: true, ...t }) + " ".repeat(5_000), { status: 200 }) : null; }],
] as const) {
  const r = await openAt({ now: TOP }, (h) => truth.get(h) ?? null, { reply });
  const s = await r.advance();
  ok(`an answer with ${what}: unavailable, no difference`, s.compare?.kind === "unavailable" && notes(s).length === 0, s.compare?.detail ?? "");
  await r.close();
}
{
  const log: string[] = [], r = await openAt({ now: TOP }, (h) => { const t = truth.get(h); return t === undefined ? null : { ...t, eventsHash: flip(t.eventsHash) }; }, { log, maxRequests: 4 });
  const s = await r.advance();
  ok("a search over every held boundary stops at its request budget and reports what it found", log.length <= 4 && s.compare?.kind === "records", `${log.length} reads`);
  await r.close();
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

void FINAL_DEPTH;
done("cairnx-replica compare");
