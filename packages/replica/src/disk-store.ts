// A Store in one directory of a local filesystem, for a server (./server). Its files, and the only names it writes or
// removes in the directory:
//   meta.json      the store's tag and format, the StoreMeta (no `witnessed`), the committed byte lengths of
//                  rows.jsonl and bounds.jsonl with `boundsHash`, a sha256 chain over the committed boundary lines,
//                  and `window`, the sha256 of the header window file; replaced whole by rename (the sync order test,
//                  test/disk-store.test.ts) from meta.json.tmp, never written in place.
//   rows.jsonl     one BlockRow a line, ascending height; bounds.jsonl one Boundary a line, ascending height.
//   window-<sha256 hex>.bin   the header window named by `window`.  lock   the writer's lease (lease.ts).
// A commit appends at the committed lengths (cutting any tail past them first), syncs each file, then writes the new
// meta to meta.json.tmp, syncs it, renames it over meta.json and syncs the directory. A rollback is that meta swap
// alone. While one holder's directory syncs return, nothing is written below the lengths of a meta that can be on
// disk, so a crash leaves a whole commit (test/disk-kill.test.ts). Where that does not hold (an extend after a rollback
// whose directory sync did not land; a refill after a reset cut short), and for anything else read back, the loop's
// check of the rows (held.ts) or this file's checks answer `corrupt`, and the reader refills. A commit that throws
// before its rename leaves the last whole commit on disk and in this object; after it, the loop reads the store back.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HASH_RE } from "@inversealtruism/cairnx-core";
import { checkBasis } from "./basis.js";
import { ReplicaConfigError, codeOf } from "./errors.js";
import { takeLease, type Lease } from "./lease.js";
import { commitShapeOk, keptHeight, keyDifference, sameCursor, type Hashes, type StoreKey } from "./store-rules.js";
import type { BlockRow, Boundary, Commit, Cursor, Store, StoreMeta } from "./types.js";

const TAG = "cairnx-replica", FORMAT = 1, WINDOW = /^window-[0-9a-f]{64}\.bin$/;
/** The boundary chain before the first line: 32 zero bytes. */
export const BOUNDS_HASH_START = "0x" + "00".repeat(32);
/** The boundary chain after `line` (a boundary's JSON, no newline) from `prev`: sha256 over the UTF-8 of prev + line. */
export const boundsHashStep = (prev: string, line: string): string => "0x" + createHash("sha256").update(prev + line, "utf8").digest("hex");

/** Internal, for tests: `clock` and `judged` for the lease (lease.ts); `point` is called before each truncate, write, sync and rename of a
 *  commit, a write with the bytes it is about to put; `sync: false` skips the syncs (and still calls their points). */
export interface DiskHooks {
  readonly clock?: () => number; readonly sync?: boolean; readonly judged?: () => void;
  point?(name: string, write?: { readonly fd: number; readonly bytes: Uint8Array; readonly position: number }): void;
}

class Corrupt extends Error {}
type End = Hashes & { readonly height: number; readonly end: number };
type BoundEnd = { readonly height: number; readonly end: number; readonly chain: string };
// What the files commit, as this object knows it.
interface Durable {
  meta: StoreMeta | null; rowsBytes: number; boundsBytes: number; rowEnds: End[]; boundEnds: BoundEnd[]; window: string | null;
  rows: BlockRow[] | null; bounds: Boundary[] | null;   // parsed at open, handed to the first read
}
const EMPTY = (): Durable => ({ meta: null, rowsBytes: 0, boundsBytes: 0, rowEnds: [], boundEnds: [], window: null, rows: [], bounds: [] });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && HASH_RE.test(v);
const cursor = (v: unknown): v is Cursor => isObject(v) && count(v.height) && hash(v.hash);
const sha = (b: Uint8Array): string => "0x" + createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: true });
const gone = (e: unknown): void => { if (codeOf(e) !== "ENOENT") throw e; };

// The StoreMeta of a parsed meta.json, or Corrupt when a field is out of form.
function metaOf(v: Record<string, unknown>): StoreMeta {
  const m = v.meta, ok = (cond: boolean) => { if (!cond) throw new Corrupt("meta.json: a field is out of form"); };
  ok(isObject(m));
  const x = m as Record<string, unknown>, r = x.rule as Record<string, unknown>;
  ok(isObject(r) && typeof r.domain === "string" && count(r.activationHeight) && (x.cursor === null || cursor(x.cursor)) && hash(x.eventsHash) &&
    hash(x.rowsHash) && count(x.eventCount) && (x.windowSha256 === null || hash(x.windowSha256)) && (x.work === null || typeof x.work === "string") &&
    (x.workRoot === null || cursor(x.workRoot)) && isObject(x.gates) && Object.values(x.gates).every(count));
  let basis: StoreMeta["basis"];
  try { basis = checkBasis(x.basis); } catch { throw new Corrupt("meta.json: the basis is out of form"); }
  return {
    format: FORMAT, rule: { domain: r.domain as string, activationHeight: r.activationHeight as number }, basis, cursor: x.cursor as Cursor | null,
    eventsHash: x.eventsHash as string, rowsHash: x.rowsHash as string, eventCount: x.eventCount as number, witnessed: null,
    windowSha256: x.windowSha256 as string | null, work: x.work as string | null, workRoot: x.workRoot as Cursor | null, gates: x.gates as Record<string, number>,
  };
}

// The committed lines of a file: the first `length` bytes, each line ending in a newline, parsed as JSON objects. A file
// that is missing or shorter than `length` ends a line early, so it is Corrupt there.
async function linesOf(path: string, length: number): Promise<{ values: Record<string, unknown>[]; lines: string[]; ends: number[] }> {
  let bytes: Uint8Array;
  try { bytes = await readFile(path); } catch (e) {
    if (codeOf(e) !== "ENOENT") throw e;
    if (length > 0) throw new Corrupt(`${path}: missing, while the meta commits ${length} bytes of it`);
    return { values: [], lines: [], ends: [] };
  }
  const values: Record<string, unknown>[] = [], lines: string[] = [], ends: number[] = [];
  for (let at = 0; at < length;) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0 || nl >= length) throw new Corrupt(`${path}: a committed line has no end (the file is cut short or changed)`);
    let v: unknown;
    const line = dec.decode(bytes.subarray(at, nl));
    try { v = JSON.parse(line); } catch { throw new Corrupt(`${path}: a committed line is not JSON`); }
    if (!isObject(v)) throw new Corrupt(`${path}: a committed line is not an object`);
    values.push(v); lines.push(line); ends.push(nl + 1);
    at = nl + 1;
  }
  return { values, lines, ends };
}

// All of `bytes` at `position`: a write can land short (a full disk), and one that makes no progress fails the commit.
async function writeAll(fh: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  for (let done = 0; done < bytes.length;) {
    const { bytesWritten } = await fh.write(bytes, done, bytes.length - done, position + done);
    if (!(bytesWritten > 0)) throw new Error(`diskStore: a write stopped after ${done} of ${bytes.length} bytes`);
    done += bytesWritten;
  }
}

/** A store in `dir`, an absolute path, created with mode 700 when absent. One process writes it at a time (a lease on
 *  `dir/lock`); while another holds it, `open` answers `unavailable` and is tried again by the next advance. A server
 *  calls the reader's `close()` at shutdown, which releases the lease; after a crash it goes stale in 20 s. Files in
 *  `dir` that are not the store's are left alone; a `meta.json` another program wrote makes `open` and `reset` throw
 *  ReplicaConfigError. */
export const diskStore = (o: { readonly dir: string }): Store => diskStoreWith(o, {});

/** Internal: diskStore with the hooks of the tests. */
export function diskStoreWith(o: { readonly dir: string }, hooks: DiskHooks): Store {
  const dir = o.dir, at = (f: string) => join(dir, f), clock = hooks.clock ?? Date.now, syncs = hooks.sync ?? true;
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new ReplicaConfigError(`diskStore: dir ${String(dir)} is not an absolute path`);
  let lease: Lease | null = null, opened: StoreKey | null = null, durable: Durable = EMPTY();
  const point = (name: string, write?: { fd: number; bytes: Uint8Array; position: number }) => hooks.point?.(name, write);
  async function synced(name: string, fh: FileHandle, f: (fh: FileHandle) => Promise<void>) { point(name); if (syncs) await f(fh); }
  async function syncDir() {
    point("sync dir");
    if (!syncs) return;
    const d = await open(dir, "r");
    try { await d.sync(); } finally { await d.close(); }
  }
  async function ensureDir() {
    try { await mkdir(dir, { recursive: true, mode: 0o700 }); } catch (e) {
      if (["EEXIST", "ENOTDIR", "EACCES", "EPERM", "EROFS"].includes(String(codeOf(e)))) throw new ReplicaConfigError(`diskStore: ${dir} cannot be used as a directory (${String(codeOf(e))})`);
      throw e;
    }
  }

  // meta.json parsed, or null when there is none. JSON that is not this store's meta throws ReplicaConfigError: the
  // directory holds another program's file, and nothing of it is read or removed.
  async function metaFile(): Promise<unknown> {
    let text: string;
    try { text = await readFile(at("meta.json"), "utf8"); } catch (e) { if (codeOf(e) === "ENOENT") return null; throw e; }
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Corrupt("meta.json is not JSON"); }
    if (!isObject(v) || v.store !== TAG) throw new ReplicaConfigError(`diskStore: ${at("meta.json")} is not a cairnx-replica store's meta; move it or use another dir`);
    return v;
  }

  // Everything committed, read back with this file's checks; the rows' own checks are the loop's.
  async function readAll(): Promise<Durable | "format"> {
    const v = (await metaFile()) as Record<string, unknown> | null;
    if (v === null) return EMPTY();
    if (v.format !== FORMAT) return "format";
    const meta = metaOf(v), rowsBytes = v.rowsBytes, boundsBytes = v.boundsBytes, window = v.window;
    if (!count(rowsBytes) || !count(boundsBytes) || !hash(v.boundsHash) || !(window === null || hash(window))) throw new Corrupt("meta.json: a length or digest is out of form");
    const r = await linesOf(at("rows.jsonl"), rowsBytes), b = await linesOf(at("bounds.jsonl"), boundsBytes);
    const rows = r.values as unknown as BlockRow[], bounds = b.values as unknown as Boundary[];
    let chain = BOUNDS_HASH_START;
    const boundEnds = b.lines.map((line, i) => ({ height: bounds[i]!.height, end: b.ends[i]!, chain: (chain = boundsHashStep(chain, line)) }));
    if (chain !== v.boundsHash) throw new Corrupt("bounds.jsonl: its chain is not the meta's boundsHash");
    if (window !== null) {
      let w: Uint8Array;
      try { w = await readFile(at(`window-${window.slice(2)}.bin`)); } catch (e) { if (codeOf(e) === "ENOENT") throw new Corrupt("the header window is missing"); throw e; }
      if (sha(w) !== window) throw new Corrupt("the header window is not its digest");
    }
    const rowEnds = rows.map((x, i) => ({ height: x.height, end: r.ends[i]!, eventsHash: x.eventsHash, rowsHash: x.rowsHash }));
    return { meta, rowsBytes, boundsBytes, rowEnds, boundEnds, window, rows, bounds };
  }

  // Appends `bytes` to `file` at the committed length `from`, cutting any tail past it first, then syncs the file.
  async function append(file: string, from: number, bytes: Uint8Array) {
    const fh = await open(at(file), constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      if ((await fh.stat()).size > from) { point(`truncate ${file}`); await fh.truncate(from); }
      if (bytes.length === 0) return;
      point(`write ${file}`, { fd: fh.fd, bytes, position: from });
      await writeAll(fh, bytes, from);
      await synced(`sync ${file}`, fh, (f) => f.datasync());
    } finally { await fh.close(); }
  }
  // Writes a whole new file `name`, synced; `label` names its points.
  async function writeFresh(name: string, label: string, bytes: Uint8Array, sync: (fh: FileHandle) => Promise<void>) {
    const fh = await open(at(name), "w", 0o600);
    try {
      point(`write ${label}`, { fd: fh.fd, bytes, position: 0 });
      await writeAll(fh, bytes, 0);
      await synced(`sync ${label}`, fh, sync);
    } finally { await fh.close(); }
  }

  // Writes the commit (the shape checked, the lease held) and returns what the files then commit.
  async function persist(c: Commit, rowEnds: End[], boundEnds: BoundEnd[]): Promise<{ next: Durable; oldWindow: string | null }> {
    let rowsBytes = rowEnds.at(-1)?.end ?? 0, boundsBytes = boundEnds.at(-1)?.end ?? 0, chain = boundEnds.at(-1)?.chain ?? BOUNDS_HASH_START;
    let window = durable.window, oldWindow: string | null = null;
    if (!("rollbackTo" in c)) {
      const rowLines = c.rows.map((r) => enc.encode(JSON.stringify(r) + "\n")), boundLines = c.boundaries.map((b) => JSON.stringify(b));
      const rowBytes = new Uint8Array(rowLines.reduce((n, l) => n + l.length, 0));
      let p = 0;
      for (const [i, l] of rowLines.entries()) { rowBytes.set(l, p); p += l.length; rowEnds.push({ height: c.rows[i]!.height, end: rowsBytes + p, eventsHash: c.rows[i]!.eventsHash, rowsHash: c.rows[i]!.rowsHash }); }
      const boundBytes = enc.encode(boundLines.map((l) => l + "\n").join(""));
      p = boundsBytes;
      for (const [i, l] of boundLines.entries()) { p += enc.encode(l).length + 1; boundEnds.push({ height: c.boundaries[i]!.height, end: p, chain: (chain = boundsHashStep(chain, l)) }); }
      await append("rows.jsonl", rowsBytes, rowBytes);
      await append("bounds.jsonl", boundsBytes, boundBytes);
      rowsBytes += rowBytes.length; boundsBytes += boundBytes.length;
      if (c.headerWindow !== undefined && sha(c.headerWindow) !== window) {
        const w = sha(c.headerWindow);
        await writeFresh(`window-${w.slice(2)}.bin`, "window", c.headerWindow, (f) => f.datasync());
        oldWindow = window; window = w;
      }
    }
    // `witnessed` is never stored (test/disk-store.test.ts): a confirmation is earned again after a restart.
    const { witnessed, ...meta } = c.meta;
    const record = { store: TAG, format: FORMAT, meta, rowsBytes, boundsBytes, boundsHash: chain, window };
    await writeFresh("meta.json.tmp", "meta", enc.encode(JSON.stringify(record) + "\n"), (f) => f.sync());
    point("rename meta");
    await rename(at("meta.json.tmp"), at("meta.json"));
    await syncDir();
    point("done");
    return { next: { meta: { ...c.meta, witnessed: null }, rowsBytes, boundsBytes, rowEnds, boundEnds, window, rows: null, bounds: null }, oldWindow };
  }

  const unavailable = { ok: false, reset: "unavailable" } as const;
  function close() { lease?.release(); lease = null; opened = null; }
  return {
    async open(expect) {
      opened = null;
      checkBasis(expect.basis);
      await ensureDir();
      if (lease === null || !lease.holds()) {
        lease = takeLease(at("lock"), clock, hooks.judged);
        if (lease === null) return unavailable;
      }
      let read: Durable | "format";
      try { read = await readAll(); } catch (e) {
        if (e instanceof Corrupt) return { ok: false, reset: "corrupt" };
        if (e instanceof ReplicaConfigError) close();   // a directory refused is not held
        throw e;
      }
      if (read === "format") return { ok: false, reset: "format" };
      durable = read;
      const reset = durable.meta === null ? null : keyDifference(durable.meta, expect);
      if (reset !== null) return { ok: false, reset };
      opened = structuredClone(expect);
      return { ok: true, meta: structuredClone(durable.meta) };
    },
    async *rows(fromHeight) {
      let rows = durable.rows;
      durable.rows = null;
      if (rows === null) {
        const r = await linesOf(at("rows.jsonl"), durable.rowsBytes);
        rows = r.values as unknown as BlockRow[];
      }
      for (const r of rows) if (r.height >= fromHeight) yield r;
    },
    async boundaries() {
      const bounds = durable.bounds;
      durable.bounds = null;
      return bounds ?? ((await linesOf(at("bounds.jsonl"), durable.boundsBytes)).values as unknown as Boundary[]);
    },
    async headerWindow() {
      const w = durable.window;
      return w === null ? null : new Uint8Array(await readFile(at(`window-${w.slice(2)}.bin`)));
    },
    async commit(c: Commit) {
      if (opened === null || keyDifference(c.meta, opened) !== null) return { ok: false, code: "STORE_FAILED" };
      if (!sameCursor(c.expect, durable.meta?.cursor ?? null)) return { ok: false, code: "CURSOR_MOVED" };
      const keep = keptHeight(c), rowEnds = durable.rowEnds.filter((r) => r.height <= keep), boundEnds = durable.boundEnds.filter((b) => b.height <= keep);
      if (!commitShapeOk(c, boundEnds.at(-1)?.height ?? -1, rowEnds.at(-1))) return { ok: false, code: "STORE_FAILED" };
      // A lease found taken over is lost for good: this commit writes nothing and the store closes. A holder stopped
      // after this check finishes its commit over the taker's files; the store then opens corrupt and is refilled.
      if (lease === null || !lease.holds()) { close(); return { ok: false, code: "STORE_FAILED" }; }
      const { next, oldWindow } = await persist(c, rowEnds, boundEnds);
      durable = next;
      if (oldWindow !== null) await unlink(at(`window-${oldWindow.slice(2)}.bin`)).catch(gone);
      return { ok: true };
    },
    async reset() {
      if (lease === null || !lease.holds()) throw new Error(`diskStore: ${dir} is not held by this store, so it is not reset`);
      try { await metaFile(); } catch (e) { if (!(e instanceof Corrupt)) throw e; }   // another program's meta.json throws
      // meta.json first: a reset cut short leaves a store with no meta, which opens empty. Only the store's own names.
      const windows = (await readdir(dir)).filter((f) => WINDOW.test(f));
      for (const f of ["meta.json", "meta.json.tmp", "rows.jsonl", "bounds.jsonl", ...windows]) await unlink(at(f)).catch(gone);
      await syncDir();
      durable = EMPTY(); opened = null;
    },
    close,
  };
}
