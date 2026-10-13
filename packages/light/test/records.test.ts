// Record primitives for a chunked header store: deserializeHeader over real headers and verifyLinkedRecords
// (refusals and the honest chunk shapes). Offline, on the committed mainnet fixtures.
import { verifyLinkedRecords, type LinkedRecordsEnds } from "../src/index.js";
import { HEADER_BYTES, serializeHeader, deserializeHeader, headerHash, type BlockHeader } from "@inversealtruism/csd-codec";
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
  ok("a batch with neither firstHash nor prevHash is refused", /firstHash or prevHash/.test(v(slice(FX.from + 1, FX.tip), { firstHeight: FX.from, lastHash: hashAt(FX.tip) })));
  ok("a partial record is refused", /whole number/.test(v(ALL.subarray(0, ALL.length - 1), ends)));
  ok("an empty batch is refused", /whole number/.test(v(new Uint8Array(0), ends)));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
