// The block bind: a served block body is the block only when every tx, rebuilt from its body, hashes into the
// merkle root of a header the client verified itself. The one implementation the light client and every
// consumer that reads block bodies (site, wallet, cairn-sdk) share.
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

/** Bind already-parsed node txs to a verified header's merkle root. */
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
