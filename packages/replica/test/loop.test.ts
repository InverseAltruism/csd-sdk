// The loop over fixtureSource and memoryStore, checked against the hashes cairnx-core pins over the same corpus
// (test/vectors/hashes.json), never against values this test computes: both hashes at the 21 pinned heights, after a
// restart, at the boundaries, after a fork cut from the fixture, through a drive cut at every 97th block, and not at
// all from rows changed behind the loop's back. Boundary replays are counted through fullReplay's clock, which a replay
// reads twice.
import { CAIRNX_EVENT_RULE, EPOCH_LEN, FINAL_DEPTH, canonicalJson, stateHash, type CairnXState } from "@inversealtruism/cairnx-core";
import { fullReplay, memoryStore, replicaLoop, type BlockRow, type Boundary, type Materializer, type Source, type Store, type StoreMeta } from "../src/index.js";
import { STATE_WINDOW } from "../src/loop.js";
import { ROWS_HASH_START, rowsHashStep } from "../src/rowshash.js";
import { fixtureSource, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx, pinned } from "./core-files.js";

const hashOf = (s: CairnXState | null) => (s === null ? null : stateHash(s));
const rowsOf = async (s: Store) => { const out: BlockRow[] = []; for await (const r of s.rows(0)) out.push(r); return out; };
const metaOf = async (s: Store, src: Source) => { const o = await s.open({ format: 1, rule: CAIRNX_EVENT_RULE, basis: src.basis }); return o.ok ? o.meta : null; };
function counted() {
  let reads = 0;
  return { m: fullReplay({ now: () => { reads++; return performance.now(); } }), replays: () => reads / 2 };
}
async function drive(source: Source, store: Store = memoryStore(), maxBlocks = 64, c = counted()) {
  const loop = replicaLoop({ source, store, maxBlocks, materializer: c.m });
  const opened = await loop.open(), status = await loop.advance();
  return { loop, store, opened, status, replays: c.replays(), count: c.replays };
}
const stated = (b: Boundary[]) => b.filter((x) => x.stateHash !== null).map((x) => x.height);
const heights = Object.keys(pinned).map(Number), want = (h: number) => pinned[String(h)]!;

console.log("fixtureSource through the loop into memoryStore:");
const main = await drive(fixtureSource(fx));
const wrong = heights.filter((h) => main.loop.eventsHashAt(h) !== want(h).eventsHash || hashOf(main.loop.stateAt(fx.to, fx.to - h)) !== want(h).stateHash);
ok(`both hashes at the ${heights.length} pinned heights equal hashes.json, read as the deep view below the tip (wrong at: ${wrong.join() || "none"})`,
  heights.length === 21 && wrong.length === 0);
ok("the drive ends at the fixture's end with its 1,133 events and nothing refused", main.opened.ok && main.status.cursor?.hash === fx.toHash &&
  main.status.eventCount === 1133 && main.status.eventsHash === want(117_000).eventsHash && main.status.lastError === null);
const mainStated = stated(await main.store.boundaries());
ok(`the drive replays only the boundaries at most ${STATE_WINDOW} below its tip (${main.replays} replays, at ${mainStated.join(", ")})`,
  main.replays === mainStated.length && mainStated.every((h) => fx.to - h <= STATE_WINDOW) && main.replays <= 24);
const tipState = main.loop.stateAt(fx.to, 0);
ok("a tip's state is memoized and its replay timed", tipState !== null && main.loop.stateAt(fx.to, 0) === tipState && typeof main.loop.status().replayMs === "number");
const rowsA = await rowsOf(main.store), restart = replicaLoop({ source: fixtureSource(fx), store: main.store });
ok("after a restart the rows are read back, checked and replayed to the same state", (await restart.open()).ok &&
  hashOf(restart.stateAt(fx.to, 0)) === want(117_000).stateHash && restart.status().cursor?.hash === fx.toHash);
const both = replicaLoop({ source: fixtureSource(fx), store: memoryStore() }), [, second] = await Promise.all([both.advance(), both.advance()]);
ok("two advances at once run one after the other", second.eventsHash === want(117_000).eventsHash && second.lastError === null);

const casStore = memoryStore(), early = replicaLoop({ source: fixtureSource(fx), store: casStore });
await early.open();
await drive(fixtureSource(fx), casStore);   // a second writer fills the store after the first loop read it
const late = await early.advance();
ok("a loop whose commit finds the cursor moved by another writer goes on from the store's", late.cursor?.hash === fx.toHash &&
  late.eventsHash === want(117_000).eventsHash && late.lastError === null);
const real = fullReplay(), mStore = memoryStore();
let boom = true;
const failing: Materializer = { load: (r, h) => real.load(r, h), apply: (r, h) => real.apply(r, h), rollback: (t) => real.rollback(t),
  stateAt: (t, d) => { if (boom) { boom = false; throw new Error("replay failed"); } return real.stateAt(t, d); }, get replayMs() { return real.replayMs; } };
const ml = replicaLoop({ source: fixtureSource(fx), store: mStore, materializer: failing }), thrown = await ml.advance().then(() => null, (e: unknown) => e);
const kept = canonicalJson((await metaOf(mStore, fixtureSource(fx)))?.cursor) === canonicalJson(ml.status().cursor), again = await ml.advance();
ok("a replay that throws at a boundary rejects advance with the loop still equal to its store, and the next advance resumes",
  thrown instanceof Error && kept && again.eventsHash === want(117_000).eventsHash && canonicalJson(await rowsOf(mStore)) === canonicalJson(rowsA));

console.log("boundaries:");
// Blocks without transactions at the pinned heights that are boundaries, and FINAL_DEPTH - 1 and FINAL_DEPTH above them.
const atB = heights.filter((h) => h % EPOCH_LEN === 0 && h <= fx.to - FINAL_DEPTH);
const synth = (h: number) => `0x${"b".repeat(58)}${h.toString(16).padStart(6, "0")}`;
const extra = atB.flatMap((b) => [b, b + FINAL_DEPTH - 1, b + FINAL_DEPTH]).filter((h) => !fx.blocks.some((x) => x.height === h));
const fxPlus: BlockFixture = { ...fx, blocks: [...fx.blocks, ...extra.map((height) => ({ height, hash: synth(height), txs: [] }))].sort((a, b) => a.height - b.height) };
const known = fxPlus.blocks.map((b) => b.height).filter((h) => h % EPOCH_LEN === 0), bStore = memoryStore(), plus = fixtureSource(fxPlus), off: string[] = [];
let looked = 0;
const watched: Source = { ...plus, async next(ctx) {   // before each step: the boundaries the steps so far committed
  const top = ctx.cursor?.height ?? 0, got = (await bStore.boundaries()).map((b) => b.height).join(), exp = known.filter((h) => h <= top - FINAL_DEPTH).join();
  looked++;
  if (got !== exp) off.push(`at ${top}: [${got}] not [${exp}]`);
  return plus.next(ctx);
} };
await drive(watched, bStore, 1);
const held = await bStore.boundaries(), tuples = atB.map((b) => held.find((x) => x.height === b));
ok(`after each of ${looked} one-block steps the boundaries are the multiples of ${EPOCH_LEN} whose hash is held, ${FINAL_DEPTH} deep (${off[0] ?? "no difference"})`,
  off.length === 0 && looked === fxPlus.blocks.length && held.length === known.filter((h) => h <= fx.to - FINAL_DEPTH).length);
ok(`the boundaries at ${atB.join(", ")}, far below the tip, hold the block hash and the pinned events hash, and no state hash`, atB.length === 5 &&
  tuples.every((t, i) => t?.hash === synth(atB[i]!) && t.eventsHash === want(atB[i]!).eventsHash && t.stateHash === null));
// The same blocks up to a tip 600 above the boundary at 60,000: only the boundaries in the window are replayed.
const tipW = 60_600, fxW: BlockFixture = { ...fxPlus, to: tipW, toHash: synth(tipW), blocks: fxPlus.blocks.filter((b) => b.height <= tipW) };
const win = await drive(fixtureSource(fxW)), winHeld = await win.store.boundaries(), at60 = winHeld.find((b) => b.height === 60_000);
ok(`a drive from activation to ${tipW} replays only the boundaries at most ${STATE_WINDOW} below it (${win.replays} of ${winHeld.length}, at ${stated(winHeld).join(", ")})`,
  winHeld.length === fxW.blocks.filter((b) => b.height % EPOCH_LEN === 0 && b.height <= tipW - FINAL_DEPTH).length && stated(winHeld).join() === winHeld.filter((b) => tipW - b.height <= STATE_WINDOW).map((b) => b.height).join() &&
  win.replays === stated(winHeld).length && at60?.stateHash === want(60_000).stateHash && at60.eventsHash === want(60_000).eventsHash);
const old = win.loop.boundary(46_440);
win.loop.stateAt(tipW, 0); win.loop.stateAt(tipW, 100);   // two other replays, past fullReplay's memo of two
const again46 = win.loop.boundary(46_440);
ok("an old boundary's state hash is replayed on demand once and is the pinned one; a stored one and a height without a boundary cost none",
  old?.stateHash === want(46_440).stateHash && old.eventsHash === want(46_440).eventsHash && again46?.stateHash === old.stateHash &&
  win.loop.boundary(60_000)?.stateHash === want(60_000).stateHash && win.loop.boundary(46_441) === null && win.count() === win.replays + 3);

console.log("a fork cut from the fixture:");
const evH = new Set(corpus.events.map((e) => e.height)), cutAt = fx.blocks.findIndex((b, i) => i >= 600 && evH.has(b.height)), cut = fx.blocks[cutAt]!;
const other = (h: string) => `${h.slice(0, -4)}${h.endsWith("ffff") ? "0000" : "ffff"}`;
const fxB: BlockFixture = { ...fx, toHash: other(fx.toHash),
  blocks: [...fx.blocks.slice(0, cutAt + 1), ...fx.blocks.slice(cutAt + 1).filter((_, i) => i % 3 !== 1).map((b) => ({ ...b, hash: other(b.hash) }))] };
const onB = new Map([...fxB.blocks.map((b) => [b.height, b.hash] as const), [fxB.to, fxB.toHash]]), branch = fixtureSource(fxB);
const forked: Source = { ...branch, next: async (ctx) => (ctx.cursor !== null && ctx.cursor.height > cut.height && onB.get(ctx.cursor.height) !== ctx.cursor.hash
  ? { kind: "reorg", to: { height: cut.height, hash: ctx.hashAt(cut.height) ?? "" }, tip: { height: fxB.to, hash: fxB.toHash, time: 0 } } : branch.next(ctx)) };
const alone = await drive(fixtureSource(fxB)), forkLoop = replicaLoop({ source: forked, store: main.store });
const fillAt = (await alone.store.boundaries()).find((b) => b.height > cut.height && b.stateHash === null)!.height;
await forkLoop.open();
const filledA = forkLoop.boundary(fillAt)?.stateHash, aFill = main.loop.boundary(fillAt)?.stateHash;
const fork = { loop: forkLoop, status: await forkLoop.advance() }, rowsF = await rowsOf(main.store), fillB = alone.loop.boundary(fillAt)?.stateHash;
await main.loop.open();
ok(`a state hash filled at ${fillAt} before the reorg is not kept for the second branch, in the loop that rolled back or one that reopens`,
  filledA === aFill && filledA !== fillB && forkLoop.boundary(fillAt)?.stateHash === fillB && main.loop.boundary(fillAt)?.stateHash === fillB);
ok(`the loop rolled back from the first branch's tip to block ${cut.height}, a held row`, fork.status.lastReorg?.from.hash === fx.toHash &&
  fork.status.lastReorg.to.height === cut.height && rowsA.some((r) => r.height === cut.height && r.hash === cut.hash));
ok("it replayed to the second branch's hashes, those of a store filled from that branch alone", fork.status.cursor?.hash === fxB.toHash &&
  fork.status.eventsHash === alone.status.eventsHash && fork.status.eventsHash !== want(117_000).eventsHash &&
  hashOf(fork.loop.stateAt(fx.to, 0)) === hashOf(alone.loop.stateAt(fx.to, 0)));
ok("the store holds the second branch's rows and boundaries, none of the first branch's above the cut",
  canonicalJson(rowsF) === canonicalJson(await rowsOf(alone.store)) && rowsF.every((r) => r.height <= cut.height || onB.get(r.height) === r.hash) &&
  canonicalJson(await main.store.boundaries()) === canonicalJson(await alone.store.boundaries()));

console.log("a drive cut at every 97th block:");
const nth = new Map(fx.blocks.map((b, i) => [b.height, i + 1])), aStore = memoryStore(), inner = fixtureSource(fx), fired: number[] = [];
let ctl = new AbortController();
const cutting: Source = { ...inner, async next(ctx) {
  const s = await inner.next(ctx), n = s.kind === "blocks" ? s.blocks.map((b) => nth.get(b.height)!).find((i) => i % 97 === 0 && !fired.includes(i)) : undefined;
  if (n === undefined) return s;
  fired.push(n);
  if (fired.length % 2 === 1) throw new Error(`cut at block ${n}`);
  ctl.abort();
  return s;   // returned after the step's signal aborted
} };
let last = null as Awaited<ReturnType<typeof drive>>["status"] | null, resumed = 0, clean = 0;
for (let run = 0; run < 20 && last?.cursor?.height !== fx.to; run++) {
  const loop = replicaLoop({ source: cutting, store: aStore }), before = last?.cursor ?? null;
  await loop.open();
  if (canonicalJson(loop.status().cursor) === canonicalJson(before)) resumed++;
  ctl = new AbortController();
  last = await loop.advance({ signal: ctl.signal });
  const cutHeight = fx.blocks[(fired.at(-1) ?? 0) - 1]?.height ?? Number.POSITIVE_INFINITY, stored = await metaOf(aStore, inner);
  if (last.cursor?.height === fx.to || (last.cursor!.height < cutHeight && canonicalJson(stored?.cursor) === canonicalJson(last.cursor) &&
    (fired.length % 2 === 0 || last.lastError?.code === "SOURCE_UNAVAILABLE"))) clean++;
}
ok(`each of ${fired.length} cuts (a throw or an aborted signal) committed nothing of its step, and each run resumed from the store (${resumed} of ${clean})`,
  fired.join() === "97,194,291,388,485,582,679,776" && resumed === 9 && clean === 9);
ok("the drive ends with the pinned hashes and the rows of the uncut drive", last?.eventsHash === want(117_000).eventsHash &&
  canonicalJson(await rowsOf(aStore)) === canonicalJson(rowsA));

console.log("rows changed behind the loop's back:");
const flip = (hex: string) => `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
type Event = BlockRow["events"][number];
const firstAttest = rowsA.findIndex((r) => r.events[0]?.kind === "attest"), firstPropose = rowsA.findIndex((r) => r.events[0]?.kind === "propose");
const attest = rowsA[firstAttest]!.events[0]!, attestOn = attest.kind === "attest" ? attest.proposalId : "";
const otherPropose = rowsA.slice(0, firstAttest).flatMap((r) => r.events).find((e) => e.kind === "propose" && e.id !== attestOn);
const changedRow = (f: (r: BlockRow) => BlockRow, at = rowsA.findIndex((r) => r.events.length > 1 && r.height % EPOCH_LEN !== 0)): Store =>
  ({ ...aStore, async *rows(from) { let i = 0; for await (const r of aStore.rows(from)) yield i++ === at ? f(r) : r; } });
const recomputedAt = rowsA.findIndex((r, i) => i > 0 && i < rowsA.length - 1 && r.events[0]?.kind === "propose");
const reordered = (f: (rows: BlockRow[]) => BlockRow[]): Store => ({ ...aStore, async *rows(from) { yield* f(await rowsOf({ ...aStore, rows: () => aStore.rows(from) })); } });
const changedEvent = (f: (e: Event) => object, at = firstPropose) =>
  changedRow((r) => ({ ...r, events: r.events.map((e, i) => (i === 0 ? { ...e, ...f(e) } : e)) as Event[] }), at);
const propose = (f: (e: Extract<Event, { kind: "propose" }>) => object) => changedEvent((e) => (e.kind === "propose" ? f(e) : {}), firstPropose);
const attested = (f: (e: Extract<Event, { kind: "attest" }>) => object) => changedEvent((e) => (e.kind === "attest" ? f(e) : {}), firstAttest);
const changedBounds = (f: (b: Boundary[]) => [Boundary, number]): Store =>
  ({ ...aStore, boundaries: async () => { const b = await aStore.boundaries(), [x, i] = f(b); b[i] = x; return b; } });
const changedMeta = (f: (m: StoreMeta) => Partial<StoreMeta>): Store =>
  ({ ...aStore, open: async (k) => { const o = await aStore.open(k); return o.ok && o.meta ? { ok: true, meta: { ...o.meta, ...f(o.meta) } } : o; } });
// A row changed and the rows hash rewritten after it, row by row and in the meta, so only the contract is left to refuse it.
const rechained = (f: (r: BlockRow) => BlockRow, at: number): Store => {
  const rows = rowsA.map((r, i) => (i === at ? f(r) : r)).reduce<BlockRow[]>((out, r) =>
    [...out, { ...r, rowsHash: rowsHashStep(out.at(-1)?.rowsHash ?? ROWS_HASH_START, r) }], []);
  return { ...changedMeta(() => ({ rowsHash: rows.at(-1)!.rowsHash })), async *rows(from) { yield* rows.filter((r) => r.height >= from); } };
};
const cases: [string, Store][] = [
  ["one byte of an event's author changed", changedEvent((e) => (e.kind === "propose" ? { proposer: flip(e.proposer) } : { attester: flip(e.attester) }))],
  ["one byte of an event's id changed", changedEvent((e) => (e.kind === "propose" ? { id: flip(e.id) } : { txid: flip(e.txid) }))],
  ["an event's height changed", changedEvent((e) => ({ height: e.height + 1 }))],
  ["a row's events hash changed", changedRow((r) => ({ ...r, eventsHash: flip(r.eventsHash) }))],
  ["a row's rows hash changed", changedRow((r) => ({ ...r, rowsHash: flip(r.rowsHash) }))],
  ["a row changed with its own rows hash recomputed, caught through the meta", changedRow((r) => {
    const events = r.events.map((e, i) => (i === 0 && e.kind === "propose" ? { ...e, uri: `${e.uri} ` } : e));
    return { ...r, events, rowsHash: rowsHashStep(rowsA[recomputedAt - 1]!.rowsHash, { ...r, events }) };
  }, recomputedAt)],
  ["an Attest's proposal changed to an id never proposed", attested(() => ({ proposalId: `0x${"9".repeat(64)}` }))],
  ["an Attest moved to another held Propose", attested(() => ({ proposalId: (otherPropose as { id: string }).id }))],
  ["an Attest moved to an id never proposed, with the rows hash rewritten to match", rechained((r) =>
    ({ ...r, events: r.events.map((e, i) => (i === 0 && e.kind === "attest" ? { ...e, proposalId: `0x${"9".repeat(64)}` } : e)) }), firstAttest)],
  ["one byte of a Propose's uri changed", propose((e) => ({ uri: `${e.uri.slice(0, -1)}${e.uri.endsWith("}") ? " " : "}"}` }))],
  ["a Propose's paidTo changed", propose((e) => ({ paidTo: { ...e.paidTo, [`0x${"77".repeat(20)}`]: "1" } }))],
  ["a Propose's payloadHash changed", propose((e) => ({ payloadHash: flip(e.payloadHash) }))],
  ["a Propose's expiresEpoch changed", propose((e) => ({ expiresEpoch: e.expiresEpoch + 1 }))],
  ["an Attest's score changed", attested((e) => ({ score: e.score + 1 }))],
  ["an Attest's confidence changed", attested((e) => ({ confidence: e.confidence + 1 }))],
  ["an event's kind changed", propose(() => ({ kind: "attest" }))],
  ["a row's block hash changed", changedRow((r) => ({ ...r, hash: flip(r.hash!) }))],
  ["a row dropped", reordered((rows) => rows.filter((_, i) => i !== 300))],
  ["two rows swapped", reordered((rows) => [...rows.slice(0, 300), rows[301]!, rows[300]!, ...rows.slice(302)])],
  ["a boundary's events hash changed", changedBounds((b) => [{ ...b[3]!, eventsHash: flip(b[3]!.eventsHash) }, 3])],
  ["a boundary's block hash changed", changedBounds((b) => [{ ...b[3]!, hash: flip(b[3]!.hash) }, 3])],
  ["a boundary added above the cursor", changedBounds((b) => [{ ...b.at(-1)!, height: fx.to + EPOCH_LEN, eventsHash: rowsA.at(-1)!.eventsHash }, b.length])],
  ["the meta's events hash changed", changedMeta((m) => ({ eventsHash: flip(m.eventsHash) }))],
  ["the meta's rows hash changed", changedMeta((m) => ({ rowsHash: flip(m.rowsHash) }))],
  ["the meta's event count changed", changedMeta((m) => ({ eventCount: m.eventCount - 1 }))],
  ["the meta's cursor moved below the last row", changedMeta((m) => ({ cursor: { height: rowsA.at(-1)!.height - 1, hash: m.cursor!.hash } }))],
];
for (const [name, store] of cases) {
  const l = replicaLoop({ source: inner, store }), o = await l.open();
  ok(`${name}: the store is corrupt and no state is replayed`, !o.ok && o.reset === "corrupt" && l.stateAt(fx.to, 0) === null && l.status().store === "corrupt");
}
const asIs = [changedRow((r) => r), changedEvent(() => ({})), reordered((rows) => rows)];
const unchanged = await Promise.all(asIs.map(async (store) => { const l = replicaLoop({ source: inner, store }); return (await l.open()).ok && hashOf(l.stateAt(fx.to, 0)); }));
ok("the same store read through each of the same paths, unchanged, opens and replays", unchanged.every((h) => h === want(117_000).stateHash) &&
  typeof otherPropose === "object" && firstPropose >= 0 && firstAttest >= 0);

done("cairnx-replica loop");
