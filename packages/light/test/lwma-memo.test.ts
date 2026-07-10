// LWMA bits->target MEMO identity — pins the memoized expectedBitsFromWindow (src/lwma.ts
// bitsToTargetBigInt) against an INDEPENDENT unmemoized reference reimplementation built here
// straight from the raw codec primitives (the pre-memo algorithm, verbatim). The memo is a pure
// perf cache and must be BYTE-IDENTICAL in every observable way: same bits out, same throws on
// invalid encodings, cold cache == warm cache == post-eviction cache. Real fixture headers are
// used so the identity holds on genuine mainnet windows (131 headers, 131 DISTINCT bits values:
// this chain retargets every block, so the memo's win is the 45x re-conversion of each header
// across sliding windows, not cross-header repetition).
import { expectedBitsFromWindow } from "../src/index.js";
import {
  type BlockHeader, bitsToTarget, targetToBigInt, bigIntToTarget, targetToBits,
  INITIAL_BITS, POW_LIMIT_BITS, LWMA_WINDOW, LWMA_SOLVETIME_MAX_FACTOR, TARGET_BLOCK_SECS,
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

// 1) every real fixture window, TWICE (cold cache pass, then warm cache pass)
for (const label of ["cold", "warm"]) {
  let all = true;
  let checked = 0;
  for (let i = 2; i < headers.length; i++) {
    const n = Math.min(LWMA_WINDOW, heightOf(i), i);
    const window = headers.slice(i - n, i);
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
    // the edge bits as a mid-window member (conversion path) with valid neighbors
    const window = [mk(INITIAL_BITS, 1000), mk(eb, 1120), mk(INITIAL_BITS, 1240)];
    if (!agree(window, 1000)) { all = false; console.log(`    mismatch at bits 0x${eb.toString(16)}`); }
  }
  ok(`edge compact encodings agree with the reference (incl. throw-for-throw on invalid)`, all);

  // invalid bits still throw AFTER the cache is fully warm (the 0n-cached path)
  const bad = [mk(INITIAL_BITS, 1000), mk(0x03800000, 1120)];
  let threw1 = false, threw2 = false;
  try { expectedBitsFromWindow(bad, 1000); } catch { threw1 = true; }
  try { expectedBitsFromWindow(bad, 1000); } catch { threw2 = true; }
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
    // exp 0x1c, mantissa walks 0x010000..: every value valid, every value distinct
    const bits = (0x1c << 24) | (0x010000 + i);
    expectedBitsFromWindow([mk(bits, 1000), mk(bits, 1120)], 1000);
  }
  const after = expectedBitsFromWindow(probeWindow, probeHeight);
  ok("results identical across a forced cap eviction (5000 distinct bits > 4096 cap)", before === after && after === refExpectedBits(probeWindow, probeHeight));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
