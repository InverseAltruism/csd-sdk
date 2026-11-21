// diskStore (disk-store.ts) and its lease (lease.ts): the store suite over the disk; a store filled through the reader
// with the pin at 30,000 and the recorded node, reopened from disk; and what a store read back can be (cut short, a
// tail past its committed length, a row or boundary changed, a consistent edit, another format or gate table, a lost
// window), each with the honest reopen beside it. Then the lease, the sync order, and the refusals of a directory.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINAL_DEPTH, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { local, nodeBlocks } from "../src/browser.js";
import { derivePin } from "../src/derive-pin.js";
import { BOUNDS_HASH_START, boundsHashStep, diskStoreWith } from "../src/disk-store.js";
import { LOADED_GATES } from "../src/gates.js";
import { STALE_MS, takeLease, type Lease } from "../src/lease.js";
import { open, pinned, ReplicaConfigError, replicaLoop, type BlockRow, type Boundary, type Pin, type Store } from "../src/index.js";
import { ROWS_HASH_START, rowsHashStep } from "../src/rowshash.js";
import { diskStore } from "../src/server.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok, thrown } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { cap, NODE, node } from "./node-harness.js";
import { hashAt, timeAt } from "./reader-harness.js";
import { FEED, at, commit, key, meta, rollback, row, storeSuite } from "./store-suite.js";

const root = mkdtempSync(join(tmpdir(), "cairnx-replica-disk-"));
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
function rewrite(dir: string, edit: (x: Lines) => void): void {
  const m = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const x: Lines = { meta: m, rows: linesOf(join(dir, "rows.jsonl"), m.rowsBytes), bounds: linesOf(join(dir, "bounds.jsonl"), m.boundsBytes) };
  edit(x);
  let rh = ROWS_HASH_START;
  const rows = x.rows.map((r) => ({ ...r, rowsHash: (rh = rowsHashStep(rh, r)) }));
  const rowsAt = (h: number) => rows.filter((r) => r.height <= h).at(-1)?.rowsHash ?? ROWS_HASH_START;
  let chain = BOUNDS_HASH_START;
  const bounds = x.bounds.map((b) => JSON.stringify({ ...b, rowsHash: rowsAt(b.height) }));
  for (const l of bounds) chain = boundsHashStep(chain, l);
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
appendFileSync(join(B, "rows.jsonl"), "{\"torn\":"); appendFileSync(join(B, "bounds.jsonl"), "garbage");
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

rmSync(root, { recursive: true, force: true });
done("cairnx-replica diskStore");
