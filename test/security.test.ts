// Security / adversarial tests. Assumes a HOSTILE RPC + a HOSTILE counterparty and proves the
// SDK cannot be made to lose funds, sign the wrong thing, or accept a forged chain.
import { buildSend, selectInputs, signTx, txToNodeJson } from "@inversealtruism/csd-tx";
import { sighash, txid, type Tx } from "@inversealtruism/csd-codec";
import { addrFromPriv, verifyDigest, signDigest } from "@inversealtruism/csd-crypto";
import { LightClient } from "@inversealtruism/csd-light";
import { CsdClient } from "@inversealtruism/csd-client";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const PRIV = "0x" + "11".repeat(32);
const ME = addrFromPriv(PRIV);
const RCPT = "0x" + "cc".repeat(20);
const utxo = (value: number, conf = 6, coinbase = false, i = 0) => ({ txid: "0x" + (i + 1).toString(16).padStart(64, "0"), vout: 0, value, confirmations: conf, coinbase });

console.log("— hostile RPC: coin selection cannot be poisoned —");
ok("negative value dropped", selectInputs([{ ...utxo(0, 6, false, 1), value: -100 }, utxo(500, 6, false, 2)], 100)?.total === 500);
ok("NaN value dropped", selectInputs([{ ...utxo(0, 6, false, 1), value: NaN }], 1) === null);
ok("Infinity value dropped", selectInputs([{ ...utxo(0, 6, false, 1), value: Infinity }], 1) === null);
ok("value > 2^53 dropped (no precision slip)", selectInputs([{ ...utxo(0, 6, false, 1), value: Number.MAX_SAFE_INTEGER + 10 }], 1) === null);
ok("unconfirmed dropped", selectInputs([utxo(1000, 0, false, 1)], 1) === null);
ok("missing confirmations treated as 0 (dropped)", selectInputs([{ txid: "0x" + "ab".repeat(32), vout: 0, value: 1000 } as any], 1) === null);
ok("duplicate outpoint (mixed case) deduped", selectInputs([{ txid: "0x" + "AB".repeat(32), vout: 0, value: 100, confirmations: 6 }, { txid: "0x" + "ab".repeat(32), vout: 0, value: 100, confirmations: 6 }], 150) === null);
// >512 inputs cap: 600 tiny coins, need exceeds any single → would require >512 → null
ok("refuses to exceed the 512-input consensus cap", selectInputs(Array.from({ length: 600 }, (_, i) => utxo(1, 6, false, i + 1)), 600) === null);

console.log("\n— buildSend: change always to self, never redirected —");
const s = buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 10, utxos: [utxo(1000)], priv: PRIV });
ok("change output address == sender (not recipient)", s.tx!.outputs.filter((o) => Number(o.value) === 890).every((o) => o.scriptPubkey === ME));
ok("no extra output to any non-recipient/non-self address", s.tx!.outputs.every((o) => o.scriptPubkey === RCPT || o.scriptPubkey === ME));
ok("rejects negative fee", buildSend({ outputs: [{ to: RCPT, value: 1 }], fee: -1, utxos: [utxo(1000)], priv: PRIV }).ok === false);
ok("rejects zero amount", buildSend({ outputs: [{ to: RCPT, value: 0 }], fee: 1, utxos: [utxo(1000)], priv: PRIV }).ok === false);
ok("rejects non-hex recipient", buildSend({ outputs: [{ to: "0xzz", value: 1 }], fee: 1, utxos: [utxo(1000)], priv: PRIV }).ok === false);

console.log("\n— signing integrity —");
// a signature is over the EXACT tx; mutating any field invalidates it against the new sighash
const built = buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 10, utxos: [utxo(1000)], priv: PRIV });
const ss = built.tx!.inputs[0]!.scriptSig.slice(2);
const sig = "0x" + ss.slice(2, 2 + 128), pub = "0x" + ss.slice(2 + 128 + 2);
const strip = (t: Tx): Tx => ({ ...t, inputs: t.inputs.map((i) => ({ ...i, scriptSig: "0x" })) });
ok("sig verifies against the genuine sighash", verifyDigest(sig, pub, sighash(strip(built.tx!))));
const tampered: Tx = { ...built.tx!, outputs: [{ value: 999, scriptPubkey: RCPT }, ...built.tx!.outputs.slice(1)] };
ok("mutating the recipient amount invalidates the signature", !verifyDigest(sig, pub, sighash(strip(tampered))));
// high-S malleability rejected
ok("verifyDigest rejects a high-S signature", (() => {
  const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  const r = sig.slice(2, 66), sLow = BigInt("0x" + sig.slice(66));
  const sHigh = (N - sLow).toString(16).padStart(64, "0");
  return !verifyDigest("0x" + r + sHigh, pub, sighash(strip(built.tx!)));
})());

console.log("\n— sighash domain separation (no cross-type confusion) —");
const base = { version: 1, locktime: 0, inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 0, scriptSig: "0x" }], outputs: [] };
const shNone = sighash({ ...base, app: { type: "None" } } as Tx);
const shProp = sighash({ ...base, app: { type: "Propose", domain: "x", payloadHash: "0x" + "00".repeat(32), uri: "", expiresEpoch: 0 } } as Tx);
const shAtt = sighash({ ...base, app: { type: "Attest", proposalId: "0x" + "00".repeat(32), score: 0, confidence: 0 } } as Tx);
ok("None / Propose / Attest produce distinct sighashes", new Set([shNone, shProp, shAtt]).size === 3);

console.log("\n— light client: forged chain rejected (needs node) —");
const BASE = process.env.CSD_RPC || "http://127.0.0.1:8790";
let reachable = false;
try { reachable = (await fetch(`${BASE}/tip`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* down */ }
if (reachable) {
  const c = new CsdClient({ baseUrl: BASE });
  // foreign genesis: feed a non-genesis header at height 0
  const real1 = await c.blockByHeight(1);
  let rejGenesis = false;
  try { new LightClient({ client: c }).ingest(0, { version: real1.header.version, prev: "0x" + "00".repeat(32), merkle: real1.header.merkle, time: 1, bits: 0x1e00ffff, nonce: 0 } as any); } catch { rejGenesis = true; }
  ok("foreign genesis rejected", rejGenesis);
  // valid bits + valid prev but BROKEN PoW (zero the nonce on a real header → hash > target)
  const lc = new LightClient({ client: c });
  await lc.sync(30);
  const real31 = await c.blockByHeight(31);
  let rejPow = false;
  try { lc.ingest(31, { version: real31.header.version, prev: real31.header.prev, merkle: real31.header.merkle, time: real31.header.time, bits: real31.header.bits, nonce: 0 } as any); }
  catch (e: any) { rejPow = /PoW|bits/.test(e?.message ?? ""); }
  ok("a header with broken PoW (nonce=0) is rejected", rejPow);
  // out-of-order ingest rejected
  let rejOrder = false;
  try { new LightClient({ client: c }).ingest(5, real31.header as any); } catch { rejOrder = true; }
  ok("out-of-order ingest rejected", rejOrder);
} else {
  console.log("  (node down — light forged-chain tests skipped)");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
