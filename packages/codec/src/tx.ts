// Transaction types + the consensus bincode codec (fixint, little-endian).
//
// Encoding rules (verified against types/mod.rs + codec/mod.rs, golden-vector-gated):
//   u32/u64           → 4/8 raw LE bytes
//   Vec<T>            → u64 LE length prefix, then elements (fixint mode → NOT varint)
//   serde_bytes       → u64 LE length, then raw bytes (the script_sig)
//   [u8;N] fixed      → N raw bytes, no length prefix (Hash32/Hash20)
//   externally-tagged → u32 LE variant index, then fields in declaration order (AppPayload)
//   String            → u64 LE length, then UTF-8 bytes
// Field order is frozen: Transaction{version,inputs,outputs,locktime,app}.
//
//   txid    = sha256d(bincode(stripped_tx))
//   sighash = sha256d( tagged_hash("CSD_SIG_V1", bincode(stripped_tx) ‖ CHAIN_ID_HASH) )
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { hb, hx, hbFixed, u32, u64, lenBytes, sha256d } from "./bytes.js";
import { CHAIN_ID_HASH, MAX_TX_BYTES, MAX_TX_INPUTS, MAX_TX_OUTPUTS } from "./params.js";

export type App =
  | { type: "None" }
  | { type: "Propose"; domain: string; payloadHash: string; uri: string; expiresEpoch: number | bigint }
  | { type: "Attest"; proposalId: string; score: number; confidence: number };

export interface TxInput { prevTxid: string; vout: number; scriptSig: string }
export interface TxOutput { value: number | bigint; scriptPubkey: string }
export interface Tx { version: number; inputs: TxInput[]; outputs: TxOutput[]; locktime: number; app: App }

/** The coinbase input sentinel (prevTxid all-zero, vout 0xffffffff). Exported (Plan 57 B4) so
 *  scanners/tools stop re-typing the literals; the u32 writer's bounds-reject exists precisely
 *  because vout=-1 would forge COINBASE_VOUT. */
export const COINBASE_TXID = "0x" + "00".repeat(32);
export const COINBASE_VOUT = 0xffffffff;
export const isCoinbaseInput = (i: TxInput): boolean => i.prevTxid === COINBASE_TXID && i.vout === COINBASE_VOUT;

/** Strip script_sig from every non-coinbase input (the txid/sighash preimage). */
export function strippedTx(tx: Tx): Tx {
  return { ...tx, inputs: tx.inputs.map((i) => (isCoinbaseInput(i) ? i : { ...i, scriptSig: "0x" })) };
}

function serializeApp(app: App): Uint8Array {
  if (app.type === "None") return u32(0);
  if (app.type === "Propose")
    return concatBytes(u32(1), lenBytes(utf8ToBytes(app.domain)), hbFixed(app.payloadHash, 32), lenBytes(utf8ToBytes(app.uri)), u64(app.expiresEpoch));
  return concatBytes(u32(2), hbFixed(app.proposalId, 32), u32(app.score), u32(app.confidence));
}

/** Consensus bincode serialization of a transaction (as-is — does NOT strip). */
export function serialize(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [u32(tx.version), u64(tx.inputs.length)];
  for (const i of tx.inputs) parts.push(hbFixed(i.prevTxid, 32), u32(i.vout), lenBytes(hb(i.scriptSig)));
  parts.push(u64(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64(o.value), hbFixed(o.scriptPubkey, 20));
  parts.push(u32(tx.locktime), serializeApp(tx.app));
  return concatBytes(...parts);
}

/** txid = sha256d(bincode(stripped_tx)). */
export function txid(tx: Tx): string { return hx(sha256d(serialize(strippedTx(tx)))); }

/** tagged_hash(tag, msg) = sha256( sha256(tag) ‖ sha256(tag) ‖ msg ) — the frozen CSD construction. */
export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(t, t, msg));
}

/** sighash = sha256d( tagged_hash("CSD_SIG_V1", bincode(stripped_tx) ‖ CHAIN_ID_HASH) ). */
export function sighash(tx: Tx): string {
  return hx(sha256d(taggedHash("CSD_SIG_V1", concatBytes(serialize(strippedTx(tx)), CHAIN_ID_HASH))));
}

// ── deserialize (inverse of serialize) — for the light client / explorer reading raw bytes ──
class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array, private readonly dv = new DataView(b.buffer, b.byteOffset, b.byteLength)) {}
  // Bounds-check before the DataView read so a truncated body throws the codec's documented error
  // (not a native RangeError) — uniform failure mode for untrusted-bytes callers (audit L16).
  u32(): number { if (this.o + 4 > this.b.length) throw new Error("unexpected end of bytes"); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64(): bigint { if (this.o + 8 > this.b.length) throw new Error("unexpected end of bytes"); const v = this.dv.getBigUint64(this.o, true); this.o += 8; return v; }
  take(n: number): Uint8Array { const v = this.b.subarray(this.o, this.o + n); if (v.length !== n) throw new Error("unexpected end of bytes"); this.o += n; return v; }
  vec(): Uint8Array { return this.take(Number(this.u64())); }
  fixedHex(n: number): string { return hx(this.take(n)); }
  // fatal:true REJECTS invalid UTF-8 in domain/uri exactly as the Rust node's bincode read_string and
  // the Python reference do — restoring the byte round-trip and refusing bytes consensus rejects (NEW-2/L10).
  str(): string { return new TextDecoder("utf-8", { fatal: true }).decode(this.vec()); }
  get offset(): number { return this.o; }
  get length(): number { return this.b.length; }
}

function readApp(r: Reader): App {
  const tag = r.u32();
  if (tag === 0) return { type: "None" };
  if (tag === 1) return { type: "Propose", domain: r.str(), payloadHash: r.fixedHex(32), uri: r.str(), expiresEpoch: r.u64() };
  if (tag === 2) return { type: "Attest", proposalId: r.fixedHex(32), score: r.u32(), confidence: r.u32() };
  throw new Error(`unknown AppPayload variant ${tag}`);
}

/**
 * Parse consensus bincode bytes back into a Tx (mirror of `serialize`). Enforces the SAME limits the
 * Rust node does at the mempool boundary (MAX_TX_BYTES / MAX_TX_INPUTS / MAX_TX_OUTPUTS) and rejects
 * trailing bytes, so decoding untrusted bytes (e.g. from a gateway) can't be coerced into an
 * over-allocation, and a non-canonical encoding doesn't parse "successfully" (finding C-S1). The
 * length caps are checked BEFORE the read loops so a forged huge count is rejected immediately.
 */
export function deserialize(bytes: Uint8Array): Tx {
  if (bytes.length > MAX_TX_BYTES) throw new Error(`tx too large (${bytes.length} > MAX_TX_BYTES=${MAX_TX_BYTES})`);
  const r = new Reader(bytes);
  const version = r.u32();
  const nIn = Number(r.u64());
  if (nIn > MAX_TX_INPUTS) throw new Error(`too many inputs (${nIn} > MAX_TX_INPUTS=${MAX_TX_INPUTS})`);
  const inputs: TxInput[] = [];
  for (let i = 0; i < nIn; i++) inputs.push({ prevTxid: r.fixedHex(32), vout: r.u32(), scriptSig: hx(r.vec()) });
  const nOut = Number(r.u64());
  if (nOut > MAX_TX_OUTPUTS) throw new Error(`too many outputs (${nOut} > MAX_TX_OUTPUTS=${MAX_TX_OUTPUTS})`);
  const outputs: TxOutput[] = [];
  for (let i = 0; i < nOut; i++) outputs.push({ value: r.u64(), scriptPubkey: r.fixedHex(20) });
  const locktime = r.u32();
  const app = readApp(r);
  if (r.offset !== bytes.length) throw new Error(`trailing bytes after tx (${bytes.length - r.offset} extra) — non-canonical encoding`);
  return { version, inputs, outputs, locktime, app };
}
