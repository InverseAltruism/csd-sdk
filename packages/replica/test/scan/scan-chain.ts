// A mock chain for Scanner tests: every record is a real consensus tx (codec txid), every block's merkle
// root is built from its txids in position order, so Scanner.verifyTx runs unmodified against it. The
// indexer side serves the csd-indexer endpoints the Scanner reads (proposal cursor, attestation keyset,
// the chain-order feeds, /tx, merkle proofs, block hashes); the node side serves the verifyInclusion sources.
import { createHash } from "node:crypto";
import { txid as codecTxid, merkleRoot, merkleBranch, sighash, type Tx } from "@inversealtruism/csd-codec";
import { addrFromPriv, buildScriptSig, signDigest } from "@inversealtruism/csd-crypto";
import { deploy, mint, transfer, type BuiltRecord } from "@inversealtruism/cairnx-core";
import { ACTIVATION_HEIGHT, DOMAIN, EPOCH_LEN, type ChainEvent } from "@inversealtruism/cairnx-core";
import type { ScanOptions } from "../../src/scanner.js";

export const A = "0x" + "aa".repeat(20);
export const B = "0x" + "bb".repeat(20);
export const C = "0x" + "cc".repeat(20);
export const H0 = ACTIVATION_HEIGHT + 40;      // below V11: deploys are fee-free, outputs do not gate them
/** The header time, in seconds, every chain here gives the block at `h`: 120 seconds apart. */
export const timeAt = (h: number): number => 1_700_000_000 + h * 120;
/** Key-derived actors for flag-on chains (a body's signer is recovered from a real signature). */
const privOf = (n: number) => n.toString(16).padStart(64, "0");
export const KA = addrFromPriv(privOf(0xa1)).toLowerCase(), KB = addrFromPriv(privOf(0xb1)).toLowerCase(), KC = addrFromPriv(privOf(0xc1)).toLowerCase();
export const KEYS: Record<string, string> = { [KA]: privOf(0xa1), [KB]: privOf(0xb1), [KC]: privOf(0xc1) };
/** Sign `tx`'s first input with `priv` over the codec sighash, as a wallet does; the txid does not change. */
export function signInput0<T extends Tx>(tx: T, priv: string): T {
  const { sig64, pub33 } = signDigest(sighash(tx), priv);
  tx.inputs[0]!.scriptSig = buildScriptSig(sig64, pub33).slice(2);
  return tx;
}

/** `bare`: the tx has no outputs. `pos` places the tx in its block (default: after the specs before it there). */
type ProposeSpec = { kind: "propose"; rec: BuiltRecord; proposer: string; height: number; pos?: number; expiresEpoch?: number | bigint; domain?: string; bare?: boolean };
type AttestSpec = { kind: "attest"; of: number; attester: string; score: number; confidence: number; height: number; pos?: number };
export type Spec = ProposeSpec | AttestSpec;

export interface ChainTx { txid: string; tx: Tx; height: number; pos: number; spec: Spec; proposalId?: string; expiresEpoch?: number | bigint }
/** Row fields a lying indexer serves for one txid in place of the true ones (`proposal_id` moves an attestation to
 *  another proposal's list). */
export type Forge = Record<string, Record<string, unknown>>;
/** The indexer's expires_epoch column: an epoch past 2^53 - 1 is stored as 2^53 (csd-indexer safeEpoch). */
const rowEpoch = (e: number | bigint | undefined) => (typeof e === "bigint" ? (e > BigInt(Number.MAX_SAFE_INTEGER) ? 2 ** 53 : Number(e)) : e);

const DEFAULT_ACTORS = { A, B, C };
/** The default chain: a deploy, mints and a transfer spread over 16 blocks, two txs sharing one block,
 *  attestations on the deploy, and a short-window proposal whose window closes early. */
export const defaultSpecs = ({ A, B, C }: { A: string; B: string; C: string } = DEFAULT_ACTORS): Spec[] => {
  const dep = deploy({ ticker: "DUST", decimals: 2, supply: "1000000", mint: "open", mintLimit: "1000" });
  return [
    { kind: "propose", rec: dep, proposer: A, height: H0 },
    { kind: "propose", rec: mint({ ticker: "DUST", amount: "100" }), proposer: A, height: H0 + 3 },
    { kind: "attest", of: 0, attester: B, score: 7, confidence: 100, height: H0 + 4 },
    { kind: "propose", rec: mint({ ticker: "DUST", amount: "200" }), proposer: B, height: H0 + 6 },
    { kind: "propose", rec: mint({ ticker: "DUST", amount: "300" }), proposer: C, height: H0 + 6 },
    { kind: "propose", rec: transfer({ ticker: "DUST", to: C, amount: "50" }), proposer: A, height: H0 + 8 },
    { kind: "propose", rec: mint({ ticker: "DUST", amount: "400" }), proposer: A, height: H0 + 9 },
    { kind: "attest", of: 0, attester: C, score: 3, confidence: 100, height: H0 + 10 },
    { kind: "propose", rec: transfer({ ticker: "DUST", to: B, amount: "25" }), proposer: C, height: H0 + 12 },
    { kind: "propose", rec: mint({ ticker: "DUST", amount: "500" }), proposer: B, height: H0 + 15 },
  ];
};

/** `keys` (address -> private key) signs each record of a listed signer: its tx gets one input, spending output 0 of
 *  a source tx that pays the signer (the node serves it), whose scriptSig the key signs, and its output pays PAYEE, so
 *  the author can come only from the spent coin and the scriptSig. Without keys every tx has no inputs and pays its
 *  signer, as before. */
export const PAYEE = "0x" + "dd".repeat(20);
/** `forks` are the branches the chain took, oldest first: from each one's `from` height up its block hashes are its own,
 *  so two chains built from specs that share a prefix (which keeps their txids) model a reorg. */
export function buildChain(specs: Spec[], { keys = {} as Record<string, string>, forks = [] }: { keys?: Record<string, string>; forks?: { name: string; from: number }[] } = {}) {
  const txs: ChainTx[] = [];
  const sources = new Map<string, Tx>();
  const fund = (salt: string, owner: string): string => {
    const tx = { version: 1, locktime: 0, inputs: [{ prevTxid: salt, vout: 0, scriptSig: "" }],
      outputs: [{ value: 1_000_000, scriptPubkey: owner.slice(2) }], app: { type: "None" } } as Tx;
    const id = codecTxid(tx);
    sources.set(id, tx);
    return id;
  };
  const posAt = new Map<number, number>();
  specs.forEach((s, i) => {
    const pos = s.pos ?? posAt.get(s.height) ?? 0;
    posAt.set(s.height, pos + 1);
    const signer = s.kind === "propose" ? s.proposer : s.attester;
    const priv = keys[signer];
    const out = s.kind === "propose" && s.bare ? [] : [{ value: 1000 + i, scriptPubkey: (priv ? PAYEE : signer).slice(2) }];
    const inputs = priv ? [{ prevTxid: fund("0x" + (i + 1).toString(16).padStart(64, "0"), signer), vout: 0, scriptSig: "" }] : [];
    let tx: Tx, proposalId: string | undefined, expiresEpoch: number | bigint | undefined;
    if (s.kind === "propose") {
      expiresEpoch = s.expiresEpoch ?? Math.floor(s.height / EPOCH_LEN) + 1000;
      tx = { version: 1, inputs, outputs: out, locktime: 0,
        app: { type: "Propose", domain: s.domain ?? DOMAIN, payloadHash: s.rec.payloadHash, uri: s.rec.uri, expiresEpoch } } as Tx;
    } else {
      const target = txs[s.of];
      if (!target) throw new Error(`spec ${i} attests spec ${s.of}, which comes later or does not exist`);
      proposalId = target.txid;
      tx = { version: 1, inputs, outputs: out, locktime: 0,
        app: { type: "Attest", proposalId, score: s.score, confidence: s.confidence } } as Tx;
    }
    if (priv) signInput0(tx, priv);
    txs.push({ txid: codecTxid(tx), tx, height: s.height, pos, spec: s, proposalId, expiresEpoch });
  });
  const byId = new Map(txs.map((x) => [x.txid, x]));
  const blockIds = (h: number) => txs.filter((x) => x.height === h).sort((a, b) => a.pos - b.pos).map((x) => x.txid);
  const rootAt = (h: number) => merkleRoot(blockIds(h));
  const hashAt = (h: number) => {
    const fork = forks.filter((f) => h >= f.from).pop();
    return fork ? "0x" + createHash("sha256").update(`${fork.name}:${h}`).digest("hex") : "0x" + h.toString(16).padStart(64, "0");
  };

  /** The indexer at `tip`. `rowHeight` overrides the height a proposal/attestation ROW reports (the /tx and
   *  merkle-proof endpoints keep the true height): a lying feed that reorders events. `feed: false` is an indexer
   *  without the chain-order feeds (/proposals, /attestations answer 404). */
  const indexer = ({ tip, rowHeight = {} as Record<string, number>, forge = {} as Forge, feed = true }: { tip: number; rowHeight?: Record<string, number>; forge?: Forge; feed?: boolean }) => {
    const visible = txs.filter((x) => x.height <= tip);
    const rh = (x: ChainTx) => rowHeight[x.txid] ?? x.height;
    const proposalRow = (x: ChainTx) => {
      const s = x.spec as ProposeSpec;
      return { txid: x.txid, domain: DOMAIN, payload_hash: s.rec.payloadHash, uri: s.rec.uri,
        expires_epoch: rowEpoch(x.expiresEpoch), proposer: s.proposer, height: rh(x), time: 0, ...forge[x.txid] };
    };
    const proposalOf = (x: ChainTx) => String(forge[x.txid]?.proposal_id ?? x.proposalId);
    const attestRow = (x: ChainTx) => {
      const s = x.spec as AttestSpec;
      const { proposal_id: _moved, ...f } = forge[x.txid] ?? {};
      return { txid: x.txid, attester: s.attester, score: s.score, confidence: s.confidence, height: rh(x), ...f };
    };
    const txidOrder = (a: ChainTx, b: ChainTx) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0);
    return (async (url: string) => {
      const u = new URL(url);
      const p = decodeURIComponent(u.pathname);
      const q = u.searchParams;
      const J = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
      const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response;
      const miss = status(404);
      if (p === "/blocks/tip/height") return J(tip);
      if (p.startsWith("/block-height/")) {
        const h = Number(p.slice("/block-height/".length));
        return h <= tip ? J(hashAt(h)) : miss;
      }
      // csd-indexer's /block/<hash>: the block of that hash on this chain at or below the tip, with its time.
      const blockOf = /^\/block\/(0x[0-9a-f]{64})$/.exec(p)?.[1];
      if (blockOf !== undefined) {
        let h = tip;
        while (h >= 0 && hashAt(h) !== blockOf) h--;
        return h >= 0 ? J({ height: h, hash: blockOf, time: timeAt(h) }) : miss;
      }
      // csd-indexer proposalsByDomain: ORDER BY height ASC, txid ASC
      if (p === `/domain/${DOMAIN}/proposals`) {
        const from = Number(q.get("from") ?? 0), limit = Number(q.get("limit") ?? 10_000);
        const rows = visible.filter((x) => x.spec.kind === "propose" && rh(x) >= from)
          .sort((a, b) => rh(a) - rh(b) || txidOrder(a, b)).slice(0, limit).map(proposalRow);
        return J(rows);
      }
      const att = p.match(/^\/proposal\/(0x[0-9a-f]+)\/attestations$/);
      if (att) {
        const limit = Number(q.get("limit") ?? 5000);
        const ah = q.get("after_height"), at = q.get("after_txid");
        const rows = visible.filter((x) => x.spec.kind === "attest" && proposalOf(x) === att[1])
          .sort((a, b) => rh(a) - rh(b) || txidOrder(a, b))
          .filter((x) => ah === null || rh(x) > Number(ah) || (rh(x) === Number(ah) && x.txid > String(at)))
          .slice(0, limit).map(attestRow);
        return J(rows);
      }
      // csd-indexer's chain-order feeds (queries.ts feedPage, server.ts feed()): rows in (height, position) order at or
      // below a snapshot block, keyset `after=<height>:<pos>`; `at=<height>:<hash>` answers 409 once that block left the
      // chain; `next` is set when the page is full. The same rows the endpoints above serve, with their position.
      if (feed && (p === "/proposals" || p === "/attestations")) {
        const kind = p === "/proposals" ? "propose" : "attest";
        const atM = q.get("at") === null ? null : /^(\d+)(?::(0x[0-9a-fA-F]{64}))?$/.exec(String(q.get("at")));
        const afterM = q.get("after") === null ? null : /^(\d+):(\d+)$/.exec(String(q.get("after")));
        if ((q.get("at") !== null && !atM) || (q.get("after") !== null && !afterM) || (afterM && !atM?.[2])) return status(400);
        const snap = atM ? Number(atM[1]) : tip;
        if (snap > tip || (atM?.[2] && atM[2].toLowerCase() !== hashAt(snap))) return status(409);
        const [ah, ap] = afterM ? [Number(afterM[1]), Number(afterM[2])] : [-1, -1];
        const n = Math.floor(Number(q.get("limit")));
        const limit = Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 1000;
        const rows = visible.filter((x) => x.spec.kind === kind && rh(x) <= snap && (rh(x) > ah || (rh(x) === ah && x.pos > ap)))
          .sort((a, b) => rh(a) - rh(b) || a.pos - b.pos).slice(0, limit)
          .map((x) => (kind === "propose" ? { ...proposalRow(x), pos: x.pos } : { ...attestRow(x), proposal_id: proposalOf(x), pos: x.pos }));
        const last = rows[rows.length - 1];
        return J({ at: { height: snap, hash: hashAt(snap) }, rows, next: rows.length === limit && last ? `${last.height}:${last.pos}` : null });
      }
      const proofId = p.match(/^\/tx\/(0x[0-9a-f]+)\/merkle-proof$/)?.[1];
      if (proofId !== undefined) {
        const x = byId.get(proofId);
        if (!x || x.height > tip) return miss;
        return J({ block_height: x.height, pos: x.pos, merkle: merkleBranch(blockIds(x.height), x.pos), merkle_root: rootAt(x.height) });
      }
      const txId = p.match(/^\/tx\/(0x[0-9a-f]+)$/)?.[1];
      if (txId !== undefined) {
        const x = byId.get(txId);
        if (!x || x.height > tip) return miss;
        return J({ txid: x.txid, height: x.height, pos: x.pos,
          outputs: x.tx.outputs.map((o) => ({ addr: "0x" + o.scriptPubkey, value: Number(o.value) })) });
      }
      return miss;
    }) as unknown as typeof fetch;
  };

  /** Scanner options with verifyInclusion on: the node knows every block up to `verifiedTip`. Merkle proofs
   *  come from the indexer endpoint (the Scanner default), as in production. */
  const verified = ({ verifiedTip, confDepth }: { verifiedTip: number; confDepth?: number }): Partial<ScanOptions> => ({
    verifyInclusion: true,
    ...(confDepth === undefined ? {} : { confDepth }),
    headerMerkleAt: async (h) => {
      if (h > verifiedTip || !txs.some((x) => x.height === h)) throw new Error(`node has no header at ${h}`);
      return rootAt(h);
    },
    rawTxAt: async (id) => {
      const x = byId.get(id)?.tx ?? sources.get(id);
      if (!x) throw new Error(`node has no transaction ${id}`);
      return x;
    },
    verifiedTipHeight: async () => verifiedTip,
  });

  return { txs, indexer, verified, rootAt, sources, hashAt };
}

/** Events in the resolver's replay order (height, propose before attest, pos, id). */
export const replayOrder = (evs: ChainEvent[]) => [...evs].sort((a, b) =>
  a.height - b.height || Number(a.kind === "attest") - Number(b.kind === "attest") || a.pos - b.pos ||
  ((a.kind === "propose" ? a.id : a.txid) < (b.kind === "propose" ? b.id : b.txid) ? -1 : 1));
