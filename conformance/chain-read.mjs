// Reading the chain from a node for the block scripts (capture-events-fixture.mjs, events-live-differential.mjs,
// scan-repeated-txids.mjs): complete blocks, each header checked by csd-light (proof of work, LWMA bits, time rules,
// the link to the header before) and each body bound to its header's merkle root (bindBlockTxs), and the author of a
// transaction bound by csd-crypto authorOf. Read-only GETs; every request of a process shares one bound on requests
// in flight.
//
// Trust: the header run starts from a seed, the LWMA window below `from` read from the same node and taken as
// given (LightClient.syncFromCheckpoint). Every block from `from` on is checked against it, so a reader compares the
// end hash a script prints with a node it trusts.
import { txid as codecTxid } from "../packages/codec/dist/index.js";
import { CsdClient, rpcTxToTx } from "../packages/client/dist/index.js";
import { authorOf } from "../packages/crypto/dist/index.js";
import { LightClient, bindBlockTxs, rpcHeaderToHeader } from "../packages/light/dist/index.js";

/** The most requests in flight at once, over every client a process makes. */
export const MAX_PARALLEL = 8;
/** The least depth below the node's tip a script reads to: the cairnx service's finality. */
export const MIN_DEPTH = 12;

let inFlight = 0;
const waiting = [];
/** fetch with at most MAX_PARALLEL requests in flight, a request holding its slot until its body is read. A freed
 *  slot passes straight to the next waiter, so a new caller cannot take it in between. */
export async function boundedFetch(input, init) {
  if (inFlight >= MAX_PARALLEL) await new Promise((go) => waiting.push(go));
  else inFlight++;
  try {
    const r = await fetch(input, init);
    return new Response(await r.arrayBuffer(), { status: r.status, statusText: r.statusText, headers: r.headers });
  } finally {
    const go = waiting.shift();
    if (go) go(); else inFlight--;
  }
}

/** A csd-client over `baseUrl` that shares the bound, parses u64 exactly and retries network failures. */
export const nodeClient = (baseUrl) => new CsdClient({ baseUrl, fetch: boundedFetch, timeoutMs: 20_000, retries: 3 });

/** A script's options: `--name value` pairs, every name listed in `known`. Throws on anything else. */
export function parseArgs(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!k?.startsWith("--") || !known.includes(k.slice(2)) || v === undefined) throw new Error(`unknown or incomplete option ${k ?? ""}`);
    out[k.slice(2)] = v;
  }
  return out;
}

/** A decimal height option, or `dflt` when absent. Throws on anything but a safe integer >= 0. */
export function heightArg(v, what, dflt) {
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== "string" || !/^[0-9]+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`${what} must be a height`);
  return Number(v);
}

/** Throws unless `from <= to` and `to` lies at least MIN_DEPTH below the node's tip; returns the tip. */
export async function checkRange(client, from, to) {
  const tip = await client.tip();
  if (from < 1 || from > to) throw new Error(`the range ${from}..${to} is empty or starts at genesis`);
  if (to > tip.height - MIN_DEPTH) throw new Error(`${to} is less than ${MIN_DEPTH} blocks below the tip ${tip.height}`);
  return tip;
}

/**
 * Every block from `from` to `to` in height order, as {height, hash, txs}, with `txs` the csd-light BoundTx list
 * (each txid recomputed from its body, the set hashing to the verified merkle root). Throws on the first header or
 * body that does not verify, and when the block at `to` has changed by the end of the read.
 */
export async function* verifiedBlocks(client, from, to) {
  const light = new LightClient({ client });
  await light.syncFromCheckpoint(from - 1, (await client.blockByHeight(from - 1)).hash);
  const pending = new Map();
  let next = from;
  const fetchAhead = () => {
    for (; next <= to && pending.size < 4 * MAX_PARALLEL; next++) {
      const p = client.blockByHeight(next);
      // Awaited in height order below, which throws the rejection; this handler only keeps it from being unhandled
      // while an earlier height is awaited.
      p.catch(() => undefined);
      pending.set(next, p);
    }
  };
  let last;
  for (let h = from; h <= to; h++) {
    fetchAhead();
    const b = await pending.get(h);
    pending.delete(h);
    if (b.height !== undefined && b.height !== h) throw new Error(`the node answered block ${b.height} for height ${h}`);
    const verified = light.ingest(h, rpcHeaderToHeader(b.header), b.hash);
    const bound = bindBlockTxs(b.txs, verified);
    if (!bound.ok) throw new Error(`${bound.kind}: ${bound.reason}`);
    last = verified.hash;
    yield { height: h, hash: verified.hash, txs: bound.txs };
  }
  const again = (await client.blockByHeight(to)).hash;
  if (again.toLowerCase() !== last.toLowerCase()) throw new Error(`block ${to} changed during the read (${last}, now ${again})`);
}

const sources = new Map();
/** The source transaction `id`, its txid recomputed from the body the node serves. */
function sourceTx(client, id) {
  const key = id.toLowerCase();
  if (!sources.has(key)) {
    const p = client.tx(id).then((info) => {
      if (!info?.ok || !info.tx) throw new Error(`the node has no source transaction ${id}`);
      const tx = rpcTxToTx(info.tx);
      if (codecTxid(tx).toLowerCase() !== key) throw new Error(`the source transaction served for ${id} has another txid`);
      return tx;
    });
    sources.set(key, p);
  }
  return sources.get(key);
}

/** The author of a bound transaction (CONVENTION §33.5): the owner of the output its first input spends, read from
 *  the source transaction after its txid is recomputed, and returned by authorOf only when the first input's
 *  signature is the owner's. Throws when it cannot be bound. */
export async function boundAuthor(client, t) {
  const in0 = t.tx.inputs[0];
  if (!in0) throw new Error(`${t.txid} has no input`);
  const out = (await sourceTx(client, in0.prevTxid)).outputs[in0.vout];
  if (!out) throw new Error(`${t.txid} spends output ${in0.vout} of ${in0.prevTxid}, which it does not have`);
  const author = authorOf(t.tx, out.scriptPubkey);
  if (!author) throw new Error(`${t.txid}: the first input's signature is not the owner's of the output it spends`);
  return author;
}

/** A bound transaction with an app payload in the fixture form: the field names of csd-codec's Tx, u64 values as
 *  decimal strings, hex lowercase with `0x`, and the bound author. */
export function fixtureTx(t, author) {
  const a = t.tx.app, hex = (s) => String(s).toLowerCase();
  const app = a.type === "Propose"
    ? { type: "Propose", domain: a.domain, payloadHash: hex(a.payloadHash), uri: a.uri, expiresEpoch: String(a.expiresEpoch) }
    : { type: "Attest", proposalId: hex(a.proposalId), score: a.score, confidence: a.confidence };
  return {
    pos: t.pos, txid: hex(t.txid), app,
    outputs: t.tx.outputs.map((o) => ({ value: String(o.value), scriptPubkey: hex(o.scriptPubkey) })),
    author,
  };
}
