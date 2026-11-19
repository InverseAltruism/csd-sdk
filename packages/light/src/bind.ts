// The block bind: a served block body is the block only when every tx, rebuilt from its body, hashes into the
// merkle root of a header the client verified itself, and every tx is in the node's text form. The one
// implementation the light client and every consumer that reads block bodies (site, wallet, cairn-sdk) share.
import { merkleRoot, txid as codecTxid, type Tx, type TxInput } from "@inversealtruism/csd-codec";
import { parseJsonExact, rpcTxToTx, type RpcTxJson } from "@inversealtruism/csd-client";
import type { VerifiedHeader } from "./index.js";

/** A scriptSig as served. The txid and the merkle root do not commit it, so it attributes nothing on its own:
 *  csd-crypto `authorOf` binds it to the coin the input spends. */
export type UnprovenScriptSig = string & { readonly unproven: "scriptSig is not committed by the txid" };
export type BoundTxBody = Omit<Tx, "inputs"> & { inputs: (Omit<TxInput, "scriptSig"> & { scriptSig: UnprovenScriptSig })[] };

/** One tx of a bound block: its position, its txid re-derived from the body, the body as a codec Tx, and the
 *  node JSON it was rebuilt from. */
export interface BoundTx { pos: number; txid: string; tx: BoundTxBody; json: RpcTxJson }

export type BlockBind =
  | { ok: true; txs: BoundTx[] }
  | { ok: false; kind: "malformed" | "duplicate-txid" | "body-mismatch"; reason: string };

// The node writes every hash, address and script of a tx as 0x and lower-case hex. The codec also reads one without
// 0x or in upper case, and rpcTxToTx rebuilds any app type other than None and Propose as an Attest, to the same
// bytes, so such a body matches the merkle root while a consumer that compares the field as text drops its record.
const HASH = /^0x[0-9a-f]{64}$/, ADDR = /^0x[0-9a-f]{40}$/, BYTES = /^0x(?:[0-9a-f]{2})*$/;
const offForm = (v: unknown, form: RegExp): boolean => typeof v !== "string" || !form.test(v);

/** The first field of a tx that rebuilt without error which is not in the node's text form, or null. */
function nonCanonicalField(j: RpcTxJson): string | null {
  for (const [k, i] of j.inputs.entries()) {
    if (offForm(i.prev_txid, HASH)) return `inputs[${k}].prev_txid`;
    if (offForm(i.script_sig, BYTES)) return `inputs[${k}].script_sig`;
  }
  for (const [k, o] of j.outputs.entries()) if (offForm(o.script_pubkey, ADDR)) return `outputs[${k}].script_pubkey`;
  const app = j.app, type: unknown = app.type;
  if (app.type === "Propose") return offForm(app.payload_hash, HASH) ? "app.payload_hash" : null;
  if (app.type === "Attest") return offForm(app.proposal_id, HASH) ? "app.proposal_id" : null;
  return type === "None" ? null : "app.type";
}

/** Bind already-parsed node txs to a verified header's merkle root. A tx not in the node's text form (every hash,
 *  address and script as 0x and lower-case hex, the app type None, Propose or Attest) is refused as body-mismatch. */
export function bindBlockTxs(txs: unknown, verified: VerifiedHeader): BlockBind {
  const h = verified.height;
  if (!Array.isArray(txs)) return { ok: false, kind: "malformed", reason: `block ${h}: the body has no tx list` };
  const out: BoundTx[] = [];
  for (let pos = 0; pos < txs.length; pos++) {
    const j = txs[pos] as RpcTxJson;
    // A tx served without `app` is rebuilt as app None: the merkle compare below still decides, and a tx with
    // the field dropped does not make the whole block unreadable.
    const json = j && typeof j === "object" && !j.app ? { ...j, app: { type: "None" as const } } : j;
    let tx: Tx, id: string;
    try { tx = rpcTxToTx(json); id = codecTxid(tx); }
    catch (e) { return { ok: false, kind: "malformed", reason: `block ${h}: tx ${pos} does not decode (${(e as Error)?.message ?? e})` }; }
    const field = nonCanonicalField(json);
    if (field !== null) return { ok: false, kind: "body-mismatch", reason: `block ${h}: tx ${pos} serves ${field} in a text form the node does not write` };
    out.push({ pos, txid: id, tx: tx as BoundTxBody, json });
  }
  const ids = out.map((t) => t.txid.toLowerCase());
  // merkleRoot pairs an odd last node with itself, so a body that repeats its last tx hashes to the honest root
  // (CVE-2012-2459); a valid block holds each txid once.
  if (new Set(ids).size !== ids.length)
    return { ok: false, kind: "duplicate-txid", reason: `block ${h} repeats a txid (a malleated body)` };
  if (merkleRoot(ids).toLowerCase() !== String(verified.header.merkle).toLowerCase())
    return { ok: false, kind: "body-mismatch", reason: `block ${h} does not match its verified merkle root` };
  return { ok: true, txs: out };
}

/** Bind a node `/block` response body, as text, to a header the caller verified (PoW, LWMA, links). The text is
 *  parsed with parseJsonExact, so a u64 above 2^53 keeps its exact value through the txid recompute. */
export function bindBlockBody(bodyText: string, verified: VerifiedHeader): BlockBind {
  let body: unknown;
  try { body = parseJsonExact(bodyText); }
  catch (e) { return { ok: false, kind: "malformed", reason: `block ${verified.height}: the body is not JSON (${(e as Error)?.message ?? e})` }; }
  const b = body as { ok?: unknown; txs?: unknown } | null;
  if (!b || typeof b !== "object" || b.ok === false) return { ok: false, kind: "malformed", reason: `block ${verified.height}: the node returned no block` };
  return bindBlockTxs(b.txs, verified);
}
