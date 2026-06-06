// @inversealtruism/csd-codec conformance — every output is checked against the Rust node's golden vectors.
// This is the gate: if any byte diverges from canonical Rust, the build fails.
import {
  serialize, deserialize, txid, sighash, strippedTx,
  serializeHeader, headerHash, bitsToTarget, powOk, merkleRoot, verifyMerkleProof, merkleBranch,
  payloadHash, canonicalJson, bytesToHex, hb,
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
// a hash equal to the target passes; target+? — sanity: all-FF hash must fail vs the pow-limit target
eq("powOk: all-0x00 hash passes pow-limit", powOk(new Uint8Array(32), GOLDEN_POW.bits), true);
eq("powOk: all-0xff hash fails pow-limit", powOk(new Uint8Array(32).fill(0xff), GOLDEN_POW.bits), false);
// the golden header's own hash satisfies its own bits? (bits 0x1f00ffff is very easy; hash starts 0x43..)
// 0x43.. > 0x0000ff.. target for 0x1f00ffff? compute target then compare.
eq("powOk matches manual compare for the golden header", powOk(hb(GOLDEN_HEADER.expectedHeaderHash), GOLDEN_HEADER.header.bits),
  (() => { const t = bitsToTarget(GOLDEN_HEADER.header.bits); const h = hb(GOLDEN_HEADER.expectedHeaderHash); for (let i = 0; i < 32; i++) { if (h[i]! < t[i]!) return true; if (h[i]! > t[i]!) return false; } return true; })());

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

console.log("\n— real mainnet blocks (live regression) —");
for (const b of LIVE_BLOCKS) {
  eq(`block ${b.height}: headerHash == on-chain hash`, headerHash(b.header), b.hash);
  eq(`block ${b.height}: powOk(hash, bits) == true`, powOk(hb(b.hash), b.header.bits), true);
  eq(`block ${b.height}: merkleRoot(txids) == header.merkle`, merkleRoot(b.txids), b.header.merkle);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
