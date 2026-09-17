// LWMA bits->target MEMO identity — pins the memoized expectedBitsFromWindow (src/lwma.ts
// bitsToTargetBigInt) against an INDEPENDENT unmemoized reference reimplementation built here
// straight from the raw codec primitives (the pre-memo algorithm, verbatim). The memo is a pure
// perf cache and must be BYTE-IDENTICAL in every observable way: same bits out, same throws on
// invalid encodings, cold cache == warm cache == post-eviction cache. Real fixture headers are
// used so the identity holds on genuine mainnet windows (131 headers, 131 DISTINCT bits values:
// this chain retargets every block, so the memo's win is the 45x re-conversion of each header
// across sliding windows, not cross-header repetition).
import { expectedBitsFromWindow, powOkMemo, workForBitsMemo } from "../src/index.js";
import {
  type BlockHeader, bitsToTarget, targetToBigInt, bigIntToTarget, targetToBits,
  INITIAL_BITS, POW_LIMIT_BITS, LWMA_WINDOW, LWMA_SOLVETIME_MAX_FACTOR, TARGET_BLOCK_SECS,
  powOk, workForBits, headerHashBytes, hx, MAX_U128,
} from "@inversealtruism/csd-codec";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures-headers.json"), "utf8")) as {
  from: number; tip: number;
  headers: { height: number; hash: string; header: BlockHeader; txids: string[] }[];
};
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n); } };

// ── the UNMEMOIZED reference: the pre-memo expectedBitsFromWindow body, from raw codec calls ──
const REF_POW_LIMIT_TARGET = targetToBigInt(bitsToTarget(POW_LIMIT_BITS));
function refExpectedBits(window: BlockHeader[], height: number): number {
  if (height === 0) return INITIAL_BITS;
  const parent = window[window.length - 1];
  if (!parent) throw new Error(`expectedBits: empty window for height ${height}`);
  if (height < 2) return parent.bits;
  const n = Math.min(LWMA_WINDOW, height, window.length);
  if (n < 2) return parent.bits;
  const w = window.slice(window.length - n);
  const times: bigint[] = [];
  const targets: bigint[] = [];
  for (const h of w) {
    const tb = bitsToTarget(h.bits);
    if (tb.every((b) => b === 0)) throw new Error("expectedBits: invalid compact bits in window");
    times.push(BigInt(h.time));
    targets.push(targetToBigInt(tb));
  }
  if (times.length < 2) return parent.bits;
  const m = times.length;
  const t = BigInt(Math.max(TARGET_BLOCK_SECS, 1));
  const maxSolve = BigInt(Math.max(LWMA_SOLVETIME_MAX_FACTOR, 1) * Math.max(TARGET_BLOCK_SECS, 1));
  let weightedSum = 0n, denom = 0n;
  for (let i = 1; i < m; i++) {
    let dt = times[i]! - times[i - 1]!;
    if (dt < 0n) dt = 0n;
    const st = dt < 1n ? 1n : dt > maxSolve ? maxSolve : dt;
    const ww = BigInt(i);
    weightedSum += st * ww;
    denom += ww;
  }
  if (denom === 0n) return parent.bits;
  const avgSolvetime = weightedSum / denom;
  let sumTarget = 0n;
  for (const tg of targets) sumTarget += tg;
  const avgTarget = sumTarget / BigInt(m);
  let nextTarget = (avgTarget * avgSolvetime) / t;
  if (nextTarget > REF_POW_LIMIT_TARGET) nextTarget = REF_POW_LIMIT_TARGET;
  if (nextTarget === 0n || nextTarget >= 1n << 256n) return POW_LIMIT_BITS;
  const bits = targetToBits(bigIntToTarget(nextTarget));
  if (targetToBigInt(bitsToTarget(bits)) > REF_POW_LIMIT_TARGET) return POW_LIMIT_BITS;
  return bits;
}

// both impls, same inputs: identical bits OR identical throw
function agree(window: BlockHeader[], height: number): boolean {
  let a: number | "THROW", b: number | "THROW";
  try { a = expectedBitsFromWindow(window, height); } catch { a = "THROW"; }
  try { b = refExpectedBits(window, height); } catch { b = "THROW"; }
  return a === b;
}

const headers = FX.headers.map((h) => h.header);
const heightOf = (i: number) => FX.headers[i]!.height;

console.log("— lwma memo identity (memoized impl vs raw-codec reference) —");

// 1) every real FULL LWMA sliding window, TWICE (cold cache pass, then warm cache pass). MF-17 makes
//    expectedBitsFromWindow reject a window shorter than n = min(LWMA_WINDOW, height), and this
//    checkpoint fixture starts at height 27541 (n is always 45), so a genuine window here is always
//    45 headers; feeding it full exercises the conversion memo without tripping the short-window guard
//    (that guard itself is covered by the MF-17 case in light-offline.test.ts). For a full window
//    refExpectedBits' n = min(LWMA_WINDOW, height, window.length) collapses to min(LWMA_WINDOW, height),
//    so the independent reference stays a faithful mirror with no edit.
for (const label of ["cold", "warm"]) {
  let all = true;
  let checked = 0;
  for (let i = LWMA_WINDOW; i < headers.length; i++) {
    const window = headers.slice(i - LWMA_WINDOW, i);
    if (!agree(window, heightOf(i))) { all = false; break; }
    checked++;
  }
  ok(`all ${checked} real fixture windows identical to the unmemoized reference (${label} cache)`, all && checked > 80);
}

// 2) edge encodings inside a window: both impls must agree (same bits or same throw), warm cache
{
  const mk = (bits: number, time: number): BlockHeader =>
    ({ ...headers[0]!, bits: bits >>> 0, time });
  const EDGE_BITS = [
    0x00000000,        // exp 0 -> invalid (all-zero target)
    0x00ffffff,        // exp 0, mant set -> invalid
    0x1c000000,        // mant 0 -> invalid
    0x03800000,        // sign-bit mantissa 0x00800000 -> invalid
    0x21ffffff,        // exp 33 > 32 -> invalid
    0x207fffff,        // exp 32, max legal mantissa (huge but valid target)
    0x01000001,        // tiny: exp 1 -> mant >> 16 (rounds to 0 -> invalid)
    0x03000001,        // smallest nonzero canonical-ish target
    POW_LIMIT_BITS,
    INITIAL_BITS,
  ];
  let all = true;
  for (const eb of EDGE_BITS) {
    // the edge bits as a mid-window member (conversion path) with valid neighbors. Call at height ==
    // window.length so n = min(LWMA_WINDOW, height) == the window length: the window is FULL, the
    // conversion memo is genuinely exercised, and MF-17's short-window guard stays out of the way.
    const window = [mk(INITIAL_BITS, 1000), mk(eb, 1120), mk(INITIAL_BITS, 1240)];
    if (!agree(window, window.length)) { all = false; console.log(`    mismatch at bits 0x${eb.toString(16)}`); }
  }
  ok(`edge compact encodings agree with the reference (incl. throw-for-throw on invalid)`, all);

  // invalid bits still throw AFTER the cache is fully warm (the 0n-cached path). Height 2 keeps the
  // 2-header window FULL (n = min(LWMA_WINDOW, 2) = 2), so the throw is the INVALID-BITS throw we mean
  // to pin, not the MF-17 short-window guard.
  const bad = [mk(INITIAL_BITS, 1000), mk(0x03800000, 1120)];
  let threw1 = false, threw2 = false;
  try { expectedBitsFromWindow(bad, 2); } catch { threw1 = true; }
  try { expectedBitsFromWindow(bad, 2); } catch { threw2 = true; }
  ok("invalid bits throw on first sight AND on the cached-0n second sight", threw1 && threw2);
}

// 3) cap eviction: stuff >4096 distinct valid bits through the memo, then confirm earlier
//    windows still produce byte-identical results (a clear must only cost speed, never bytes)
{
  const mk = (bits: number, time: number): BlockHeader => ({ ...headers[0]!, bits: bits >>> 0, time });
  const probeWindow = headers.slice(0, LWMA_WINDOW);
  const probeHeight = heightOf(LWMA_WINDOW);
  const before = expectedBitsFromWindow(probeWindow, probeHeight);
  for (let i = 0; i < 5000; i++) {
    // exp 0x1c, mantissa walks 0x010000..: every value valid, every value distinct. Height 2 keeps the
    // 2-header probe window FULL (n = min(LWMA_WINDOW, 2) = 2) so the conversion runs without tripping
    // MF-17's short-window guard; the return value is unused (this only forces memo insertions/eviction).
    const bits = (0x1c << 24) | (0x010000 + i);
    expectedBitsFromWindow([mk(bits, 1000), mk(bits, 1120)], 2);
  }
  const after = expectedBitsFromWindow(probeWindow, probeHeight);
  ok("results identical across a forced cap eviction (5000 distinct bits > 4096 cap)", before === after && after === refExpectedBits(probeWindow, probeHeight));
}

// ── powOkMemo / workForBitsMemo: observationally identical to the raw codec, cold/warm/post-eviction ──
// These fail if the memos are skipped (import) or if a cached target/work diverges from powOk/workForBits.
console.log("— powOkMemo / workForBitsMemo identity (memo vs raw codec) —");

const BEYOND_LIMIT_BITS = 0x1f00ffff; // node's easier-than-limit encoding (codec NEW-1)
const CLAMP_BITS = 0x10000001;        // extreme low target → u128 clamp in workForBits
const POW_EDGE_BITS = [
  0x00000000, 0x00ffffff, 0x1c000000, 0x03800000, 0x21ffffff, 0x207fffff,
  0x01000001, 0x03000001, POW_LIMIT_BITS, INITIAL_BITS, BEYOND_LIMIT_BITS, CLAMP_BITS,
];
const HASH_CASES: Uint8Array[] = [
  new Uint8Array(32),
  new Uint8Array(32).fill(0xff),
  new Uint8Array(32).fill(0x80),
  bitsToTarget(POW_LIMIT_BITS),
];

{
  let hashesMatch = true;
  let powMatch = true;
  let workMatch = true;
  for (const row of FX.headers) {
    const hashBytes = headerHashBytes(row.header);
    if (hx(hashBytes).toLowerCase() !== row.hash.toLowerCase()) hashesMatch = false;
    if (powOkMemo(hashBytes, row.header.bits) !== powOk(hashBytes, row.header.bits)) powMatch = false;
    if (workForBitsMemo(row.header.bits) !== workForBits(row.header.bits)) workMatch = false;
  }
  ok("hx(headerHashBytes(h)) matches every fixture hash (hash-once identity)", hashesMatch);
  ok("powOkMemo == codec powOk on every fixture header (cold+warm over the run)", powMatch);
  ok("workForBitsMemo == codec workForBits on every fixture bits", workMatch);
}

{
  let powMatch = true;
  let workMatch = true;
  for (const label of ["cold", "warm"]) {
    for (const bits of POW_EDGE_BITS) {
      for (const hash of HASH_CASES) {
        if (powOkMemo(hash, bits) !== powOk(hash, bits)) {
          powMatch = false;
          console.log(`    pow mismatch ${label} bits=0x${(bits >>> 0).toString(16)}`);
        }
      }
      if (workForBitsMemo(bits) !== workForBits(bits)) {
        workMatch = false;
        console.log(`    work mismatch ${label} bits=0x${(bits >>> 0).toString(16)}`);
      }
    }
  }
  ok("powOkMemo == codec powOk on edge bits × probe hashes (cold and warm)", powMatch);
  ok("workForBitsMemo == codec workForBits on edge bits (invalid, limit, beyond-limit, clamp)", workMatch);
  ok("workForBitsMemo clamps extreme low-target to MAX_U128 like the codec", workForBitsMemo(CLAMP_BITS) === MAX_U128 && workForBits(CLAMP_BITS) === MAX_U128);
  ok("workForBitsMemo yields 0n for easier-than-limit bits (NEW-1)", workForBitsMemo(BEYOND_LIMIT_BITS) === 0n);
  ok("powOkMemo rejects easier-than-limit bits even for the all-zero hash (NEW-1)", powOkMemo(new Uint8Array(32), BEYOND_LIMIT_BITS) === false);
}

{
  const probeBits = FX.headers[0]!.header.bits;
  const probeHash = headerHashBytes(FX.headers[0]!.header);
  const powBefore = powOkMemo(probeHash, probeBits);
  const workBefore = workForBitsMemo(probeBits);
  for (let i = 0; i < 5000; i++) {
    const bits = (0x1c << 24) | (0x010000 + i);
    workForBitsMemo(bits);
    powOkMemo(new Uint8Array(32), bits);
  }
  ok("powOkMemo identical across a forced cap eviction", powOkMemo(probeHash, probeBits) === powBefore && powBefore === powOk(probeHash, probeBits));
  ok("workForBitsMemo identical across a forced cap eviction", workForBitsMemo(probeBits) === workBefore && workBefore === workForBits(probeBits));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
