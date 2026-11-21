// A csd-indexer over cairnx-core's recorded block fixture (29,860 to 117,000, every transaction with an app payload, the
// author bound when it was recorded): the answers the Scanner reads, in csd-indexer's orders. Proposals are the
// fixture's cairnx:v1 Proposes, attestations its Attests listed under their proposal, /tx the decoded outputs. The
// fixture records the hash of its blocks with a transaction and of its last; another height's hash is a stand-in
// derived from the height. The chain-order feeds answer 404, so every scan is a full pull.
import { createHash } from "node:crypto";
import { DOMAIN } from "@inversealtruism/cairnx-core";
import type { BlockFixture, FixtureTx } from "../src/testing.js";

type Row = { tx: FixtureTx; height: number };
const byHeightTxid = (a: Row, b: Row) => a.height - b.height || (a.tx.txid < b.tx.txid ? -1 : a.tx.txid > b.tx.txid ? 1 : 0);
const epochRow = (v: unknown) => (BigInt(String(v)) > BigInt(Number.MAX_SAFE_INTEGER) ? 2 ** 53 : Number(v));

/** The indexer at `tip` (default the fixture's last height): a fetch over the fixture. */
export function captureIndexer(fx: BlockFixture, tip = fx.to): typeof fetch {
  const known = new Map<number, string>([[fx.to, fx.toHash], ...fx.blocks.map((b) => [b.height, b.hash] as [number, string])]);
  const hashAt = (h: number) => known.get(h) ?? "0x" + createHash("sha256").update(`capture:${h}`).digest("hex");
  const rows: Row[] = fx.blocks.filter((b) => b.height <= tip).flatMap((b) => b.txs.map((tx) => ({ tx, height: b.height })));
  const proposals = rows.filter((r) => r.tx.app.type === "Propose" && r.tx.app.domain === DOMAIN).sort(byHeightTxid);
  const byTxid = new Map(rows.map((r) => [r.tx.txid, r]));
  const attestations = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.tx.app.type === "Attest").sort(byHeightTxid)) {
    const pid = String(r.tx.app.proposalId).toLowerCase(), list = attestations.get(pid);
    if (list) list.push(r); else attestations.set(pid, [r]);
  }
  const answer = (path: string, q: URLSearchParams): unknown => {
    if (path === "/blocks/tip/height") return tip;
    if (path.startsWith("/block-height/")) { const h = Number(path.slice(14)); return h <= tip ? hashAt(h) : undefined; }
    if (path === `/domain/${DOMAIN}/proposals`) {
      const from = Number(q.get("from") ?? 0), limit = Number(q.get("limit") ?? 10_000);
      return proposals.filter((r) => r.height >= from).slice(0, limit).map(({ tx, height }) => ({
        txid: tx.txid, domain: DOMAIN, payload_hash: tx.app.payloadHash, uri: tx.app.uri, expires_epoch: epochRow(tx.app.expiresEpoch),
        proposer: tx.author, height,
      }));
    }
    const att = /^\/proposal\/(0x[0-9a-f]{64})\/attestations$/.exec(path);
    if (att) {
      const limit = Number(q.get("limit") ?? 5000), ah = q.get("after_height"), at = q.get("after_txid");
      return (attestations.get(att[1]!) ?? [])
        .filter((r) => ah === null || r.height > Number(ah) || (r.height === Number(ah) && r.tx.txid > String(at)))
        .slice(0, limit).map(({ tx, height }) => ({ txid: tx.txid, attester: tx.author, score: tx.app.score, confidence: tx.app.confidence, height }));
    }
    const id = /^\/tx\/(0x[0-9a-f]{64})$/.exec(path)?.[1], r = id === undefined ? undefined : byTxid.get(id);
    if (r) return { txid: r.tx.txid, height: r.height, pos: r.tx.pos, outputs: r.tx.outputs.map((o) => ({ addr: o.scriptPubkey, value: Number(o.value) })) };
    return undefined;
  };
  return (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = answer(decodeURIComponent(u.pathname), u.searchParams);
    return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
  }) as typeof fetch;
}
