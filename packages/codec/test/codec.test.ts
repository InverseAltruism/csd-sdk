// @inversealtruism/csd-codec conformance — every output is checked against the Rust node's golden vectors.
// This is the gate: if any byte diverges from canonical Rust, the build fails.
import {
  serialize, deserialize, txid, sighash, strippedTx,
  serializeHeader, headerHash, bitsToTarget, powOk, merkleRoot, verifyMerkleProof, merkleBranch,
  payloadHash, canonicalJson, bytesToHex, hb, workForBits, MAX_U128, MAX_TX_BYTES,
  COINBASE_TXID, COINBASE_VOUT, isCoinbaseInput,
  blockReward, blockRewardBase, emittedSupplyBase, maxSupplyBase, INITIAL_REWARD, HALVING_INTERVAL,
} from "../src/index.js";
import { GOLDEN_HEADER, GOLDEN_TX, GOLDEN_POW, TX_VECTORS, HEADER_VECTORS, LIVE_BLOCKS } from "@inversealtruism/csd-vectors";

let pass = 0, fail = 0;
const eq = (n: string, a: unknown, b: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${n}`);
  if (!ok) console.log(`     got ${JSON.stringify(a)}\n     exp ${JSON.stringify(b)}`);
};
const hxOf = (b: Uint8Array) => "0x" + bytesToHex(b);

console.log("— transaction codec (golden_vectors.rs) —");
for (const v of TX_VECTORS) {
  eq("serialize(tx) == expected bincode bytes", hxOf(serialize(v.tx)), v.expectedConsensusBytes);
  eq("txid(tx) == expected (stripped)", txid(v.tx), v.expectedTxid);
  eq("sighash(tx) == expected (CSD_SIG_V1)", sighash(v.tx), v.expectedSighash);
  // round-trip: deserialize(serialize(tx)) reproduces the struct (compare via re-serialize)
  eq("deserialize ∘ serialize round-trips", hxOf(serialize(deserialize(serialize(v.tx)))), v.expectedConsensusBytes);
}
// stripped serialization differs from full (script_sig cleared on the non-coinbase input)
eq("stripped tx clears the non-coinbase script_sig", strippedTx(GOLDEN_TX.tx).inputs[0]!.scriptSig, "0x");

console.log("\n— block header (golden_vectors.rs) —");
for (const v of HEADER_VECTORS) {
  eq("serializeHeader == expected 84-byte bytes", hxOf(serializeHeader(v.header)), v.expectedConsensusBytes);
  eq("serializeHeader length == 84", serializeHeader(v.header).length, 84);
  eq("headerHash == expected", headerHash(v.header), v.expectedHeaderHash);
}

console.log("\n— PoW target (compact bits) —");
eq("bitsToTarget(POW_LIMIT_BITS) == expected BE target", hxOf(bitsToTarget(GOLDEN_POW.bits)), GOLDEN_POW.expectedTargetBE);
// a hash equal to the target passes; sanity: all-FF hash must fail vs the pow-limit target
eq("powOk: all-0x00 hash passes pow-limit", powOk(new Uint8Array(32), GOLDEN_POW.bits), true);
eq("powOk: all-0xff hash fails pow-limit", powOk(new Uint8Array(32).fill(0xff), GOLDEN_POW.bits), false);
// NEW-1 regression: bits EASIER than the pow limit must be rejected even for a trivially-small hash —
// the node gates on bits_within_pow_limit (chain/pow.rs); without it the SDK light client would deem
// an out-of-consensus low-difficulty header "valid". workForBits must likewise yield NO work.
eq("powOk: REJECTS easier-than-limit bits (NEW-1)", powOk(new Uint8Array(32), GOLDEN_POW.beyondLimitBits), false);
eq("workForBits: 0 for easier-than-limit bits (NEW-1)", workForBits(GOLDEN_POW.beyondLimitBits).toString(), "0");
// the golden header uses the frozen 0x1f00ffff (beyond-limit) serialization bits; powOk must still mirror
// the node: easier-than-limit ⇒ false, regardless of the hash.
eq("powOk matches the node for the golden header", powOk(hb(GOLDEN_HEADER.expectedHeaderHash), GOLDEN_HEADER.header.bits),
  (() => { const t = bitsToTarget(GOLDEN_HEADER.header.bits); const lim = bitsToTarget(GOLDEN_POW.bits);
    const gt = (x: Uint8Array, y: Uint8Array) => { for (let i = 0; i < 32; i++) { if (x[i]! > y[i]!) return true; if (x[i]! < y[i]!) return false; } return false; };
    if (t.every((b) => b === 0) || gt(t, lim)) return false; // invalid or easier than pow limit
    const h = hb(GOLDEN_HEADER.expectedHeaderHash); for (let i = 0; i < 32; i++) { if (h[i]! < t[i]!) return true; if (h[i]! > t[i]!) return false; } return true; })());

console.log("\n— merkle —");
// single tx → root == txid
eq("merkleRoot([txid]) == txid (single tx)", merkleRoot([GOLDEN_TX.expectedTxid]), GOLDEN_TX.expectedTxid);
// build a 5-leaf tree, prove every leaf via its branch
const leaves = Array.from({ length: 5 }, (_, i) => "0x" + bytesToHex(new Uint8Array(32).fill(i + 1)));
const root = merkleRoot(leaves);
let allProofs = true;
leaves.forEach((leaf, i) => { if (!verifyMerkleProof(leaf, i, merkleBranch(leaves, i), root)) allProofs = false; });
eq("merkleBranch+verify round-trips for all 5 leaves (odd-row dup)", allProofs, true);
eq("a wrong position fails verification", verifyMerkleProof(leaves[0]!, 1, merkleBranch(leaves, 0), root), false);

console.log("\n— content addressing —");
eq("canonicalJson sorts keys + is compact", canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
eq("payloadHash is a 0x..64 sha256", /^0x[0-9a-f]{64}$/.test(payloadHash({ x: 1 })), true);
// hardening: undefined values are dropped (valid, re-parseable JSON) — no {a:undefined} collision
eq("canonicalJson drops undefined keys", canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
eq("canonicalJson {a:undefined,b:1} == {b:1}", payloadHash({ a: undefined, b: 1 }), payloadHash({ b: 1 }));
eq("canonicalJson output is always valid JSON", (() => { try { JSON.parse(canonicalJson({ a: undefined, b: [undefined, 1] })); return true; } catch { return false; } })(), true);
// hardening: deep nesting throws (DoS guard) rather than overflowing the stack
{
  let deep: any = 1; for (let i = 0; i < 5000; i++) deep = [deep];
  let threw = false; try { canonicalJson(deep); } catch { threw = true; }
  eq("canonicalJson rejects pathologically deep input (no stack overflow)", threw, true);
}

console.log("\n— u64 encoding guards (consensus primitive) —");
eq("u64 rejects a Number ≥ 2^53 (precision loss)", (() => { try { serialize({ version: 1, locktime: 0, app: { type: "None" }, inputs: [], outputs: [{ value: 9007199254740993, scriptPubkey: "0x" + "cd".repeat(20) }] } as any); return false; } catch { return true; } })(), true);
eq("u64 rejects a negative value", (() => { try { serialize({ version: 1, locktime: 0, app: { type: "None" }, inputs: [], outputs: [{ value: -1, scriptPubkey: "0x" + "cd".repeat(20) }] } as any); return false; } catch { return true; } })(), true);
eq("u64 ACCEPTS a large value as bigint (no precision loss)", (() => { try { serialize({ version: 1, locktime: 0, app: { type: "None" }, inputs: [], outputs: [{ value: 90000000000000000n, scriptPubkey: "0x" + "cd".repeat(20) }] } as any); return true; } catch { return false; } })(), true);

console.log("\n— u32 encoding guards (symmetry with u64; no silent >>>0 wrap) —");
const serU32 = (patch: any) => { try { serialize({ version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }], outputs: [], ...patch } as any); return false; } catch { return true; } };
eq("u32 rejects version ≥ 2^32 (would wrap to a different signed value)", serU32({ version: 4294967296 }), true);
eq("u32 rejects a negative vout (would wrap to the 0xffffffff coinbase sentinel)", serU32({ inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: -1, scriptSig: "0x" }] }), true);
eq("u32 ACCEPTS vout = 4294967295 (real coinbase sentinel, a valid u32)", (() => { try { serialize({ version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: "0x".padEnd(66, "0"), vout: 4294967295, scriptSig: "0x" }], outputs: [] } as any); return true; } catch { return false; } })(), true);
eq("u32 rejects an Attest score ≥ 2^32", (() => { try { serialize({ version: 1, locktime: 0, app: { type: "Attest", proposalId: "0x" + "22".repeat(32), score: 4294967296, confidence: 0 }, inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }], outputs: [] } as any); return false; } catch { return true; } })(), true);

console.log("\n— real mainnet blocks (live regression) —");
for (const b of LIVE_BLOCKS) {
  eq(`block ${b.height}: headerHash == on-chain hash`, headerHash(b.header), b.hash);
  eq(`block ${b.height}: powOk(hash, bits) == true`, powOk(hb(b.hash), b.header.bits), true);
  eq(`block ${b.height}: merkleRoot(txids) == header.merkle`, merkleRoot(b.txids), b.header.merkle);
}

console.log("\n— deserialize untrusted-input guards (C-S1: match node MAX_TX limits + canonicality) —");
const throwsD = (b: Uint8Array) => { try { deserialize(b); return false; } catch { return true; } };
const validBytes = serialize(TX_VECTORS[0]!.tx);
eq("deserialize accepts a valid tx", throwsD(validBytes), false);
eq("deserialize REJECTS trailing bytes (non-canonical)", throwsD(new Uint8Array([...validBytes, 0x00])), true);
eq("deserialize REJECTS oversized input (> MAX_TX_BYTES)", throwsD(new Uint8Array(MAX_TX_BYTES + 1)), true);
// version(4)=1 ‖ nIn(8 LE)=513 → caps before any allocation/loop
eq("deserialize REJECTS too many inputs (513 > 512) before allocating", throwsD(new Uint8Array([1,0,0,0, 1,2,0,0,0,0,0,0])), true);
// version ‖ nIn=0 ‖ nOut=513
eq("deserialize REJECTS too many outputs (513 > 512) before allocating", throwsD(new Uint8Array([1,0,0,0, 0,0,0,0,0,0,0,0, 1,2,0,0,0,0,0,0])), true);

console.log("\n— chainwork u128 faithfulness (A-S4: clamp per-block work to u128 like the node) —");
eq("workForBits clamps an extreme low-target to MAX_U128", workForBits(0x10000001) === MAX_U128, true);
eq("workForBits at real difficulty is NOT clamped (< MAX_U128)", workForBits(LIVE_BLOCKS[0]!.header.bits) < MAX_U128, true);
eq("workForBits at real difficulty is > 0", workForBits(LIVE_BLOCKS[0]!.header.bits) > 0n, true);

console.log("\n— coinbase sentinels + exact-bigint emission (Plan 57 B4) —");
eq("coinbase sentinel exports match the wire constants", COINBASE_TXID === "0x" + "00".repeat(32) && COINBASE_VOUT === 0xffffffff, true);
eq("isCoinbaseInput: true only for the exact sentinel pair",
  isCoinbaseInput({ prevTxid: COINBASE_TXID, vout: COINBASE_VOUT, scriptSig: "0x" })
  && !isCoinbaseInput({ prevTxid: COINBASE_TXID, vout: 0, scriptSig: "0x" })
  && !isCoinbaseInput({ prevTxid: "0x" + "11".repeat(32), vout: COINBASE_VOUT, scriptSig: "0x" }), true);
eq("blockRewardBase mirrors blockReward across era boundaries",
  [0, 1, HALVING_INTERVAL - 1, HALVING_INTERVAL, HALVING_INTERVAL * 2, HALVING_INTERVAL * 63, HALVING_INTERVAL * 64]
    .every((h) => blockRewardBase(h) === BigInt(blockReward(h))), true);
eq("emittedSupplyBase: a genesis-only chain has emitted one reward (blocks 0..0)", emittedSupplyBase(0) === BigInt(INITIAL_REWARD), true);
// Live-chain pin (2026-07-02, tip 45560): the indexer's DB-derived emitted supply
// (SUM(coinbase) - SUM(fees)) was 227805000000000 = 45561 blocks x 50 CSD. This is the
// off-by-one contract consumers must rely on: blocks 0..height INCLUSIVE.
eq("emittedSupplyBase matches the live indexer emitted_supply at height 45560", emittedSupplyBase(45560) === 227_805_000_000_000n, true);
eq("emittedSupplyBase crosses the first halving exactly (one era-1 block)",
  emittedSupplyBase(HALVING_INTERVAL) === BigInt(HALVING_INTERVAL) * BigInt(INITIAL_REWARD) + BigInt(INITIAL_REWARD) / 2n, true);
eq("maxSupplyBase matches the live indexer max_supply", maxSupplyBase() === 10_511_999_988_436_800n, true);
eq("emittedSupplyBase saturates at maxSupplyBase past the last era", emittedSupplyBase(HALVING_INTERVAL * 64 + 12_345) === maxSupplyBase(), true);
eq("emittedSupplyBase: negative/NaN heights emit 0n", emittedSupplyBase(-5) === 0n && emittedSupplyBase(NaN) === 0n, true);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
