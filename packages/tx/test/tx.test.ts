// @inversealtruism/csd-tx — builder + coin-selection conformance + adversarial guards.
import { selectInputs, buildSend, buildPropose, buildAttest, signTx, txToNodeJson } from "../src/index.js";
import { txid, sighash, MIN_FEE_PROPOSE } from "@inversealtruism/csd-codec";
import { addrFromPriv, verifyDigest } from "@inversealtruism/csd-crypto";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };

const PRIV = "0x" + "11".repeat(32);
const ME = addrFromPriv(PRIV);
const RCPT = "0x" + "cc".repeat(20);
const utxo = (value: number, conf = 6, coinbase = false, i = 0) => ({ txid: "0x" + (i + 1).toString(16).padStart(64, "0"), vout: 0, value, confirmations: conf, coinbase });

console.log("— coin selection (hardened) —");
ok("selects largest-first to cover need", selectInputs([utxo(100, 6, false, 0), utxo(500, 6, false, 1)], 400)?.total === 500);
ok("returns null when insufficient", selectInputs([utxo(100)], 400) === null);
ok("ignores unconfirmed (confirmations<1)", selectInputs([utxo(1000, 0)], 100) === null);
ok("ignores missing-confirmations coin", selectInputs([{ txid: "0x" + "ab".repeat(32), vout: 0, value: 1000 }], 100) === null);
ok("dedupes the same outpoint", selectInputs([utxo(100, 6, false, 0), utxo(100, 6, false, 0)], 150) === null);
ok("rejects unsafe-magnitude value", selectInputs([{ ...utxo(0), value: Number.MAX_SAFE_INTEGER + 4 }], 1) === null);
ok("prefers non-coinbase, falls back to coinbase", selectInputs([utxo(1000, 6, true, 9)], 100)?.total === 1000);

console.log("\n— buildSend —");
const send = buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 10, utxos: [utxo(1000)], priv: PRIV });
ok("buildSend ok", send.ok === true);
ok("change returns to sender", send.tx!.outputs.some((o) => o.scriptPubkey === ME && Number(o.value) === 890));
ok("recipient paid exactly", send.tx!.outputs.some((o) => o.scriptPubkey === RCPT && Number(o.value) === 100));
ok("value conserved: inputs == outputs + fee", Number(send.inTotal) === send.tx!.outputs.reduce((s, o) => s + Number(o.value), 0) + Number(send.fee));
ok("signed tx verifies against the sighash", (() => { const sh = sighash({ ...send.tx!, inputs: send.tx!.inputs.map((i) => ({ ...i, scriptSig: "0x" })) } as any); const ss = send.tx!.inputs[0]!.scriptSig.slice(2); const sig = "0x" + ss.slice(2, 2 + 128); const pub = "0x" + ss.slice(2 + 128 + 2); return verifyDigest(sig, pub, sh); })());
ok("txid recomputes", send.txid === txid(send.tx!));
ok("rejects a bad recipient", buildSend({ outputs: [{ to: "0xnothex", value: 1 }], fee: 1, utxos: [utxo(1000)], priv: PRIV }).ok === false);
ok("rejects insufficient balance", buildSend({ outputs: [{ to: RCPT, value: 10_000 }], fee: 1, utxos: [utxo(100)], priv: PRIV }).ok === false);
// node mempool requires feerate_ppm = fee*1e6/bytes ≥ 1; fee:0 builds a tx the node bounces
ok("rejects fee:0 (below the node feerate floor — was a silent build-success/broadcast-fail)", buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 0, utxos: [utxo(1000)], priv: PRIV }).ok === false);
ok("accepts fee:1 (a sub-MB tx needs only 1 base unit to clear the feerate floor)", buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 1, utxos: [utxo(1000)], priv: PRIV }).ok === true);

console.log("\n— buildPropose / buildAttest —");
const prop = buildPropose({ domain: "csd:test", payloadHash: "0x" + "ab".repeat(32), uri: "cairn:v1:abcdef", expiresEpoch: 9999, fee: MIN_FEE_PROPOSE, utxos: [utxo(MIN_FEE_PROPOSE * 2)], priv: PRIV });
ok("buildPropose ok + app=Propose", prop.ok && prop.tx!.app.type === "Propose");
ok("propose rejects sub-minimum fee", buildPropose({ domain: "d", payloadHash: "0x" + "ab".repeat(32), uri: "u", expiresEpoch: 1, fee: 1, utxos: [utxo(1e8)], priv: PRIV }).ok === false);
const att = buildAttest({ proposalId: "0x" + "cd".repeat(32), score: 80, confidence: 60, fee: 5_000_000, utxos: [utxo(1e7)], priv: PRIV });
ok("buildAttest ok + app=Attest", att.ok && att.tx!.app.type === "Attest");
ok("buildAttest accepts the CONF_TOKEN_FILL marker confidence=1_000_000", buildAttest({ proposalId: "0x" + "cd".repeat(32), score: 100, confidence: 1_000_000, fee: 5_000_000, utxos: [utxo(1e7)], priv: PRIV }).ok === true);
ok("buildAttest REJECTS score ≥ 2^32 (no silent >>>0 wrap)", buildAttest({ proposalId: "0x" + "cd".repeat(32), score: 4294967296, confidence: 0, fee: 5_000_000, utxos: [utxo(1e7)], priv: PRIV }).ok === false);
ok("buildAttest REJECTS a negative confidence", buildAttest({ proposalId: "0x" + "cd".repeat(32), score: 0, confidence: -1, fee: 5_000_000, utxos: [utxo(1e7)], priv: PRIV }).ok === false);

console.log("\n— node JSON shape —");
const nj = txToNodeJson(send.tx!);
ok("nodeJson app is 'None' for a transfer", nj.app === "None");
ok("nodeJson inputs carry byte-array prevout txid", Array.isArray(nj.inputs[0].prevout.txid) && nj.inputs[0].prevout.txid.length === 32);
ok("nodeJson outputs carry byte-array script_pubkey(20)", nj.outputs[0].script_pubkey.length === 20);
const njp = txToNodeJson(prop.tx!);
ok("nodeJson Propose is externally-tagged {Propose:{…}}", !!njp.app.Propose && Array.isArray(njp.app.Propose.payload_hash));

console.log("\n— u64 submit-JSON faithfulness (regression: C-S2/A2 — no silent >2^53 truncation) —");
const throws = (n: string, fn: () => unknown) => { let t = false; try { fn(); } catch { t = true; } ok(n, t); };
const baseTx = { version: 1, locktime: 0, app: { type: "None" } as const, inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 0, scriptSig: "0x" }], outputs: [{ value: 1000, scriptPubkey: RCPT }] };
ok("MAX_SAFE_INTEGER value round-trips exactly", txToNodeJson({ ...baseTx, outputs: [{ value: Number.MAX_SAFE_INTEGER, scriptPubkey: RCPT }] }).outputs[0].value === Number.MAX_SAFE_INTEGER);
ok("bigint value within safe range round-trips exactly", txToNodeJson({ ...baseTx, outputs: [{ value: 9007199254740991n, scriptPubkey: RCPT }] }).outputs[0].value === 9007199254740991);
throws("REFUSES output value > 2^53 (would corrupt sign==submit) instead of Number()-truncating", () => txToNodeJson({ ...baseTx, outputs: [{ value: 9007199254740993n, scriptPubkey: RCPT }] }));
throws("REFUSES negative output value", () => txToNodeJson({ ...baseTx, outputs: [{ value: -1, scriptPubkey: RCPT }] }));
throws("REFUSES non-integer output value", () => txToNodeJson({ ...baseTx, outputs: [{ value: 1.5, scriptPubkey: RCPT }] }));
throws("REFUSES Propose expires_epoch > 2^53", () => txToNodeJson({ ...baseTx, app: { type: "Propose", domain: "d", payloadHash: "0x" + "ab".repeat(32), uri: "u", expiresEpoch: 9007199254740993n } }));

console.log("\n— DvP value outputs on Propose/Attest (consensus F4) —");
{
  const dvp = buildAttest({ proposalId: "0x" + "cd".repeat(32), score: 100, confidence: 100, fee: 5_000_000,
    outputs: [{ to: RCPT, value: 40_000_000 }], utxos: [utxo(2e8)], priv: PRIV });
  ok("attest+payment builds (atomic DvP shape)", dvp.ok === true);
  ok("payment output present with exact value", dvp.tx!.outputs.some((o) => o.value === 40_000_000 && String(o.scriptPubkey).toLowerCase() === RCPT.toLowerCase()));
  ok("change returns to sender", dvp.tx!.outputs.some((o) => String(o.scriptPubkey).toLowerCase() === addrFromPriv(PRIV).toLowerCase()));
  const bad = buildAttest({ proposalId: "0x" + "cd".repeat(32), score: 100, confidence: 100, fee: 5_000_000,
    outputs: [{ to: RCPT, value: 0 }], utxos: [utxo(2e8)], priv: PRIV });
  ok("zero-value output refused", bad.ok === false);
  const dvpP = buildPropose({ domain: "cairnx:v1", payloadHash: "0x" + "ab".repeat(32), uri: "u", expiresEpoch: 10,
    fee: 25_000_000, outputs: [{ to: RCPT, value: 100_000_000 }], utxos: [utxo(3e8)], priv: PRIV });
  ok("propose+fee-output builds (fee-bearing record shape)", dvpP.ok === true && dvpP.tx!.outputs.some((o) => o.value === 100_000_000));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
