// open() and openLog() (design section 5): a loop over one source and one store, witnesses asked with every advance,
// and the reads, each answered with the verdict of verdict.ts and its own conditions. A read starts an advance when
// none is running and waits for it at most `waitMs` (default 0, so it answers from what is held); nothing polls on a
// timer, so a caller drives advance() or reads. No value is computed from a source's tip(): depth is counted from the
// tip the loop's last step reported.
import {
  CAIRNX_EVENT_RULE, FINAL_DEPTH, NAME_RE, TICKER_RE, canonicalJson, eventOfTx, resolve, type CairnXState, type ChainEvent, type EventRule, type EventRuleTx,
} from "@inversealtruism/cairnx-core";
import type { Answer, AnswerMeta, At, BalanceValue, BoundCursor, NameValue, Page, ReadOptions, ReplicaStatus, Snapshot, Transfer, Witness } from "./answer.js";
import { basisKey, checkBasis, floorBreak, levelOf, proofOf } from "./basis.js";
import type { NoteCode, NotVerifiedCode } from "./codes.js";
import { sameRule } from "./contract.js";
import { afterInApplyOrder, boundOf, nextOf, resumeOf, type HeldChain } from "./cursor.js";
import { ReplicaConfigError, messageOf } from "./errors.js";
import { comparer, type TupleReference } from "./compare.js";
import { either } from "./http.js";
import { coreCheck, LOADED_GATES, type CoreModule } from "./gates.js";
import { replicaLoop, type StoreReason } from "./loop.js";
import { memoryStore } from "./memory-store.js";
import { fullReplay } from "./replay.js";
import { movesPage } from "./transfers.js";
import { tupleOf, type Tuple } from "./tuple.js";
import type { Basis, Cursor, HeaderRoot, KeptView, Materializer, Source, Store } from "./types.js";
import { FRESH_MS, STALE_MAX_MS, farAhead, olderThan, verdict } from "./verdict.js";
import { addressOf, balanceOf, nameOf, primaryOf } from "./views.js";
import { witnessBoard } from "./witness.js";

/** `source`: a block source (or, in tests, a feed); `store` defaults to memoryStore(); `witnesses` are asked with each
 *  advance; `core` is the caller's cairnx-core module, compared with the one this package loads; `clock` gives ms;
 *  `reference`: a host whose tuples each advance compares with the replica's (compare.ts; open() only).
 *  `step`, internal: the budget of each step, default the loop's (64 blocks, 10 requests). */
export interface OpenOptions {
  readonly source: Source; readonly store?: Store; readonly witnesses?: readonly Witness[]; readonly core?: CoreModule; readonly clock?: () => number;
  readonly reference?: TupleReference; readonly step?: { readonly maxBlocks: number; readonly maxRequests: number };
}
/** The least time between the end of an advance and one a read starts, as the hosted resolver polls by default: a burst
 *  of reads polls the source at most once in it. advance() itself starts one whenever none runs. */
export const READ_ADVANCE_MS = 15_000;
/** How long a recount from blocks may run before it gives no answer: it reads its source from the floor to the source's
 *  tip, 10 minutes at most. The advance's signal and close() end it sooner, and an ended recount settles nothing. */
export const RECOUNT_MS = 600_000;
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
   *  view; its `at` is the cursor it was tried above, which is the tip at depth 0 when the replica is synced. */
  dryRun(tx: DryRunTx, author: string, o?: Omit<ReadOptions, "minDepth">): Promise<Answer<{ readonly applied: boolean; readonly code: string | null; readonly note: string | null }>>;
  /** The tip view (depth 0, the lower of the cursor and the tip) and every event held up to it, from one commit, frozen:
   *  what a server answers the CairnX resolver's reads from (handlers.ts, read-routes.ts). `at` names the view's block. */
  snapshot(o?: Omit<ReadOptions, "minDepth">): Promise<Answer<Snapshot>>;
}
/** A transaction to try: its app payload and outputs as cairnx-core's event rule reads them. */
export type DryRunTx = EventRuleTx["tx"];
/** Internal. The detail of STORE_UNAVAILABLE for each reason a load gives (loop.ts StoreReason). */
export const STORE_DETAILS: Readonly<Record<StoreReason, string>> = Object.freeze({
  held: "another process or context holds the store",
  foreign: "the store refuses its directory: another program's file is there",
  io: "a read or write of the store failed",
  format: "the store is of another format and its reset failed",
  rule: "the store was written under another rule or gate table and its reset failed",
  basis: "the store was filled under another basis and its reset failed",
  corrupt: "the store's files fail their checks and its reset failed",
  unconfirmed: "the store's trusted slot does not name its record and its reset failed",
});
// The id a tried transaction takes. Its entry in the applied log is found by this id at the height above the cursor,
// where no held event lies.
const TRY_TXID = `0x${"f".repeat(64)}`;

type Views = { deep: CairnXState | null; top: CairnXState | null; deepHeight: number };
type Out<T> = { value: T | null; shown: T | null; why?: NotVerifiedCode[]; notes?: NoteCode[] };

const rootOf = (b: Basis): { root: HeaderRoot; pin: Cursor | null } | null =>
  b.kind === "blocks" ? { root: b.root, pin: null } : b.kind === "pinned" ? { root: b.above.root, pin: b.pin } : null;
const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return url; } };
// Every origin a store's records or headers are read from: a reference on one of them is no second source.
const originsOf = (b: Basis): string[] => {
  const blocks = b.kind === "pinned" ? b.above : b.kind === "blocks" ? b : null;
  if (blocks === null) return b.kind === "feed" ? [originOf(b.feed)] : b.kind === "display" ? [originOf(b.origin)] : [];
  const root = blocks.root;
  return [originOf(blocks.bodies), ...(root.kind === "own-node" ? [originOf(root.node)] : root.kind === "caller" ? [originOf(root.origin)] : [])];
};
// openLog's: another rule's events have no CairnX state, so a boundary keeps a null state hash.
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
};
const copy = <T>(v: T): T => (v === null ? v : structuredClone(v));
// An answer whose value was read at `height` (the cursor, or a view below the tip) names that block in `at`.
function atHeight<T>(a: Answer<T>, height: number, hash: string | null): Answer<T> {
  if (a.at === null || a.at.height === height) return a;
  return { ...a, at: { ...a.at, height, hash, deepHeight: height, depth: Math.max(0, a.at.tipHeight - height) } };
}
// name and primary: the deep view is the value; when the tip view differs, SHALLOW with the tip view in `shown`, since
// a recent change of a name is the caution (design section 5).
function bothViews<T>(v: Views, f: (s: CairnXState) => T): Out<T> {
  const deep = v.deep === null ? null : f(v.deep), top = v.top === null ? null : f(v.top);
  const shallow = deep !== null && top !== null && canonicalJson(deep) !== canonicalJson(top);
  return { value: deep, shown: top ?? deep, why: shallow ? ["SHALLOW"] : [] };
}
const noState: Materializer = { load: () => undefined, apply: () => undefined, rollback: () => undefined, stateAt: () => null, replayMs: null };

async function start(o: OpenOptions, rule: EventRule, m: Materializer, recount: Source | null = null, compares = false) {
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
  restore(store.kept?.() ?? null);
  const level = levelOf(basis), meta = { level, proof: proofOf(basis), vouch: basis }, listeners = new Set<(s: ReplicaStatus) => void>();
  // A feed with inclusion serves final blocks only: its tip is its final height (indexer-feed.ts), noted on every answer.
  const finalOnly = basis.kind === "feed" && basis.inclusion;
  // `running` is a whole advance; `stepping` the part a read waits for (the step and the witnesses), so a read is not
  // held by a reference, which the advance compares after it. close() aborts the comparison and a recount.
  let running: Promise<ReplicaStatus> | null = null, stepping: Promise<void> | null = null, endedAt = Number.NEGATIVE_INFINITY;
  const closing = new AbortController();
  const ref = compares ? o.reference : undefined;
  const cmp = ref === undefined ? null : comparer({
    ref, sameOrigin: originsOf(basis).includes(originOf(ref.base)), gates: LOADED_GATES, rebuild: () => loop.rebuild(),
    ...(recount === null ? {} : { recount: (h: number, sig: AbortSignal) => recountAt(recount, h, sig) }),
  });
  // A separate loop over the recount source in memory, read to `height` FINAL_DEPTH deep: its tuple there, or null.
  async function recountAt(src: Source, height: number, signal: AbortSignal): Promise<Tuple | null> {
    const l = replicaLoop({ source: src, store: memoryStore(), rule, clock, ...o.step });
    try { await l.open(); await l.advance({ budgetMs: RECOUNT_MS, signal }); return signal.aborted ? null : tupleOf(l.boundary(height)); } finally { await l.close(); }
  }
  const pin = o.source.pin;
  const view = {
    heights: () => loop.boundaryHeights(), tupleAt: (h: number) => tupleOf(loop.boundary(h)), hashAt: (h: number) => loop.hashAt(h),
    newest: () => tupleOf(loop.newestBoundary()), pin: basis.kind === "pinned" && pin !== undefined ? { height: pin.height, blockHash: pin.blockHash, eventsHash: pin.eventsHash, stateHash: pin.stateHash } : null,
  };
  const COMPARE_NOTES = { branch: "TUPLE_BRANCH", records: "TUPLE_RECORDS", rules: "TUPLE_RULES" } as const;

  function judge(minDepth: number): Pick<AnswerMeta, "why" | "notes" | "at"> & { codes: NotVerifiedCode[] } {
    const now = board.now(), s = loop.status(), w = board.witnessed(loop.generation());   // the clock first: a set-back voids
    // During a step's commit the loop holds a half state: it is not synced until the commit ends.
    const busy = loop.committing();
    const synced = !busy && s.store === "open" && s.cursor !== null && s.tip !== null ? { cursor: s.cursor, tip: s.tip } : null;
    // Only a pinned source keeps a refusal of its pin; an anchor root without one names PIN_OFF_CHAIN for a step alone.
    const e = basis.kind === "pinned" ? s.lastError?.code : undefined, refused = e === "PIN_MISMATCH" || e === "PIN_OFF_CHAIN" || e === "RULES_DIFFER" ? e : null;
    const codes = verdict({
      level, feed: basis.kind === "feed", finalOnly, synced, now, peerAhead: (t) => board.peerLead(t) > 0, refused, unconfirmed: s.unconfirmed || (cmp?.owed() ?? false) || (cmp?.outvoted() ?? false),
      rulesDiffer: (tip) => core.differ(tip) || board.rulesDiffer(core.own, tip), disputed: cmp?.pinDisputed() ?? false,
      witness: r === null || r.root.kind === "own-node" ? null : { at: w?.at ?? null },
    });
    // Why the store is unavailable reaches a caller that only reads as one of a fixed list (a refusal met inside a
    // later load throws only into advance()); the store's own message, which holds paths, stays on the loop's status.
    const unavailable = s.storeReason === null ? { code: "STORE_UNAVAILABLE" as const } : { code: "STORE_UNAVAILABLE" as const, detail: STORE_DETAILS[s.storeReason] };
    const lead = synced === null ? 0 : board.peerLead(synced.tip);
    const notes: { code: NoteCode; detail?: string }[] = [...(finalOnly ? [{ code: "FINAL_VIEW" as const }] : []), ...(core.two ? [{ code: "TWO_CORES" as const }] : []), ...(s.store === "unavailable" ? [unavailable] : []),
      ...(board.disagree() ? [{ code: "SOURCES_DISAGREE" as const }] : []), ...(board.malformed() ? [{ code: "WITNESS_MALFORMED" as const }] : []), ...compareNotes(),
      ...(farAhead(lead, finalOnly) ? [{ code: "PEER_FAR_AHEAD" as const, detail: `a witness's tip ${lead} blocks above` }] : []),
      ...(synced !== null && olderThan(now, synced.tip.time, STALE_MAX_MS, finalOnly) ? [{ code: "TIP_STALE_LONG" as const }] : [])];
    const deep = synced === null ? 0 : synced.tip.height - minDepth;
    const at: At | null = synced === null ? null
      : { height: deep, hash: loop.hashAt(deep), deepHeight: deep, depth: minDepth, tipHeight: synced.tip.height, tipTime: synced.tip.time };
    const why = codes.map((code) => (code === "NOT_SYNCED" && busy ? { code, detail: "a step's commit is in flight" } : { code }));
    return { codes, why, notes, at };
  }

  // A view the store kept from before a restart of its context, kept only while the reader was verified, taken whole or
  // not at all, and only where a running reader would answer from it: the clock reads no earlier than at the keep (a
  // running reader voids its confirmation on a clock set back); the tip is the block at the cursor, in a record
  // committed under this basis (loop.resume), and at most FRESH_MS old; where the root needs a witness, the
  // confirmation is of a block held, at most FRESH_MS old and not later than the clock, by one of this reader's
  // witnesses, and was held with that tip. Otherwise the reader starts as a fresh one (test/browser/idb-store.test.ts).
  function restore(v: KeptView | null): void {
    if (v === null) return;
    const now = clock(), w = v.witnessed, needs = r !== null && r.root.kind !== "own-node";
    if (now < v.at || !(now - v.tip.time * 1000 <= FRESH_MS)) return;
    if (needs && !(w !== null && w.tip === v.tip.hash && now >= w.at && now - w.at <= FRESH_MS && witnesses.some((x) => x.id === w.by) && loop.hashAt(w.height) === w.hash)) return;
    if (!loop.resume(v.tip)) return;
    if (needs) board.restore({ height: w!.height, hash: w!.hash, by: w!.by, at: w!.at, generation: loop.generation() });
  }
  // What the store keeps for the next start of its context: while the verdict has no code, the last step's tip and the
  // confirmation held with it; under any other verdict nothing, so a restart does not forget a denial. A store that
  // throws fails soft: the error goes to status(), the view is cleared where the store lets it, and the advance goes on.
  let keepError: string | null = null;
  async function keep(): Promise<void> {
    if (store.keep === undefined) return;
    const s = loop.status(), w = board.witnessed(loop.generation()), now = Math.floor(clock());
    const view: KeptView | null = s.store === "open" && s.tip !== null && judge(FINAL_DEPTH).codes.length === 0
      ? { at: now, tip: s.tip, witnessed: w === null ? null : { height: w.height, hash: w.hash, by: w.by, at: Math.floor(w.at), tip: s.tip.hash } } : null;
    try { await store.keep(view); keepError = null; } catch (e) {
      keepError = messageOf(e);
      if (view !== null) await store.keep(null).catch((e2: unknown) => { keepError += `; clearing it: ${messageOf(e2)}`; });
    }
  }

  function compareNotes(): { code: NoteCode; detail?: string }[] {
    const c = cmp?.report() ?? null;
    if (c === null) return [];
    const kind = c.kind === "branch" || c.kind === "records" || c.kind === "rules" ? [{ code: COMPARE_NOTES[c.kind] as NoteCode, detail: `boundary ${c.height}` }] : [];
    return [...kind, ...(c.recount === "ours" ? [{ code: "DIVERGENCE_CONFIRMED" as const, detail: `boundary ${c.height}` }] : []),
      ...(cmp?.outvoted() === true ? [{ code: "SOURCES_DISAGREE" as const, detail: `the store's source, against the recount and the reference at boundary ${c.height}` }] : [])];
  }

  function status(): ReplicaStatus {
    const s = loop.status(), j = judge(FINAL_DEPTH), w = board.witnessed(loop.generation());
    return { ...meta, why: j.why, notes: j.notes, at: j.at, verified: j.codes.length === 0, source: basisKey(basis), cursor: copy(s.cursor),
      storeReason: s.storeReason, storeError: s.storeError, keepError,
      witnessed: w === null ? null : { height: w.height, at: w.at }, lastReorg: copy(s.lastReorg), lastError: copy(s.lastError), tuple: tupleOf(loop.newestBoundary()), compare: copy(cmp?.report() ?? null), replayMs: s.replayMs };
  }

  // A call while a run is in flight joins it (its own budget and signal are not applied), so two runs never overlap.
  function advance(a: { budgetMs?: number; signal?: AbortSignal } = {}): Promise<ReplicaStatus> {
    if (running !== null) return running;
    const signal = a.signal ?? new AbortController().signal;
    const stepped = (async () => {
      await Promise.all([loop.advance(a), board.tips(signal)]);
      await board.confirm({ cursor: loop.status().cursor, hashAt: (h) => loop.hashAt(h), generation: () => loop.generation() }, signal);
    })();
    const run = (async () => {
      await stepped;
      await cmp?.run(view, either(signal, closing.signal));
      await keep();
      const s = status();
      for (const f of listeners) f(s);
      return s;
    })();
    running = run; stepping = stepped;
    const clear = () => { endedAt = clock(); if (running === run) { running = null; stepping = null; } };
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
    // A read starts an advance unless one runs or the last ended less than READ_ADVANCE_MS ago, then waits for the step
    // of the advance running (not the comparison that follows it) and for a commit in flight, together at most
    // `waitMs` (default 0) from now. From the last check of committing() on nothing is awaited, so a read either
    // answers from the state the last whole commit left or, with a commit still in flight, NOT_SYNCED with nothing shown.
    const since = clock() - endedAt;   // a clock set back counts as the interval passed
    if (running === null && !(since >= 0 && since < READ_ADVANCE_MS)) void advance().catch(() => undefined);
    const deadline = Date.now() + (o.waitMs ?? 0), step = stepping;
    let ran = step === null;
    void step?.then(() => { ran = true; }, () => { ran = true; });
    await within(o, deadline, () => ran, () => step ?? Promise.resolve());
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
    async close() { closing.abort(); await running?.catch(() => undefined); await loop.close(); },
  };
  return { log, read, loop, pagedChain };
}

/** A replica of another rule's events (CONVENTION section 35.2): the event log and its status, no resolved state. */
export async function openLog(o: OpenOptions & { readonly rule: EventRule }): Promise<EventLog> {
  return (await start(o, o.rule, noState)).log;
}

/** A CairnX replica: the event log and the reads over cairnx-core's resolve(). Throws ReplicaConfigError for a basis
 *  that cannot give every event from activation (`code` BELOW_FLOOR), a pin of another rule (`code` PIN_MISMATCH) or a
 *  witness on the header source's origin. */
export function open(o: OpenOptions): Promise<Reader> {
  return openWith(o, null);
}

/** Internal: open() with a recount source, which ./server's open() takes. */
export async function openWith(o: OpenOptions, recount: Source | null): Promise<Reader> {
  const { log, read, loop, pagedChain } = await start(o, CAIRNX_EVENT_RULE, fullReplay(), recount, true);
  // The last snapshot, kept while its key names the state the loop holds: one copy per commit, however many reads.
  let snap: { key: string; value: Snapshot } | null = null;
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
    async dryRun(tx, author, ro) {
      const a = addressOf(author);
      let ev: ChainEvent | null = null;
      try { ev = a === null ? null : eventOfTx({ pos: 1, txid: TRY_TXID, tx }, Number.MAX_SAFE_INTEGER - 1, a); } catch { ev = null; }   // refused by the rule
      const tried: { c: Cursor | null } = { c: null };
      const answer = await read({ ...ro, minDepth: 0 }, ev !== null, () => {
        const c = log.status().cursor;
        if (c === null) return { value: null, shown: null };
        tried.c = c;
        const h = c.height + 1, events = [...loop.rows(0).flatMap((r) => r.events), { ...ev!, height: h }];
        const entry = resolve(events, h).events.find((e) => e.id === TRY_TXID && e.height === h);
        const value = { applied: entry?.ok === true, code: entry?.code ?? null, note: entry?.note ?? null };
        return { value, shown: value };
      });
      return tried.c === null ? answer : atHeight(answer, tried.c.height, tried.c.hash);
    },
    async snapshot(ro) {
      const view: { height: number; hash: string | null } = { height: -1, hash: null };
      const answer = await read<Snapshot>({ ...ro, minDepth: 0 }, true, (v) => {
        const c = loop.status().cursor;
        if (c === null || v.top === null) return { value: null, shown: null };
        const height = Math.min(c.height, v.deepHeight), key = `${height}:${c.hash}:${loop.generation()}`;
        view.height = height; view.hash = height === c.height ? c.hash : loop.hashAt(height);
        if (snap?.key !== key) {
          const events = loop.rows(0).filter((r) => r.height <= height).flatMap((r) => r.events);
          snap = { key, value: deepFreeze({ key, height, state: structuredClone(v.top), events: structuredClone(events) }) };
        }
        return { value: snap.value, shown: snap.value };
      });
      return view.height < 0 ? answer : atHeight(answer, view.height, view.hash);
    },
  };
}
