// The service worker of the test extension (idb-store.test.ts bundles it): the store suite over idbStore, fills of a
// stub chain through the loop and the reader, a fill held at a point of a commit, and the store-level cases, each one
// command a control page sends with chrome.runtime.sendMessage.
import { CAIRNX_EVENT_RULE, eventsHashStep, payloadHash } from "@inversealtruism/cairnx-core";
import { idbStore, idbStoreWith, sessionSlot } from "../../src/idb-store.js";
import { open, replicaLoop, type Boundary, type BlockRow, type BlocksSource, type Commit, type Step, type Store, type Witness } from "../../src/index.js";
import { rowsHashStep } from "../../src/rowshash.js";
import { boundsHashStep, BOUNDS_HASH_START } from "../../src/store-format.js";
import { fixtures } from "../../src/testing.js";
import { FEED, at, commit, key, row, storeSuite } from "../store-suite.js";

type Chrome = {
  runtime: { onMessage: { addListener(f: (m: { cmd?: string; args?: Args }, s: unknown, reply: (v: unknown) => void) => boolean): void } };
  storage: { session: { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void>; remove(k: string): Promise<void> } };
};
type Args = Record<string, unknown> & { name?: string; top?: number; nth?: number; point?: string };
const chrome = (globalThis as unknown as { chrome: Chrome }).chrome;
const ACT = CAIRNX_EVENT_RULE.activationHeight, TOP = ACT + 2_000, f = fixtures();

// The stub chain: a block at every height from activation, `dense` Proposes at every 37th, a hash a height. Under a
// caller root (`caller`) a reader needs a witness; `offline` refuses every step, as a source with no network.
const hashOf = (h: number) => `0x${h.toString(16).padStart(8, "0")}${"ab".repeat(28)}`;
const eventsAt = (h: number, dense: number) => (h % 37 !== 0 ? [] : Array.from({ length: dense }, (_, i) =>
  f.prop({ v: 1, t: "nrenew", name: "alice" }, { proposer: `0x${"a1".repeat(20)}`, height: h, pos: i + 1, id: `0x${h.toString(16).padStart(56, "0")}${(i + 1).toString(16).padStart(8, "0")}` })));
type Kind = { readonly caller?: boolean; readonly offline?: boolean; readonly dense?: number };
const calls = { next: 0, tip: 0 };
function source(top: number, k: Kind = {}): BlocksSource {
  const tip = () => ({ height: top, hash: hashOf(top), time: Math.floor(Date.now() / 1000) });
  const root = k.caller === true ? { kind: "caller", floor: ACT - 1, origin: "https://headers.example" } as const : { kind: "own-node", node: "http://127.0.0.1:8789" } as const;
  return {
    basis: { kind: "blocks", root, bodies: k.caller === true ? "https://bodies.example" : "http://127.0.0.1:8789" }, floor: null,
    tip: async () => tip(), block: async () => { throw new Error("the stub source serves steps only"); },
    async next(ctx): Promise<Step> {
      calls.next++;
      if (k.offline === true) return { kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "offline", retryAfterMs: null };
      const after = ctx.cursor?.height ?? ACT - 1;
      if (after >= top) return { kind: "idle", tip: tip() };
      const blocks = [];
      for (let h = after + 1; h <= Math.min(top, after + ctx.budget.maxBlocks); h++) blocks.push({ height: h, hash: hashOf(h), events: eventsAt(h, k.dense ?? 1) });
      return { kind: "blocks", blocks, cursor: { height: blocks.at(-1)!.height, hash: blocks.at(-1)!.hash }, tip: tip() };
    },
  };
}
const slotKey = (name: string) => `slot:${name}`;
// A witness on another origin at the stub chain's top; `offline` throws, as a witness with no network.
const witness = (offline: boolean): Witness => ({
  id: "w1", origin: "https://witness.example",
  async tip() { calls.tip++; if (offline) throw new Error("offline"); return { height: TOP, hash: hashOf(TOP), time: Math.floor(Date.now() / 1000), header: {} as never }; },
  async hashAt(h) { if (offline) throw new Error("offline"); return hashOf(h); },
});
// The reader of the production call shape over `name`'s store: open() with idbStore and sessionSlot.
const viewReader = (name: string, k: Kind, clock?: () => number) => open({ source: source(TOP, k), store: idbStore({ name, slot: sessionSlot(slotKey(name)) }),
  witnesses: k.caller === true ? [witness(k.offline === true)] : [], ...(clock === undefined ? {} : { clock }) });
const codesOf = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code);
// A store recording each open's answer and each commit's cursor once taken.
function watched(s: Store, opens: string[], cursors: (number | null)[]): Store {
  return { ...s, rows: (h) => s.rows(h), async open(e) { const o = await s.open(e); opens.push(o.ok ? "ok" : o.reset); return o; },
    async commit(c: Commit) { const r = await s.commit(c); if (r.ok) cursors.push(c.meta.cursor?.height ?? null); return r; } };
}
const never = new Promise<void>(() => undefined);
let reached: ((p: string) => void) | null = null;

// The loop over the stub chain on `name`'s store: the answers of its opens, where it opened, and the cursor and events
// hash it ran on to.
async function state(name: string, top = TOP) {
  const opens: string[] = [], cursors: (number | null)[] = [];
  const loop = replicaLoop({ source: source(top), store: watched(idbStore({ name, slot: sessionSlot(slotKey(name)) }), opens, cursors), resetRefused: true });
  await loop.open();
  const openedAt = loop.status().cursor?.height ?? null, s = await loop.advance({ budgetMs: 120_000 });
  await loop.close();
  return { opens, openedAt, cursor: s.cursor?.height ?? null, eventsHash: s.eventsHash, lastError: s.lastError?.reason ?? null, commits: cursors };
}
// The raw content of `name`'s database.
async function raw(name: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => { const q = indexedDB.open(`cairnx-replica:${name}`); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
const all = <T>(db: IDBDatabase, s: string): Promise<T[]> => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result as T[]); });
const one = <T>(db: IDBDatabase, s: string, k: string): Promise<T> => new Promise((res) => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => res(q.result as T); });
function put(db: IDBDatabase, writes: [string, unknown, IDBValidKey][], clear: string[] = []): Promise<void> {
  const tx = db.transaction(["meta", "rows", "bounds", "window"], "readwrite");
  for (const s of clear) tx.objectStore(s).clear();
  for (const [s, v, k] of writes) tx.objectStore(s).put(v, k);
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); });
}
const reasonOf = async (s: Store) => { const o = await s.open(key(FEED)); return o.ok ? "ok" : o.reset; };
const fresh = (p: string) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const cmds: Record<string, (a: Args) => Promise<unknown>> = {
  async suite() {
    const checks = await storeSuite(() => { const name = fresh("suite"); return idbStore({ name, slot: sessionSlot(slotKey(name)) }); });
    return { total: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) };
  },
  async refusals() {
    const name = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return (e as Error).name; } };
    return { badName: name(() => idbStore({ name: "Wallet Store", slot: sessionSlot("x") })), noSlot: name(() => idbStore({ name: "w" } as never)),
      emptyKey: name(() => sessionSlot("")) };
  },
  state: (a) => state(a.name!, a.top),
  // The production call shape: open() over idbStore and sessionSlot; verified, and how the store opened.
  async reader(a) {
    const opens: string[] = [];
    const r = await open({ source: source(TOP), store: watched(idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }), opens, []) });
    const s = await r.advance({ budgetMs: 120_000 });
    await r.close();
    return { verified: s.verified, why: s.why.map((w) => w.code), cursor: s.cursor?.height ?? null, opens };
  },
  // A fill whose `nth` commit stops at `point`: it answers once the point is reached and never finishes there.
  async fillHeld(a) {
    let commits = 0;
    const got = new Promise<string>((res) => { reached = res; });
    const store = idbStoreWith({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }, {
      // "issued" is not awaited (the transaction would commit), so that commit is held at its next point instead: the
      // fill stops there and the worker is stopped with the transaction in flight or just landed, never a later commit.
      point(p) {
        if (commits === a.nth && a.point === "issued" && p === "slot new") return never;
        if (commits !== a.nth || p !== a.point) return undefined;
        reached?.(p);
        return p === "issued" ? undefined : never;
      },
    });
    const counted: Store = { ...store, rows: (h) => store.rows(h), commit(c) { commits++; return store.commit(c); } };
    const loop = replicaLoop({ source: source(TOP), store: counted, resetRefused: true });
    void loop.open().then(() => loop.advance({ budgetMs: 120_000 }));
    return { reached: await Promise.race([got, new Promise((res) => setTimeout(() => res(null), 30_000))]) };
  },
  async fillAsync(a) {
    const loop = replicaLoop({ source: source(TOP), store: idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }), resetRefused: true });
    void loop.open().then(() => loop.advance({ budgetMs: 120_000 }));
    return { started: true };
  },
  async emptySlot(a) { await chrome.storage.session.remove(slotKey(a.name!)); return { emptied: true }; },
  // A consistent forgery, as a program writing the profile makes it: a Propose added to the last row and every running
  // value after it recomputed (the rows, the meta, the boundaries at or above it, the chain, the record). With
  // `slotToo`, the slot is made to name the forged record, as if check (2) were not made.
  async forge(a) {
    const db = await raw(a.name!), rows = await all<BlockRow>(db, "rows"), bounds = await all<Boundary>(db, "bounds");
    const record = await one<{ meta: { eventCount: number; eventsHash: string; rowsHash: string } }>(db, "meta", "meta"), last = rows.at(-1)!, below = rows.at(-2);
    last.events.push(f.prop({ v: 1, t: "nrenew", name: "forged" }, { proposer: `0x${"f1".repeat(20)}`, height: last.height, pos: 9, id: `0x${"f".repeat(64)}` }));
    const eventsHash = eventsHashStep(below!.eventsHash, last.height, last.events), rowsHash = rowsHashStep(below!.rowsHash, last);
    Object.assign(last, { eventsHash, rowsHash });
    let chain = BOUNDS_HASH_START;
    for (const b of bounds) { if (b.height >= last.height) Object.assign(b, { eventsHash, rowsHash }); chain = boundsHashStep(chain, b); }
    const forged = { ...record, meta: { ...record.meta, eventsHash, rowsHash, eventCount: record.meta.eventCount + 1 }, boundsHash: chain };
    await put(db, [["rows", last, last.height], ["meta", forged, "meta"], ...bounds.map((b): [string, unknown, IDBValidKey] => ["bounds", b, b.height])]);
    db.close();
    if (a.slotToo === true) await chrome.storage.session.set({ [slotKey(a.name!)]: JSON.stringify({ hashes: [payloadHash(forged)] }) });
    return { forgedAt: last.height };
  },
  // The view a reader keeps: online until verified (under a caller root with its witness), then closed.
  async fillView(a) {
    const r = await viewReader(a.name!, { caller: true, dense: Number(a.dense ?? 1) });
    let s = await r.advance({ budgetMs: 120_000 });
    for (let i = 0; i < 5 && !s.verified; i++) s = await r.advance({ budgetMs: 120_000 });
    await r.close();
    return { verified: s.verified, why: codesOf(s), cursor: s.cursor?.height ?? null, slotBytes: await (chrome.storage.session as unknown as { getBytesInUse(k: string): Promise<number> }).getBytesInUse(slotKey(a.name!)) };
  },
  // A worker's first read, offline (every step and witness refused): from the worker's start and from the open.
  async readView(a) {
    calls.next = 0; calls.tip = 0;
    const t0 = performance.now(), r = await viewReader(a.name!, { caller: true, offline: true }), t1 = performance.now();
    const n = await r.name("alice"), t2 = performance.now();
    await r.close();
    return { verified: n.verified, why: codesOf(n), sinceStart: t2, openMs: t1 - t0, readMs: t2 - t1, nextCalls: calls.next, tipCalls: calls.tip };
  },
  // Each binding of a kept view broken alone: the reader answers as one with no view does (`fresh`), offline.
  async bindings() {
    const out: Record<string, unknown> = {};
    const other = `0x${"cd".repeat(32)}`, old = 31 * 60;
    const cases: Record<string, (held: { record: string; tip: { height: number; hash: string; time: number }; witnessed: { height: number; hash: string; by: string; at: number; tip: string } }) => void> = {
      honest: () => undefined,
      record: (v) => { v.record = other; },
      tipAbove: (v) => { v.tip.height += 5; },
      tipBlock: (v) => { v.tip.hash = other; v.witnessed.tip = other; },   // the confirmation moved with it: only the block binds
      tipOld: (v) => { v.tip.time -= old; },
      witBlock: (v) => { v.witnessed.hash = other; },
      witOld: (v) => { v.witnessed.at -= old * 1000; },
      witBy: (v) => { v.witnessed.by = "w2"; },
      witTip: (v) => { v.witnessed.tip = other; },
    };
    for (const [c, mutate] of Object.entries(cases)) {
      const name = fresh(`bind-${c.toLowerCase()}`), filled = await cmds.fillView!({ name }) as { verified: boolean };
      const key = slotKey(name), slot = JSON.parse((await chrome.storage.session.get(key))[key] as string);
      mutate(slot.held);
      await chrome.storage.session.set({ [key]: JSON.stringify(slot) });
      const restored = await cmds.readView!({ name }) as { verified: boolean; why: string[] };
      await chrome.storage.session.set({ [key]: JSON.stringify({ hashes: slot.hashes }) });
      const freshRead = await cmds.readView!({ name }) as { verified: boolean; why: string[] };
      out[c] = { filled: filled.verified, restored: restored.why, verified: restored.verified, fresh: freshRead.why };
    }
    return out;
  },
  // A browser start: the slot empty, the store reset and refilled; STORE_UNCONFIRMED until the refill reaches the tip.
  async unconfirmedRefill(a) {
    await state(a.name!);
    await chrome.storage.session.remove(slotKey(a.name!));
    const r = await open({ source: source(TOP), store: idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }) });
    const during = r.status(), firstStep = await r.advance({ budgetMs: 1 });
    let s = firstStep;
    for (let i = 0; i < 50 && !s.verified; i++) s = await r.advance({ budgetMs: 120_000 });
    await r.close();
    return { during: codesOf(during), firstStep: codesOf(firstStep), after: codesOf(s), verified: s.verified, cursor: s.cursor?.height ?? null };
  },
  // A loop that keeps the store open, so it holds the lock, until the worker stops.
  async hold(a) {
    const loop = replicaLoop({ source: source(TOP), store: idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }), resetRefused: true });
    return { open: await loop.open() };
  },
  // A stolen lock (the package never steals one; a caller could). Each case holds a commit of store A at a point, steals
  // A's lock, lets store B take the store, then lets A go on.
  async steal() {
    const out: Record<string, unknown> = {};
    const make = (name: string) => idbStore({ name, slot: sessionSlot(slotKey(name)) });
    const steal = (name: string) => navigator.locks.request(`cairnx-replica:${name}`, { steal: true }, async () => undefined);
    const r1 = row(30_001, null), r2 = row(30_050, r1), r3 = row(30_100, r2);
    // Store A whose `nth` commit waits at `point` until released.
    function held(name: string, point: string, nth: number) {
      let count = 0, go = () => undefined as void, hit = () => undefined as void;
      const gate = new Promise<void>((r) => { go = r; }), reached = new Promise<void>((r) => { hit = r; });
      const store = idbStoreWith({ name, slot: sessionSlot(slotKey(name)) }, {
        point(p) { if (p === "slot pair") count++; if (count !== nth || p !== point) return undefined; hit(); return gate; } });
      return { store, reached, go };
    }
    const snapshot = async (name: string) => { const db = await raw(name), v = { record: await one(db, "meta", "meta"), rows: await all<BlockRow>(db, "rows") }; db.close(); return v; };
    const putBack = async (name: string, v: { record: unknown; rows: BlockRow[] }) => {
      const db = await raw(name);
      await put(db, [["meta", v.record, "meta"], ...v.rows.map((r): [string, unknown, IDBValidKey] => ["rows", r, r.height])], ["rows", "meta"]);
      db.close();
    };

    // The review's sequence: A's 2nd commit lands and waits before its last slot write; the lock is stolen and released;
    // B opens, commits and confirms; A goes on.
    let n = fresh("steal-last"), a = held(n, "slot new", 2);
    await a.store.open(key(FEED));
    await a.store.commit(commit(null, [r1], at(30_010)));
    let pending = a.store.commit(commit(at(30_010), [r2], at(30_060)));
    await a.reached;
    await steal(n);
    let b = make(n);
    const bOpen = await reasonOf(b), older = await snapshot(n), bCommit = await b.commit(commit(at(30_060), [r3], at(30_110)));
    a.go();
    const aCommit = await pending;
    b.close();
    const reopened = await reasonOf(b = make(n));
    b.close();
    await putBack(n, older);
    out.last = { bOpen, bCommit: bCommit.ok, aCommit: aCommit.ok ? "ok" : aCommit.code, reopened, older: await reasonOf(b = make(n)),
      aOpen: await reasonOf(a.store), aAgain: (await a.store.commit(commit(at(30_110), [], at(30_120)))).ok };
    b.close();

    // Stolen before the slot's first write: A must not write its pair over B's confirmation.
    n = fresh("steal-first"); a = held(n, "slot pair", 2);
    await a.store.open(key(FEED));
    await a.store.commit(commit(null, [r1], at(30_010)));
    pending = a.store.commit(commit(at(30_010), [r2], at(30_060)));
    await a.reached;
    await steal(n);
    b = make(n);
    const bOpen2 = await reasonOf(b), bCommit2 = await b.commit(commit(at(30_010), [row(30_040, r1, "b")], at(30_045)));
    a.go();
    const aCommit2 = await pending;
    b.close();
    out.first = { bOpen: bOpen2, bCommit: bCommit2.ok, aCommit: aCommit2.ok ? "ok" : aCommit2.code, reopened: await reasonOf(b = make(n)) };
    b.close();

    // No steal: the slot changed under A before its last write. A leaves the other value as it is.
    n = fresh("slot-changed"); a = held(n, "slot new", 1);
    await a.store.open(key(FEED));
    pending = a.store.commit(commit(null, [r1], at(30_010)));
    await a.reached;
    const other = JSON.stringify([`0x${"ee".repeat(32)}`]);
    await chrome.storage.session.set({ [slotKey(n)]: other });
    a.go();
    const aCommit3 = await pending;
    out.changed = { aCommit: aCommit3.ok ? "ok" : aCommit3.code, slotKept: (await chrome.storage.session.get(slotKey(n)))[slotKey(n)] === other };
    a.store.close();
    return out;
  },
  // The store-level cases, each on a store of its own.
  async cases() {
    const out: Record<string, unknown> = {};
    const make = (name: string) => idbStore({ name, slot: sessionSlot(slotKey(name)) });
    const r1 = row(30_001, null), r2 = row(30_050, r1), b0: Boundary = { height: 30_000, hash: at(30_000).hash, eventsHash: r1.eventsHash, rowsHash: r1.rowsHash, stateHash: null };

    let n = fresh("older"), s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_010)));
    let db = await raw(n);
    const before = { record: await one(db, "meta", "meta"), rows: await all<BlockRow>(db, "rows") };
    db.close();
    const second = await s.commit(commit(at(30_010), [r2], at(30_060)));
    s.close();
    db = await raw(n);
    await put(db, [["meta", before.record, "meta"], ...before.rows.map((r): [string, unknown, IDBValidKey] => ["rows", r, r.height])], ["rows", "meta"]);
    db.close();
    out.olderCopy = { secondCommit: second.ok, reopened: await reasonOf(make(n)) };

    n = fresh("bound"); s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_040), { boundaries: [b0] }));
    s.close();
    out.boundOpensFirst = await reasonOf(s = make(n));
    s.close();
    db = await raw(n);
    await put(db, [["bounds", { ...b0, stateHash: `0x${"cd".repeat(32)}` }, b0.height]]);
    db.close();
    out.boundEdited = await reasonOf(s = make(n));
    s.close();

    n = fresh("deleted"); s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_010)));
    await new Promise<void>((res, rej) => { const q = indexedDB.deleteDatabase(`cairnx-replica:${n}`); q.onsuccess = () => res(); q.onerror = () => rej(q.error); });
    const afterDelete = await s.commit(commit(at(30_010), [r2], at(30_060)));
    out.deleted = { commit: afterDelete.ok ? "ok" : afterDelete.code, reopened: await reasonOf(s) };
    s.close();

    n = fresh("two"); s = make(n);
    const t = make(n), first = await reasonOf(s), held = await reasonOf(t);
    s.close();
    out.twoStores = { first, second: held, afterClose: await reasonOf(t) };
    t.close();

    n = fresh("newer");
    await new Promise<void>((res) => { const q = indexedDB.open(`cairnx-replica:${n}`, 2); q.onupgradeneeded = () => q.result.createObjectStore("later"); q.onsuccess = () => { q.result.close(); res(); }; });
    s = make(n);
    const newer = await reasonOf(s);
    await s.reset();
    out.newer = { open: newer, afterReset: await reasonOf(s) };
    s.close();

    n = fresh("garbage"); s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_010)));
    s.close();
    await chrome.storage.session.set({ [slotKey(n)]: "not a list" });
    out.slotOutOfForm = await reasonOf(s = make(n));
    s.close();
    return out;
  },
};

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  const run = m?.cmd === undefined ? undefined : cmds[m.cmd];
  if (run === undefined) return false;
  run(m.args ?? {}).then(reply, (e: unknown) => reply({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
  return true;
});
