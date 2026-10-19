// tipHeaderPowOk and contenderPlausible: the two checks a service runs before a non-primary RPC backend may win
// routing. Real mainnet headers: csd-vectors LIVE_BLOCKS and this package's fixtures-headers.json. Offline.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bigIntToTarget, bitsToTarget, headerHash, LWMA_WINDOW, POW_LIMIT_BITS, targetToBigInt, targetToBits, type BlockHeader } from "@inversealtruism/csd-codec";
import { LIVE_BLOCKS } from "@inversealtruism/csd-vectors";
import { contenderPlausible, expectedBitsFromWindow, tipHeaderPowOk, type ContenderPlausibleOpts } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n); } };

const live = LIVE_BLOCKS[1]!;
const header = live.header;

console.log("tipHeaderPowOk:");
ok("a real mainnet header bound to its own hash passes", tipHeaderPowOk(header, live.hash) === true);
ok("the claimed hash compares case-insensitively", tipHeaderPowOk(header, "0x" + live.hash.slice(2).toUpperCase()) === true);
const bumped = { ...header, nonce: header.nonce + 1 };
ok("a nonce-bumped header claimed under its own hash fails on PoW alone", headerHash(bumped) !== live.hash && tipHeaderPowOk(bumped, headerHash(bumped)) === false);
ok("a valid header under a different claimed tip hash fails (hash binding)", tipHeaderPowOk(header, "0x" + "00".repeat(32)) === false);
ok("a header served for another block fails", tipHeaderPowOk(LIVE_BLOCKS[0]!.header, live.hash) === false);
ok("no claimed tip hash, or one that is not 32 bytes of hex, fails",
  tipHeaderPowOk(header, null) === false && tipHeaderPowOk(header, "0xdead") === false && tipHeaderPowOk(header, live.hash.slice(2)) === false);
ok("null, empty and non-object headers fail",
  tipHeaderPowOk(null, live.hash) === false && tipHeaderPowOk({}, live.hash) === false && tipHeaderPowOk("x", live.hash) === false);
ok("bits 0 or non-numeric bits fail",
  tipHeaderPowOk({ ...header, bits: 0 }, live.hash) === false && tipHeaderPowOk({ ...header, bits: "453072620" }, live.hash) === false);
ok("a header the codec cannot serialize fails instead of throwing", tipHeaderPowOk({ ...header, prev: "0xzz" }, live.hash) === false);
const GFX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures-genesis.json"), "utf8")) as {
  headers: { height: number; hash: string; header: BlockHeader }[];
};
const minDiff = GFX.headers[1]!;
ok("a real header at POW_LIMIT bits passes: PoW alone does not bound difficulty, contenderPlausible does",
  minDiff.header.bits === POW_LIMIT_BITS && tipHeaderPowOk(minDiff.header, minDiff.hash) === true);

console.log("contenderPlausible:");
const REAL_BITS = header.bits;
const HARDER_BITS = targetToBits(bigIntToTarget(targetToBigInt(bitsToTarget(REAL_BITS)) / 256n));
const NOW = 1_800_000_000;
const LOCAL = 32_803;
const base: ContenderPlausibleOpts = {
  enabled: true, claimedHeight: LOCAL + 5, contenderBits: REAL_BITS, localHeight: LOCAL, localTime: NOW, nowSecs: NOW,
  blockSecs: 120, expectedLocalBits: REAL_BITS, maxAhead: 128, maxEase: 16,
};
const plaus = (over: Partial<ContenderPlausibleOpts>) => contenderPlausible({ ...base, ...over });

ok("an honest contender a few blocks ahead at the local difficulty passes", plaus({}) === true);
ok("a claimed height past maxAhead fails (delta cap)", plaus({ claimedHeight: LOCAL + 129 }) === false && plaus({ claimedHeight: LOCAL + 128 }) === true);
ok("a contender target more than maxEase times easier than the local one fails (LWMA ease)",
  plaus({ expectedLocalBits: HARDER_BITS }) === false);
ok("a POW_LIMIT contender against a real local difficulty fails", plaus({ contenderBits: POW_LIMIT_BITS }) === false);
ok("a harder-than-local contender passes", plaus({ contenderBits: HARDER_BITS }) === true);
ok("the ease threshold is capped at the pow limit, so a min-difficulty local chain still admits POW_LIMIT",
  plaus({ contenderBits: POW_LIMIT_BITS, expectedLocalBits: POW_LIMIT_BITS }) === true);
ok("a contender target easier than the pow limit fails even when the local chain sits at the limit",
  plaus({ contenderBits: 0x1e08ffff, expectedLocalBits: POW_LIMIT_BITS }) === false);
ok("disabled: a forged height and a POW_LIMIT target pass (kill switch)",
  plaus({ enabled: false, claimedHeight: LOCAL + 99_999, contenderBits: POW_LIMIT_BITS }) === true);

const STALE = 200 * 120;
ok("wedge: an honest contender 150 ahead of a 200-block-stale anchor passes (the cap grows with staleness)",
  plaus({ claimedHeight: LOCAL + 150, localTime: NOW - STALE }) === true && plaus({ claimedHeight: LOCAL + 150 }) === false);
ok("wedge: a claim beyond what wall-clock time allows still fails", plaus({ claimedHeight: LOCAL + 100_000, localTime: NOW - STALE }) === false);
ok("wedge: a too-easy contender still fails on LWMA ease", plaus({ claimedHeight: LOCAL + 150, localTime: NOW - STALE, expectedLocalBits: HARDER_BITS }) === false);
ok("a local time in the future grants no extra blocks", plaus({ claimedHeight: LOCAL + 129, localTime: NOW + STALE }) === false);
ok("a non-numeric local time or clock grants no extra blocks",
  plaus({ claimedHeight: LOCAL + 129, localTime: Number.NaN, nowSecs: NOW + STALE }) === false &&
  plaus({ claimedHeight: LOCAL + 129, localTime: NOW - STALE, nowSecs: Number.NaN }) === false);

ok("no local anchor (localHeight -1 or non-numeric) passes, even a forgery",
  plaus({ localHeight: -1, claimedHeight: LOCAL + 99_999, contenderBits: POW_LIMIT_BITS }) === true &&
  plaus({ localHeight: Number.NaN, claimedHeight: LOCAL + 99_999 }) === true);
ok("anchorFloor: a local tip below the floor is no anchor; at the floor the gate applies",
  plaus({ anchorFloor: LOCAL + 1, claimedHeight: LOCAL + 99_999 }) === true && plaus({ anchorFloor: LOCAL, claimedHeight: LOCAL + 99_999 }) === false);
ok("anchorFloor defaults to 0: a local tip at height 0 is an anchor",
  plaus({ localHeight: 0, claimedHeight: 500 }) === false && plaus({ localHeight: 0, claimedHeight: 5 }) === true);
ok("an unparseable claimed height fails", plaus({ claimedHeight: Number.NaN }) === false);
ok("non-numeric or invalid contender bits fail", plaus({ contenderBits: Number.NaN }) === false && plaus({ contenderBits: 0 }) === false && plaus({ contenderBits: 0x1d800000 }) === false);
ok("no derivable local LWMA anchor leaves only the delta cap",
  plaus({ expectedLocalBits: null, contenderBits: POW_LIMIT_BITS }) === true && plaus({ expectedLocalBits: null, claimedHeight: LOCAL + 129 }) === false);
ok("an invalid local anchor (bits 0) leaves only the delta cap", plaus({ expectedLocalBits: 0, contenderBits: POW_LIMIT_BITS }) === true);

ok("blockSecs 0 or non-numeric falls back to 120 s spacing",
  plaus({ blockSecs: 0, claimedHeight: LOCAL + 150, localTime: NOW - STALE }) === true &&
  plaus({ blockSecs: Number.NaN, claimedHeight: LOCAL + 329, localTime: NOW - STALE }) === false);
ok("maxAhead below 0 or non-numeric reads as 0", plaus({ maxAhead: -50, claimedHeight: LOCAL + 1 }) === false &&
  plaus({ maxAhead: Number.NaN, claimedHeight: LOCAL + 1 }) === false && plaus({ maxAhead: Number.NaN, claimedHeight: LOCAL }) === true);
ok("maxEase below 1 or non-numeric reads as 1", plaus({ maxEase: 0, contenderBits: REAL_BITS }) === true &&
  plaus({ maxEase: Number.NaN, contenderBits: REAL_BITS }) === true &&
  plaus({ maxEase: Number.NaN, contenderBits: targetToBits(bigIntToTarget(targetToBigInt(bitsToTarget(REAL_BITS)) * 2n)) }) === false);

console.log("honest path, each consumer's call shape over a real window:");
const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures-headers.json"), "utf8")) as {
  headers: { height: number; hash: string; header: BlockHeader }[];
};
const at = new Map(FX.headers.map((h) => [h.height, h]));
const localH = FX.headers[0]!.height + LWMA_WINDOW;
const win = FX.headers.filter((h) => h.height < localH && h.height >= localH - LWMA_WINDOW)
  .map((h) => ({ version: 0, prev: "", merkle: "", time: Number(h.header.time), bits: Number(h.header.bits), nonce: 0 }));
const expectedLocalBits = expectedBitsFromWindow(win, localH);
const localTip = at.get(localH)!;
const contender = at.get(localH + 20)!;
ok("the local LWMA window re-derives the real local tip's bits", expectedLocalBits === localTip.header.bits);
const nowSecs = Number(localTip.header.time) + 30;
// cairn src/routes/rpc.ts: tipHeaderPowOk(header, s.tipHash) && contenderPlausible({ enabled: true, ... })
const cairnShape = tipHeaderPowOk(contender.header, contender.hash) && contenderPlausible({
  enabled: true, claimedHeight: contender.height, contenderBits: Number((contender.header as { bits?: unknown }).bits),
  localHeight: localH, localTime: Number(localTip.header.time), nowSecs, blockSecs: 120,
  expectedLocalBits, maxAhead: 128, maxEase: 16,
});
ok("cairn's shape: a real header 20 blocks past the local tip is eligible", cairnShape === true);
// csd-indexer src/rpc.ts: the anchor only counts from the scan start (CFG.scanFrom), here the window's first height
const indexerShape = tipHeaderPowOk(contender.header, contender.hash) && contenderPlausible({
  enabled: true, claimedHeight: contender.height, contenderBits: Number(contender.header.bits),
  localHeight: localH, anchorFloor: FX.headers[0]!.height, localTime: Number(localTip.header.time), nowSecs,
  blockSecs: 120, expectedLocalBits, maxAhead: 128, maxEase: 16,
});
ok("the indexer's shape with anchorFloor = its scan start: the same header is eligible", indexerShape === true);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
