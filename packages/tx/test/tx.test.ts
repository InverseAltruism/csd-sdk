// @inversealtruism/csd-tx — builder + coin-selection conformance + adversarial guards.
import { selectInputs, buildSend, buildSendVerified, buildPropose, buildAttest, buildProposeVerified, buildAttestVerified, signTx, txToNodeJson } from "../src/index.js";
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

console.log("\n— selectInputs `exclude` (0.1.16 upstream of the wallet's ghost-coin skip; mirrors cairn-wallet/test/selectinputs-parity.ts) —");
{
  const key = (u: { txid: string; vout: number }) => `${u.txid.toLowerCase()}:${u.vout}`;
  const best = utxo(900, 6, false, 9), other = utxo(800, 6, false, 1); // best's txid ends …0a (carries a hex letter)
  ok("an excluded outpoint is never selected, even as the best coin", selectInputs([best, other], 700, new Set([key(best)]))?.inputs[0]?.txid === other.txid);
  ok("exclusion can exhaust the pool → null", selectInputs([best], 100, new Set([key(best)])) === null);
  ok("exclude key is case-sensitive by contract: an UPPERCASE-txid key excludes NOTHING (the caller must lowercase)", selectInputs([best, other], 700, new Set([`0x${best.txid.slice(2).toUpperCase()}:${best.vout}`]))?.inputs[0]?.txid === best.txid);
  ok("2-arg call behavior unchanged (no exclude → best coin picked)", selectInputs([best, other], 700)?.inputs[0]?.txid === best.txid);
}

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

console.log("\n— max-fee backstop (UTXO-VALUE-1: no silent fund-burn via absurd fee) —");
{
  // honest fees pass: a tiny transfer fee, and a fee-only Propose at its 0.25 CSD floor.
  ok("normal transfer fee passes the backstop", buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 10, utxos: [utxo(1e9)], priv: PRIV }).ok === true);
  ok("Propose at the 0.25 CSD floor passes (under the 1 CSD abs cap)", buildPropose({ domain: "d", payloadHash: "0x" + "ab".repeat(32), uri: "u", expiresEpoch: 1, fee: MIN_FEE_PROPOSE, utxos: [utxo(1e9)], priv: PRIV }).ok === true);
  // ATTACK: a hostile RPC under-reports the input → the wrapper assembles a tx whose fee swallows
  // almost the whole input (change collapsed). Simulate by requesting an absurd fee on a small input.
  const burn = buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 990_000_000, utxos: [utxo(1_000_000_100)], priv: PRIV });
  ok("REFUSES an absurd fee that would burn ~all of the input (collapsed change)", burn.ok === false && /max-fee backstop/.test(String(burn.error)));
  // the backstop is both-conditions: a fee above 1 CSD but well within 10% of a large input is fine.
  ok("a 1+ CSD fee on a large input (≤10%) still passes", buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 200_000_000, utxos: [utxo(5_000_000_000)], priv: PRIV }).ok === true);
  // explicit override: a caller can deliberately authorize a higher fee.
  ok("maxFee override lets a deliberate high fee through", buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 990_000_000, utxos: [utxo(1_000_000_100)], priv: PRIV, maxFee: 1_000_000_000 }).ok === true);
  ok("a too-low maxFee can also tighten the cap (rejects an otherwise-fine fee)", buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 200_000_000, utxos: [utxo(5_000_000_000)], priv: PRIV, maxFee: 50_000_000 }).ok === false);
  // an attest's weight IS the user's deliberate stake — never blocked by the default backstop.
  ok("attest weight (its fee) is honored even above the abs cap", buildAttest({ proposalId: "0x" + "cd".repeat(32), score: 1, confidence: 1, fee: 300_000_000, utxos: [utxo(5e9)], priv: PRIV }).ok === true);
  ok("REFUSES a negative maxFee (range-guarded)", buildSend({ outputs: [{ to: RCPT, value: 100 }], fee: 10, utxos: [utxo(1e9)], priv: PRIV, maxFee: -1 }).ok === false);
}

console.log("\n— L4: hostile-RPC confirmations (NaN/Infinity bypass) —");
const bad = (c: unknown) => ({ txid: "0x" + "ab".repeat(32), vout: 0, value: 1000, confirmations: c as number });
ok("L4: NaN confirmations is REJECTED (NaN<1 is false)", selectInputs([bad(NaN)], 100) === null);
ok("L4: Infinity confirmations is REJECTED", selectInputs([bad(Infinity)], 100) === null);
ok("L4: string 'abc' confirmations (→NaN) is REJECTED", selectInputs([bad("abc")], 100) === null);
ok("L4: a real 6-conf coin is still accepted", selectInputs([bad(6)], 100)?.total === 1000);

console.log("\n— H2: buildSendVerified (UTXO-VALUE-1 implicit-fee-burn cure) —");
{
  const RCPT2 = "0x" + "cc".repeat(20);
  const u = (value: number) => ({ txid: "0x" + "ab".repeat(32), vout: 0, value, confirmations: 6, coinbase: false });
  // under-reported input: reported 1_000_000_100, REAL 5_000_000_000. Pure buildSend would compute change
  // from the reported value and burn the difference; buildSendVerified uses the VERIFIED total.
  const vr = await buildSendVerified({ outputs: [{ to: RCPT2, value: 100 }], fee: 10_000_000, utxos: [u(1_000_000_100)], priv: PRIV, verify: async () => ({ ok: true, total: 5_000_000_000 }) });
  ok("computes change from the VERIFIED total (no burn)", vr.ok === true && vr.inTotal === 5_000_000_000 && vr.change === 5_000_000_000 - 100 - 10_000_000);
  // fail-closed when verification fails
  const vf = await buildSendVerified({ outputs: [{ to: RCPT2, value: 100 }], fee: 10_000_000, utxos: [u(1_000_000_000)], priv: PRIV, verify: async () => ({ ok: false, total: 0 }) });
  ok("FAILS CLOSED when input verification fails (signs nothing)", vf.ok === false && vf.txid === undefined);
  // fail-closed when verify throws
  const vt = await buildSendVerified({ outputs: [{ to: RCPT2, value: 100 }], fee: 10_000_000, utxos: [u(1_000_000_000)], priv: PRIV, verify: async () => { throw new Error("rpc down"); } });
  ok("fails closed when verify throws", vt.ok === false);
  // over-reported input: reported 5e9 passes selection, but verified is only 50 → abort (no malformed tx)
  const vo = await buildSendVerified({ outputs: [{ to: RCPT2, value: 1_000_000_000 }], fee: 10_000_000, utxos: [u(5_000_000_000)], priv: PRIV, verify: async () => ({ ok: true, total: 50 }) });
  ok("aborts when the VERIFIED total is short (over-reported input)", vo.ok === false && /insufficient/.test(String(vo.error)));
  // honest case: verify confirms the reported value → same result as buildSend
  const vh = await buildSendVerified({ outputs: [{ to: RCPT2, value: 100 }], fee: 10_000_000, utxos: [u(5_000_000_000)], priv: PRIV, verify: async () => ({ ok: true, total: 5_000_000_000 }) });
  ok("honest verify → ok, change from the (true) total", vh.ok === true && vh.change === 5_000_000_000 - 100 - 10_000_000);
}

console.log("\n— F9-C: buildProposeVerified / buildAttestVerified (money-out board-post builders fail-closed) —");
{
  const u = (value: number) => ({ txid: "0x" + "ab".repeat(32), vout: 0, value, confirmations: 6, coinbase: false });
  const PH = "0x" + "ab".repeat(32), PID = "0x" + "cd".repeat(32);
  // honest verify → builds a Propose, change computed from the VERIFIED (higher) total → surplus not burned.
  const pv = await buildProposeVerified({ domain: "csd:board", payloadHash: PH, uri: "cairn:v1:abc", expiresEpoch: 9999, fee: MIN_FEE_PROPOSE, utxos: [u(1_000_000_100)], priv: PRIV, verify: async () => ({ ok: true, total: 5_000_000_000 }) });
  ok("buildProposeVerified honest → ok + app=Propose", pv.ok === true && pv.tx!.app.type === "Propose");
  ok("buildProposeVerified change from the VERIFIED total (no burn)", pv.inTotal === 5_000_000_000 && pv.change === 5_000_000_000 - MIN_FEE_PROPOSE);
  // fail-closed: verify {ok:false} → signs nothing (an under-reporting RPC can't trick a burn through).
  const pf = await buildProposeVerified({ domain: "d", payloadHash: PH, uri: "u", expiresEpoch: 1, fee: MIN_FEE_PROPOSE, utxos: [u(1_000_000_000)], priv: PRIV, verify: async () => ({ ok: false, total: 0 }) });
  ok("buildProposeVerified FAILS CLOSED when verify !ok (signs nothing)", pf.ok === false && pf.txid === undefined && !pf.nodeJson);
  const pt = await buildProposeVerified({ domain: "d", payloadHash: PH, uri: "u", expiresEpoch: 1, fee: MIN_FEE_PROPOSE, utxos: [u(1_000_000_000)], priv: PRIV, verify: async () => { throw new Error("rpc lied"); } });
  ok("buildProposeVerified fails closed when verify throws", pt.ok === false && !pt.nodeJson);
  ok("buildProposeVerified rejects sub-minimum fee (fee-floor twin)", (await buildProposeVerified({ domain: "d", payloadHash: PH, uri: "u", expiresEpoch: 1, fee: 1, utxos: [u(1e9)], priv: PRIV, verify: async () => ({ ok: true, total: 1e9 }) })).ok === false);

  const av = await buildAttestVerified({ proposalId: PID, score: 80, confidence: 60, fee: 5_000_000, utxos: [u(1_000_000_100)], priv: PRIV, verify: async () => ({ ok: true, total: 5_000_000_000 }) });
  ok("buildAttestVerified honest → ok + app=Attest + change from verified total", av.ok === true && av.tx!.app.type === "Attest" && av.inTotal === 5_000_000_000);
  const af = await buildAttestVerified({ proposalId: PID, score: 80, confidence: 60, fee: 5_000_000, utxos: [u(1_000_000_000)], priv: PRIV, verify: async () => ({ ok: false, total: 0 }) });
  ok("buildAttestVerified FAILS CLOSED when verify !ok (signs nothing)", af.ok === false && af.txid === undefined && !af.nodeJson);
  ok("buildAttestVerified rejects sub-minimum fee (fee-floor twin)", (await buildAttestVerified({ proposalId: PID, score: 1, confidence: 1, fee: 1, utxos: [u(1e9)], priv: PRIV, verify: async () => ({ ok: true, total: 1e9 }) })).ok === false);
  ok("buildAttestVerified honors the CONF_TOKEN_FILL marker confidence=1_000_000", (await buildAttestVerified({ proposalId: PID, score: 100, confidence: 1_000_000, fee: 5_000_000, utxos: [u(1e8)], priv: PRIV, verify: async () => ({ ok: true, total: 1e8 }) })).ok === true);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
