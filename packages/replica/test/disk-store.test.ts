// diskStore (disk-store.ts) and its lease (lease.ts): the store suite over the disk; a store filled through the reader
// with the pin at 30,000 and the recorded node, reopened from disk; and what a store read back can be (cut short, a
// tail past its committed length, a row or boundary changed, a consistent edit, another format or gate table, a lost
// window), each with the honest reopen beside it. Then the lease, the sync order, and the refusals of a directory.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINAL_DEPTH, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { local, nodeBlocks } from "../src/browser.js";
import { derivePin } from "../src/derive-pin.js";
import { diskStoreWith } from "../src/disk-store.js";
import { BOUNDS_HASH_START, boundsHashStep } from "../src/store-format.js";
import { LOADED_GATES } from "../src/gates.js";
import { STALE_MS, takeLease, type Lease } from "../src/lease.js";
import { memoryStore, open, pinned, ReplicaConfigError, replicaLoop, type BlockRow, type Boundary, type Pin, type Store } from "../src/index.js";
import type { StoreReason } from "../src/loop.js";
import { STORE_DETAILS } from "../src/reader.js";
import { ROWS_HASH_START, rowsHashStep } from "../src/rowshash.js";
import { diskStore } from "../src/server.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok, thrown } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { cap, NODE, node } from "./node-harness.js";
import { hashAt, scripted as scripted0, timeAt } from "./reader-harness.js";
import { FEED, at, commit, key, meta, rollback, row, storeSuite } from "./store-suite.js";

const root = mkdtempSync(join(tmpdir(), "cairnx-replica-disk-"));
// Removed however the process ends: done() exits the process, and a throw ends it too.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `s${n++}`);
const P = 30_000, TIP = cap.to, DEEP = TIP - FINAL_DEPTH, clock = () => timeAt(TIP) * 1000 + 60_000;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const truth = stateHash(resolve(corpus.events.filter((e) => e.height <= DEEP), DEEP));
const upTo: BlockFixture = { ...fx, to: P, toHash: hashAt(P), blocks: fx.blocks.filter((b) => b.height <= P) };
const d = await derivePin(upTo);
let logReads = 0;
const pinOf = (o: Partial<Omit<Pin, "log">> = {}): Pin => ({ ...d.pin, ...o, log: async () => { logReads++; return d.log; } });

console.log("the store suite, diskStore:");
const checks = await storeSuite(() => diskStore({ dir: fresh() }));
for (const c of checks) ok(c.name, c.ok);
ok("the suite ran its 32 checks", checks.length === 32);

// A reader with the pin at 30,000 over the recorded node on a disk store in `dir`; `tip` caps the node's tip.
const reader = (dir: string, o: { pin?: Pin; tip?: number; store?: Store } = {}) =>
  open({ ...local({ node: NODE, pin: o.pin ?? pinOf(), fetch: node({ answers: cap.answers, ...(o.tip ? { tip: o.tip } : {}) }).f }), store: o.store ?? diskStore({ dir }), clock });
async function verifiedAt(dir: string, o: { pin?: Pin; tip?: number } = {}) {
  const r = await reader(dir, o), s = await r.advance(), st = await r.state();
  await r.close();
  return { s, ok: s.verified && st.verified && s.cursor?.height === (o.tip ?? TIP) && (o.tip !== undefined || stateHash(st.value) === truth), why: codes(s) };
}
const filled = async () => { const dir = fresh(); await verifiedAt(dir); return dir; };

console.log("a store filled through the reader, reopened from disk:");
const A = fresh(), a0 = await verifiedAt(A);
ok("filled: verified at 30,300, the deep state resolve()'s over the corpus", a0.ok, a0.why);
logReads = 0;
const a1 = await verifiedAt(A);
ok("reopened by a new reader: verified, the log not read again", a1.ok && logReads === 0, `${a1.why} reads=${logReads}`);
const m0 = JSON.parse(readFileSync(join(A, "meta.json"), "utf8"));
ok("meta.json names the committed lengths of rows.jsonl and bounds.jsonl, which are the files' sizes, and holds no witnessed",
  m0.rowsBytes === statSync(join(A, "rows.jsonl")).size && m0.boundsBytes === statSync(join(A, "bounds.jsonl")).size && !("witnessed" in m0.meta) && m0.format === 1);

// The files of a store as data: edit them, recompute every running value, write them back consistently.
type Lines = { meta: Record<string, any>; rows: BlockRow[]; bounds: Boundary[] };
const linesOf = (file: string, length: number) => readFileSync(file).subarray(0, length).toString("utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
function rewrite(dir: string, edit: (x: Lines) => void, after: (bounds: Record<string, unknown>[]) => void = () => undefined): void {
  const m = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const x: Lines = { meta: m, rows: linesOf(join(dir, "rows.jsonl"), m.rowsBytes), bounds: linesOf(join(dir, "bounds.jsonl"), m.boundsBytes) };
  edit(x);
  let rh = ROWS_HASH_START;
  const rows = x.rows.map((r) => ({ ...r, rowsHash: (rh = rowsHashStep(rh, r)) }));
  const rowsAt = (h: number) => rows.filter((r) => r.height <= h).at(-1)?.rowsHash ?? ROWS_HASH_START;
  let chain = BOUNDS_HASH_START;
  const recomputed: Record<string, unknown>[] = x.bounds.map((b) => ({ ...b, rowsHash: rowsAt(b.height) }));
  after(recomputed);
  const bounds = recomputed.map((b) => JSON.stringify(b));
  for (const b of recomputed) chain = boundsHashStep(chain, b as unknown as Boundary);
  const rowText = rows.map((r) => JSON.stringify(r) + "\n").join(""), boundText = bounds.map((l) => l + "\n").join("");
  writeFileSync(join(dir, "rows.jsonl"), rowText); writeFileSync(join(dir, "bounds.jsonl"), boundText);
  m.meta.rowsHash = rh; m.rowsBytes = Buffer.byteLength(rowText); m.boundsBytes = Buffer.byteLength(boundText); m.boundsHash = chain;
  writeFileSync(join(dir, "meta.json"), JSON.stringify(m) + "\n");
}
const loopOpen = async (dir: string, pin = pinOf()) => {
  const loop = replicaLoop({ source: pinned({ pin, then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) }), store: diskStore({ dir }) });
  const o = await loop.open(); await loop.close(); return o.ok ? "opened" : o.reset;
};

console.log("what a store read back can be:");
const B = fresh();
await verifiedAt(B, { tip: 30_200 });
// Longer than what the next commit writes, so only a cut leaves the files at their committed lengths.
appendFileSync(join(B, "rows.jsonl"), `{"torn":"${"x".repeat(100_000)}`); appendFileSync(join(B, "bounds.jsonl"), "garbage".repeat(10_000));
const b1 = await verifiedAt(B);
const mB = JSON.parse(readFileSync(join(B, "meta.json"), "utf8"));
ok("a tail past the committed lengths (a cut append): opens, goes on to 30,300 verified, and the next commit cuts the tail",
  b1.ok && mB.rowsBytes === statSync(join(B, "rows.jsonl")).size && mB.boundsBytes === statSync(join(B, "bounds.jsonl")).size, b1.why);
const C = await filled();
truncateSync(join(C, "rows.jsonl"), statSync(join(C, "rows.jsonl")).size - 10);
ok("rows.jsonl shorter than its committed length: corrupt", (await loopOpen(C)) === "corrupt");
const c1 = await verifiedAt(C);
ok("through the reader it is reset and refilled: verified with the honest state", c1.ok, c1.why);
const D = await filled();
writeFileSync(join(D, "rows.jsonl"), readFileSync(join(D, "rows.jsonl"), "utf8").replace("\"pos\":1", "\"pos\":2"));
ok("a changed row (its running values not recomputed): corrupt; the reader resets and refills it, verified",
  (await loopOpen(D)) === "corrupt" && (await verifiedAt(D)).ok);
const E = await filled();
writeFileSync(join(E, "bounds.jsonl"), readFileSync(join(E, "bounds.jsonl"), "utf8").replace(/"stateHash":"0x[0-9a-f]{4}/, "\"stateHash\":\"0x0000"));
ok("a boundary line changed with its chain not recomputed: corrupt", (await loopOpen(E)) === "corrupt");
const F = await filled(), wrong = `0x${"ab".repeat(32)}`;
rewrite(F, (x) => { const b = x.bounds.find((y) => y.height === P)!; (b as { stateHash: string }).stateHash = wrong; });
ok("a consistent wrong state hash on the pin's boundary: the store opens", (await loopOpen(F)) === "opened");
const f1 = await verifiedAt(F);
ok("the honest pin is bound by a replay, not the stored value: verified", f1.ok, f1.why);
const f2 = await reader(F, { pin: pinOf({ stateHash: wrong }) }), f2s = await f2.advance();
ok("a descriptor carrying that stored value is refused PIN_MISMATCH", !f2s.verified && codes(f2s).split(",").includes("PIN_MISMATCH"), codes(f2s));
await f2.close();
const F3 = await filled();
rewrite(F3, () => undefined, (bounds) => { bounds[0]!.rowsHash = wrong; });
ok("a boundary whose rows hash is not the rows' there, its chain recomputed: corrupt", (await loopOpen(F3)) === "corrupt");
const G = await filled();
rewrite(G, (x) => { const r = x.rows.find((y) => y.height <= P && y.events.length > 0)!; (r.events[0] as unknown as Record<string, unknown>).note = "edited"; });
ok("an event at or below the pin given a field, every running value recomputed (the events hash does not cover it): the store opens",
  (await loopOpen(G)) === "opened");
const g1 = await reader(G), g1s = await g1.advance();
ok("the bind compares the stored log's digest with the pin's logSha256: PIN_MISMATCH, not verified", !g1s.verified && codes(g1s).split(",").includes("PIN_MISMATCH"), codes(g1s));
await g1.close();
const H = fresh();
await verifiedAt(H, { tip: 30_200 });
const mh = JSON.parse(readFileSync(join(H, "meta.json"), "utf8"));
writeFileSync(join(H, "meta.json"), JSON.stringify({ ...mh, meta: { ...mh.meta, gates: { ...LOADED_GATES, V99_HEIGHT: 30_100 } } }) + "\n");
ok("rows written under a gate table that differs at or below the cursor: reset rule", (await loopOpen(H)) === "rule");
writeFileSync(join(H, "meta.json"), JSON.stringify({ ...mh, meta: { ...mh.meta, gates: { ...LOADED_GATES, V99_HEIGHT: 40_000 } } }) + "\n");
ok("a table that differs only above the cursor: opens", (await loopOpen(H)) === "opened");
const h1 = await verifiedAt(H);
ok("and goes on verified to 30,300, its meta rewritten with the loaded table", h1.ok && JSON.stringify(JSON.parse(readFileSync(join(H, "meta.json"), "utf8")).meta.gates) === JSON.stringify(LOADED_GATES), h1.why);
writeFileSync(join(H, "meta.json"), JSON.stringify({ ...mh, format: 2 }) + "\n");
ok("meta.json of another format: reset format", (await loopOpen(H)) === "format");
writeFileSync(join(H, "meta.json"), "{\"store\":");
ok("meta.json that does not parse: corrupt", (await loopOpen(H)) === "corrupt");

console.log("the store's own fields:");
const W = fresh(), w = diskStore({ dir: W }), r1 = row(30_001, null);
await w.open(key(FEED));
const withWitness = { ...commit(null, [r1], at(30_010), { headerWindow: new Uint8Array([7, 8]) }) };
const c1w = await w.commit({ ...withWitness, meta: { ...meta(at(30_010), [r1]), witnessed: { height: 30_005, hash: at(30_005).hash, by: "x", at: 1 } } });
w.close();
const w2 = diskStore({ dir: W }), o2 = await w2.open(key(FEED));
ok("witnessed is never stored: committed set, read back null", c1w.ok && o2.ok && o2.meta?.witnessed === null);
ok("the header window is read back as committed", [...((await w2.headerWindow()) ?? [])].join() === "7,8");
const first = `window-${JSON.parse(readFileSync(join(W, "meta.json"), "utf8")).window.slice(2)}.bin`;
const r2 = row(30_020, r1);
await w2.commit(commit(at(30_010), [r2], at(30_020), { headerWindow: new Uint8Array([9]) }));
ok("a new window replaces the old file", !exists(join(W, first)) && [...((await w2.headerWindow()) ?? [])].join() === "9");
w2.close();
unlinkSync(join(W, `window-${JSON.parse(readFileSync(join(W, "meta.json"), "utf8")).window.slice(2)}.bin`));
const w3 = diskStore({ dir: W });
ok("a window file that is gone: corrupt", (await w3.open(key(FEED)).then((o) => (o.ok ? "opened" : o.reset))) === "corrupt");
w3.close();
function exists(path: string): boolean { try { statSync(path); return true; } catch { return false; } }

console.log("files in the directory that are not the store's:");
const X = fresh();
mkdirSync(join(X, "sub"), { recursive: true });
writeFileSync(join(X, "notes.txt"), "mine"); writeFileSync(join(X, "app.db"), "db"); writeFileSync(join(X, "sub", "inner"), "in");
const x0 = await verifiedAt(X);
ok("a directory holding notes.txt, app.db and a subdirectory opens and fills: verified", x0.ok, x0.why);
truncateSync(join(X, "rows.jsonl"), 5);
const x1 = await verifiedAt(X);
const kept = ["notes.txt", "app.db", "sub"].every((f) => readdirSync(X).includes(f)) && readFileSync(join(X, "notes.txt"), "utf8") === "mine" &&
  readFileSync(join(X, "app.db"), "utf8") === "db" && readFileSync(join(X, "sub", "inner"), "utf8") === "in";
ok("the store found corrupt is reset and refilled, verified, and the three are kept as they were", x1.ok && kept, `${x1.why} ${readdirSync(X).join(",")}`);
const Y = fresh();
mkdirSync(Y, { recursive: true });
const foreign = JSON.stringify({ name: "another program", version: 3 });
writeFileSync(join(Y, "meta.json"), foreign); writeFileSync(join(Y, "data.bin"), "data");
const y0 = await diskStore({ dir: Y }).open(key(FEED)).catch((e: unknown) => e);
const y1 = await reader(Y).catch((e: unknown) => e);
ok("a meta.json another program wrote: open throws ReplicaConfigError naming it, and so does the reader's open",
  y0 instanceof ReplicaConfigError && y0.message.includes(join(Y, "meta.json")) && y1 instanceof ReplicaConfigError, String(y0));
ok("that meta.json and the file beside it are unchanged on disk", readFileSync(join(Y, "meta.json"), "utf8") === foreign && readFileSync(join(Y, "data.bin"), "utf8") === "data");
const Z = fresh();
mkdirSync(Z, { recursive: true });
const z0 = await verifiedAt(Z);
ok("an empty directory that exists opens and fills: verified", z0.ok, z0.why);

console.log("a store found by a reader that started while the old lease was live:");
// The old process fills the store under a lease touched at t0 and is never closed, as after a kill; the store is then
// left as it was, or damaged; the new process starts inside the lease, and its lease clock is then moved past it.
async function lateStart(name: string, damage: (dir: string) => void, pin: Pin | null) {
  const dir = fresh(), t0 = clock() - 10_000;
  const old = await reader(dir, { store: diskStoreWith({ dir }, { clock: () => t0 }) });
  await old.advance();
  damage(dir);
  const now = { t: t0 + 1_000 };
  const src = pin === null ? nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) : pinned({ pin, then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) });
  const r = await open({ source: src, store: diskStoreWith({ dir }, { clock: () => now.t }), clock });
  const held = await r.advance();
  now.t = t0 + STALE_MS + 5_000;
  const after = await r.advance(), st = await r.state();
  ok(`${name}: unavailable while the old lease is live (NOT_SYNCED, STORE_UNAVAILABLE), then reset, refilled and verified with the honest state`,
    !held.verified && held.notes.some((x) => x.code === "STORE_UNAVAILABLE") && after.verified && st.verified && stateHash(st.value) === truth, `${codes(held)} then ${codes(after)}`);
  await r.close(); await old.close();
}
await lateStart("the same basis, as left", () => undefined, pinOf());
await lateStart("another basis (no pin)", () => undefined, null);
await lateStart("a corrupt rows file", (dir) => truncateSync(join(dir, "rows.jsonl"), statSync(join(dir, "rows.jsonl")).size - 10), pinOf());
await lateStart("a gate table that differs at or below the cursor", (dir) => {
  const m = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...m, meta: { ...m.meta, gates: { ...LOADED_GATES, V99_HEIGHT: 30_010 } } }) + "\n");
}, pinOf());

// A directory refused once the lease is had (another program's meta.json) throws into advance() alone; a caller that
// only reads gets the reason in the note's detail, from the fixed list, without the path. Removed, the next advance
// opens and fills the store.
{
  const dir = fresh(), t0 = clock() - 10_000, holder = diskStoreWith({ dir }, { clock: () => t0 });
  await holder.open(key(FEED));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ name: "another program" }));
  const now = { t: t0 + 1_000 };
  const r = await open({ source: pinned({ pin: pinOf(), then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) }), store: diskStoreWith({ dir }, { clock: () => now.t }), clock });
  const held = await r.advance(), heldNote = held.notes.find((x) => x.code === "STORE_UNAVAILABLE");
  now.t = t0 + STALE_MS + 5_000;
  const thrownBy = await r.advance().then(() => null, (e: unknown) => e), st = await r.state(), note = st.notes.find((x) => x.code === "STORE_UNAVAILABLE");
  ok("a foreign meta.json met once a held lease goes stale: advance() rejects with ReplicaConfigError naming it; a read answers NOT_SYNCED, STORE_UNAVAILABLE's detail the list's, without the path, which status() carries",
    heldNote?.detail === STORE_DETAILS.held && thrownBy instanceof ReplicaConfigError && thrownBy.message.includes(dir) && !st.verified && codes(st).includes("NOT_SYNCED") &&
    note?.detail === STORE_DETAILS.foreign && !JSON.stringify(st).includes(dir) && r.status().storeReason === "foreign" && r.status().storeError?.includes(dir) === true,
    `${JSON.stringify(heldNote)} ${JSON.stringify(st.notes)}`);
  unlinkSync(join(dir, "meta.json"));
  const healed = await r.advance();
  ok("the foreign file moved away, the next advance opens and fills the store: verified, no STORE_UNAVAILABLE", healed.verified && healed.notes.length === 0, codes(healed));
  await r.close(); holder.close();
}

// Each reason a load gives, from stores that answer it with a path and a marker in their messages: the answers of the
// reads carry the list's detail and neither string; status(), for the server's own logs, and the loop keep both.
{
  const BOTH_ADDR = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016", PATH = "/srv/replica/private/meta.json", MARK = "MARKER-7b-not-for-pages", says = `${PATH} ${MARK}`;
  const scripted = (o: { open: (n: number) => Promise<Awaited<ReturnType<Store["open"]>>>; reset?: () => Promise<void> }): Store => {
    const m = memoryStore();
    let n = 0;
    return { ...m, open: () => o.open(++n), reset: o.reset ?? m.reset };
  };
  const failingReset = (reset: "format" | "rule" | "basis" | "corrupt" | "unconfirmed") => () => scripted({ open: async () => ({ ok: false, reset }), reset: async () => { throw new Error(`EACCES: ${says}`); } });
  const cases: [StoreReason, () => Store][] = [
    ["held", () => scripted({ open: async () => ({ ok: false, reset: "unavailable" }) })],
    ["io", () => scripted({ open: async () => { throw new Error(`EIO: ${says}`); } })],
    ["foreign", () => scripted({ open: async (k) => { if (k === 1) return { ok: false, reset: "unavailable" }; throw new ReplicaConfigError(`diskStore: ${says}`); } })],
    ["format", failingReset("format")], ["rule", failingReset("rule")], ["basis", failingReset("basis")], ["corrupt", failingReset("corrupt")],
    ["unconfirmed", failingReset("unconfirmed")],
  ];
  const tip = { height: 30_010, hash: at(30_010).hash, time: 0 }, bad: string[] = [];
  for (const [reason, make] of cases) {
    const rd = await open({ source: scripted0([], tip), store: make(), clock });
    await rd.advance().catch(() => undefined);
    const answers = [await rd.state({ waitMs: 2_000 }), await rd.name("alice", { waitMs: 2_000 }), await rd.balance("CAIRN", BOTH_ADDR, { waitMs: 2_000 }),
      await rd.events(null, { waitMs: 2_000 }), await rd.transfers(BOTH_ADDR, null, { waitMs: 2_000 })];
    const st = rd.status(), details = [...answers, st].map((x) => x.notes.find((y) => y.code === "STORE_UNAVAILABLE")?.detail);
    const logged = st.storeReason === reason && (reason === "held" ? st.storeError === null : st.storeError?.includes(PATH) === true && st.storeError.includes(MARK));
    await rd.close();
    const loop = replicaLoop({ source: scripted0([], tip), store: make(), resetRefused: true });
    await loop.open().catch(() => undefined); await loop.advance().catch(() => undefined);
    const ls = loop.status(), kept = reason === "held" ? ls.storeError === null : ls.storeError?.includes(PATH) === true && ls.storeError.includes(MARK);
    await loop.close();
    if (!details.every((x) => x === STORE_DETAILS[reason]) || answers.some((x) => JSON.stringify(x).includes(PATH) || JSON.stringify(x).includes(MARK)) || !logged ||
      ls.storeReason !== reason || !kept)
      bad.push(`${reason}: ${JSON.stringify(details)} ${ls.storeReason} ${ls.storeError}`);
  }
  ok(`each of the ${cases.length} reasons: the detail of five reads' answers and of status() is the list's, no path or marker in a read's answer, status() and the loop keep the reason and both`, bad.length === 0, bad.join("; "));
}

console.log("missing files, out-of-form fields, short writes:");
const M = await filled();
unlinkSync(join(M, "rows.jsonl"));
ok("rows.jsonl missing while the meta commits bytes of it: corrupt", (await loopOpen(M)) === "corrupt");
const M2 = await filled();
unlinkSync(join(M2, "bounds.jsonl"));
ok("bounds.jsonl missing likewise: corrupt; the reader resets and refills it, verified", (await loopOpen(M2)) === "corrupt" && (await verifiedAt(M2)).ok);
const N = await filled(), mn = JSON.parse(readFileSync(join(N, "meta.json"), "utf8"));
writeFileSync(join(N, "meta.json"), JSON.stringify({ ...mn, meta: { ...mn.meta, windowSha256: 5 } }) + "\n");
ok("a meta field out of form that no later check reads (windowSha256 a number): corrupt", (await loopOpen(N)) === "corrupt");
const probe = await openFile(join(root, "probe"), "w"), proto = Object.getPrototypeOf(probe) as { write: (...a: unknown[]) => Promise<{ bytesWritten: number }> };
await probe.close();
const realWrite = proto.write;
const SW = fresh(), sw = diskStore({ dir: SW });
await sw.open(key(FEED));
let cut = true;
proto.write = function (this: unknown, ...a: unknown[]) {
  // The first write of the commit lands half its bytes and says so; the rest go through.
  if (cut && a[0] instanceof Uint8Array && typeof a[2] === "number" && a[2] > 1) { cut = false; return realWrite.call(this, a[0], a[1], Math.floor(a[2] / 2), a[3]); }
  return realWrite.apply(this, a);
};
const swOk = await sw.commit(commit(null, [r1, r2], at(30_020))).finally(() => { proto.write = realWrite; });
sw.close();
const sw2 = diskStore({ dir: SW }), swo = await sw2.open(key(FEED)), swRows: BlockRow[] = [];
for await (const x of sw2.rows(0)) swRows.push(x);
sw2.close();
ok("a write that lands short is completed: the commit answers ok and reopens with both rows", swOk.ok && swo.ok && swRows.length === 2 && !cut);
const SZ = fresh(), sz = diskStore({ dir: SZ });
await sz.open(key(FEED));
await sz.commit(commit(null, [r1], at(30_010)));
const szBefore = readFileSync(join(SZ, "meta.json"));
proto.write = async function () { return { bytesWritten: 0, buffer: new Uint8Array() }; };
const szR = await sz.commit(commit(at(30_010), [r2], at(30_020))).then((r) => r.ok, () => false).finally(() => { proto.write = realWrite; });
sz.close();
ok("a write that makes no progress fails the commit, and meta.json is as before", szR === false && readFileSync(join(SZ, "meta.json")).equals(szBefore));

console.log("the lease:");
const L = fresh(), t0 = 1_000_000_000_000;
const sa = diskStoreWith({ dir: L }, { clock: () => t0 }), oa = await sa.open(key(FEED));
const sb = diskStoreWith({ dir: L }, { clock: () => t0 + STALE_MS }), ob = await sb.open(key(FEED));
ok("a lease touched within 20 s holds: the second store is unavailable", oa.ok && !ob.ok && ob.reset === "unavailable");
const held = await open({ source: pinned({ pin: pinOf(), then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) }), store: diskStoreWith({ dir: L }, { clock: () => t0 + 1 }), clock });
const hs = held.status();
ok("a reader over a held store: NOT_SYNCED with STORE_UNAVAILABLE, nothing reset", !hs.verified && codes(hs).includes("NOT_SYNCED") && hs.notes.some((x) => x.code === "STORE_UNAVAILABLE"),
  `${codes(hs)} ${JSON.stringify(hs.notes)}`);
sa.close();
const hs2 = await held.advance();
ok("released by close(), the next advance opens it: verified", hs2.verified, codes(hs2));
await held.close();
const L2 = fresh(), old = diskStoreWith({ dir: L2 }, { clock: () => t0 });
await old.open(key(FEED));
await old.commit(commit(null, [r1], at(30_010)));
const before = readFileSync(join(L2, "meta.json")), rowsBefore = statSync(join(L2, "rows.jsonl")).size;
const taker = diskStoreWith({ dir: L2 }, { clock: () => t0 + STALE_MS + 1 }), ot = await taker.open(key(FEED));
ok("a lease not touched for more than 20 s is stale: taken over", ot.ok && ot.meta?.cursor?.height === 30_010);
const lost = await old.commit(commit(at(30_010), [r2], at(30_020)));
ok("the old holder's next commit fails closed and writes nothing", !lost.ok && lost.code === "STORE_FAILED" &&
  readFileSync(join(L2, "meta.json")).equals(before) && statSync(join(L2, "rows.jsonl")).size === rowsBefore);
ok("the taker commits", (await taker.commit(commit(at(30_010), [r2], at(30_020)))).ok);
taker.close();
ok("close() removes the lock", !exists(join(L2, "lock")));
const L4 = fresh(), h4 = diskStoreWith({ dir: L4 }, { clock: () => t0 });
await h4.open(key(FEED)); await h4.commit(commit(null, [r1], at(30_010)));
const o4 = diskStoreWith({ dir: L4 }, { clock: () => t0 + 1 }), u4 = await o4.open(key(FEED)), e4 = await o4.reset().then(() => null, (e: unknown) => e);
ok("reset() by a store that does not hold the lease throws and removes nothing", !u4.ok && e4 instanceof Error && exists(join(L4, "meta.json")) && exists(join(L4, "rows.jsonl")));
h4.close();
const L3 = fresh(), stale = diskStoreWith({ dir: L3 }, { clock: () => t0 });
await stale.open(key(FEED));
const late = () => t0 + STALE_MS + 1;
let won: Lease | null = null;
const loser = diskStoreWith({ dir: L3 }, { clock: late, judged: () => { won = takeLease(join(L3, "lock"), late); } });
const ol = await loser.open(key(FEED));
ok("two takers of one stale lock, the second taking it between the first's judging and moving it: the second holds it, the first is unavailable",
  !ol.ok && ol.reset === "unavailable" && won !== null && (won as Lease).holds(), JSON.stringify(ol));
(won as Lease | null)?.release(); loser.close();

console.log("the sync order:");
const S = fresh(), trace: string[] = [], ss = diskStoreWith({ dir: S }, { point: (p) => trace.push(p) });
await ss.open(key(FEED));
const commitsOf = () => { const out: string[][] = [[]]; for (const p of trace) { out.at(-1)!.push(p); if (p === "done") out.push([]); } return out.slice(0, -1); };
await ss.commit(commit(null, [r1, r2], at(30_040), { boundaries: [{ height: 30_030, hash: at(30_030).hash, eventsHash: r1.eventsHash, rowsHash: r1.rowsHash, stateHash: null }], headerWindow: new Uint8Array([1]) }));
await ss.commit(rollback(at(30_040), { height: r1.height, hash: r1.hash! }, r1));
await ss.commit(commit({ height: r1.height, hash: r1.hash! }, [row(30_002, r1)], at(30_002)));
ss.close();
const [ext, back, after] = commitsOf();
const before_ = (c: string[], a: string, b: string) => c.indexOf(a) >= 0 && c.indexOf(a) < c.indexOf(b);
const metaLast = (c: string[]) => before_(c, "write meta", "sync meta") && before_(c, "sync meta", "rename meta") && before_(c, "rename meta", "sync dir") && before_(c, "sync dir", "done");
ok("an extend syncs each file it wrote before the rename that names it, then the directory, before the commit resolves",
  ["rows.jsonl", "bounds.jsonl", "window"].every((f) => before_(ext!, `write ${f}`, `sync ${f}`) && before_(ext!, `sync ${f}`, "rename meta")) && metaLast(ext!), ext!.join(" "));
ok("a rollback writes nothing but the meta", back!.join(" ") === "write meta sync meta rename meta sync dir done", back!.join(" "));
ok("the extend after it cuts the rolled-back tail before it writes, then syncs as an extend does",
  before_(after!, "truncate rows.jsonl", "write rows.jsonl") && before_(after!, "sync rows.jsonl", "rename meta") && metaLast(after!), after!.join(" "));

console.log("the directory:");
ok("a relative dir throws ReplicaConfigError", thrown(() => diskStore({ dir: "relative/store" })) instanceof ReplicaConfigError);
const file = join(root, "a-file");
writeFileSync(file, "x");
const asFile = await diskStore({ dir: file }).open(key(FEED)).catch((e: unknown) => e);
ok("a dir that is a file: open throws ReplicaConfigError", asFile instanceof ReplicaConfigError);
const nested = diskStore({ dir: join(root, "made", "on", "open") });
ok("an absolute dir that does not exist is created at open", (await nested.open(key(FEED))).ok && statSync(join(root, "made", "on", "open")).isDirectory());
nested.close();

done("cairnx-replica diskStore");
