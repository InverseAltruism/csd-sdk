// The tuple book on the loop (tuple.ts over loop.ts's boundaries), with the cases of the resolver's own book tests that
// apply to it: a boundary is kept once FINAL_DEPTH deep and only at multiples of the epoch; its tuple is the block, the
// events hash up to it and the state hash of resolve() at it; the corpus at 117,000 gives the hashes cairnx-core pins;
// an advance with nothing new leaves the kept tuples as they were; a step that cannot read stops, and the next fills
// the boundaries with no hole. The reorg cases (below a kept boundary, above every one) and the resolver's withholding
// (a refused scan) are in tuple-differential.test.ts, beside the resolver's own book. Its snapshot reuse and its two
// read routes are the resolver's, not the book's.
import { EPOCH_LEN, EVENTS_HASH_START, FINAL_DEPTH, eventsHashStep, resolve, stateHash, type ChainEvent } from "@inversealtruism/cairnx-core";
import { memoryStore, replicaLoop, type Source } from "../src/index.js";
import { applyOrder } from "../src/order.js";
import { tupleOf } from "../src/tuple.js";
import { done, ok } from "./check.js";
import { corpus, fx, pinned } from "./core-files.js";
import { growing, withBoundaries } from "./tuple-harness.js";

const WIDE = { maxBlocks: 100_000, maxRequests: 100_000 };

console.log("the fixture tuple at 117,000:");
{
  const top = { now: 117_000 + FINAL_DEPTH - 1 };
  const loop = replicaLoop({ source: growing(fx, top), store: memoryStore(), ...WIDE });
  await loop.open();
  await loop.advance();
  ok("11 blocks above it, 117,000 is not yet a boundary", loop.boundary(117_000) === null && loop.boundaryHeights().at(-1) === 116_970);
  top.now = 117_000 + FINAL_DEPTH;
  await loop.advance();
  const t = tupleOf(loop.boundary(117_000));
  ok("12 above it: (117000, the fixture's block hash, and the events and state hashes of hashes.json)", t !== null && t.height === 117_000 &&
    t.blockHash === fx.toHash && t.eventsHash === pinned["117000"]?.eventsHash && t.stateHash === pinned["117000"]?.stateHash, JSON.stringify(t));
  const hs = loop.boundaryHeights();
  ok(`every kept boundary is a multiple of the epoch, one per epoch from the first (${hs.length})`, hs.every((h, i) => h % EPOCH_LEN === 0 && (i === 0 || h - hs[i - 1]! === EPOCH_LEN)));
  // A boundary's tuple from first principles, at a few boundaries spread over the range.
  const sorted = [...corpus.events].sort(applyOrder);
  const direct = (h: number) => {
    let eh = EVENTS_HASH_START;
    const byH = new Map<number, ChainEvent[]>();
    for (const e of sorted) if (e.height <= h) byH.set(e.height, [...(byH.get(e.height) ?? []), e]);
    for (const [height, evs] of [...byH].sort((a, b) => a[0] - b[0])) eh = eventsHashStep(eh, height, evs);
    return { eventsHash: eh, stateHash: stateHash(resolve(sorted.filter((e) => e.height <= h), h)) };
  };
  const probes = [hs[0]!, hs[Math.floor(hs.length / 3)]!, hs[Math.floor((2 * hs.length) / 3)]!, 117_000];
  ok(`at ${probes.join(", ")}: the events hash of the events up to it in block order and the state hash of resolve() at it`, probes.every((h) => {
    const t2 = tupleOf(loop.boundary(h)), d = direct(h);
    return t2 !== null && t2.eventsHash === d.eventsHash && t2.stateHash === d.stateHash && t2.blockHash === loop.hashAt(h);
  }));
  const json = (h: number) => JSON.stringify(tupleOf(loop.boundary(h))), before = new Map(hs.map((h) => [h, json(h)]));
  await loop.advance();
  ok("honest path: an advance with nothing new keeps every kept tuple as it was", loop.boundaryHeights().every((h) => json(h) === before.get(h)) &&
    loop.boundaryHeights().length === hs.length);
  await loop.close();
}

console.log("a boundary whose block hash cannot be read:");
{
  // Each step serves the boundary blocks the fixture source gives, except that a boundary's block whose hash the source
  // cannot read makes the step fail, once.
  const fx2 = withBoundaries(fx, 30_300), base = growing(fx, { now: 30_300 });
  let fail = 30_000;
  const flaky: Source = { ...base, async next(ctx) {
    if (fail > 0 && (ctx.cursor?.height ?? 0) < fail) { const f = fail; fail = 0; return { kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: `no hash at ${f}`, retryAfterMs: 0 }; }
    return base.next(ctx);
  } };
  const loop = replicaLoop({ source: flaky, store: memoryStore(), ...WIDE });
  await loop.open();
  const a = await loop.advance();
  ok("the step stops and commits nothing", a.cursor === null && a.lastError?.code === "SOURCE_UNAVAILABLE" && loop.boundaryHeights().length === 0);
  const b = await loop.advance();
  const hs = loop.boundaryHeights();
  ok("the next step fills it: one boundary per epoch, no hole", b.cursor?.height === 30_300 && hs.includes(30_000) &&
    hs.every((h, i) => i === 0 || h - hs[i - 1]! === EPOCH_LEN) && hs.at(-1) === 30_270 && fx2.blocks.some((x) => x.height === 30_000));
  await loop.close();
}

done("cairnx-replica tuple book");
