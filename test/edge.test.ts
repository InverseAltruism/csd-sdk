// Edge-case conformance (pure — no node). Exercises boundaries the happy-path tests miss:
// empty/large/coinbase txs, bigint fields, unicode, malformed deserialize, compact-bits
// rejection cases + round-trip, merkle odd rows, PoW boundary, canonical JSON ordering.
import {
  serialize, deserialize, txid, sighash, strippedTx,
  bitsToTarget, targetToBits, targetToBigInt, powOk, headerHash, serializeHeader,
  merkleRoot, verifyMerkleProof, merkleBranch, canonicalJson, payloadHash, bytesToHex, hb,
  type Tx,
} from "@inversealtruism/csd-codec";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const throws = (n: string, f: () => unknown) => { let t = false; try { f(); } catch { t = true; } ok(n, t); };
const A20 = "0x" + "09".repeat(20), H32 = "0x" + "ab".repeat(32);

console.log("— tx codec edge cases —");
// empty inputs + empty outputs (a degenerate but serializable tx)
const empty: Tx = { version: 1, inputs: [], outputs: [], locktime: 0, app: { type: "None" } };
ok("empty tx round-trips", bytesToHex(serialize(deserialize(serialize(empty)))) === bytesToHex(serialize(empty)));
// multi-input / multi-output
const multi: Tx = { version: 7, locktime: 42, app: { type: "None" },
  inputs: [{ prevTxid: H32, vout: 0, scriptSig: "0x" }, { prevTxid: "0x" + "cd".repeat(32), vout: 4294967294, scriptSig: "0xdeadbeef" }],
  outputs: [{ value: 1, scriptPubkey: A20 }, { value: 999999, scriptPubkey: "0x" + "11".repeat(20) }] };
ok("multi in/out round-trips byte-identical", bytesToHex(serialize(deserialize(serialize(multi)))) === bytesToHex(serialize(multi)));
// coinbase input (vout 0xffffffff, prev all-zero) is NOT stripped (its scriptSig is consensus data)
const cb: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 0xffffffff, scriptSig: "0x" + "ee".repeat(8) }], outputs: [{ value: 50, scriptPubkey: A20 }] };
ok("coinbase scriptSig preserved by strippedTx", strippedTx(cb).inputs[0]!.scriptSig === "0x" + "ee".repeat(8));
// big u64 value + bigint expiresEpoch
const big: Tx = { version: 1, locktime: 0, inputs: [], outputs: [{ value: 18446744073709551615n, scriptPubkey: A20 }], app: { type: "Propose", domain: "d", payloadHash: H32, uri: "u", expiresEpoch: 12345678901234n } };
ok("u64 max value + bigint expiresEpoch round-trip", (() => { const d = deserialize(serialize(big)); return (d.outputs[0]!.value as bigint) === 18446744073709551615n && (d.app as any).expiresEpoch === 12345678901234n; })());
// unicode + empty strings in Propose
const uni: Tx = { version: 1, locktime: 0, inputs: [], outputs: [], app: { type: "Propose", domain: "csd:wall🪨", payloadHash: H32, uri: "", expiresEpoch: 0 } };
ok("unicode domain + empty uri round-trip", (() => { const d = deserialize(serialize(uni)) as any; return d.app.domain === "csd:wall🪨" && d.app.uri === ""; })());
// Attest app
const att: Tx = { version: 1, locktime: 0, inputs: [], outputs: [], app: { type: "Attest", proposalId: H32, score: 4294967295, confidence: 0 } };
ok("Attest with u32-max score round-trips", (() => { const d = deserialize(serialize(att)) as any; return d.app.score === 4294967295 && d.app.confidence === 0; })());

console.log("\n— malformed input rejection —");
throws("deserialize truncated bytes throws", () => deserialize(serialize(multi).slice(0, 10)));
throws("deserialize unknown app variant (u32=3) throws", () => { const b = serialize(empty); b[b.length - 4] = 3; deserialize(b); });
throws("wrong-length scriptPubkey field throws (hbFixed)", () => serialize({ ...empty, outputs: [{ value: 1, scriptPubkey: "0x1234" }] }));
throws("wrong-length payloadHash throws", () => serialize({ ...empty, app: { type: "Propose", domain: "d", payloadHash: "0xabcd", uri: "u", expiresEpoch: 0 } }));

console.log("\n— compact bits ↔ target —");
ok("sign-bit-set mantissa → invalid (all-zero)", bitsToTarget(0x01800000).every((b) => b === 0));
ok("exp=0 → invalid", bitsToTarget(0x00123456).every((b) => b === 0));
ok("mant=0 → invalid", bitsToTarget(0x1e000000).every((b) => b === 0));
ok("exp>32 → invalid", bitsToTarget(0x21000001).every((b) => b === 0));
// round-trip for a range of real-ish bits values (canonical re-encode is idempotent)
let rtBits = true;
for (const bits of [0x1d00ffff, 0x1e00ffff, 0x1f00ffff, 0x1b0404cb, 0x1c0168fd, 0x18009645]) {
  const t = bitsToTarget(bits);
  if (t.every((b) => b === 0)) continue;
  if (targetToBits(t) !== bits) { rtBits = false; console.log(`     bits round-trip drift: ${bits.toString(16)} → ${targetToBits(t).toString(16)}`); }
}
ok("bitsToTarget→targetToBits is idempotent for canonical bits", rtBits);

console.log("\n— PoW boundary —");
const tgt = bitsToTarget(0x1e00ffff);
ok("hash == target passes", powOk(tgt, 0x1e00ffff));
const justOver = bitsToTarget(0x1e00ffff).slice(); justOver[31] = (justOver[31]! + 0); // target itself
// construct target+1 by incrementing the bigint
const over = (() => { const v = targetToBigInt(tgt) + 1n; const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; })();
ok("hash == target+1 fails", !powOk(over, 0x1e00ffff));

console.log("\n— merkle —");
for (const k of [1, 2, 3, 4, 5, 8, 9]) {
  const leaves = Array.from({ length: k }, (_, i) => "0x" + bytesToHex(new Uint8Array(32).fill(i + 1)));
  const root = merkleRoot(leaves);
  let allOk = true;
  for (let i = 0; i < k; i++) if (!verifyMerkleProof(leaves[i]!, i, merkleBranch(leaves, i), root)) allOk = false;
  ok(`merkle proof verifies for all ${k} leaves (odd-row dup)`, allOk);
}
const lv = ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32)];
const r3 = merkleRoot(lv);
ok("tampered root → proof fails", !verifyMerkleProof(lv[0]!, 0, merkleBranch(lv, 0), "0x" + "ff".repeat(32)));
ok("wrong leaf → proof fails", !verifyMerkleProof("0x" + "99".repeat(32), 0, merkleBranch(lv, 0), r3));

console.log("\n— canonical JSON / content hash —");
ok("keys sorted recursively, arrays preserve order", canonicalJson({ z: 1, a: [3, 2, { y: 1, b: 2 }] }) === '{"a":[3,2,{"b":2,"y":1}],"z":1}');
ok("key order does not change the hash", payloadHash({ a: 1, b: 2 }) === payloadHash({ b: 2, a: 1 }));
ok("different content → different hash", payloadHash({ a: 1 }) !== payloadHash({ a: 2 }));
ok("null / bool / number handled", canonicalJson({ n: null, t: true, x: 1.5 }) === '{"n":null,"t":true,"x":1.5}');

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
