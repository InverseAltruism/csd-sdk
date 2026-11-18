// FullReplay: in this version the only way from a loop's rows to a resolved state. It keeps the events of the rows it
// is given and replays them with cairnx-core's resolve() when a state is asked for; no state is persisted, so after a
// restart every state comes from rows the loop has read back and checked (held.ts) before it loads them here.
import { resolve, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";
import type { Materializer } from "./types.js";

/** A materializer that replays every held event at or below the height asked for. It keeps the last two states it
 *  replayed: a tip's two views, all events (`depth` 0) and those at or below `tip - minDepth`. */
export function fullReplay(o: { now?: () => number } = {}): Materializer {
  const now = o.now ?? (() => performance.now());
  let events: ChainEvent[] = [], height: number | null = null, replayMs: number | null = null;
  const memo = new Map<number, CairnXState>();
  const replay = (at: number): CairnXState => {
    const hit = memo.get(at);
    if (hit !== undefined) return hit;
    const t = now();
    const state = resolve(events.filter((e) => e.height <= at), at);
    replayMs = now() - t;
    if (memo.size >= 2) memo.delete(memo.keys().next().value!);
    memo.set(at, state);
    return state;
  };
  return {
    load(rows, h) { events = rows.flatMap((r) => r.events); height = h; memo.clear(); },
    // Rows applied lie above `height`, and no state above `height` was replayed, so every memoized state stays exact.
    apply(rows, h) { for (const r of rows) events.push(...r.events); height = h; },
    rollback(to) {
      events = events.filter((e) => e.height <= to); height = to;
      for (const k of [...memo.keys()]) if (k > to) memo.delete(k);
    },
    stateAt(tip, depth) {
      const at = tip - depth;
      return height === null || !Number.isSafeInteger(at) || at < 0 || at > height ? null : replay(at);
    },
    get replayMs() { return replayMs; },
  };
}
