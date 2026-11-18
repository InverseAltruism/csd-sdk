// One block read from a node and bound: its header hashed and equal to the hash served, its prev equal to the block
// before when that is known, its body bound to the header's merkle root (csd-light bindBlockTxs), and the author of
// each picked transaction bound by csd-crypto authorOf to the owner of the coin its first input spends, read from the
// source transaction once its txid is recomputed (CONVENTION section 33.5). The source transaction is the block
// answer's `spent_tx` field when the answer carries one (P3) and it hashes to the spent id, else the node's /tx/:id.
// Every read bypasses HTTP caches (http.ts), so a refusal is final at once; a re-read with the cache bypassed is the
// hosted source's (slice 4), whose pages a cache may hold.
import type { EventRule } from "@inversealtruism/cairnx-core";
import { headerHash, txid as codecTxid, type BlockHeader, type Tx } from "@inversealtruism/csd-codec";
import { rpcHeaderToHeader, rpcTxToTx, type CsdClient, type RpcHeaderJson, type RpcTxJson } from "@inversealtruism/csd-client";
import { authorOf } from "@inversealtruism/csd-crypto";
import { bindBlockTxs, type BoundTx } from "@inversealtruism/csd-light";
import { SourceError, messageOf } from "./errors.js";
import type { Session } from "./http.js";
import type { AuthorScope, BoundBlock } from "./types.js";

/** The transactions of a bound block whose authors a read binds. */
export type Pick = (txs: readonly BoundTx[]) => readonly BoundTx[];
const PREFETCH = 4;

export const pickOf = (scope: AuthorScope, rule: EventRule): Pick => (txs) =>
  scope === "none" ? [] : txs.filter((t) => t.pos > 0 && (scope === "all" || t.tx.app.type === "Attest" ||
    (t.tx.app.type === "Propose" && t.tx.app.domain === rule.domain)));

function headerOf(v: unknown, height: number, prev: string | null): { hash: string; header: BlockHeader; txs: unknown } {
  const b = v as { height?: unknown; hash?: unknown; header?: RpcHeaderJson; txs?: unknown } | null;
  if (b === null || typeof b !== "object" || b.height !== height || typeof b.hash !== "string") {
    throw new SourceError("SOURCE_MALFORMED", `block ${height}: the answer is not the block at ${height}`);
  }
  let header: BlockHeader, hash: string;
  try {
    header = rpcHeaderToHeader(b.header as RpcHeaderJson);
    hash = headerHash(header);
  } catch (e) {
    throw new SourceError("SOURCE_MALFORMED", `block ${height}: the header does not encode (${messageOf(e)})`);
  }
  if (hash !== b.hash.toLowerCase()) throw new SourceError("HEADER_INVALID", `block ${height}: the header hashes to ${hash}, not ${b.hash}`);
  if (prev !== null && String(header.prev).toLowerCase() !== prev) throw new SourceError("BRANCH_MOVED", `block ${height} does not link to ${prev}`);
  return { hash, header, txs: b.txs };
}

// The transaction a node JSON decodes to when its txid is `id`, else the reason it is not.
function txWithId(json: unknown, id: string): Tx | string {
  try {
    const tx = rpcTxToTx(json as RpcTxJson), again = codecTxid(tx);
    return again === id ? tx : `it has the txid ${again}`;
  } catch (e) {
    return `it does not decode (${messageOf(e)})`;
  }
}

async function sourceTx(c: CsdClient, id: string, served: unknown): Promise<Tx> {
  const inBlock = served === undefined ? null : txWithId(served, id);
  if (inBlock !== null && typeof inBlock !== "string") return inBlock;
  const info = await c.tx(id);
  if (info?.ok !== true || info.tx === undefined) throw new SourceError("SOURCE_UNAVAILABLE", `the node does not have the source transaction ${id}`);
  const tx = txWithId(info.tx, id);
  if (typeof tx === "string") throw new SourceError("AUTHOR_UNBOUND", `the source transaction served for ${id}: ${tx}`);
  return tx;
}

async function authorOfMember(c: CsdClient, t: BoundTx, memo: Map<string, Promise<Tx>>): Promise<string> {
  const in0 = t.tx.inputs[0], id = in0?.prevTxid.toLowerCase() ?? "";
  if (in0 === undefined) throw new SourceError("AUTHOR_UNBOUND", `${t.txid} has no input`);
  let src = memo.get(id);
  if (src === undefined) memo.set(id, (src = sourceTx(c, id, (t.json as { spent_tx?: unknown }).spent_tx)));
  const out = (await src).outputs[in0.vout], author = out === undefined ? null : authorOf(t.tx, out.scriptPubkey);
  if (author === null) throw new SourceError("AUTHOR_UNBOUND", `${t.txid}: its first input is not signed by the owner of output ${in0.vout} of ${id}`);
  return author;
}

/** The block at `height`, bound, with the authors of `pick` bound; throws SourceError for what the node served. */
export async function readBound(s: Session, height: number, pick: Pick, prev: string | null): Promise<BoundBlock> {
  const c = s.client, { hash, header, txs } = headerOf(await c.blockByHeight(height), height, prev);
  // The own node is the header root, so its header is taken as given; bindBlockTxs reads only its height and merkle.
  const bound = bindBlockTxs(txs, { height, hash, header, chainwork: 0n, trusted: true });
  if (!bound.ok) throw new SourceError(bound.kind === "malformed" ? "SOURCE_MALFORMED" : "BODY_MISMATCH", bound.reason);
  const picked = pick(bound.txs), memo = new Map<string, Promise<Tx>>(), authors = new Map<string, string>();
  for (let i = 0; i < picked.length; i += PREFETCH) {
    const part = picked.slice(i, i + PREFETCH), got = await Promise.all(part.map((t) => authorOfMember(c, t, memo)));
    part.forEach((t, j) => authors.set(t.txid, got[j]!));
  }
  return { height, hash, header, txs: bound.txs, authors };
}
