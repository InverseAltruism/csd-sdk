// A Store in IndexedDB for an extension's own contexts (./browser), confirmed by a trusted slot. Database
// `cairnx-replica:<name>`, IndexedDB version 1 (the layout); its object stores, the only names it writes or removes:
//   meta    key "meta": the record { store, format, meta (no `witnessed`), boundsHash, window } (store-format.ts)
//   rows    key height: a BlockRow        bounds   key height: a Boundary        window   key "window": its bytes
// The slot holds JSON { hashes, held? }: the record hashes it confirms, and the view a reader kept (keep()) with the
// record hash it was kept under.
// A commit is one readwrite transaction that first reads the stored cursor and aborts unless it is `expect`, so a
// writer that got past the lock does not interleave. The slot is written before it with the pair [stored record's
// hash, new record's hash] and after it with the new hash alone, so a context stopped at any point leaves a record the
// slot names (test/browser/idb-store.test.ts stops the worker at each). At open a record whose hash the slot does not
// hold is `unconfirmed` and the reader resets and refills the store: the slot lives in memory and only the extension's
// own contexts write it, while the profile on disk can be written by any program. One context holds a store at a
// time, by the Web Lock of the database's name taken at open and released at close() or with the context.
import { payloadHash } from "@inversealtruism/cairnx-core";
import { checkBasis } from "./basis.js";
import { ReplicaConfigError } from "./errors.js";
import { BOUNDS_HASH_START, Corrupt, FORMAT, TAG, boundsHashStep, checkedChain, count, hash, isObject, metaOf, storedMeta, windowDigest } from "./store-format.js";
import { commitShapeOk, keptHeight, keyDifference, sameCursor, type Hashes, type StoreKey } from "./store-rules.js";
import type { BlockRow, Boundary, Commit, KeptView, Store, StoreMeta, TrustedSlot } from "./types.js";

const STORES = ["meta", "rows", "bounds", "window"], NAME = /^[a-z0-9-]{1,64}$/;

/** Internal, for tests: `point` is called before the slot's first write ("slot pair"), before the transaction's fence
 *  check ("transaction"), past it as the transaction is opened ("write"), once its requests are issued ("issued", not
 *  awaited: an await there would let it commit), before the slot's last write ("slot new") and at the end ("done"). */
export interface IdbHooks { point?(name: string): void | Promise<void> }

type SessionArea = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
/** The slot `key` in chrome.storage.session, which only the extension's own contexts reach by default and a browser
 *  start clears. Throws ReplicaConfigError where that area is absent (a page: pages use memoryStore). */
export function sessionSlot(key: string): TrustedSlot {
  const area = (globalThis as { chrome?: { storage?: { session?: SessionArea } } }).chrome?.storage?.session;
  if (area === undefined) throw new ReplicaConfigError("sessionSlot: chrome.storage.session is not available here; a page uses memoryStore");
  if (typeof key !== "string" || key === "") throw new ReplicaConfigError("sessionSlot: the key is not a non-empty string");
  return {
    async get() { const v = (await area.get(key))[key]; return typeof v === "string" ? v : null; },
    async set(value) { await area.set({ [key]: value }); },
  };
}

type Lock = { held(): boolean; lost(): boolean; release(): void; readonly gone: Promise<void> };
// Locks this context is releasing, by name: the lock manager frees a lock after its holder's callback settles, so a store
// opened in the same context right after another's close() waits for that instead of finding it held.
const releasing = new Map<string, Promise<void>>();
// The Web Lock `name` until release(), or null while another context holds it. A steal ends it: held() turns false and
// lost() true.
function takeLock(name: string): Promise<Lock | null> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (locks === undefined) throw new ReplicaConfigError("idbStore: the Web Locks API is not available here");
  return new Promise((resolve, reject) => {
    let held = false, lost = false;
    const gone = locks.request(name, { ifAvailable: true }, (lock) => {
      if (lock === null) { resolve(null); return undefined; }
      held = true;
      return new Promise<void>((end) => resolve({ held: () => held, lost: () => lost, release: () => { held = false; end(); }, gone: settled }));
    });
    const settled: Promise<void> = gone.then(() => { held = false; }, (e: unknown) => { held = false; lost = true; reject(e); });
  });
}

const slotText = (hashes: string[], held?: unknown): string => JSON.stringify(held === undefined ? { hashes } : { hashes, held });
// The slot's value, or null when it is out of form (which confirms no record).
function slotValue(v: string | null): { hashes: string[]; held: unknown } | null {
  let x: unknown;
  try { x = v === null ? { hashes: [] } : JSON.parse(v); } catch { return null; }
  return isObject(x) && Array.isArray(x.hashes) && x.hashes.every((h) => typeof h === "string") ? { hashes: x.hashes as string[], held: x.held } : null;
}
// The view kept under the record hash `h`, or null for another record's or one out of form.
function keptOf(held: unknown, h: string): KeptView | null {
  if (!isObject(held) || held.record !== h || !isObject(held.tip) || !count(held.at)) return null;
  const t = held.tip, w = held.witnessed;
  if (!count(t.height) || !hash(t.hash) || !count(t.time)) return null;
  const tip = { height: t.height, hash: t.hash, time: t.time };
  if (w === null) return { at: held.at, tip, witnessed: null };
  if (!isObject(w) || !count(w.height) || !hash(w.hash) || typeof w.by !== "string" || !count(w.at) || !hash(w.tip)) return null;
  return { at: held.at, tip, witnessed: { height: w.height, hash: w.hash, by: w.by, at: w.at, tip: w.tip } };
}

const request = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

type Stored = { store: string; format: number; meta: Omit<StoreMeta, "witnessed">; boundsHash: string; window: string | null };
type End = Hashes & { readonly height: number };
interface Durable {
  meta: StoreMeta | null; window: string | null; hash: string | null; rowEnds: End[]; boundEnds: { height: number; chain: string }[];
  rows: BlockRow[] | null; bounds: Boundary[] | null;   // read at open, handed to the first read
}
const EMPTY = (): Durable => ({ meta: null, window: null, hash: null, rowEnds: [], boundEnds: [], rows: [], bounds: [] });

/** A store in the database `cairnx-replica:<name>` (`name`: 1 to 64 of a-z, 0-9 and -), confirmed by `slot`, written
 *  by one context at a time (the Web Lock of the database's name; while another holds it, `open` answers `unavailable`
 *  and the next advance tries again). Throws ReplicaConfigError for another name or a missing slot. */
export const idbStore = (o: { readonly name: string; readonly slot: TrustedSlot }): Store => idbStoreWith(o, {});

/** Internal: idbStore with the hooks of the tests. */
export function idbStoreWith(o: { readonly name: string; readonly slot: TrustedSlot }, hooks: IdbHooks): Store {
  if (typeof o?.name !== "string" || !NAME.test(o.name)) throw new ReplicaConfigError(`idbStore: name ${String(o?.name)} is not 1 to 64 of a-z, 0-9 and -`);
  const slot = o.slot, dbName = `cairnx-replica:${o.name}`;
  if (typeof slot?.get !== "function" || typeof slot.set !== "function") throw new ReplicaConfigError("idbStore: a slot (sessionSlot) is required");
  let db: IDBDatabase | null = null, lock: Lock | null = null, opened: StoreKey | null = null, durable = EMPTY(), newer = false;
  // A store whose lock was stolen is lost for good: it opens `unavailable` and commits nothing, to the database or the
  // slot, so it cannot write over the successor that took the lock (test/browser/idb-store.test.ts, the steal cases).
  let lost = false, kept: KeptView | null = null;
  const fenced = (): boolean => (lost ||= lock?.lost() === true) || lock === null || !lock.held();

  function connect(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => {
        const d = r.result;
        // Another context deleting or upgrading the database: this connection gives way, and the next commit's compare
        // finds the cursor gone.
        d.onversionchange = () => { d.close(); if (db === d) db = null; };
        d.onclose = () => { if (db === d) db = null; };
        res(d);
      };
      r.onerror = () => rej(r.error);
    });
  }
  const connection = async (): Promise<IDBDatabase> => (db ??= await connect());

  // Everything committed, read in one transaction and checked here; the rows' own checks are the loop's.
  async function readAll(d: IDBDatabase): Promise<Durable | "format"> {
    const tx = d.transaction(STORES, "readonly");
    const [record, rows, bounds, win] = await Promise.all([request(tx.objectStore("meta").get("meta")), request(tx.objectStore("rows").getAll()),
      request(tx.objectStore("bounds").getAll()), request(tx.objectStore("window").get("window"))]) as [unknown, BlockRow[], Boundary[], unknown];
    if (record === undefined) {
      if (rows.length > 0 || bounds.length > 0 || win !== undefined) throw new Corrupt("rows without a record");
      return EMPTY();
    }
    if (!isObject(record) || record.store !== TAG) throw new Corrupt("the record is not this store's");
    if (record.format !== FORMAT) return "format";
    const meta = metaOf(record);
    if (!hash(record.boundsHash) || !(record.window === null || hash(record.window))) throw new Corrupt("the record's chain or digest is out of form");
    const chain = checkedChain(bounds, record.boundsHash);
    let h: string;
    try { h = payloadHash(record); } catch { throw new Corrupt("the record is not JSON data"); }
    return { meta, window: record.window as string | null, hash: h, rows, bounds, boundEnds: bounds.map((b, i) => ({ height: b.height, chain: chain[i]! })),
      rowEnds: rows.map((r) => ({ height: r.height, eventsHash: r.eventsHash, rowsHash: r.rowsHash })) };
  }

  // Check (2): the slot names the record. A view kept under that record is taken with it.
  async function confirmed(h: string): Promise<boolean> {
    const v = slotValue(await slot.get());
    if (v === null || !v.hashes.includes(h)) return false;
    kept = keptOf(v.held, h);
    return true;
  }

  // The commit's transaction: "moved" when the stored cursor is not `expect`, else it resolves on complete.
  async function write(c: Commit, keep: number, record: Stored): Promise<"ok" | "moved"> {
    await hooks.point?.("write");
    const tx = (await connection()).transaction(STORES, "readwrite", { durability: "relaxed" });
    let moved = false;
    const end = new Promise<"ok" | "moved">((res, rej) => {
      tx.oncomplete = () => res("ok");
      tx.onabort = () => (moved ? res("moved") : rej(tx.error ?? new Error("idbStore: the commit's transaction aborted")));
    });
    const got = tx.objectStore("meta").get("meta");
    got.onsuccess = () => {
      const stored = got.result as { meta?: { cursor?: unknown } } | undefined;
      if (fenced()) { moved = true; tx.abort(); return; }
      if (!sameCursor(c.expect, (stored?.meta?.cursor ?? null) as typeof c.expect)) { moved = true; tx.abort(); return; }
      const rows = tx.objectStore("rows"), bounds = tx.objectStore("bounds");
      if ("rollbackTo" in c) {
        rows.delete(IDBKeyRange.lowerBound(keep, true)); bounds.delete(IDBKeyRange.lowerBound(keep, true));
      } else {
        for (const r of c.rows) rows.put(r, r.height);
        for (const b of c.boundaries) bounds.put(b, b.height);
        if (c.headerWindow !== undefined && record.window !== durable.window) tx.objectStore("window").put(c.headerWindow.slice().buffer, "window");
      }
      tx.objectStore("meta").put(record, "meta");
      void hooks.point?.("issued");
    };
    return end;
  }

  const unavailable = { ok: false, reset: "unavailable" } as const;
  function close() {
    if (lock !== null) { releasing.set(dbName, lock.gone); lock.release(); }
    lock = null; db?.close(); db = null; opened = null;
  }
  return {
    async open(expect) {
      opened = null; kept = null;
      checkBasis(expect.basis);
      if (lost || lock?.lost() === true) { lost = true; return unavailable; }
      if (lock === null || !lock.held()) {
        await releasing.get(dbName);
        lock = await takeLock(dbName);
        if (lock === null) return unavailable;
      }
      let read: Durable | "format";
      try { read = await readAll(await connection()); } catch (e) {
        if (e instanceof Corrupt) return { ok: false, reset: "corrupt" };
        if ((e as { name?: unknown } | null)?.name === "VersionError") { newer = true; return { ok: false, reset: "format" }; }   // a later layout
        throw e;
      }
      if (read === "format") return { ok: false, reset: "format" };
      if (read.hash !== null && !(await confirmed(read.hash))) { kept = null; return { ok: false, reset: "unconfirmed" }; }
      durable = read;
      const meta = read.meta, reset = meta === null ? null : keyDifference(meta, expect);
      if (reset !== null) return { ok: false, reset };
      opened = structuredClone(expect);
      return { ok: true, meta: structuredClone(meta) };
    },
    async *rows(fromHeight) {
      let rows = durable.rows;
      durable.rows = null;
      rows ??= await request((await connection()).transaction("rows").objectStore("rows").getAll(IDBKeyRange.lowerBound(fromHeight))) as BlockRow[];
      for (const r of rows) if (r.height >= fromHeight) yield r;
    },
    async boundaries() {
      const bounds = durable.bounds;
      durable.bounds = null;
      return bounds ?? (await request((await connection()).transaction("bounds").objectStore("bounds").getAll()) as Boundary[]);
    },
    async headerWindow() {
      if (durable.window === null) return null;
      const w = await request((await connection()).transaction("window").objectStore("window").get("window"));
      return w instanceof ArrayBuffer && windowDigest(new Uint8Array(w)) === durable.window ? new Uint8Array(w) : null;
    },
    async commit(c) {
      if (opened === null || keyDifference(c.meta, opened) !== null) return { ok: false, code: "STORE_FAILED" };
      if (!sameCursor(c.expect, durable.meta?.cursor ?? null)) return { ok: false, code: "CURSOR_MOVED" };
      const keep = keptHeight(c), rowEnds = durable.rowEnds.filter((r) => r.height <= keep), boundEnds = durable.boundEnds.filter((b) => b.height <= keep);
      if (!commitShapeOk(c, boundEnds.at(-1)?.height ?? -1, rowEnds.at(-1))) return { ok: false, code: "STORE_FAILED" };
      if (fenced()) { close(); return { ok: false, code: "STORE_FAILED" }; }
      let chain = boundEnds.at(-1)?.chain ?? BOUNDS_HASH_START, window = durable.window;
      if (!("rollbackTo" in c)) {
        for (const r of c.rows) rowEnds.push({ height: r.height, eventsHash: r.eventsHash, rowsHash: r.rowsHash });
        for (const b of c.boundaries) boundEnds.push({ height: b.height, chain: (chain = boundsHashStep(chain, b)) });
        if (c.headerWindow !== undefined) window = windowDigest(c.headerWindow);
      }
      const record: Stored = { store: TAG, format: FORMAT, meta: storedMeta(c.meta), boundsHash: chain, window }, h = payloadHash(record);
      const failed = { ok: false, code: "STORE_FAILED" } as const, pair = slotText(durable.hash === null ? [h] : [durable.hash, h]);
      await hooks.point?.("slot pair");
      if (fenced()) return failed;
      kept = null;
      await slot.set(pair);
      await hooks.point?.("transaction");
      if (fenced()) return failed;
      if ((await write(c, keep, record)) === "moved") return fenced() ? failed : { ok: false, code: "CURSOR_MOVED" };
      durable = { meta: { ...c.meta, witnessed: null }, window, hash: h, rowEnds, boundEnds, rows: null, bounds: null };
      await hooks.point?.("slot new");
      // Only over the pair this commit wrote: another writer's value stays, and the pair still names this record, so the
      // loop reads the store back and finds it confirmed.
      if (fenced() || (await slot.get()) !== pair) return failed;
      await slot.set(slotText([h]));
      await hooks.point?.("done");
      return { ok: true };
    },
    async reset() {
      if (lock === null || !lock.held()) throw new Error(`idbStore: ${dbName} is not held by this store, so it is not reset`);
      if (newer) {
        // A database of a later layout cannot be opened at this one: it is deleted and made again.
        db?.close(); db = null;
        await new Promise<void>((res, rej) => {
          const r = indexedDB.deleteDatabase(dbName);
          r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error(`idbStore: deleting ${dbName} is blocked by another connection`));
        });
        newer = false;
      } else {
        const tx = (await connection()).transaction(STORES, "readwrite", { durability: "relaxed" });
        for (const s of STORES) tx.objectStore(s).clear();
        await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error ?? new Error("idbStore: the reset aborted")); });
      }
      await slot.set(slotText([]));
      kept = null;
      durable = EMPTY(); opened = null;
    },
    close,
    kept: () => kept,
    // Only while the slot confirms the stored record alone, so it neither names an older record nor writes over another
    // writer's value. A null view clears the one kept.
    async keep(view) {
      const h = durable.hash;
      if (fenced() || h === null || opened === null) return;
      const now = await slot.get(), v = slotValue(now);
      if (v === null || v.hashes.length !== 1 || v.hashes[0] !== h) return;
      const next = view === null ? slotText([h]) : slotText([h], { record: h, at: view.at, tip: view.tip, witnessed: view.witnessed });
      if (next !== now) await slot.set(next);
    },
  };
}
