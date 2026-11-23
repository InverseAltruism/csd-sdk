// heldReplay, the default materializer, against fullReplay (resolve() over every held event): for every prefix of the
// recorded log, the states each gives at the heights the loop asks (the boundaries made deep, the deep view, the tip
// view, and heights between blocks), through rollbacks and loads, and the tuple at every boundary of a loop over the
// recorded capture. A context that refuses an event falls back to resolve().
import { EPOCH_LEN, FINAL_DEPTH, applyOrder, canonicalJson, stateHash, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";
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
