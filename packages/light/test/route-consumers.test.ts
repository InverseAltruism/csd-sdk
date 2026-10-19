// contenderPlausible against the two decisions it replaces, over fractional config values. A test here does not read
// the consumers' trees, so each decision is transcribed below from the cited commit as the reference:
//   csd-indexer f512c29 src/rpc.ts:78-124 (contenderPlausible), its config from src/config.ts:78, 87, 95, 119
//   cairn 3660c74 src/lib/rpcroute.ts:78-123 (contenderPlausible)
// The SDK must equal the indexer on every input, and equal cairn when cairn's adapter floors blockSecs and maxAhead.
import { bigIntToTarget, bitsToTarget, POW_LIMIT_BITS, targetToBigInt, targetToBits } from "@inversealtruism/csd-codec";
import { contenderPlausible, type ContenderPlausibleOpts } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n + (detail ? `\n      ${detail}` : "")); } };
const target = (bits: number) => targetToBigInt(bitsToTarget(bits));
const POW_LIMIT = target(POW_LIMIT_BITS);

/** csd-indexer: env values go through `num` (finite and > 0, else the default), blockSecs through Math.max(1, ...). */
function indexerRef(o: ContenderPlausibleOpts): boolean {
  const num = (v: number, d: number) => (Number.isFinite(v) && v > 0 ? v : d);
  const maxAheadBlocks = num(o.maxAhead, 128), maxEaseFactor = num(o.maxEase, 16);
  const routeBlockSecs = Math.max(1, num(o.blockSecs, 120)), scanFrom = num(o.anchorFloor ?? 0, 0);
  if (!o.enabled) return true;
  const lh = Number(o.localHeight);
  if (!Number.isFinite(lh) || lh < scanFrom) return true;
  const claimed = Number(o.claimedHeight);
  if (!Number.isFinite(claimed)) return false;
  const ltTime = Number(o.localTime);
  const staleBlocks = Number.isFinite(ltTime) ? Math.max(0, Math.floor((o.nowSecs - ltTime) / routeBlockSecs)) : 0;
  if (claimed > lh + maxAheadBlocks + staleBlocks) return false;
  const cbits = Number(o.contenderBits);
  if (!Number.isFinite(cbits)) return false;
  const contenderTarget = target(cbits);
  if (contenderTarget <= 0n) return false;
  const t = o.expectedLocalBits == null ? 0n : target(o.expectedLocalBits);
  if (t <= 0n) return true;
  let threshold = t * BigInt(Math.max(1, Math.floor(maxEaseFactor)));
  if (threshold > POW_LIMIT) threshold = POW_LIMIT;
  return contenderTarget <= threshold;
}

/** cairn: the pure function as written (it floors blockSecs, maxAhead and maxEase itself). */
function cairnRef(o: ContenderPlausibleOpts): boolean {
  if (!o.enabled) return true;
  const lh = Number(o.localHeight);
  if (!Number.isFinite(lh) || lh < 0) return true;
  const claimed = Number(o.claimedHeight);
  if (!Number.isFinite(claimed)) return false;
  const bs = Math.max(1, Math.floor(Number(o.blockSecs) || 120));
  const staleBlocks = (Number.isFinite(o.localTime) && Number.isFinite(o.nowSecs))
    ? Math.max(0, Math.floor((Number(o.nowSecs) - Number(o.localTime)) / bs)) : 0;
  if (claimed > lh + Math.max(0, Math.floor(o.maxAhead)) + staleBlocks) return false;
  const cbits = Number(o.contenderBits);
  if (!Number.isFinite(cbits)) return false;
  const contenderTarget = target(cbits);
  if (contenderTarget <= 0n) return false;
  if (o.expectedLocalBits == null) return true;
  const expected = target(Number(o.expectedLocalBits));
  if (expected <= 0n) return true;
  let threshold = expected * BigInt(Math.max(1, Math.floor(o.maxEase)));
  if (threshold > POW_LIMIT) threshold = POW_LIMIT;
  return contenderTarget <= threshold;
}
const cairnAdapter = (o: ContenderPlausibleOpts): ContenderPlausibleOpts =>
  ({ ...o, blockSecs: Math.max(1, Math.floor(o.blockSecs)), maxAhead: Math.floor(o.maxAhead) });

console.log("contenderPlausible vs the consumers' decisions, fractional config:");
const repro: ContenderPlausibleOpts = {
  enabled: true, localHeight: 32803, claimedHeight: 32933, localTime: 1799999760, nowSecs: 1800000000, blockSecs: 120.5,
  maxAhead: 128, maxEase: 16, contenderBits: 454356570, expectedLocalBits: 454356570,
};
ok("review repro (blockSecs 120.5, 240 s stale): the indexer grants one stale block, so the claim fails, as here",
  indexerRef(repro) === false && contenderPlausible(repro) === false && cairnRef(repro) === true);

const REAL = 454356570;
const HARDER = targetToBits(bigIntToTarget(target(REAL) / 256n));
const EASIER2 = targetToBits(bigIntToTarget(target(REAL) * 2n));
const L = 32803, NOW = 1_800_000_000;
let n = 0, idxDiff = 0, cairnDiff = 0;
const firstIdx: string[] = [], firstCairn: string[] = [];
for (const blockSecs of [0.5, 1, 1.5, 60.25, 119.9, 120, 120.5, 121.7, 3600.5])
  for (const maxAhead of [0.5, 1, 127.5, 128, 128.5, 200.9])
    for (const maxEase of [0.5, 1, 1.5, 15.9, 16, 16.5])
      for (const stale of [0, 240, 241, 3600, 24_000])
        for (const off of [0, 1, 127, 128, 128.5, 129, 130, 150, 200, 328, 329, 400])
          for (const contenderBits of [REAL, HARDER, EASIER2, POW_LIMIT_BITS])
            for (const expectedLocalBits of [REAL, null]) {
              const o: ContenderPlausibleOpts = { enabled: true, localHeight: L, claimedHeight: L + off, localTime: NOW - stale, nowSecs: NOW,
                blockSecs, maxAhead, maxEase, contenderBits, expectedLocalBits };
              n++;
              const sdk = contenderPlausible(o);
              if (sdk !== indexerRef(o)) { idxDiff++; if (firstIdx.length < 3) firstIdx.push(JSON.stringify(o)); }
              if (contenderPlausible(cairnAdapter(o)) !== cairnRef(o)) { cairnDiff++; if (firstCairn.length < 3) firstCairn.push(JSON.stringify(o)); }
            }
ok(`equals the indexer on every fractional input (${n} cases, ${idxDiff} differ)`, idxDiff === 0, firstIdx.join("\n      "));
ok(`equals cairn through its flooring adapter (${n} cases, ${cairnDiff} differ)`, cairnDiff === 0, firstCairn.join("\n      "));
ok("the grid reaches both verdicts and the stale allowance", (() => {
  const v = [contenderPlausible({ ...repro, blockSecs: 120 }), contenderPlausible(repro), contenderPlausible({ ...repro, claimedHeight: 32803 + 128 })];
  return v[0] === true && v[1] === false && v[2] === true;
})());

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
