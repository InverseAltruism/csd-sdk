// @inversealtruism/csd-tx — Compute Substrate transaction builder. p2pkh-only (no scripts), so far simpler
// than Bitcoin: one sighash signs ALL inputs (CSD blanks every input in the sighash), change
// always returns to the sender. Coin selection is hardened against a hostile/buggy RPC.
import { type Tx, type TxOutput, type App, serialize, txid, sighash, MAX_TX_INPUTS, MIN_FEE_PROPOSE, MIN_FEE_ATTEST } from "@inversealtruism/csd-codec";
import { addrFromPriv, signDigest, buildScriptSig, isValidAddr } from "@inversealtruism/csd-crypto";

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
/**
 * Encode a u64 field for the node's serde-JSON submit shape. The node parses these from a BARE JSON
 * integer (serde u64 — full precision, but rejects strings); JS Numbers lose precision above 2^53 and
 * JSON cannot emit a bigint as a bare literal. So a value beyond MAX_SAFE_INTEGER cannot be submitted
 * faithfully — REFUSE it loudly rather than `Number()`-truncating, which would make the SUBMITTED json
 * differ from the SIGNED bytes (the sig/txid commit to the exact u64). Mirrors the codec u64 guard.
 * At CSD emission rates 2^53 sats (~90M CSD) is unreachable for years; >2^53-sat single outputs are a
 * documented limit, not a silent corruption. (Confirms/closes finding C-S2/A2, 2026-06-08 baseline.)
 */
function u64Json(v: number | bigint, field: string): number {
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error(`${field} must be an integer, got ${v}`);
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n) throw new Error(`${field} must be non-negative, got ${v}`);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field}=${v} exceeds JSON-safe u64 range (2^53-1); cannot submit without value corruption`);
  return Number(n);
}
function appToJson(app: App): unknown {
  if (app.type === "None") return "None";
  if (app.type === "Propose") return { Propose: { domain: app.domain, payload_hash: bytesArr(app.payloadHash), uri: app.uri, expires_epoch: u64Json(app.expiresEpoch, "expires_epoch") } };
  return { Attest: { proposal_id: bytesArr(app.proposalId), score: app.score, confidence: app.confidence } };
}
export function txToNodeJson(tx: Tx): any {
  return {
    version: tx.version, locktime: tx.locktime, app: appToJson(tx.app),
    inputs: tx.inputs.map((i) => ({ prevout: { txid: bytesArr(i.prevTxid), vout: i.vout }, script_sig: bytesArr(i.scriptSig) })),
    outputs: tx.outputs.map((o) => ({ value: u64Json(o.value, "output.value"), script_pubkey: bytesArr(o.scriptPubkey) })),
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
  const signed = signTx(tx, priv);
  // Node mempool rule (net/mempool.rs): feerate_ppm = fee*1e6/bytes must be ≥ MIN_FEERATE_PPM (=1),
  // i.e. fee*1e6 ≥ (signed) tx_bytes. Without this, buildSend({fee:0}) returns ok:true for a tx the
  // node rejects with "feerate too low" — a silent build-success/broadcast-failure (the same
  // looks-like-success class as the lagging-mempool fund-burn incident). Propose/Attest clear this
  // trivially via their own floors; this guards the None path.
  const bytes = serialize(signed.tx).length;
  if (fee * 1_000_000 < bytes) {
    return { ok: false, error: `fee ${fee} below the node feerate floor (need ≥ ${Math.ceil(bytes / 1_000_000)} for a ${bytes}-byte tx)` };
  }
  return { ok: true, ...signed, change, inTotal: sel.total, fee };
}

/** Build + sign a 1→many transfer (None app). Change → sender. */
export function buildSend(p: { outputs: { to: string; value: number }[]; fee: number; utxos: Utxo[]; priv: string }): BuildResult {
  if (!p.outputs?.length) return { ok: false, error: "at least one output required" };
  for (const o of p.outputs) if (!(Number(o.value) > 0)) return { ok: false, error: "each send amount must be positive" };
  const outs: TxOutput[] = p.outputs.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return selectAndAssemble(p.utxos, outs, p.fee, { type: "None" }, p.priv);
}

// Consensus fact F4: a Propose/Attest tx's value outputs are UNRESTRICTED — one tx can carry an
// app payload AND pay arbitrary addresses. That is the chain's native delivery-versus-payment
// kernel (a CairnX "fill" = an Attest whose same tx pays the seller; a fee-bearing record = a
// Propose whose same tx pays the treasury). `outputs` makes that shape first-class so consumers
// stop re-implementing the validate→select→change→sign pipeline (and silently losing this
// file's hardening, e.g. the feerate floor).
const valueOuts = (outputs?: { to: string; value: number }[]): TxOutput[] | { error: string } => {
  const outs: TxOutput[] = [];
  for (const o of outputs ?? []) {
    if (!(Number(o.value) > 0)) return { error: "each value output must be positive" };
    outs.push({ value: Number(o.value), scriptPubkey: String(o.to) });
  }
  return outs;
};

/** Build + sign a Propose. Optional `outputs` ride in the SAME tx (atomic payment + record). */
export function buildPropose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; utxos: Utxo[]; priv: string; outputs?: { to: string; value: number }[] }): BuildResult {
  if (p.fee < MIN_FEE_PROPOSE) return { ok: false, error: `propose fee must be ≥ ${MIN_FEE_PROPOSE} (0.25 CSD)` };
  const outs = valueOuts(p.outputs);
  if ("error" in outs) return { ok: false, error: outs.error };
  return selectAndAssemble(p.utxos, outs, p.fee, { type: "Propose", domain: p.domain, payloadHash: p.payloadHash, uri: p.uri, expiresEpoch: p.expiresEpoch }, p.priv);
}

/** Build + sign an Attest (fee = weight). Optional `outputs` ride in the SAME tx (atomic DvP). */
export function buildAttest(p: { proposalId: string; score: number; confidence: number; fee: number; utxos: Utxo[]; priv: string; outputs?: { to: string; value: number }[] }): BuildResult {
  if (p.fee < MIN_FEE_ATTEST) return { ok: false, error: `attest fee must be ≥ ${MIN_FEE_ATTEST} (0.05 CSD)` };
  // REJECT (don't silently `>>>0`-wrap) out-of-range score/confidence: a wrap changes the caller's
  // intent into different signed bytes (e.g. CairnX's CONF_TOKEN_FILL=1_000_000 marker must commit
  // exactly). The codec u32 guard would also catch it now, but failing here gives a clear field name.
  if (!Number.isSafeInteger(p.score) || p.score < 0 || p.score > 0xffff_ffff) return { ok: false, error: `score ${p.score} out of u32 range` };
  if (!Number.isSafeInteger(p.confidence) || p.confidence < 0 || p.confidence > 0xffff_ffff) return { ok: false, error: `confidence ${p.confidence} out of u32 range` };
  const outs = valueOuts(p.outputs);
  if ("error" in outs) return { ok: false, error: outs.error };
  return selectAndAssemble(p.utxos, outs, p.fee, { type: "Attest", proposalId: p.proposalId, score: p.score, confidence: p.confidence }, p.priv);
}

export type { Tx, TxInput, TxOutput, App } from "@inversealtruism/csd-codec";
