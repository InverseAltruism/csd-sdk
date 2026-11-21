// The anchor root's header window kept by the store (README, "What a store must keep"), on the production call shape
// open({ ...hosted({ pin, origin, witness, store }) }) over the recorded captures, the pin at 30,000: a reader started
// again over a store that keeps its window reads no header (memory and disk; the browser store is
// test/browser/idb-store.test.ts), and above the cursor only the new blocks' pages. A window that does not hold
// together falls back to the walk from the pin and ends verified at the same cursor and deep state as a fresh replica:
// bytes that are not the record's, a window ending below the cursor, one that does not hold the cursor's block, one
// whose headers do not link, one that links without the proof of work. The work rule over a kept window is
// hosted-work.test.ts.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateHash } from "@inversealtruism/cairnx-core";
import { HEADER_BYTES, deserializeHeader, headerHash, serializeHeader } from "@inversealtruism/csd-codec";
import { hosted } from "../src/browser.js";
import { derivePin, diskStore } from "../src/server.js";
import { memoryStore, open, type Pin, type Store } from "../src/index.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { all, front, ORIGIN, type Hosted } from "./hosted-harness.js";
import { hashAt, timeAt, witnessOn } from "./reader-harness.js";

const P = 30_000, MID = 30_250, TIP = 30_300;
const root = mkdtempSync(join(tmpdir(), "cairnx-replica-window-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dirOf = () => join(root, `s${n++}`);
const upTo: BlockFixture = { ...fx, to: P, toHash: hashAt(P), blocks: fx.blocks.filter((b) => b.height <= P) };
const d = await derivePin(upTo), pin: Pin = { ...d.pin, log: async () => d.log };
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");

// One reader's life on `store` with the front door at `tip`: opened, advanced, closed. `heads` are the /api/headers
// paths it read, `requests` every path.
async function life(store: Store, tip: number) {
  const fr = front({ answers: all, tip } as Hosted), wit = witnessOn(all, tip), clock = () => timeAt(tip) * 1000 + 60_000;
  const r = await open({ ...hosted({ pin, origin: ORIGIN, witness: wit.witness, store, fetch: fr.f }), clock });
  let s = await r.advance();
  for (let i = 0; i < 10 && s.lastError !== null; i++) s = await r.advance();
  const st = await r.state();
  await r.close();
  const paths = fr.log.map((l) => l.path);
  return { s, verified: s.verified && st.verified, cursor: s.cursor, state: st.verified ? stateHash(st.value) : null, requests: paths, heads: paths.filter((p) => p.startsWith("/api/headers/")),
    pages: paths.filter((p) => p.startsWith("/api/blocks/")) };
}
const fresh = await life(memoryStore(), TIP), freshMid = await life(memoryStore(), MID);
const same = (x: { verified: boolean; cursor: unknown; state: string | null }, ref = fresh) =>
  x.verified && JSON.stringify(x.cursor) === JSON.stringify(ref.cursor) && x.state !== null && x.state === ref.state;
ok(`a fresh replica: verified at ${TIP}, its headers the seed and one walk (${fresh.heads.join(" ")})`, fresh.verified && fresh.cursor?.height === TIP &&
  fresh.heads.join() === "/api/headers/29956/45", codes(fresh.s));

console.log("a restart over a store that keeps its window:");
for (const [name, make] of [["memoryStore", () => memoryStore()], ["diskStore", () => diskStore({ dir: dirOf() })]] as const) {
  const store = make();
  const first = await life(store, MID), again = await life(store, MID), on = await life(store, TIP);
  ok(`${name}: filled to ${MID}; started again at the same tip: no header read, only the server's tip (${again.requests.join(" ")}), verified as before`,
    same(first, freshMid) && again.heads.length === 0 && again.requests.length > 0 && again.requests.every((x) => x === "/api/rpc/tip") && same(again, freshMid), `${codes(again.s)} ${again.requests.join(" ")}`);
  ok(`${name}: started again with the tip at ${TIP}: no header read, only the pages from the one holding ${MID + 1} (${on.pages.join(" ")}), verified as a fresh replica`,
    on.heads.length === 0 && on.pages[0] === "/api/blocks/30208/64" && same(on), `${codes(on.s)} ${on.requests.join(" ")}`);
}

console.log("a window that does not hold together: the walk from the pin, then the fresh replica's end:");
const walked = (x: { heads: string[] }) => x.heads[0] === "/api/headers/29956/45" && x.heads.length === 2 && x.heads[1]!.startsWith("/api/headers/30001/");
// A store whose headerWindow() gives `f` of what it holds.
const edited = (s: Store, f: (b: Uint8Array) => Uint8Array): Store => ({ ...s, rows: (h) => s.rows(h), headerWindow: async () => { const b = await s.headerWindow(); return b === null ? null : f(b); } });
const headerAt = (b: Uint8Array, i: number) => deserializeHeader(b.subarray(4 + i * HEADER_BYTES, 4 + (i + 1) * HEADER_BYTES));
const withHeader = (b: Uint8Array, i: number, h: ReturnType<typeof deserializeHeader>) => { const c = b.slice(); c.set(serializeHeader(h), 4 + i * HEADER_BYTES); return c; };

{
  const dir = dirOf(), inner = diskStore({ dir });
  await life(inner, TIP);
  // Between the store's open (which checks the digest) and the loop's read of the window, the file is overwritten.
  const swapped: Store = { ...inner, rows: (h) => inner.rows(h), async open(e) {
    const o = await inner.open(e);
    for (const f of readdirSync(dir).filter((x) => x.startsWith("window-"))) writeFileSync(join(dir, f), new Uint8Array([1, 2, 3]));
    return o;
  } };
  const x = await life(swapped, TIP);
  ok("bytes that are not the record's (the disk file overwritten after the open): headerWindow() gives none, the walk, verified as a fresh replica", walked(x) && same(x), `${codes(x.s)} ${x.heads.join(" ")}`);
}
{
  const store = memoryStore();
  await life(store, MID);
  // The same store filled on to the tip by a reader whose source keeps no window: the store's window ends at 30,250.
  const fr = front({ answers: all, tip: TIP } as Hosted), opts = hosted({ pin, origin: ORIGIN, witness: witnessOn(all, TIP).witness, store, fetch: fr.f });
  const { windowAt: _w, restoreWindow: _r, ...blind } = opts.source;
  const r = await open({ ...opts, source: blind, clock: () => timeAt(TIP) * 1000 + 60_000 });
  const filled = await r.advance();
  await r.close();
  const x = await life(store, TIP);
  ok(`a window ending at ${MID}, below the cursor ${TIP}: the walk, verified as a fresh replica`, filled.cursor?.height === TIP && walked(x) && same(x), `${codes(x.s)} ${x.heads.join(" ")}`);
}
{
  const store = memoryStore();
  await life(store, TIP);
  // The header at 30,150 given another merkle root: its hash changes, so 30,151 no longer links to it; the cursor's is kept.
  const bytes = (await store.headerWindow())!, base = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true), i = 30_150 - base;
  const x = await life(edited(store, (b) => withHeader(b, i, { ...headerAt(b, i), merkle: `0x${"11".repeat(32)}` })), TIP);
  ok("headers that do not link (one header below the cursor changed): the walk, verified as a fresh replica", base === 29_956 && walked(x) && same(x), `${codes(x.s)} ${x.heads.join(" ")}`);
}
{
  const store = memoryStore();
  await life(store, TIP);
  // The header at 30,150 given another nonce and every header above it linked again: one chain, without the work.
  const relinked = (b: Uint8Array) => {
    let c = b.slice();
    const count = (c.length - 4) / HEADER_BYTES, i0 = 30_150 - 29_956;
    c = withHeader(c, i0, { ...headerAt(c, i0), nonce: headerAt(c, i0).nonce + 1 });
    for (let i = i0 + 1; i < count; i++) c = withHeader(c, i, { ...headerAt(c, i), prev: headerHash(headerAt(c, i - 1)) });
    return c;
  };
  const x = await life(edited(store, relinked), TIP);
  ok("a window that links without the proof of work (a header mined again, those above linked to it): the walk, verified as a fresh replica", walked(x) && same(x),
    `${codes(x.s)} ${x.heads.join(" ")}`);
}
{
  const store = memoryStore();
  await life(store, TIP);
  // The window of a store filled only to 30,250, given with this store's record at 30,300.
  const short = memoryStore();
  await life(short, MID);
  const other = (await short.headerWindow())!;
  const x = await life(edited(store, () => other), TIP);
  ok("a window that does not hold the cursor's block (another store's, to 30,250): the walk, verified as a fresh replica", walked(x) && same(x), `${codes(x.s)} ${x.heads.join(" ")}`);
}

done("cairnx-replica hosted window");
