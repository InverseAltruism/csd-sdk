// open() and openLog() (design section 5): a loop over one source and one store, witnesses asked with every advance,
// and the reads, each answered with the verdict of verdict.ts and its own conditions. A read starts an advance when
// none is running and waits for it at most `waitMs` (default 0, so it answers from what is held); nothing polls on a
// timer, so a caller drives advance() or reads. No value is computed from a source's tip(): depth is counted from the
// tip the loop's last step reported.
import {
  CAIRNX_EVENT_RULE, FINAL_DEPTH, NAME_RE, TICKER_RE, canonicalJson, eventOfTx, resolve, type CairnXState, type ChainEvent, type EventRule, type EventRuleTx,
} from "@inversealtruism/cairnx-core";
import type { Answer, AnswerMeta, At, BalanceValue, BoundCursor, NameValue, Page, ReadOptions, ReplicaStatus, Transfer, Witness } from "./answer.js";
import { basisKey, checkBasis, floorBreak, levelOf, proofOf } from "./basis.js";
import type { NoteCode, NotVerifiedCode } from "./codes.js";
import { sameRule } from "./contract.js";
import { afterInApplyOrder, boundOf, nextOf, resumeOf, type HeldChain } from "./cursor.js";
import { ReplicaConfigError } from "./errors.js";
import { coreCheck, type CoreModule } from "./gates.js";
import { replicaLoop } from "./loop.js";
import { memoryStore } from "./memory-store.js";
import { fullReplay } from "./replay.js";
import { movesPage } from "./transfers.js";
import type { Basis, Cursor, HeaderRoot, Materializer, Source, Store } from "./types.js";
import { verdict } from "./verdict.js";
import { addressOf, balanceOf, nameOf, primaryOf } from "./views.js";
import { witnessBoard } from "./witness.js";

/** `source`: a block source (or, in tests, a feed); `store` defaults to memoryStore(); `witnesses` are asked with each
 *  advance; `core` is the caller's cairnx-core module, compared with the one this package loads; `clock` gives ms.
 *  `step`, internal: the budget of each step, default the loop's (64 blocks, 10 requests). */
export interface OpenOptions {
  readonly source: Source; readonly store?: Store; readonly witnesses?: readonly Witness[]; readonly core?: CoreModule; readonly clock?: () => number;
  readonly step?: { readonly maxBlocks: number; readonly maxRequests: number };
}
export interface EventLog {
  /** The events after `after` (exclusive) at least `minDepth` deep, in the order of CONVENTION section 33.3. A cursor
   *  whose events hash is no longer the replica's at its height is CURSOR_OFF_BRANCH, nothing shown (cursor.ts). */
  events(after: BoundCursor | null, o?: ReadOptions & { readonly limit?: number }): Promise<Answer<Page<ChainEvent>>>;
  status(): ReplicaStatus;
  subscribe(fn: (s: ReplicaStatus) => void): () => void;
  advance(o?: { readonly budgetMs?: number; readonly signal?: AbortSignal }): Promise<ReplicaStatus>;
  close(): Promise<void>;
}
export interface Reader extends EventLog {
  /** cairnx-core's nameView of `name` at the deep view, SHALLOW when the tip view differs. `name` is asked as `names`
   *  writes it (lower case, no `.csd`): any other string is INPUT_INVALID. */
  name(name: string, o?: ReadOptions): Promise<Answer<NameValue>>;
  balance(ticker: string, address: string, o?: ReadOptions): Promise<Answer<BalanceValue>>;
  /** The token moves to `address` (every address when null, which needs `ticker`) of the applied log at the deep view,
   *  narrowed to `ticker` when given, after `since` in (height, position) order. A `since` whose events hash is no
   *  longer the replica's at its height is CURSOR_OFF_BRANCH, nothing shown. */
  transfers(address: string | null, since: BoundCursor | null, o?: ReadOptions & { readonly limit?: number; readonly ticker?: string }): Promise<Answer<Page<Transfer, BoundCursor>>>;
  primary(address: string, o?: ReadOptions): Promise<Answer<{ readonly address: string; readonly name: string | null }>>;
  /** The deep view, a copy. */
  state(o?: ReadOptions): Promise<Answer<CairnXState>>;
  /** What cairnx-core's resolve() does with `tx`, a Propose or an Attest by `author`, in the block above the cursor
   *  after every event held: whether it applies, with the reason code and note of the applied log. It reads the tip
   *  view, so its `at` is the tip at depth 0. */
  dryRun(tx: DryRunTx, author: string, o?: Omit<ReadOptions, "minDepth">): Promise<Answer<{ readonly applied: boolean; readonly code: string | null; readonly note: string | null }>>;
}
/** A transaction to try: its app payload and outputs as cairnx-core's event rule reads them. */
export type DryRunTx = EventRuleTx["tx"];
// The id a tried transaction takes. Its entry in the applied log is found by this id at the height above the cursor,
// where no held event lies.
const TRY_TXID = `0x${"f".repeat(64)}`;

type Views = { deep: CairnXState | null; top: CairnXState | null; deepHeight: number };
type Out<T> = { value: T | null; shown: T | null; why?: NotVerifiedCode[]; notes?: NoteCode[] };

const rootOf = (b: Basis): { root: HeaderRoot; pin: Cursor | null } | null =>
  b.kind === "blocks" ? { root: b.root, pin: null } : b.kind === "pinned" ? { root: b.above.root, pin: b.pin } : null;
const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return url; } };
// openLog's: another rule's events have no CairnX state, so a boundary keeps a null state hash.
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
};
const copy = <T>(v: T): T => (v === null ? v : structuredClone(v));
// name and primary: the deep view is the value; when the tip view differs, SHALLOW with the tip view in `shown`, since
// a recent change of a name is the caution (design section 5).
function bothViews<T>(v: Views, f: (s: CairnXState) => T): Out<T> {
  const deep = v.deep === null ? null : f(v.deep), top = v.top === null ? null : f(v.top);
  const shallow = deep !== null && top !== null && canonicalJson(deep) !== canonicalJson(top);
  return { value: deep, shown: top ?? deep, why: shallow ? ["SHALLOW"] : [] };
}
const noState: Materializer = { load: () => undefined, apply: () => undefined, rollback: () => undefined, stateAt: () => null, replayMs: null };

async function start(o: OpenOptions, rule: EventRule, m: Materializer) {
  // Every answer's `vouch` is this object, so it is frozen; every other value a read returns is built for that read.
  const basis = deepFreeze(checkBasis(o.source.basis)), clock = o.clock ?? Date.now, witnesses = o.witnesses ?? [];
  if (basis.kind === "display") throw new ReplicaConfigError("open: a display source is read through ./display");
  const carried = o.source.rule;
  if (carried !== undefined && !sameRule(carried, rule)) throw new ReplicaConfigError(`open: the source's pin is of ${carried.domain}, not the store's rule`, "PIN_MISMATCH");
  const r = rootOf(basis), low = r === null ? null : floorBreak(r.root, r.pin?.height ?? rule.activationHeight - 1, rule);
  if (low !== null) throw new ReplicaConfigError(`open: ${low}`, "BELOW_FLOOR");
  const headers = r === null || r.root.kind === "own-node" ? null : r.root.kind === "caller" ? r.root.origin : (basis.kind === "pinned" ? basis.above : basis as { bodies: string }).bodies;
  const same = headers === null ? undefined : witnesses.find((w) => originOf(w.origin) === originOf(headers));
  if (same !== undefined) throw new ReplicaConfigError(`open: the witness ${same.id} is on the header source's origin ${originOf(headers!)}`);
  const core = coreCheck(o.core), board = witnessBoard(witnesses, clock), store = o.store ?? memoryStore();
  // A store refused for a reason other than `unavailable` is reset and refilled at whichever load finds it (loop.ts).
  const loop = replicaLoop({ source: o.source, store, rule, materializer: m, clock, resetRefused: true, ...o.step });
  await loop.open();
  const level = levelOf(basis), meta = { level, proof: proofOf(basis), vouch: basis }, listeners = new Set<(s: ReplicaStatus) => void>();
  let running: Promise<ReplicaStatus> | null = null;

  function judge(minDepth: number): Pick<AnswerMeta, "why" | "notes" | "at"> & { codes: NotVerifiedCode[] } {
    const now = board.now(), s = loop.status(), w = board.witnessed(loop.generation());   // the clock first: a set-back voids
    // During a step's commit the loop holds a half state: it is not synced until the commit ends.
    const busy = loop.committing();
    const synced = !busy && s.store === "open" && s.cursor !== null && s.tip !== null ? { cursor: s.cursor, tip: s.tip } : null;
    // Only a pinned source keeps a refusal of its pin; an anchor root without one names PIN_OFF_CHAIN for a step alone.
    const e = basis.kind === "pinned" ? s.lastError?.code : undefined, refused = e === "PIN_MISMATCH" || e === "PIN_OFF_CHAIN" || e === "RULES_DIFFER" ? e : null;
    const codes = verdict({
      level, feed: basis.kind === "feed", synced, now, peerAhead: (t) => board.peerAhead(t), refused,
      rulesDiffer: (tip) => core.differ(tip) || board.rulesDiffer(core.own, tip),
      witness: r === null || r.root.kind === "own-node" ? null : { at: w?.at ?? null },
    });
    const notes: NoteCode[] = [...(core.two ? ["TWO_CORES" as const] : []), ...(s.store === "unavailable" ? ["STORE_UNAVAILABLE" as const] : []),
      ...(board.disagree() ? ["SOURCES_DISAGREE" as const] : []), ...(board.malformed() ? ["WITNESS_MALFORMED" as const] : [])];
    const deep = synced === null ? 0 : synced.tip.height - minDepth;
    const at: At | null = synced === null ? null
      : { height: deep, hash: loop.hashAt(deep), deepHeight: deep, depth: minDepth, tipHeight: synced.tip.height, tipTime: synced.tip.time };
    const why = codes.map((code) => (code === "NOT_SYNCED" && busy ? { code, detail: "a step's commit is in flight" } : { code }));
    return { codes, why, notes: notes.map((code) => ({ code })), at };
  }

  function status(): ReplicaStatus {
    const s = loop.status(), j = judge(FINAL_DEPTH), w = board.witnessed(loop.generation());
    return { ...meta, why: j.why, notes: j.notes, at: j.at, verified: j.codes.length === 0, source: basisKey(basis), cursor: copy(s.cursor),
      witnessed: w === null ? null : { height: w.height, at: w.at }, lastReorg: copy(s.lastReorg), lastError: copy(s.lastError), tuple: null, compare: null, replayMs: s.replayMs };
  }

  // A call while a run is in flight joins it (its own budget and signal are not applied), so two runs never overlap.
  function advance(a: { budgetMs?: number; signal?: AbortSignal } = {}): Promise<ReplicaStatus> {
    if (running !== null) return running;
    const signal = a.signal ?? new AbortController().signal;
    const run = (async () => {
      await Promise.all([loop.advance(a), board.tips(signal)]);
      await board.confirm({ cursor: loop.status().cursor, hashAt: (h) => loop.hashAt(h), generation: () => loop.generation() }, signal);
      const s = status();
      for (const f of listeners) f(s);
      return s;
    })();
    running = run;
    const clear = () => { if (running === run) running = null; };
    run.then(clear, clear);
    return run;
  }

  // Waits until `done()` holds or a promise of `wake()` settles with it holding, at most until `deadline` (a time of
  // Date.now) or the read's signal. The read's signal ends only this wait.
  async function within(o: ReadOptions, deadline: number, done: () => boolean, wake: () => Promise<unknown>): Promise<void> {
    const ms = deadline - Date.now();
    if (done() || !(ms > 0) || o.signal?.aborted) return;
    let t: ReturnType<typeof setTimeout> | undefined, stop = () => undefined as void, over = false;
    const bound = new Promise<void>((go) => { stop = () => { over = true; go(); }; t = setTimeout(stop, ms); o.signal?.addEventListener("abort", stop, { once: true }); });
    while (!done() && !over) await Promise.race([wake().then(() => undefined, () => undefined), bound]);
    clearTimeout(t);
    o.signal?.removeEventListener("abort", stop);
  }

  async function read<T>(o: ReadOptions = {}, inputOk: boolean, f: (v: Views) => Out<T>): Promise<Answer<T>> {
    const minDepth = o.minDepth ?? FINAL_DEPTH, invalid = (): Answer<T> =>
      ({ ...meta, verified: false, value: null, shown: null, why: [{ code: "INPUT_INVALID" }], notes: [], at: null });
    if (!inputOk || !Number.isSafeInteger(minDepth) || minDepth < 0) return invalid();
    // A read starts an advance unless one runs, then waits for it and for a commit in flight, together at most
    // `waitMs` (default 0) from now. From the last check of committing() on nothing is awaited, so a read either
    // answers from the state the last whole commit left or, with a commit still in flight, NOT_SYNCED with nothing shown.
    const deadline = Date.now() + (o.waitMs ?? 0), step = running ?? advance();
    let ran = false;
    void step.then(() => { ran = true; }, () => { ran = true; });
    await within(o, deadline, () => ran, () => step);
    await within(o, deadline, () => !loop.committing(), () => loop.quiet());
    const j = judge(minDepth), s = loop.status(), busy = loop.committing();
    if (s.tip !== null && minDepth > s.tip.height) return invalid();
    const deepHeight = j.at?.deepHeight ?? 0;
    const views: Views = busy || s.tip === null || s.cursor === null ? { deep: null, top: null, deepHeight }
      : { deep: loop.stateAt(s.tip.height, minDepth), top: loop.stateAt(Math.min(s.cursor.height, s.tip.height), 0), deepHeight };
    const out: Out<T> = busy ? { value: null, shown: null } : f(views), own = [...(out.why ?? [])];
    // A cursor is checked against the rows held, inside the read; its refusal comes alone, as every other input's.
    if (own.includes("INPUT_INVALID")) return invalid();
    if (j.codes.length + own.length === 0 && out.value === null) own.push("NOT_SYNCED");
    const why = [...j.why, ...own.map((code) => ({ code }))], notes = [...j.notes, ...(out.notes ?? []).map((code) => ({ code }))];
    return why.length === 0 ? { ...meta, why, notes, at: j.at, verified: true, value: out.value! } : { ...meta, why, notes, at: j.at, verified: false, value: null, shown: out.shown };
  }

  // The chain both paged reads page and check a cursor against. None while the store is not open (after close() the
  // loop answers events hashes and no rows) or while the deep height lies above the replica's cursor (a catch-up, or a
  // rollback before the blocks after it), where no events hash is held for a cursor to be made at.
  function pagedChain(deepHeight: number): HeldChain | null {
    const s = loop.status(), c = s.cursor;
    if (s.store !== "open" || c === null || deepHeight > c.height) return null;
    return { cursorHeight: c.height, eventsHashAt: (h) => loop.eventsHashAt(h), rows: (h) => loop.rows(h) };
  }

  const log: EventLog = {
    events(after, o = {}) {
      const from = boundOf(after), limit = o.limit ?? 100;
      return read(o, from !== undefined && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, (v) => {
        const held = pagedChain(v.deepHeight);
        if (held === null) return { value: null, shown: null };
        const r = resumeOf(from!, held), items: ChainEvent[] = [];
        if (r.kind === "off-branch") return { value: null, shown: null, why: ["CURSOR_OFF_BRANCH"] };
        if (r.kind === "invalid") return { value: null, shown: null, why: ["INPUT_INVALID"] };
        let more = false;
        // Rows hold their events in apply order; the page resumes after the cursor's event in that order. A cursor
        // above the replica's has no rows above it.
        const start = r.kind === "from" ? r : null;
        for (const row of start === null ? [] : loop.rows(start.since?.height ?? 0)) {
          if (row.height > v.deepHeight) break;
          for (const e of row.events) {
            if (!afterInApplyOrder(e, start!)) continue;
            if (items.length === limit) { more = true; break; }
            items.push(e);
          }
          if (more) break;
        }
        // The held events are the loop's and the materializer's own objects: a page carries copies.
        const page = { items: structuredClone(items), next: nextOf(held, v.deepHeight, r, items.at(-1), more), more };
        return { value: page, shown: page, notes: r.kind === "above-tip" ? ["CURSOR_ABOVE_TIP"] : [] };
      });
    },
    status,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    advance,
    async close() { await running?.catch(() => undefined); await loop.close(); },
  };
  return { log, read, loop, pagedChain };
}

/** A replica of another rule's events (design section 5, M12): the event log and its status, no resolved state. */
export async function openLog(o: OpenOptions & { readonly rule: EventRule }): Promise<EventLog> {
  return (await start(o, o.rule, noState)).log;
}

/** A CairnX replica: the event log and the reads over cairnx-core's resolve(). Throws ReplicaConfigError for a basis
 *  that cannot give every event from activation (`code` BELOW_FLOOR), a pin of another rule (`code` PIN_MISMATCH) or a
 *  witness on the header source's origin. */
export async function open(o: OpenOptions): Promise<Reader> {
  const { log, read, loop, pagedChain } = await start(o, CAIRNX_EVENT_RULE, fullReplay());
  return {
    ...log,
    balance(ticker, address, ro) {
      const a = addressOf(address);
      return read<BalanceValue>(ro, a !== null && typeof ticker === "string" && TICKER_RE.test(ticker), (v) => {
        const deep = v.deep === null ? null : balanceOf(v.deep, ticker, a!), top = v.top === null ? null : balanceOf(v.top, ticker, a!);
        const base = deep ?? top;
        if (base === null) return { value: null, shown: null };
        const atTip = top !== null && deep !== null && (top.available !== deep.available || top.locked !== deep.locked) ? { atTip: { available: top.available, locked: top.locked } } : {};
        const value: BalanceValue = { ticker, address: a!, deployId: base.deployId, available: base.available, locked: base.locked, ...atTip };
        return { value: deep === null ? null : value, shown: value };
      });
    },
    transfers(address, since, ro = {}) {
      const to = address === null ? null : addressOf(address), ticker = ro.ticker ?? null, from = boundOf(since), limit = ro.limit ?? 100;
      const inputOk = (address === null ? ticker !== null : to !== null) && (ticker === null || (typeof ticker === "string" && TICKER_RE.test(ticker))) &&
        from !== undefined && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000;
      return read<Page<Transfer, BoundCursor>>(ro, inputOk, (v) => {
        const held = pagedChain(v.deepHeight);
        if (v.deep === null || held === null) return { value: null, shown: null };
        const r = movesPage({ ...held, deep: v.deep, deepHeight: v.deepHeight, to, ticker, since: from!, limit });
        if (r.kind !== "page") return { value: null, shown: null, why: [r.kind === "off-branch" ? "CURSOR_OFF_BRANCH" : "INPUT_INVALID"] };
        return { value: r.page, shown: r.page, notes: r.aboveTip ? ["CURSOR_ABOVE_TIP"] : [] };
      });
    },
    name(name, ro) {
      return read(ro, typeof name === "string" && NAME_RE.test(name), (v) => bothViews(v, (s) => nameOf(s, name)!));
    },
    primary(address, ro) {
      const a = addressOf(address);
      return read(ro, a !== null, (v) => bothViews(v, (s) => ({ address: a!, name: primaryOf(s, a!) })));
    },
    state(ro) {
      return read(ro, true, (v) => { const s = v.deep === null ? null : structuredClone(v.deep); return { value: s, shown: s }; });
    },
    dryRun(tx, author, ro) {
      const a = addressOf(author);
      let ev: ChainEvent | null = null;
      try { ev = a === null ? null : eventOfTx({ pos: 1, txid: TRY_TXID, tx }, Number.MAX_SAFE_INTEGER - 1, a); } catch { ev = null; }   // refused by the rule
      return read({ ...ro, minDepth: 0 }, ev !== null, () => {
        const c = log.status().cursor;
        if (c === null) return { value: null, shown: null };
        const h = c.height + 1, events = [...loop.rows(0).flatMap((r) => r.events), { ...ev!, height: h }];
        const entry = resolve(events, h).events.find((e) => e.id === TRY_TXID && e.height === h);
        const value = { applied: entry?.ok === true, code: entry?.code ?? null, note: entry?.note ?? null };
        return { value, shown: value };
      });
    },
  };
}
