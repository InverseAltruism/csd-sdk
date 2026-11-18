// nodeBlocks when the node's chain moves (fork.ts), over branches mined again from the capture (node-harness.ts): a
// fork is followed to the pinned hashes, a deep one at the loop's default budget within a stated number of steps; a
// node behind the cursor on the same chain rolls nothing back; and every step emitted, for an honest node and for the
// inconsistent ones, keeps the loop's contract for a reorg (below the cursor, at or above the floor).
import { CAIRNX_EVENT_RULE } from "@inversealtruism/cairnx-core";
import { nodeBlocks } from "../src/browser.js";
import { reorgBreak } from "../src/contract.js";
import { memoryStore, replicaLoop, type BlockRow, type Source, type Step, type Store } from "../src/index.js";
import { done, ok } from "./check.js";
import { NODE, blockAt, branchFrom, cap, hashesOk, node, type Answers, type Served } from "./node-harness.js";

/** A loop at the loop's default budget (64 blocks, 10 requests) over a served node, every step it is given recorded
 *  with the cursor it was asked from and whether a reorg keeps the contract. */
function follow(s: Served, o: { maxRequests?: number } = {}) {
  const n = node(s), inner = nodeBlocks({ node: NODE, fetch: n.f }), steps: { step: Step; from: number | null; reads: number }[] = [];
  let t = 0;
  const source: Source = { ...inner, async next(ctx) {
    const before = n.log.length, step = await inner.next(ctx);
    steps.push({ step, from: ctx.cursor?.height ?? null, reads: n.log.length - before });
    if (step.kind === "reorg" && reorgBreak(step.to, ctx.cursor, CAIRNX_EVENT_RULE.activationHeight - 1, ctx.hashAt) !== null) bad.push(step);
    return step;
  } };
  const bad: Step[] = [], store: Store = memoryStore();
  const loop = replicaLoop({ source, store, clock: () => (t += 1_000), ...(o.maxRequests === undefined ? {} : { maxRequests: o.maxRequests }) });
  return { n, loop, steps, bad, store, run: () => loop.advance() };
}
const kinds = (steps: { step: Step }[]) => steps.map((x) => (x.step.kind === "cannot" ? x.step.code : x.step.kind));
const rowsOf = async (s: Store) => { const out: BlockRow[] = []; for await (const r of s.rows(0)) out.push(r); return out; };

console.log("a fork followed:");
const near = branchFrom(30_290), tipMoved: Served = { answers: cap.answers }, tm = follow(tipMoved, { maxRequests: 200 });
await tm.run();
tipMoved.answers = near;
const tms = await tm.run();
ok("another block at the cursor's height: rolled back to 30,286, the highest held block below the fork, then the branch read",
  tms.lastReorg?.to.height === 30_286 && tms.cursor?.hash === blockAt(near, cap.to).hash && tms.lastError === null && hashesOk(tm.loop) && tm.bad.length === 0);
const linkMoved: Served = { answers: cap.answers, tip: 30_295 }, lm = follow(linkMoved, { maxRequests: 200 });
await lm.run();
Object.assign(linkMoved, { answers: near, tip: cap.to });
const lms = await lm.run();
ok("a next block that does not link to the cursor: rolled back the same way", lms.lastReorg?.from.height === 30_295 && lms.lastReorg.to.height === 30_286 &&
  lms.cursor?.hash === blockAt(near, cap.to).hash && hashesOk(lm.loop) && lm.bad.length === 0);

const DEEP = 29_870, deepServed: Served = { answers: cap.answers }, dp = follow(deepServed);
await dp.run();
const rows = await rowsOf(dp.store), held = rows.length, orphaned = rows.filter((r) => r.height >= DEEP).length;
const bound = 2 * Math.ceil(Math.log2(held + 1));
deepServed.answers = branchFrom(DEEP);
const first = dp.steps.length, dps = await dp.run(), search = dp.steps.slice(first, dp.steps.findIndex((x, i) => i >= first && x.step.kind === "reorg") + 1);
const probes = search.reduce((a, x) => a + x.reads - 1, 0);
ok(`a fork at ${DEEP} orphaning ${orphaned} of ${held} held blocks, at the default budget of 10 requests: found in ${search.length} steps (${probes} probes, bound ${bound}), then followed to the pinned hashes`,
  search.length > 0 && search.length <= 3 && search.at(-1)?.step.kind === "reorg" && probes <= bound && dps.lastReorg?.to.height === 29_868 &&
  dps.cursor?.hash === blockAt(deepServed.answers, cap.to).hash && dps.lastError === null && hashesOk(dp.loop) && dp.bad.length === 0, kinds(search).join());

const tight: Served = { answers: cap.answers }, tg = follow(tight, { maxRequests: 4 });
await tg.run();
tight.answers = branchFrom(DEEP);
// A refused step ends an advance, so each advance takes one step of the search, as each poll would.
const t0 = tg.steps.length;
let tgs = await tg.run();
for (let i = 0; i < 10 && tgs.lastError !== null; i++) tgs = await tg.run();
const tsteps = tg.steps.slice(t0, tg.steps.findIndex((x, i) => i >= t0 && x.step.kind === "reorg") + 1);
const tprobes = tsteps.reduce((a, x) => a + x.reads - 1, 0);
ok(`the same fork at 4 requests a step (3 probes): the search resumes at the next advance where the last step left it, found in ${tsteps.length} steps (${tprobes} probes)`,
  tsteps.length >= 2 && tsteps.length <= Math.ceil(bound / 3) + 1 && tprobes <= bound && tsteps.slice(0, -1).every((x) => x.step.kind === "cannot" && x.step.code === "SOURCE_RATE_LIMITED" && x.step.retryAfterMs === 0) &&
  tgs.lastReorg?.to.height === 29_868 && tgs.lastError === null && hashesOk(tg.loop), kinds(tsteps).join());

const early: Served = { answers: cap.answers, tip: 29_862 }, ey = follow(early);
await ey.run();
Object.assign(early, { answers: branchFrom(29_861), tip: 29_864 });
const eys = await ey.run();
ok("a fork before the store holds a row: rolled back to the floor, 29,859, then the branch read", eys.lastReorg?.to.height === 29_859 &&
  eys.cursor?.hash === blockAt(early.answers, 29_864).hash && eys.lastError === null && ey.bad.length === 0);

console.log("a node behind the cursor:");
for (const [tip, how] of [[30_256, "its tip is a held block"], [30_250, "its tip is not held, the held block below it is probed"]] as const) {
  const behind: Served = { answers: cap.answers }, bh = follow(behind);
  await bh.run();
  behind.tip = tip;
  const bs = await bh.run();
  behind.tip = cap.to;
  const back = await bh.run();
  ok(`the same chain, ${how}: SOURCE_UNAVAILABLE with nothing rolled back, then on again when the node catches up`,
    bs.lastError?.code === "SOURCE_UNAVAILABLE" && bs.lastReorg === null && bs.cursor?.height === cap.to && back.lastError === null && hashesOk(bh.loop));
}
const other: Served = { answers: cap.answers }, ot = follow(other, { maxRequests: 200 });
await ot.run();
Object.assign(other, { answers: branchFrom(30_200), tip: 30_250 });
const os = await ot.run();
ok("another chain, shorter: rolled back to 30,180, the highest held block (an epoch boundary) below its fork at 30,200", os.lastReorg?.to.height === 30_180 && os.cursor?.height === 30_250 &&
  os.cursor.hash === blockAt(other.answers, 30_250).hash && ot.bad.length === 0);

console.log("a node inconsistent between requests:");
const stale: Served = { answers: cap.answers, tip: 30_295 }, st = follow(stale, { maxRequests: 200 });
await st.run();
stale.tipOf = () => ({ tip: `0x${"ab".repeat(32)}`, height: 30_295 });
const s0 = st.steps.length;
for (let i = 0; i < 3; i++) await st.run();
const staleKinds = kinds(st.steps.slice(s0));
ok("a /tip naming a block the node does not serve: one rollback, then SOURCE_MALFORMED with nothing rolled back", st.bad.length === 0 &&
  staleKinds.filter((k) => k === "reorg").length === 1 && staleKinds.at(-1) === "SOURCE_MALFORMED" && st.loop.status().lastReorg?.to.height === 30_286, staleKinds.join());
const mixed: Answers = { ...cap.answers }, newer = branchFrom(30_290);
for (let h = 30_296; h <= cap.to; h++) mixed[`/block/height/${h}`] = newer[`/block/height/${h}`]!;
const mix: Served = { answers: cap.answers, tip: 30_280 }, mx = follow(mix, { maxRequests: 200 });
await mx.run();
Object.assign(mix, { answers: mixed, tip: cap.to });
const m0 = mx.steps.length;
for (let i = 0; i < 3; i++) await mx.run();
const mixKinds = kinds(mx.steps.slice(m0));
ok("old blocks below 30,296 and new above: the step ends at 30,295, then SOURCE_MALFORMED with nothing rolled back", mx.bad.length === 0 &&
  mixKinds[0] === "blocks" && mixKinds.slice(1).every((k) => k === "SOURCE_MALFORMED") && mx.loop.status().cursor?.height === 30_295 && mx.loop.status().lastReorg === null, mixKinds.join());

done("cairnx-replica node fork");
