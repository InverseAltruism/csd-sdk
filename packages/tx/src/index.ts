// @csd/tx — Compute Substrate transaction builder. p2pkh-only (no scripts), so far simpler
// than Bitcoin: one sighash signs ALL inputs (CSD blanks every input in the sighash), change
// always returns to the sender. Coin selection is hardened against a hostile/buggy RPC.
import { type Tx, type TxOutput, type App, serialize, txid, sighash, MAX_TX_INPUTS, MIN_FEE_PROPOSE, MIN_FEE_ATTEST } from "@csd/codec";
import { addrFromPriv, signDigest, buildScriptSig, isValidAddr } from "@csd/crypto";

export interface Utxo { txid: string; vout: number; value: number; confirmations?: number; coinbase?: boolean }
export interface Selection { inputs: { txid: string; vout: number; value: number }[]; total: number }

/**
 * Greedy largest-first coin selection. Prefers mature non-coinbase coins; HARDENED against a
 * hostile/buggy RPC: missing confirmations → 0 (unspendable), dedupe by (case-normalized)
 * outpoint, drop non-positive/unsafe values, refuse to exceed the consensus input cap, and
 * safe-integer-guard the running sum so no mis-signed value can slip in.
 */
export function selectInputs(utxos: Utxo[], need: number): Selection | null {
  const seen = new Set<string>();
  const confirmed = utxos.filter((x) => {
    if (Number(x.confirmations ?? 0) < 1) return false;
    const v = Number(x.value);
    if (!Number.isFinite(v) || v <= 0 || !Number.isSafeInteger(v)) return false;
    const key = `${String(x.txid).toLowerCase()}:${Number(x.vout)}`;
    if (seen.has(key)) return false; seen.add(key);
    return true;
  });
  const take = (pool: Utxo[]): Selection | null => {
    const inputs: { txid: string; vout: number; value: number }[] = []; let total = 0;
    for (const x of [...pool].sort((a, b) => Number(b.value) - Number(a.value))) {
      const v = Number(x.value); total += v;
      if (!Number.isSafeInteger(total)) return null;
      inputs.push({ txid: x.txid, vout: Number(x.vout), value: v });
      if (inputs.length > MAX_TX_INPUTS) return null;
      if (total >= need) return { inputs, total };
    }
    return null;
  };
  return take(confirmed.filter((x) => !x.coinbase)) ?? take(confirmed);
}

/** Exact serialized byte size of a tx (deterministic — no scripts/witness). */
export function txSize(tx: Tx): number { return serialize(tx).length; }

// ── node-submit JSON (serde external tagging; hashes as byte arrays) ──
const bytesArr = (hex: string): number[] => Array.from(hex.startsWith("0x") ? hexToU8(hex.slice(2)) : hexToU8(hex));
function hexToU8(h: string): Uint8Array { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; }
function appToJson(app: App): unknown {
  if (app.type === "None") return "None";
  if (app.type === "Propose") return { Propose: { domain: app.domain, payload_hash: bytesArr(app.payloadHash), uri: app.uri, expires_epoch: Number(app.expiresEpoch) } };
  return { Attest: { proposal_id: bytesArr(app.proposalId), score: app.score, confidence: app.confidence } };
}
export function txToNodeJson(tx: Tx): any {
  return {
    version: tx.version, locktime: tx.locktime, app: appToJson(tx.app),
    inputs: tx.inputs.map((i) => ({ prevout: { txid: bytesArr(i.prevTxid), vout: i.vout }, script_sig: bytesArr(i.scriptSig) })),
    outputs: tx.outputs.map((o) => ({ value: Number(o.value), script_pubkey: bytesArr(o.scriptPubkey) })),
  };
}

export interface Signed { tx: Tx; txid: string; sighash: string; nodeJson: any }

/** Sign an already-constructed tx. One sighash signs all inputs (CSD blanks every input). */
export function signTx(tx: Tx, priv: string): Signed {
  const sh = sighash(tx);
  const { sig64, pub33 } = signDigest(sh, priv);
  const ss = buildScriptSig(sig64, pub33);
  const signed: Tx = { ...tx, inputs: tx.inputs.map((i) => ({ ...i, scriptSig: ss })) };
  return { tx: signed, txid: txid(signed), sighash: sh, nodeJson: txToNodeJson(signed) };
}

export interface BuildResult extends Partial<Signed> { ok: boolean; error?: string; change?: number; inTotal?: number; fee?: number }

function selectAndAssemble(utxos: Utxo[], outs: TxOutput[], fee: number, app: App, priv: string): BuildResult {
  if (!Number.isSafeInteger(fee) || fee < 0) return { ok: false, error: "fee out of range" };
  let sumOut = 0;
  for (const o of outs) {
    if (!isValidAddr(String(o.scriptPubkey))) return { ok: false, error: "each recipient must be a 0x… 20-byte address" };
    const v = Number(o.value);
    if (!(v >= 0) || !Number.isSafeInteger(v)) return { ok: false, error: "each amount must be a non-negative safe integer" };
    sumOut += v; if (!Number.isSafeInteger(sumOut)) return { ok: false, error: "total outputs exceed safe-integer range" };
  }
  const addr = addrFromPriv(priv);
  const need = sumOut + fee;
  const sel = selectInputs(utxos, need);
  if (!sel) return { ok: false, error: "insufficient confirmed balance for outputs + fee" };
  const change = sel.total - need;
  const outputs: TxOutput[] = [...outs];
  if (change > 0) outputs.push({ value: change, scriptPubkey: addr });
  const tx: Tx = { version: 1, locktime: 0, app, inputs: sel.inputs.map((i) => ({ prevTxid: i.txid, vout: i.vout, scriptSig: "0x" })), outputs };
  return { ok: true, ...signTx(tx, priv), change, inTotal: sel.total, fee };
}

/** Build + sign a 1→many transfer (None app). Change → sender. */
export function buildSend(p: { outputs: { to: string; value: number }[]; fee: number; utxos: Utxo[]; priv: string }): BuildResult {
  if (!p.outputs?.length) return { ok: false, error: "at least one output required" };
  for (const o of p.outputs) if (!(Number(o.value) > 0)) return { ok: false, error: "each send amount must be positive" };
  const outs: TxOutput[] = p.outputs.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return selectAndAssemble(p.utxos, outs, p.fee, { type: "None" }, p.priv);
}

/** Build + sign a Propose (fee paid via input−change; no value output beyond change). */
export function buildPropose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; utxos: Utxo[]; priv: string }): BuildResult {
  if (p.fee < MIN_FEE_PROPOSE) return { ok: false, error: `propose fee must be ≥ ${MIN_FEE_PROPOSE} (0.25 CSD)` };
  return selectAndAssemble(p.utxos, [], p.fee, { type: "Propose", domain: p.domain, payloadHash: p.payloadHash, uri: p.uri, expiresEpoch: p.expiresEpoch }, p.priv);
}

/** Build + sign an Attest (fee = weight). */
export function buildAttest(p: { proposalId: string; score: number; confidence: number; fee: number; utxos: Utxo[]; priv: string }): BuildResult {
  if (p.fee < MIN_FEE_ATTEST) return { ok: false, error: `attest fee must be ≥ ${MIN_FEE_ATTEST} (0.05 CSD)` };
  return selectAndAssemble(p.utxos, [], p.fee, { type: "Attest", proposalId: p.proposalId, score: p.score >>> 0, confidence: p.confidence >>> 0 }, p.priv);
}

export type { Tx, TxInput, TxOutput, App } from "@csd/codec";
