// heldReplay, the default materializer, against fullReplay (resolve() over every held event): for every prefix of the
// recorded log, the states each gives at the heights the loop asks (the boundaries made deep, the deep view, the tip
// view, and heights between blocks), through rollbacks and loads, and the tuple at every boundary of a loop over the
// recorded capture. A context that refuses an event falls back to resolve().
import { EPOCH_LEN, FINAL_DEPTH, applyOrder, canonicalJson, resolve, stateHash, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";
import { fullReplay, heldReplay, memoryStore, replicaLoop, type BlockRow, type Materializer } from "../src/index.js";
import { indexerFeed } from "../src/server.js";
import { done, ok } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { captureIndexer } from "./indexer-capture.js";

const rowsOf = (events: readonly ChainEvent[]): BlockRow[] => {
  const by = new Map<number, ChainEvent[]>();
  for (const e of [...events].sort(applyOrder)) { const l = by.get(e.height); if (l) l.push(e); else by.set(e.height, [e]); }
  return [...by].map(([height, ev]) => ({ height, hash: null, events: ev, eventsHash: "", rowsHash: "" }));
};
const same = (a: CairnXState | null, b: CairnXState | null) => (a === null || b === null ? a === b : canonicalJson(a) === canonicalJson(b));

console.log("every prefix of the replay corpus, asked as the loop asks:");
{
  const rows = rowsOf(corpus.events), held = heldReplay(), full = fullReplay();
  held.load([], null); full.load([], null);
  let asks = 0, differ: string[] = [], prev = rows[0]!.height - 1;
  const ask = (tip: number, depth: number) => { asks++; if (!same(held.stateAt(tip, depth), full.stateAt(tip, depth))) differ.push(`${tip}-${depth}`); };
  for (const [i, row] of rows.entries()) {
    for (const m of [held, full]) m.apply([row], row.height);
    for (let b = (Math.floor((prev - FINAL_DEPTH) / EPOCH_LEN) + 1) * EPOCH_LEN; b <= row.height - FINAL_DEPTH; b += EPOCH_LEN) if (b >= 0) ask(b, 0);
    ask(row.height, FINAL_DEPTH);
    ask(row.height, 0);
    const next = rows[i + 1]?.height;
    if (next !== undefined && next - row.height > 2) { for (const m of [held, full]) m.apply([], next - 1); ask(next - 1, 0); }
    prev = row.height;
  }
  ok(`${rows.length} blocks, ${corpus.events.length} events, ${asks} states asked: every one equal to resolve()'s`, differ.length === 0 && asks > rows.length * 2, differ.slice(0, 5).join(","));

  ok("no state of the sweep was answered by the fallback to resolve()", held.fallbacks === 0, `${held.fallbacks} fallbacks`);

  // Rollbacks to each tenth block, each refilled first with another branch (the block above the rollback left out) and
  // then with the recorded one, then a load from the rows.
  differ = []; asks = 0;
  const end = rows.at(-1)!.height;
  for (let k = rows.length - 1; k > 0; k -= Math.max(1, Math.floor(rows.length / 10))) {
    const to = rows[k - 1]!.height;
    for (const m of [held, full]) m.rollback(to);
    ask(to, 0); ask(to, FINAL_DEPTH);
    for (const m of [held, full]) m.apply(rows.slice(k + 1), end);
    ask(end, FINAL_DEPTH); ask(end, 0);
    for (const m of [held, full]) m.rollback(to);
    for (const m of [held, full]) m.apply(rows.slice(k), end);
    ask(end, FINAL_DEPTH); ask(end, 0);
  }
  for (const m of [held, full]) m.load(rows.slice(0, 300), rows[299]!.height);
  ask(rows[299]!.height, 0); ask(rows[200]!.height, 0); ask(rows[299]!.height, 0);
  ok(`after rollbacks to each tenth block, refills on two branches and a load: ${asks} states, every one equal, none by the fallback`,
    differ.length === 0 && held.fallbacks === 0, `${differ.slice(0, 5).join(",")} ${held.fallbacks} fallbacks`);
}

console.log("the tuples of a loop over the recorded capture (29,860 to 117,000):");
{
  const tuples = async (m: Materializer) => {
    const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: captureIndexer(fx) }), store: memoryStore(), materializer: m, maxBlocks: 100_000, maxRequests: 100_000 });
    await loop.open();
    await loop.advance({ budgetMs: 600_000 });
    const t0 = performance.now(), out = loop.boundaryHeights().map((h) => loop.boundary(h));
    const ms = performance.now() - t0;
    await loop.close();
    return { out, ms };
  };
  const t0 = performance.now(), h = await tuples(heldReplay()), heldMs = performance.now() - t0;
  const t1 = performance.now(), f = await tuples(fullReplay()), fullMs = performance.now() - t1;
  ok(`${f.out.length} boundaries, each tuple (block, events and state hash) equal to the full replay's`,
    f.out.length > 2_000 && JSON.stringify(h.out) === JSON.stringify(f.out) && f.out.every((b) => b !== null && b.stateHash !== null));
  console.log(`  (the sync and every boundary's state: held ${heldMs.toFixed(0)} ms, full ${fullMs.toFixed(0)} ms)`);
}

console.log("a load and a split block, against held contexts:");
{
  const rows = rowsOf(corpus.events), held = heldReplay(), full = fullReplay(), top = rows.at(-1)!.height;
  for (const m of [held, full]) m.load(rows, top);
  held.stateAt(top, 0); held.stateAt(top, FINAL_DEPTH);
  // a load of rows that differ at and below both contexts' heights: every second block left out
  const other = rows.filter((_, i) => i % 2 === 0), otherTop = other.at(-1)!.height;
  for (const m of [held, full]) m.load(other, top);
  ok("a load that changes events below the held contexts: the states are the full replay's", same(held.stateAt(top, 0), full.stateAt(top, 0)) && same(held.stateAt(top, FINAL_DEPTH), full.stateAt(top, FINAL_DEPTH)) && otherTop <= top);

  // one block's events in two apply() calls: the context at that height is let go when the second comes
  const block = rows.find((r) => r.events.length >= 2)!, before = rows.filter((r) => r.height < block.height);
  const first = { ...block, events: block.events.slice(0, 1) }, rest = { ...block, events: block.events.slice(1) };
  const h2 = heldReplay(), f2 = fullReplay();
  for (const m of [h2, f2]) m.load(before, before.at(-1)!.height);
  for (const m of [h2, f2]) m.apply([first], block.height);
  h2.stateAt(block.height, 0); f2.stateAt(block.height, 0);
  for (const m of [h2, f2]) m.apply([rest], block.height + 5);
  ok(`a block (${block.height}, ${block.events.length} events) fed in two calls: the state above it is the full replay's`,
    same(h2.stateAt(block.height + 5, 0), f2.stateAt(block.height + 5, 0)) && h2.fallbacks === 0, `${h2.fallbacks} fallbacks`);
}

console.log("late rows (a row at or below a height already replayed), against resolve() over the events given:");
{
  // Both materializers share one memo, so each is checked against an independent resolve() of the events it was given.
  const rows = rowsOf(corpus.events), k = 400, H = rows[k]!.height;
  const late = (src: BlockRow, h: number): BlockRow => ({ ...src, height: h, events: src.events.map((e) => ({ ...e, height: h })) });
  const oracle = (given: readonly BlockRow[], at: number) => resolve(given.flatMap((r) => r.events).filter((e) => e.height <= at).sort(applyOrder), at);
  const cases: [string, (m: Materializer) => { given: BlockRow[]; at: number }][] = [
    // the tip view replayed, then a row below it: the memoized state at the tip must not be served again
    ["the state at the tip asked again", (m) => {
      const base = rows.slice(0, k + 1), row = late(rows[k + 1]!, rows[k - 5]!.height);
      m.load(base, H); m.stateAt(H, 0); m.apply([row], H);
      return { given: [...base, row], at: H };
    }],
    // a row below the last one held, then a height between the two: its events must be found though they came last
    ["a height between the late row and the tip", (m) => {
      const base = rows.slice(0, k + 1), row = late(rows[k + 1]!, rows[k - 10]!.height);
      m.load(base, H); m.stateAt(rows[k - 20]!.height, 0); m.apply([row], H);
      return { given: [...base, row], at: rows[k - 5]!.height };
    }],
    // a context at the late row's height: it must be let go, or the row is skipped
    ["a context at the late row's height", (m) => {
      const base = rows.slice(0, k + 1), row = late(rows[k + 1]!, rows[k - 10]!.height);
      m.load(base, H); m.stateAt(rows[k - 10]!.height, 0); m.apply([row], H);
      return { given: [...base, row], at: H };
    }],
  ];
  for (const [name, run] of cases) {
    const held = heldReplay(), full = fullReplay();
    const h = run(held), f = run(full);
    const want = oracle(h.given, h.at);
    ok(`${name}: the held and the full replay each equal resolve() of what they were given`, same(held.stateAt(h.at, 0), want) && same(full.stateAt(f.at, 0), want));
  }
}

console.log("a rollback that un-mines the tip block's record:");
{
  const rows = rowsOf(corpus.events), k = 300, top = rows[k]!, below = rows[k - 1]!;
  for (const m of [heldReplay(), fullReplay()]) {
    m.load(rows.slice(0, k + 1), top.height);
    m.stateAt(top.height, 0);
    m.rollback(below.height);
    m.apply([], top.height);   // the new branch's block at that height carries no record
    const want = resolve(rows.slice(0, k).flatMap((r) => r.events).sort(applyOrder), top.height);
    ok(`after the rollback the state at that height is the new branch's (${"fallbacks" in m ? "held" : "full"})`, same(m.stateAt(top.height, 0), want));
  }
}

console.log("a context that refuses falls back to resolve():");
{
  const rows = rowsOf(corpus.events.filter((e) => e.height <= 30_400));
  const odd = { ...rows[3]!, events: [{ ...rows[3]!.events[0]!, pos: 2 ** 53 }] };
  const bad = [...rows.slice(0, 3), odd, ...rows.slice(4)], top = rows.at(-1)!.height;
  const outcome = (m: Materializer) => { try { m.load(bad, top); const s = m.stateAt(top, 0); return s === null ? "null" : stateHash(s); } catch (e) { return `threw ${(e as Error).message}`; } };
  const m = heldReplay(), h = outcome(m), f = outcome(fullReplay());
  ok("an event at position 2^53: the context refuses it and the held replay answers what resolve() answers", h === f && h.startsWith("0x") && m.fallbacks === 1,
    `${h} | ${f} | ${m.fallbacks} fallbacks`);
}

done("held-replay");
