// One step at a time through a scripted source: each lie a source can tell is refused whole as SOURCE_MALFORMED with
// nothing committed, and an honest step after them is taken; a source that cannot answer is backed off; advance keeps
// its budget; close() aborts a step in flight; fullReplay answers no height it does not hold.
import { CAIRNX_EVENT_RULE, EVENTS_HASH_START, canonicalJson, resolve, type ChainEvent } from "@inversealtruism/cairnx-core";
import {
  fullReplay, memoryStore, replicaLoop, type BlockEvents, type BlockRow, type Source, type Step, type StepContext, type Store, type TipView,
} from "../src/index.js";
import { ROWS_HASH_START } from "../src/rowshash.js";
import { fixtures } from "../src/testing.js";
import { done, ok } from "./check.js";

const AL = `0x${"a1".repeat(20)}`, f = fixtures({ lower: true });
const hash = (h: number, c = "c") => `0x${c.repeat(58)}${h.toString(16).padStart(6, "0")}`;
const tip: TipView = { height: 31_000, hash: hash(31_000), time: 0 };
const prop = (height: number, o: { pos?: number; id?: string } = {}) =>
  f.prop({ v: 1, t: "nrenew", name: "alice" }, { proposer: AL, height, pos: o.pos ?? 1, ...(o.id ? { id: o.id } : {}) });
const att = (height: number, proposalId: string, pos = 50) => f.att({ proposalId, attester: AL, score: 1, height, pos });
const blk = (height: number, events: ChainEvent[]): BlockEvents => ({ height, hash: hash(height), events });
const step = (blocks: BlockEvents[], height = blocks.at(-1)!.height, h: string | null = hash(height)): Step => ({ kind: "blocks", blocks, cursor: { height, hash: h }, tip });
const rowsOf = async (s: Store) => { const out: BlockRow[] = []; for await (const r of s.rows(0)) out.push(r); return out; };
// A source that hands out the steps queued in it, then idles; `calls` counts its steps and `ctx` is the last context.
function scripted(): Source & { queue: Step[]; calls: number; ctx: StepContext | null } {
  const s = { queue: [] as Step[], calls: 0, ctx: null as StepContext | null, basis: { kind: "feed", feed: "scripted", inclusion: false } as const,
    floor: null, tip: async () => tip, next: async (ctx: StepContext) => { s.calls++; s.ctx = ctx; return s.queue.shift() ?? ({ kind: "idle", tip } as const); } };
  return s;
}
let now = 0;
const clock = () => now;

console.log("a source that lies:");
const src = scripted(), store = memoryStore(), loop = replicaLoop({ source: src, store, clock });
const P1 = prop(29_900), X = prop(29_000);   // X lies below the activation height, 29,860
src.queue.push({ kind: "reorg", to: { height: 29_900, hash: hash(29_900) }, tip });
await loop.open();
const early = await loop.advance();
ok("a reorg before any cursor is refused as SOURCE_MALFORMED", early.lastError?.code === "SOURCE_MALFORMED" && early.cursor === null && (await rowsOf(store)).length === 0);
now += 400_000;
src.queue.push(step([blk(29_900, [P1, att(29_900, P1.id)])], 29_950));
const base = await loop.advance(), held = async () => canonicalJson({ rows: await rowsOf(store), boundaries: await store.boundaries(), at: loop.status().cursor });
const before = await held(), ctx = src.ctx!;
ok("the honest first step is taken", base.cursor?.height === 29_950 && base.eventCount === 2 && base.lastError === null);
ok("the source is given the hashes held at a row and at the cursor, and the events hash up to the cursor", ctx.hashAt(29_900) === hash(29_900) &&
  ctx.hashAt(29_950) === hash(29_950) && ctx.hashAt(29_920) === null && ctx.eventsHashAt(29_950) === base.eventsHash && ctx.eventsHashAt(29_951) === null);
const twice = prop(30_000);
const lies: [string, Step][] = [
  ["a block at the cursor", step([blk(29_950, [prop(29_950)]), blk(30_000, [prop(30_000)])])],
  ["blocks out of height order", step([blk(30_010, [prop(30_010)]), blk(30_005, [prop(30_005)])])],
  ["an event at another height than its block's", step([blk(30_000, [prop(30_001)])])],
  ["an event id already held", step([blk(30_000, [prop(30_000, { id: P1.id })])])],
  ["an event id twice in one step", step([blk(30_000, [twice]), blk(30_001, [{ ...twice, height: 30_001 }])])],
  ["a block below the activation height", step([blk(29_000, [X]), blk(30_000, [att(30_000, X.id)])])],
  ["an Attest whose Propose lies below the activation height", step([blk(30_000, [att(30_000, X.id)])])],
  ["Proposes out of position order in a block", step([blk(30_000, [prop(30_000, { pos: 5 }), prop(30_000, { pos: 2 })])])],
  ["a cursor below its last block", step([blk(30_000, [prop(30_000)])], 29_999)],
  ["a cursor without a hash", step([blk(30_000, [prop(30_000)])], 30_000, null)],
  ["a cursor that moves back without a reorg", step([], 29_900)],
  ["a step that does not move the cursor", step([], 29_950)],
  ["a block hash out of form", step([{ height: 30_000, hash: "0xABC", events: [prop(30_000)] }])],
  ["a reorg to the cursor's height", { kind: "reorg", to: { height: 29_950, hash: hash(29_950) }, tip }],
  ["a reorg below the floor", { kind: "reorg", to: { height: 29_858, hash: hash(29_858) }, tip }],
  ["a reorg onto another hash than the one held there", { kind: "reorg", to: { height: 29_900, hash: hash(29_900, "d") }, tip }],
];
for (const [name, lie] of lies) {
  now += 400_000;   // past any back-off
  src.queue.push(lie);
  const s = await loop.advance();
  ok(`${name} is refused as SOURCE_MALFORMED and nothing is committed`, s.lastError?.code === "SOURCE_MALFORMED" && (await held()) === before,
    s.lastError?.reason);
}
const low = memoryStore(), lowSrc = scripted(), lowKey = { format: 1, rule: CAIRNX_EVENT_RULE, basis: lowSrc.basis } as const;
await low.open(lowKey);
await low.commit({ expect: null, rows: [], boundaries: [], meta: { ...lowKey, cursor: { height: 100, hash: hash(100) }, eventsHash: EVENTS_HASH_START,
  rowsHash: ROWS_HASH_START, eventCount: 0, witnessed: null, windowSha256: null, work: null, workRoot: null } });
lowSrc.queue.push(step([blk(29_000, [X])]));
const below = await replicaLoop({ source: lowSrc, store: low, clock }).advance();
ok("from a stored cursor below the activation height, a block below that height is still refused", below.lastError?.code === "SOURCE_MALFORMED" &&
  below.cursor?.height === 100 && (await rowsOf(low)).length === 0);
now += 400_000;
const P2 = prop(30_000, { pos: 2 });
src.queue.push(step([blk(30_000, [P2, att(30_000, P1.id, 1), att(30_000, P2.id, 3)])]), { kind: "reorg", to: { height: 29_900, hash: hash(29_900) }, tip });
const after = await loop.advance();
ok("then an honest step (Attests on a held Propose and on one of their block) and an honest reorg onto a held row are taken",
  after.lastError === null && after.cursor?.height === 29_900 && after.lastReorg?.from.height === 30_000 && (await rowsOf(store)).length === 1);

console.log("back-off:");
src.queue.push({ kind: "cannot", code: "SOURCE_RATE_LIMITED", reason: "429", retryAfterMs: 5_000 });
const calls = src.calls, limited = await loop.advance();
ok("a cannot step is recorded with its Retry-After", limited.lastError?.code === "SOURCE_RATE_LIMITED" && limited.retryAt === now + 5_000);
await loop.advance();
now += 5_000;
const resumed = await loop.advance();
ok("advance calls no source until then, and once it has passed a step that succeeds clears the back-off",
  src.calls === calls + 2 && resumed.lastError === null && resumed.retryAt === null);
const waits: number[] = [];
for (let i = 0; i < 10; i++) {
  src.queue.push({ kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "down", retryAfterMs: null });
  const s = await loop.advance();
  waits.push(s.retryAt! - now);
  now = s.retryAt!;
}
ok(`without Retry-After the delay doubles from 1 s to 300 s (${waits.join()})`, waits.join() === "1000,2000,4000,8000,16000,32000,64000,128000,256000,300000");

console.log("a store that throws:");
const flaky = memoryStore(), fs = scripted(), once = prop(30_000);
let commits = 0, reopened = false;
const flakyStore: Store = { ...flaky,
  commit: async (c) => { if (++commits === 2) throw new Error("disk full"); return flaky.commit(c); },
  open: async (k) => { if (commits === 2 && !reopened) { reopened = true; throw new Error("disk gone"); } return flaky.open(k); } };
fs.queue.push(step([blk(29_950, [prop(29_950)])]), step([blk(30_000, [once])]), step([blk(30_000, [once])]));
const fl = replicaLoop({ source: fs, store: flakyStore, clock }), failed = await fl.advance();
ok("a commit that throws backs off as STORE_FAILED; a store that then throws on open is unavailable and answers no state",
  failed.lastError?.code === "STORE_FAILED" && failed.lastError.reason === "disk full" && failed.store === "unavailable" && failed.cursor === null &&
  fl.stateAt(29_950, 0) === null && (await rowsOf(flaky)).length === 1);
now += 400_000;
const healed = await fl.advance();
ok("the next advance opens the store again and takes the step again", healed.store === "open" && healed.cursor?.height === 30_000 && healed.eventCount === 2);

console.log("advance and close:");
const timedSrc = scripted(), deadlines: number[] = [];
for (let h = 30_100; h <= 30_500; h += 100) timedSrc.queue.push(step([blk(h, [prop(h)])]));
const timed: Source = { ...timedSrc, next: async (ctx) => { now += 1_000; deadlines.push(ctx.budget.deadlineAt); return timedSrc.next(ctx); } };
const timedStore = memoryStore(), l2 = replicaLoop({ source: timed, store: timedStore, clock }), start = now, spent = await l2.advance({ budgetMs: 2_500 });
const storedAt = async () => { const o = await timedStore.open({ format: 1, rule: CAIRNX_EVENT_RULE, basis: timed.basis }); return o.ok ? o.meta?.cursor?.height : null; };
ok("advance stops at its budget, passes the deadline to the source and resolves after the last commit",
  spent.cursor?.height === 30_300 && deadlines.join() === [1, 2, 3].map(() => start + 2_500).join() && (await storedAt()) === 30_300);
const caught = await l2.advance();
ok("without a budget it runs until the source is caught up", caught.cursor?.height === 30_500 && caught.lastError === null && (await storedAt()) === 30_500);
const hangSrc = scripted(), hangStore = memoryStore();
const hang: Source = { ...hangSrc, next: (ctx) => new Promise((res) => ctx.signal.addEventListener("abort", () => res(step([blk(30_000, [prop(30_000)])])))) };
const l3 = replicaLoop({ source: hang, store: hangStore }), pending = l3.advance();
await new Promise((r) => setTimeout(r, 10));
await l3.close();
const closed = await pending;
ok("close() aborts the step in flight and commits nothing it returns", closed.cursor === null && (await rowsOf(hangStore)).length === 0);

console.log("fullReplay:");
const m = fullReplay(), rows: BlockRow[] = [{ height: 29_900, hash: hash(29_900), events: [P1], eventsHash: hash(1), rowsHash: hash(1) }];
ok("before a load it holds no state", m.stateAt(29_900, 0) === null && m.replayMs === null);
m.load(rows, 29_950);
ok("it answers the heights it holds, by depth below a tip, and no height above them",
  m.stateAt(29_950, 0)?.tipHeight === 29_950 && m.stateAt(30_000, 100)?.tipHeight === 29_900 && m.stateAt(29_951, 0) === null && typeof m.replayMs === "number");
m.rollback(29_899);
ok("after a rollback, none above it", m.stateAt(29_900, 0) === null && m.stateAt(29_899, 0)?.events.length === 0);
const m2 = fullReplay(), P3 = prop(29_920);
m2.load(rows, 29_950);
m2.stateAt(29_950, 0);
m2.rollback(29_899);
m2.apply([{ height: 29_920, hash: hash(29_920), events: [P3], eventsHash: hash(2), rowsHash: hash(2) }], 29_950);
ok("a state replayed before a rollback is not handed out after rows are applied again",
  canonicalJson(m2.stateAt(29_950, 0)) === canonicalJson(resolve([P3], 29_950)) && canonicalJson(m2.stateAt(29_950, 0)) !== canonicalJson(resolve([P1], 29_950)));

done("cairnx-replica steps");
