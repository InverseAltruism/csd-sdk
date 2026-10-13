// Record primitives for a chunked header store: deserializeHeader over real headers, verifyLinkedRecords
// (refusals and the honest chunk shapes), fromRecords against fromSnapshot, toRecords, and the
// per-call MessageChannel. Offline, on the committed mainnet fixtures.
import { LightClient, verifyLinkedRecords, type LinkedRecordsEnds } from "../src/index.js";
import { LWMA_WINDOW, HEADER_BYTES, serializeHeader, deserializeHeader, headerHash, type BlockHeader } from "@inversealtruism/csd-codec";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type Fx = { from: number; tip: number; headers: { height: number; hash: string; header: BlockHeader }[] };
const load = (f: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), "utf8")) as Fx;
const FX = load("fixtures-headers.json");
const GFX = load("fixtures-genesis.json");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n); } };
const errOf = (f: () => unknown) => { try { f(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const hashAt = (h: number) => FX.headers[h - FX.from]!.hash;
const pack = (hs: BlockHeader[]) => { const out = new Uint8Array(hs.length * HEADER_BYTES); hs.forEach((h, i) => out.set(serializeHeader(h), i * HEADER_BYTES)); return out; };
const ALL = pack(FX.headers.map((h) => h.header));
const slice = (from: number, to: number) => ALL.slice((from - FX.from) * HEADER_BYTES, (to - FX.from + 1) * HEADER_BYTES);
const CP = FX.from + LWMA_WINDOW - 1;
const CHECKPOINTS = { [CP]: hashAt(CP), [FX.tip]: hashAt(FX.tip) };
const mcPorts = () => process.getActiveResourcesInfo().filter((r) => r === "MessagePort").length;
const nextTask = () => new Promise((r) => setTimeout(r, 0));
const sameChain = (a: LightClient, b: LightClient) => a.baseHeight === b.baseHeight && a.chain.length === b.chain.length &&
  a.chain.every((v, i) => { const w = b.chain[i]!; return v.height === w.height && v.hash === w.hash && v.chainwork === w.chainwork && !!v.trusted === !!w.trusted; });

console.log("- deserializeHeader over every fixture header -");
{
  const all = [...FX.headers, ...GFX.headers];
  const bad = all.filter((h) => { const r = serializeHeader(h.header); const d = deserializeHeader(r); return headerHash(d) !== h.hash || serializeHeader(d).some((b, i) => b !== r[i]); });
  ok(`serializeHeader(deserializeHeader(r)) == r and the hash holds for all ${all.length} fixture headers`, bad.length === 0 && all.length === 182);
}

console.log("- verifyLinkedRecords -");
{
  const v = (records: Uint8Array, ends: LinkedRecordsEnds) => errOf(() => verifyLinkedRecords(records, ends));
  // The two production shapes: the floor chunk binds its first record's hash, every later chunk binds the anchor below it.
  ok("honest: a run bound by firstHash and lastHash verifies", v(ALL, { firstHeight: FX.from, firstHash: hashAt(FX.from), lastHash: hashAt(FX.tip) }) === "");
  ok("honest: a run bound by prevHash and lastHash verifies", v(slice(FX.from + 1, FX.tip), { firstHeight: FX.from + 1, prevHash: hashAt(FX.from), lastHash: hashAt(FX.tip) }) === "");
  ok("honest: all three bounds given verifies", v(slice(FX.from + 1, FX.tip), { firstHeight: FX.from + 1, firstHash: hashAt(FX.from + 1), prevHash: hashAt(FX.from), lastHash: hashAt(FX.tip) }) === "");
  const ends = { firstHeight: FX.from, firstHash: hashAt(FX.from), lastHash: hashAt(FX.tip) };
  const flip = (at: number) => { const r = ALL.slice(); r[at] ^= 0x01; return r; };
  ok("a flipped merkle byte in a middle record is refused at the next height", /prev link broken at 27592/.test(v(flip(50 * HEADER_BYTES + 40), ends)));
  ok("a flipped prev byte is refused at that height", /prev link broken at 27571/.test(v(flip(30 * HEADER_BYTES + 4), ends)));
  ok("a flipped byte in the last record is refused on lastHash", /last record at 27671/.test(v(flip(ALL.length - 1), ends)));
  ok("a wrong end hash is refused", /does not match lastHash/.test(v(ALL, { ...ends, lastHash: hashAt(FX.tip - 1) })));
  ok("a wrong first hash is refused", /does not match firstHash/.test(v(ALL, { ...ends, firstHash: hashAt(FX.from + 1) })));
  ok("a wrong prevHash is refused at the first height", /prev link broken at 27542/.test(v(slice(FX.from + 1, FX.tip), { firstHeight: FX.from + 1, prevHash: hashAt(FX.from + 1), lastHash: hashAt(FX.tip) })));
  const gap = new Uint8Array([...slice(FX.from, FX.from + 59), ...slice(FX.from + 61, FX.tip)]);
  ok("a non-contiguous batch (one record missing) is refused", /prev link broken at 27601/.test(v(gap, ends)));
  ok("a batch missing its first record is refused on firstHash", /does not match firstHash/.test(v(slice(FX.from + 1, FX.tip), ends)));
  const lastEnds = { firstHeight: FX.from + 1, prevHash: hashAt(FX.from), lastHash: hashAt(FX.tip) };
  ok("honest: a run whose count matches lastHeight verifies", v(slice(FX.from + 1, FX.tip), { ...lastEnds, lastHeight: FX.tip }) === "");
  ok("a run whose count disagrees with lastHeight is refused", /do not end at lastHeight 27670/.test(v(slice(FX.from + 1, FX.tip), { ...lastEnds, lastHeight: FX.tip - 1 })));
  ok("without lastHeight the count is not checked", v(slice(FX.from + 1, FX.tip), lastEnds) === "");
  ok("a batch with neither firstHash nor prevHash is refused", /firstHash or prevHash/.test(v(slice(FX.from + 1, FX.tip), { firstHeight: FX.from, lastHash: hashAt(FX.tip) })));
  ok("a partial record is refused", /whole number/.test(v(ALL.subarray(0, ALL.length - 1), ends)));
  ok("an empty batch is refused", /whole number/.test(v(new Uint8Array(0), ends)));
}

// The honest chain fromSnapshot restores: a 45-header seed at CP, synced forward to the tip.
const byH = new Map(FX.headers.map((h) => [h.height, h]));
const honest = new LightClient({ headerProvider: async (h) => { const r = byH.get(h)!; return { header: r.header, hash: r.hash, txids: [] }; } });
honest.seedTrusted(FX.headers.slice(0, LWMA_WINDOW).map((h) => ({ height: h.height, header: h.header })), hashAt(CP));
await honest.sync(FX.tip);
const fromSnap = LightClient.fromSnapshot(honest.toSnapshot(), { checkpoints: CHECKPOINTS });

console.log("- fromRecords -");
{
  const ports0 = mcPorts();
  const r = await LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS });
  ok("fromRecords equals fromSnapshot on the fixture (heights, hashes, chainwork, trusted seed)", !r.failed && sameChain(r.client, fromSnap) && r.client.tip!.height === FX.tip);
  await nextTask();
  ok("the MessageChannel is closed after a completed restore", mcPorts() === ports0);

  const t = await LightClient.fromRecords(new Uint8Array([...slice(FX.from, CP + 9), ...pack([{ ...byH.get(CP + 10)!.header, nonce: 1 }]), ...slice(CP + 11, FX.tip)]),
    { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS });
  ok("a bad suffix record stops the restore there and keeps the verified records below it",
    t.failed?.height === CP + 10 && /PoW/.test(t.failed.reason) && t.client.tip!.height === CP + 9 && t.client.tip!.hash === hashAt(CP + 9));
  await nextTask();
  ok("the MessageChannel is closed after a stopped restore", mcPorts() === ports0);

  const pinned = await LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: { ...CHECKPOINTS, [CP + 20]: hashAt(CP + 21) } });
  ok("a checkpoint above the anchor still applies on restore", pinned.failed?.height === CP + 20 && /checkpoint mismatch/.test(pinned.failed.reason));

  const thrown = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };
  ok("no checkpoint at the anchor is refused", /no checkpoint configured at anchor/.test(await thrown(() => LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: { [FX.tip]: hashAt(FX.tip) } }))));
  ok("a wrong checkpoint at the anchor is refused", /checkpoint/.test(await thrown(() => LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: { [CP]: hashAt(CP - 1) } }))));
  const seedFlip = ALL.slice(); seedFlip[10 * HEADER_BYTES + 40] ^= 0x01;
  ok("a tampered seed record is refused", /seed/.test(await thrown(() => LightClient.fromRecords(seedFlip, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS }))));
  ok("a seed longer than LWMA_WINDOW + 1 is refused", /must be 45 or 46/.test(await thrown(() => LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP + 2 }, { checkpoints: { [CP + 2]: hashAt(CP + 2) } }))));
  ok("a seed shorter than LWMA_WINDOW is refused up front", /must be 45 or 46/.test(await thrown(() => LightClient.fromRecords(ALL, { firstHeight: FX.from + 1, anchorHeight: CP }, { checkpoints: CHECKPOINTS }))));
  const seed46 = await LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP + 1 }, { checkpoints: { [CP + 1]: hashAt(CP + 1) } });
  ok("honest: a 46-record seed restores to the tip", !seed46.failed && seed46.client.tip!.hash === hashAt(FX.tip) && seed46.client.chain.length === FX.tip - FX.from + 1);
  ok("a yieldEvery of 0 is refused", /yieldEvery/.test(await thrown(() => LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS }, 0))));
  await nextTask();
  ok("a refused restore opens no MessageChannel", mcPorts() === ports0);

  const [a, b] = await Promise.race([
    Promise.all([1, 3].map((every) => LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS }, every))),
    new Promise<never[]>((r) => setTimeout(() => r([]), 5000)),
  ]);
  ok("two concurrent restores that yield both complete", !!a && !!b && sameChain(a.client, fromSnap) && sameChain(b.client, fromSnap));

  // Node drains a port's queue in one wakeup, so the task interleaving the yield buys in Chrome is not
  // observable here; the spy pins the mechanism instead: one channel per call, one posted task per turn.
  const Real = globalThis.MessageChannel;
  let made = 0, posts = 0;
  globalThis.MessageChannel = class extends Real {
    constructor() { super(); made++; const post = this.port2.postMessage.bind(this.port2); this.port2.postMessage = (m: unknown) => { posts++; post(m); }; }
  };
  try {
    await LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS }, 8);
    await LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS }, 8);
  } finally {
    globalThis.MessageChannel = Real;
  }
  ok("each restore opens its own MessageChannel and posts one task per 8 ingested records", made === 2 && posts === 2 * Math.floor((FX.tip - CP) / 8));
}

console.log("- fromRecords keeps the wall-clock drift bound -");
{
  const realNow = Date.now;
  const tipTime = Number(byH.get(FX.tip)!.header.time);
  const nowSecs = tipTime - 3 * 3600; // the clock is 3 h behind the stored tip
  const firstAhead = FX.headers.find((h) => h.height > CP && Number(h.header.time) > nowSecs + 2 * 3600)!.height;
  const snap = honest.toSnapshot();
  Date.now = () => nowSecs * 1000;
  try {
    const r = await LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS });
    ok("with the clock 3 h back the restore stops at the first record above now + 2 h and keeps the prefix",
      firstAhead < FX.tip && r.failed?.height === firstAhead && /future/.test(r.failed.reason) && r.client.tip!.height === firstAhead - 1 && r.client.tip!.hash === hashAt(firstAhead - 1));
    ok("with the clock 3 h back fromSnapshot refuses the honest snapshot", /future/.test(errOf(() => LightClient.fromSnapshot(snap, { checkpoints: CHECKPOINTS }))));
  } finally {
    Date.now = realNow;
  }
  const r = await LightClient.fromRecords(ALL, { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS });
  ok("honest: with a correct clock the same records restore intact", !r.failed && sameChain(r.client, fromSnap));
  const early = { ...byH.get(CP + 5)!.header, time: Number(byH.get(CP + 4)!.header.time) + 1 };
  const e = await LightClient.fromRecords(new Uint8Array([...slice(FX.from, CP + 4), ...pack([early])]), { firstHeight: FX.from, anchorHeight: CP }, { checkpoints: CHECKPOINTS });
  ok("the deterministic time rules still apply on restore", e.failed?.height === CP + 5 && /time too early/.test(e.failed.reason));
}

console.log("- toRecords -");
{
  const eqBytes = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((b, i) => b === y[i]);
  ok("toRecords(base) is the fixture's bytes", eqBytes(honest.toRecords(FX.from), ALL));
  ok("toRecords(h) starts at h", eqBytes(honest.toRecords(CP + 1), slice(CP + 1, FX.tip)));
  ok("toRecords(tip) is the tip record", eqBytes(honest.toRecords(FX.tip), slice(FX.tip, FX.tip)));
  ok("toRecords above the tip is empty", honest.toRecords(FX.tip + 1).length === 0);
  ok("toRecords below the base is refused", /below the held base/.test(errOf(() => honest.toRecords(FX.from - 1))));
  const back = await LightClient.fromRecords(honest.toRecords(honest.baseHeight), { firstHeight: honest.baseHeight, anchorHeight: CP }, { checkpoints: CHECKPOINTS });
  ok("fromRecords(toRecords(base)) rebuilds the same chain", !back.failed && sameChain(back.client, honest));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
