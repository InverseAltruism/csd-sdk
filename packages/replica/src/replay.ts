// The materializers: in this version the only ways from a loop's rows to a resolved state. Each keeps the events of the
// rows it is given and replays them with cairnx-core when a state is asked for; no state is persisted, so after a
// restart every state comes from rows the loop has read back and checked (held.ts) before it loads them here.
import { ReplayContextRefusal, newReplayContext, resolve, type CairnXState, type ChainEvent, type ReplayContext } from "@inversealtruism/cairnx-core";
import type { Materializer } from "./types.js";

/** The events of `events` (ascending by height, as rows hold them) with a height in (from, to]. */
function between(events: readonly ChainEvent[], from: number, to: number): ChainEvent[] {
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (events[mid]!.height <= from) lo = mid + 1; else hi = mid; }
  const out: ChainEvent[] = [];
  for (let i = lo; i < events.length && events[i]!.height <= to; i++) out.push(events[i]!);
  return out;
}

/** The shared part of both materializers: the held events, the cursor's height, the last two states replayed (a tip's
 *  two views, all events, `depth` 0, and those at or below `tip - minDepth`) and the time of the last replay. */
function materializer(replay: (events: readonly ChainEvent[], at: number) => CairnXState, o: { now?: () => number; onLoad?: () => void; onRollback?: (to: number) => void }): Materializer {
  const now = o.now ?? (() => performance.now());
  let events: ChainEvent[] = [], height: number | null = null, replayMs: number | null = null;
  const memo = new Map<number, CairnXState>();
  const at = (h: number): CairnXState => {
    const hit = memo.get(h);
    if (hit !== undefined) return hit;
    const t = now();
    const state = replay(events, h);
    replayMs = now() - t;
    if (memo.size >= 2) memo.delete(memo.keys().next().value!);
    memo.set(h, state);
    return state;
  };
  return {
    load(rows, h) { events = rows.flatMap((r) => r.events); height = h; memo.clear(); o.onLoad?.(); },
    // Rows applied lie above `height`, and no state above `height` was replayed, so every memoized state stays exact.
    apply(rows, h) { for (const r of rows) events.push(...r.events); height = h; },
    rollback(to) {
      events = events.filter((e) => e.height <= to); height = to;
      for (const k of [...memo.keys()]) if (k > to) memo.delete(k);
      o.onRollback?.(to);
    },
    stateAt(tip, depth) {
      const h = tip - depth;
      return height === null || !Number.isSafeInteger(h) || h < 0 || h > height ? null : at(h);
    },
    get replayMs() { return replayMs; },
  };
}

/** A materializer that replays every held event at or below the height asked for with resolve(). */
export function fullReplay(o: { now?: () => number } = {}): Materializer {
  return materializer((events, h) => resolve(events.filter((e) => e.height <= h), h), o);
}

/** How many held contexts heldReplay keeps: the loop asks two heights a commit, the tip view and the deep view. */
const CONTEXTS = 2;

/** A materializer over cairnx-core's held replay contexts (newReplayContext), whose answer at a height is resolve()'s
 *  over the same events there: a state at height h comes from the context at or below h nearest to it, given the
 *  events of the blocks above it, or from a new one when none lies at or below h (the least recently used is let go
 *  past CONTEXTS). The loop asks ascending heights between commits (the boundaries it makes deep, then the deep view,
 *  then the tip view), so a commit's states cost only its new events. A rollback lets go every context above it, a
 *  load all of them. A context that refuses (ReplayContextRefusal) is let go and that height replayed with resolve(),
 *  as cairnx-core says to, and counted in `fallbacks`; a replay that throws inside the fold throws, as resolve() does
 *  there. */
export function heldReplay(o: { now?: () => number } = {}): Materializer & { readonly fallbacks: number } {
  let held: { ctx: ReplayContext; used: number }[] = [], uses = 0, fallbacks = 0;
  const replay = (events: readonly ChainEvent[], h: number): CairnXState => {
    let best: { ctx: ReplayContext; used: number } | undefined;
    for (const c of held) if (c.ctx.height <= h && (best === undefined || c.ctx.height > best.ctx.height)) best = c;
    try {
      if (best === undefined) {
        if (held.length >= CONTEXTS) held = held.sort((a, b) => a.used - b.used).slice(1);
        best = { ctx: newReplayContext(), used: 0 };
        held.push(best);
      }
      best.used = ++uses;
      if (best.ctx.height < h) best.ctx.advance(h, between(events, best.ctx.height, h));
      return best.ctx.stateAt(h);
    } catch (e) {
      held = held.filter((c) => c !== best);
      if (!(e instanceof ReplayContextRefusal)) throw e;
      fallbacks++;
      return resolve(events.filter((x) => x.height <= h), h);
    }
  };
  const m = materializer(replay, {
    ...o,
    onLoad: () => { held = []; },
    onRollback: (to) => { held = held.filter((c) => c.ctx.height <= to); },
  });
  return Object.defineProperty(m, "fallbacks", { get: () => fallbacks, enumerable: true }) as Materializer & { readonly fallbacks: number };
}
