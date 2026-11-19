// The loop that drives a source into a store (design section 4). A step that breaks the contract (contract.ts) is
// refused whole as SOURCE_MALFORMED; one that keeps it is committed whole, with the events hash and the rows hash
// stepped per block and the epoch boundaries now FINAL_DEPTH deep, by a commit that names the cursor the step started
// from. A reorg rolls the store back. A source that cannot answer, throws or breaks the contract is backed off:
// Retry-After, else a delay doubling from 1 s to 300 s. Nothing a step returns is committed once the step's signal
// has aborted.
//
// Every boundary keeps its block hash and events hash; its state hash costs a full replay, so it is computed as the
// boundary becomes deep only when the boundary lies at most STATE_WINDOW below the tip the step reports. A catch-up to
// a tip that holds still therefore replays at most 24 boundaries, and then one per epoch as the tip moves; an older
// boundary is stored with a null state hash and replayed on demand (Loop.boundary).
import { CAIRNX_EVENT_RULE, EPOCH_LEN, EVENTS_HASH_START, FINAL_DEPTH, stateHash, type CairnXState, type EventRule } from "@inversealtruism/cairnx-core";
import { checkStep, reorgBreak } from "./contract.js";
import { BACKOFF_MAX_MS, ReplicaConfigError, messageOf } from "./errors.js";
import { Held, verifyRows } from "./held.js";
import { fullReplay } from "./replay.js";
import type { BlockRow, Boundary, Commit, Cursor, Materializer, Source, SourceCode, Step, Store, StoreMeta, TipView } from "./types.js";

type Reset = "format" | "rule" | "basis" | "corrupt" | "unavailable";
/** Internal. How a loop's store opened: refused with the store's reason, or `corrupt` when its rows do not match its
 *  meta and boundaries (held.ts). */
export type LoopOpen = { ok: true } | { ok: false; reset: Reset };
/** Internal. `maxBlocks` and `maxRequests` are passed to the source as each step's budget. */
export interface LoopOptions {
  readonly source: Source; readonly store: Store; readonly rule?: EventRule; readonly materializer?: Materializer;
  readonly clock?: () => number; readonly maxBlocks?: number; readonly maxRequests?: number;
}
/** Internal. `store` is null before the first open; `retryAt` is when a backed-off loop next calls its source. */
export interface LoopStatus {
  readonly store: "open" | Reset | null; readonly cursor: Cursor | null; readonly eventsHash: string; readonly eventCount: number;
  readonly tip: TipView | null; readonly lastReorg: { readonly from: Cursor; readonly to: Cursor; readonly at: number } | null;
  readonly lastError: { readonly code: SourceCode | "STORE_FAILED"; readonly reason: string; readonly at: number } | null;
  readonly retryAt: number | null; readonly replayMs: number | null;
}
/** Internal. Calls to open, advance and close run one after another. */
export interface Loop {
  /** The held boundary at `height`, its state hash replayed once and memoized when it was stored without one; null when
   *  no boundary is held there or the store is not open. */
  boundary(height: number): Boundary | null;
  open(): Promise<LoopOpen>;
  /** Runs steps until caught up, backed off, aborted or past `budgetMs`, and resolves after the last commit. */
  advance(o?: { budgetMs?: number; signal?: AbortSignal }): Promise<LoopStatus>;
  status(): LoopStatus;
  eventsHashAt(height: number): string | null;
  /** The block hash the loop holds at `height`: a row's, the cursor's, or one of the last FINAL_DEPTH + 1 blocks'
   *  that steps of this generation carried; else null. */
  hashAt(height: number): string | null;
  /** The rows held at or above `fromHeight`, checked as every held row is; read-only. */
  rows(fromHeight: number): readonly BlockRow[];
  /** A number that changes whenever the chain held is replaced (a rollback, a reload from the store, a reset); an
   *  extension by a step's blocks keeps it. */
  generation(): number;
  /** Whether a step is being committed: its rows and state may be half applied until it ends. */
  committing(): boolean;
  /** Resolves when no step is being committed; a caller checks committing() again in the turn it reads in. */
  quiet(): Promise<void>;
  /** The materializer's state at `tip - depth`, or null when the store is not open or that height is not held. */
  stateAt(tip: number, depth: number): CairnXState | null;
  close(): Promise<void>;
}

/** Whether the chain held after a change extends the one before: every row held before is still held, in place, and
 *  the cursor moved up. Any other change replaces the chain and moves the generation. */
export function chainExtends(before: readonly BlockRow[], after: readonly BlockRow[], fromHeight: number, toHeight: number): boolean {
  return toHeight > fromHeight && after.length >= before.length && before.every((r, i) => after[i] === r);
}

const BACKOFF_FIRST_MS = 1_000;
/** How far below the tip a boundary is replayed as it becomes deep: 24 epochs, 720 blocks. */
export const STATE_WINDOW = 24 * EPOCH_LEN;

// A signal that aborts when either does; AbortSignal.any needs Node 20.3 and the package declares Node 18.
function linked(a: AbortSignal, b: AbortSignal | undefined): { signal: AbortSignal; dispose(): void } {
  const c = new AbortController(), stop = () => c.abort();
  for (const s of [a, b]) if (s?.aborted) c.abort(); else s?.addEventListener("abort", stop, { once: true });
  return { signal: c.signal, dispose: () => { a.removeEventListener("abort", stop); b?.removeEventListener("abort", stop); } };
}

/** Internal. A loop over one source and one store; the materializer defaults to fullReplay(). */
export function replicaLoop(o: LoopOptions): Loop {
  const { source, store } = o, rule = o.rule ?? CAIRNX_EVENT_RULE, m = o.materializer ?? fullReplay(), clock = o.clock ?? Date.now;
  const limits = { maxBlocks: o.maxBlocks ?? 64, maxRequests: o.maxRequests ?? 10 };
  const closing = new AbortController();
  let opened: LoopStatus["store"] = null, meta: StoreMeta | null = null, held = new Held(), bounds: Boundary[] = [];
  let tip: TipView | null = null, lastReorg: LoopStatus["lastReorg"] = null, lastError: LoopStatus["lastError"] = null;
  let retryAt: number | null = null, failures = 0, queue: Promise<unknown> = Promise.resolve();
  const filled = new Map<number, string>();   // state hashes replayed on demand for boundaries stored without one
  let generation = 0, busy: Promise<void> | null = null;
  // The hashes of the blocks at the cursor and the FINAL_DEPTH heights below it, as this generation's steps carried
  // them (at most FINAL_DEPTH + 1 entries); emptied whenever the generation moves. Sources do not read them.
  const recent = new Map<number, string>();
  function remember(blocks: readonly { height: number; hash: string | null }[], cursor: Cursor): void {
    for (const b of [...blocks, cursor]) if (b.hash !== null) recent.set(b.height, b.hash);
    for (const h of [...recent.keys()]) if (h < cursor.height - FINAL_DEPTH || h > cursor.height) recent.delete(h);
  }

  // The one place the chain held changes. An extension (a step's blocks, which the source linked to the cursor) must
  // keep every row held in place and move the cursor up (chainExtends); every other change moves the generation,
  // which a witness's confirmation is bound to (witness.ts).
  function change(kind: "extend" | "replace", from: number, to: number, apply: () => void): void {
    const before = held.rows.slice();
    apply();
    if (kind === "replace") { generation++; recent.clear(); }
    else if (!chainExtends(before, held.rows, from, to)) throw new Error("loop: a change of the chain held that does not extend it must move the generation");
  }
  // A step's commit is marked from before its rows change until its tip is settled: committing() is true meanwhile.
  async function exclusive<T>(f: () => Promise<T>): Promise<T> {
    let done = () => undefined as void;
    busy = new Promise<void>((go) => { done = go; });
    try { return await f(); } finally { busy = null; done(); }
  }

  const cursor = (): Cursor | null => meta?.cursor ?? null;
  const hashAt = (h: number): string | null => held.hashAt(h) ?? (cursor()?.height === h ? cursor()!.hash : null);
  const eventsHashAt = (h: number): string | null => { const c = cursor(); return c === null || h > c.height ? null : held.eventsHashAt(h); };
  const metaAt = (c: Cursor): StoreMeta => ({
    ...(meta ?? { format: 1, rule, basis: source.basis, witnessed: null, windowSha256: null, work: null, workRoot: null }),
    cursor: c, eventsHash: held.eventsHash, rowsHash: held.rowsHash, eventCount: held.count,
  });

  // A store that throws while it is read is unavailable; a basis it refuses is the caller's error and is thrown.
  async function load(): Promise<LoopOpen> {
    let r: Awaited<ReturnType<Store["open"]>>, h: Held | null = null, b: Boundary[] = [];
    const rows: BlockRow[] = [];
    try {
      r = await store.open({ format: 1, rule, basis: source.basis });
      if (r.ok) {
        for await (const row of store.rows(0)) rows.push(row);
        b = await store.boundaries();
        h = verifyRows(rows, b, r.meta, rule);
      }
    } catch (e) {
      if (e instanceof ReplicaConfigError) throw e;
      r = { ok: false, reset: "unavailable" };
    }
    if (!r.ok || h === null) {
      const reset = r.ok ? "corrupt" : r.reset;
      change("replace", 0, 0, () => { opened = reset; meta = null; held = new Held(); bounds = []; });
      return { ok: false, reset };
    }
    change("replace", 0, 0, () => { opened = "open"; meta = r.meta; held = h!; bounds = b; filled.clear(); });
    m.load(rows, r.meta?.cursor?.height ?? null);
    return { ok: true };
  }

  function backOff(code: SourceCode | "STORE_FAILED", reason: string, afterMs: number | null): "stop" {
    lastError = { code, reason, at: clock() };
    // A source's wait is taken up to BACKOFF_MAX_MS; one that is not a finite number >= 0 is treated as absent.
    const asked = afterMs !== null && Number.isFinite(afterMs) && afterMs >= 0 ? Math.min(afterMs, BACKOFF_MAX_MS) : null;
    retryAt = clock() + (asked ?? Math.min(BACKOFF_FIRST_MS * 2 ** failures, BACKOFF_MAX_MS));
    failures++;
    return "stop";
  }
  function settled(t: TipView): void { tip = t; lastError = null; retryAt = null; failures = 0; }

  // `build` moves the rows and the materializer ahead of the commit, since a boundary's state is replayed from them.
  // When it throws, or the commit throws or is refused, both are read back from the store, so the loop never holds
  // what the store does not.
  async function commit(build: () => Commit): Promise<"ok" | "more" | "stop"> {
    let c: Commit, r: Awaited<ReturnType<Store["commit"]>>, why = "the store refused the commit";
    try { c = build(); } catch (e) { await load(); throw e; }
    try { r = await store.commit(c); } catch (e) { r = { ok: false, code: "STORE_FAILED" }; why = messageOf(e); }
    if (r.ok) {
      const keep = c.rollbackTo?.height ?? Number.POSITIVE_INFINITY;
      meta = c.meta;
      bounds = [...bounds.filter((b) => b.height <= keep), ...c.boundaries];
      for (const h of [...filled.keys()]) if (h > keep) filled.delete(h);
      return "ok";
    }
    await load();
    if (r.code === "STORE_FAILED") return backOff("STORE_FAILED", why, null);
    return opened === "open" ? "more" : "stop";   // another writer moved the cursor: go on from the store's
  }

  // The boundaries the cursor's move from `from` to `to` buries FINAL_DEPTH deep: multiples of EPOCH_LEN above the
  // last boundary held whose block is a held row (contract.ts keeps a row at every boundary height a source serves).
  // Those at or below `from - FINAL_DEPTH` were deep before this step, and a row is never added below the cursor.
  // Only a boundary at most STATE_WINDOW below `tip` is replayed for its state hash.
  function deepBoundaries(from: number, to: number, tip: number): Boundary[] {
    const out: Boundary[] = [], low = Math.max(bounds.at(-1)?.height ?? -1, from - FINAL_DEPTH);
    for (let b = (Math.floor(low / EPOCH_LEN) + 1) * EPOCH_LEN; b <= to - FINAL_DEPTH; b += EPOCH_LEN) {
      const hash = held.hashAt(b);
      if (hash === null) continue;
      const state = tip - b <= STATE_WINDOW ? m.stateAt(b, 0) : null;
      out.push({ height: b, hash, eventsHash: held.eventsHashAt(b), stateHash: state === null ? null : stateHash(state) });
    }
    return out;
  }

  async function onBlocks(s: Extract<Step, { kind: "blocks" }>): Promise<"more" | "stop"> {
    const at = cursor(), after = at?.height ?? rule.activationHeight - 1;
    let c: ReturnType<typeof checkStep>;
    try {
      c = checkStep(s, { after, eventsHash: held.eventsHash, rowsHash: held.rowsHash, sofar: held, rule });
    } catch (e) {
      c = { ok: false, reason: messageOf(e) };
    }
    if (!c.ok) return backOff("SOURCE_MALFORMED", c.reason, null);
    const { rows, cursor: next } = c, r = await commit(() => {
      change("extend", after, next.height, () => { held.add(rows); remember(s.blocks, next); });
      m.apply(rows, next.height);
      return { expect: at, rows, boundaries: deepBoundaries(after, next.height, s.tip.height), meta: metaAt(next) };
    });
    if (r !== "ok") return r;
    settled(s.tip);
    const goal = Math.max(s.tip.height, Number.isSafeInteger(s.reach) ? s.reach! : 0);
    return next.height >= goal ? "stop" : "more";
  }

  async function onReorg(s: Extract<Step, { kind: "reorg" }>): Promise<"more" | "stop"> {
    const at = cursor(), why = reorgBreak(s.to, at, source.floor?.height ?? rule.activationHeight - 1, hashAt);
    if (why !== null) return backOff("SOURCE_MALFORMED", why, null);
    const to = { height: s.to.height, hash: s.to.hash }, r = await commit(() => {
      change("replace", 0, 0, () => held.truncate(to.height));
      m.rollback(to.height);
      return { expect: at, rollbackTo: to, rows: [], boundaries: [], meta: metaAt(to) };
    });
    if (r !== "ok") return r;
    lastReorg = { from: at!, to: cursor()!, at: clock() };
    settled(s.tip);
    return "more";
  }

  async function step(signal: AbortSignal, deadlineAt: number): Promise<"more" | "stop"> {
    let s: Step;
    try {
      s = await source.next({ rule, cursor: cursor(), sofar: held, hashAt, eventsHashAt, budget: { deadlineAt, ...limits }, signal, now: clock });
    } catch (e) {
      return signal.aborted ? "stop" : backOff("SOURCE_UNAVAILABLE", messageOf(e), null);
    }
    if (signal.aborted) return "stop";
    if (s.kind === "cannot") return backOff(s.code, s.reason, s.retryAfterMs);
    if (s.kind === "idle") { settled(s.tip); return "stop"; }
    return exclusive(() => (s.kind === "reorg" ? onReorg(s) : onBlocks(s)));
  }

  async function drive(budgetMs: number, outer: AbortSignal | undefined): Promise<LoopStatus> {
    if (closing.signal.aborted) return status();
    if (opened !== "open") await load();
    const deadlineAt = clock() + budgetMs, l = linked(closing.signal, outer);
    try {
      while (opened === "open" && !l.signal.aborted && clock() < deadlineAt && (retryAt === null || clock() >= retryAt)) {
        if ((await step(l.signal, deadlineAt)) === "stop") break;
      }
    } finally {
      l.dispose();
    }
    return status();
  }

  const status = (): LoopStatus => ({
    store: opened, cursor: cursor(), eventsHash: meta?.eventsHash ?? EVENTS_HASH_START, eventCount: meta?.eventCount ?? 0,
    tip, lastReorg, lastError, retryAt, replayMs: m.replayMs,
  });
  const queued = <T>(f: () => Promise<T>): Promise<T> => { const run = queue.then(f); queue = run.catch(() => undefined); return run; };
  return {
    open: () => queued(load),
    advance: (a = {}) => queued(() => drive(a.budgetMs ?? Number.POSITIVE_INFINITY, a.signal)),
    status, eventsHashAt,
    hashAt: (h) => (opened === "open" ? hashAt(h) ?? recent.get(h) ?? null : null),
    generation: () => generation,
    committing: () => busy !== null,
    async quiet() { while (busy !== null) await busy; },
    rows: (from) => (opened === "open" ? held.rows.filter((r) => r.height >= from) : []),
    stateAt: (t, d) => (opened === "open" ? m.stateAt(t, d) : null),
    boundary(h) {
      const b = opened === "open" ? bounds.find((x) => x.height === h) : undefined;
      if (b === undefined || b.stateHash !== null) return b ?? null;
      let hash = filled.get(h);
      if (hash === undefined) {
        const state = m.stateAt(h, 0);
        if (state === null) return null;
        filled.set(h, (hash = stateHash(state)));
      }
      return { ...b, stateHash: hash };
    },
    async close() { closing.abort(); await queue; store.close(); opened = null; },
  };
}
