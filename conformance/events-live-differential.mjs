#!/usr/bin/env node
// Live differential of CONVENTION §33, never in CI: the cairnx:v1 events from the activation height to `--to`
// derived twice and required equal, as canonicalJson of each event in the order of §33.3 and of the whole list.
//   blocks: every block read from the node as a complete block (chain-read.mjs: headers checked by csd-light, each
//     body bound to its header's merkle root), the rule (blockMembers, blockEvents) applied block by block, the
//     author of each member bound by authorOf.
//   feed: csd-indexer's chain-order feeds /proposals and /attestations (domain=cairnx:v1, walked at the snapshot
//     block `--to`), an attestation kept when its proposal is a feed proposal at or below its height. The feed rows
//     carry no outputs, so `paidTo` comes from the node: /tx/<txid>, the body's txid recomputed.
// The indexer's snapshot block must be the node's block at `--to`. Read-only GETs to both.
//
//   CSD_RPC=<node url> CSD_INDEXER=<indexer url> node conformance/events-live-differential.mjs [--to <height>]
//   (--to defaults to the node's tip less 48; both services are meant to be local, e.g. http://127.0.0.1:8795 and
//   http://127.0.0.1:8793)
import { txid as codecTxid } from "../packages/codec/dist/index.js";
import { parseJsonExact, rpcTxToTx } from "../packages/client/dist/index.js";
import { CAIRNX_EVENT_RULE, blockEvents, blockMembers, canonicalJson, paidToFromOutputs } from "../packages/cairnx/dist/index.js";
import { boundAuthor, boundedFetch, checkRange, heightArg, nodeClient, parseArgs, verifiedBlocks } from "./chain-read.mjs";

const USAGE = "usage: CSD_RPC=<node url> CSD_INDEXER=<indexer url> node conformance/events-live-differential.mjs [--to <height>]";
const { domain: DOMAIN, activationHeight: FROM } = CAIRNX_EVENT_RULE;
let opts;
try {
  opts = parseArgs(process.argv.slice(2), ["to"]);
  if (!process.env.CSD_RPC) throw new Error("CSD_RPC is unset");
  if (!process.env.CSD_INDEXER) throw new Error("CSD_INDEXER is unset");
} catch (e) { console.error(`events-live-differential: ${e.message}\n${USAGE}`); process.exit(2); }

const applyOrder = (a, b) => a.height - b.height || (a.kind === "propose" ? 0 : 1) - (b.kind === "propose" ? 0 : 1) || a.pos - b.pos;
const idOf = (e) => (e.kind === "propose" ? e.id : e.txid);
const lower = (s) => String(s).toLowerCase();

async function fromBlocks(client, to) {
  const eventIds = new Set(), proposeIds = new Set(), sofar = { eventIds, proposeIds }, events = [];
  let blocks = 0, toHash = "";
  for await (const b of verifiedBlocks(client, FROM, to)) {
    blocks++;
    toHash = lower(b.hash);
    const payload = b.txs.filter((t) => t.tx.app.type !== "None");
    if (payload.length === 0) continue;
    const members = blockMembers(b.height, payload, sofar);
    const authors = [];
    for (const m of members) authors.push(await boundAuthor(client, m.item));
    for (const e of blockEvents(b.height, payload, sofar, authors)) {
      eventIds.add(idOf(e));
      if (e.kind === "propose") proposeIds.add(e.id);
      events.push(e);
    }
  }
  return { events, blocks, toHash };
}

async function feedRows(base, kind, to) {
  const get = async (q) => {
    const r = await boundedFetch(`${base}/${kind}?${q}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`indexer /${kind}?${q}: HTTP ${r.status}`);
    return parseJsonExact(await r.text());
  };
  const d = `domain=${encodeURIComponent(DOMAIN)}`;
  let page = await get(`${d}&at=${to}`);
  const at = page.at, rows = [...page.rows];
  while (page.next !== null) {
    page = await get(`${d}&at=${at.height}:${at.hash}&after=${encodeURIComponent(page.next)}`);
    rows.push(...page.rows);
  }
  return { at, rows };
}

async function paidToOf(client, id) {
  const info = await client.tx(id);
  if (!info?.ok || !info.tx) throw new Error(`the node has no transaction ${id}`);
  const tx = rpcTxToTx(info.tx);
  if (lower(codecTxid(tx)) !== lower(id)) throw new Error(`the body served for ${id} has another txid`);
  const counted = tx.outputs.filter((o) => BigInt(o.value) <= BigInt(Number.MAX_SAFE_INTEGER)).map((o) => ({ addr: lower(o.scriptPubkey), value: Number(o.value) }));
  return paidToFromOutputs(counted);
}

async function fromFeed(client, base, to) {
  const props = await feedRows(base, "proposals", to), atts = await feedRows(base, "attestations", to);
  const proposalAt = new Map(), events = [];
  let attsBelow = 0, attsOff = 0;
  for (const r of props.rows) {
    if (r.height < FROM) continue;
    const expiry = BigInt(r.expires_epoch);
    proposalAt.set(lower(r.txid), r.height);
    events.push({
      kind: "propose", id: lower(r.txid), proposer: lower(r.proposer), uri: r.uri, payloadHash: lower(r.payload_hash),
      expiresEpoch: expiry <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(expiry) : 2 ** 53, height: r.height, pos: r.pos,
    });
  }
  for (const r of atts.rows) {
    if (r.height < FROM) { attsBelow++; continue; }
    const p = proposalAt.get(lower(r.proposal_id));
    if (p === undefined || p > r.height) { attsOff++; continue; }
    events.push({
      kind: "attest", txid: lower(r.txid), proposalId: lower(r.proposal_id), attester: lower(r.attester), score: r.score,
      confidence: r.confidence, height: r.height, pos: r.pos,
    });
  }
  for (const e of events) e.paidTo = await paidToOf(client, idOf(e));
  return { events: events.sort(applyOrder), at: [props.at, atts.at], rows: { proposals: props.rows.length, attestations: atts.rows.length }, attsBelow, attsOff };
}

try {
  const t0 = Date.now();
  const client = nodeClient(process.env.CSD_RPC);
  const tip = await client.tip();
  const to = heightArg(opts.to, "--to", tip.height - 48);
  await checkRange(client, FROM, to);
  const chain = await fromBlocks(client, to);
  const feed = await fromFeed(client, process.env.CSD_INDEXER.replace(/\/+$/, ""), to);
  for (const at of feed.at)
    if (at.height !== to || lower(at.hash) !== chain.toHash) throw new Error(`the indexer's snapshot ${at.height}:${at.hash} is not the node's block ${to}:${chain.toHash}`);
  const n = Math.max(chain.events.length, feed.events.length);
  let equal = 0, first = null;
  for (let i = 0; i < n; i++) {
    const a = canonicalJson(chain.events[i] ?? null), b = canonicalJson(feed.events[i] ?? null);
    if (a === b) equal++;
    else first ??= { index: i, blocks: chain.events[i] ?? null, feed: feed.events[i] ?? null };
  }
  const count = (evs) => ({ events: evs.length, proposes: evs.filter((e) => e.kind === "propose").length, attests: evs.filter((e) => e.kind === "attest").length });
  const same = first === null && canonicalJson(chain.events) === canonicalJson(feed.events);
  console.log(JSON.stringify({
    from: FROM, to, toHash: chain.toHash, nodeTip: tip.height, blocksRead: chain.blocks,
    blocks: count(chain.events), feed: { ...count(feed.events), rows: feed.rows, attestationsBelowActivation: feed.attsBelow, attestationsOnNoEvent: feed.attsOff },
    equal, same, firstDifference: first, seconds: Math.round((Date.now() - t0) / 1000),
  }, null, 1));
  process.exit(same ? 0 : 1);
} catch (e) { console.error(`events-live-differential: FAIL: ${e.message}`); process.exit(1); }
