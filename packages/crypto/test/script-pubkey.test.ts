// addrFromScriptPubkey against the node's address parser (compute-substrate src/api/mod.rs parse_addr20): the
// accepted and refused spellings below are the node's verdicts, and the honest path runs each consumer's call shape
// on real mined outputs. Offline.
import { deserialize, serialize } from "@inversealtruism/csd-codec";
import { GOLDEN_ATTEST_TX, GOLDEN_PROPOSE_TX, GOLDEN_TX } from "@inversealtruism/csd-vectors";
import { addrFromScriptPubkey } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };

const A = "44d92872a5b65d37d60ed532f41efe7c5aed59ec";
const CANON = "0x" + A;

console.log("addrFromScriptPubkey: spellings the node accepts");
ok("the node's own form (0x + 40 lowercase hex) maps to itself", addrFromScriptPubkey(CANON) === CANON);
ok("bare 40 hex", addrFromScriptPubkey(A) === CANON);
ok("upper-case hex digits, with and without 0x, map to the lowercase form",
  addrFromScriptPubkey("0x" + A.toUpperCase()) === CANON && addrFromScriptPubkey(A.toUpperCase()) === CANON);
ok("all-zero and all-f scripts are addresses too",
  addrFromScriptPubkey("0x" + "0".repeat(40)) === "0x" + "0".repeat(40) && addrFromScriptPubkey("F".repeat(40)) === "0x" + "f".repeat(40));
ok("surrounding Unicode White_Space is trimmed (tab, newline, NEL U+0085, NBSP, U+3000)",
  ["\t", "\n", "\u0085", " ", "　", " ", " "].every((w) => addrFromScriptPubkey(w + CANON + w) === CANON && addrFromScriptPubkey(w + w + A + w) === CANON));

console.log("addrFromScriptPubkey: spellings the node refuses");
ok("an upper-case 0X prefix", addrFromScriptPubkey("0X" + A) === null && addrFromScriptPubkey("0X" + A.toUpperCase()) === null);
ok("19 or 21 bytes, or an odd digit count", addrFromScriptPubkey("0x" + A.slice(0, 38)) === null &&
  addrFromScriptPubkey("0x" + A + "00") === null && addrFromScriptPubkey("0x" + A.slice(0, 39)) === null && addrFromScriptPubkey("0x" + A + "0") === null);
ok("empty, a bare 0x, a doubled 0x", addrFromScriptPubkey("") === null && addrFromScriptPubkey("0x") === null && addrFromScriptPubkey("0x0x" + A) === null);
ok("whitespace inside, or between 0x and the digits", addrFromScriptPubkey("0x" + A.slice(0, 20) + " " + A.slice(21)) === null && addrFromScriptPubkey("0x " + A) === null);
ok("U+FEFF and U+200B are not White_Space (JS String#trim strips U+FEFF; the node does not)",
  addrFromScriptPubkey("﻿" + CANON) === null && addrFromScriptPubkey(CANON + "​") === null);
ok("non-ASCII digits and a sign", addrFromScriptPubkey("0x" + A.slice(0, 39) + "٠") === null && addrFromScriptPubkey("+0x" + A) === null);
ok("non-strings, including an array whose String() is a valid address", [null, undefined, 0, 1n, [A], { toString: () => A }, new Uint8Array(20)]
  .every((v) => addrFromScriptPubkey(v) === null));

console.log("honest path, each consumer's call shape on real mined outputs:");
const mined = [GOLDEN_TX, GOLDEN_PROPOSE_TX, GOLDEN_ATTEST_TX];
// csd-indexer decode.ts / cairn chainscan.ts / cairnx scan.ts: the node RPC's and the indexer's script_pubkey text
const rpcOutputs = mined.flatMap((v) => v.tx.outputs.map((o) => ({ value: o.value, script_pubkey: o.scriptPubkey })));
ok("RPC and indexer rows: every output maps to its own lowercase 0x form",
  rpcOutputs.length > 0 && rpcOutputs.every((o) => addrFromScriptPubkey(o.script_pubkey) === o.script_pubkey.toLowerCase()));
ok("the proposer's payout output resolves to the funded address", addrFromScriptPubkey(GOLDEN_PROPOSE_TX.tx.outputs[0]!.scriptPubkey) === CANON);
// cairn-wallet namespv.ts / fillspv.ts: outputs of a body decoded by the codec
const decoded = mined.flatMap((v) => deserialize(serialize(v.tx as Parameters<typeof serialize>[0])).outputs);
ok("codec-decoded bodies: every scriptPubkey maps to an address equal to the vector's",
  decoded.length === rpcOutputs.length && decoded.every((o, i) => addrFromScriptPubkey(o.scriptPubkey) === rpcOutputs[i]!.script_pubkey.toLowerCase()));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
