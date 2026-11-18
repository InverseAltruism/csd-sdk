#!/usr/bin/env node
// Scan for transaction ids mined twice (CONVENTION §33.2; the fact CONSENSUS_CHANGES.md cites for 0.2.5): every
// block from `--from` to `--to` read from the node as a complete block (chain-read.mjs: headers checked by csd-light,
// each body bound to its header's merkle root, so each txid is recomputed from its body), and every transaction id
// that occurs at more than one (height, position) reported, split by coinbase and by app payload. A block repeating a
// txid within itself fails the bind and the scan. Exits 1 when any id repeats. Read-only GETs to the node.
//
//   node conformance/scan-repeated-txids.mjs --rpc <node url> [--from 29860] [--to <height>]
//   (--rpc defaults to CSD_RPC, --to to the node's tip less 48; the node is meant to be a local one)
import { ACTIVATION_HEIGHT } from "../packages/cairnx/dist/index.js";
import { checkRange, heightArg, nodeClient, parseArgs, verifiedBlocks } from "./chain-read.mjs";

const USAGE = "usage: node conformance/scan-repeated-txids.mjs --rpc <node url> [--from 29860] [--to <height>]";
let opts;
try {
  opts = parseArgs(process.argv.slice(2), ["rpc", "from", "to"]);
  opts.rpc ??= process.env.CSD_RPC;
  if (!opts.rpc) throw new Error("no node: pass --rpc or set CSD_RPC");
  opts.from = heightArg(opts.from, "--from", ACTIVATION_HEIGHT);
} catch (e) { console.error(`scan-repeated-txids: ${e.message}\n${USAGE}`); process.exit(2); }

try {
  const t0 = Date.now();
  const client = nodeClient(opts.rpc);
  const tip = await client.tip();
  const to = heightArg(opts.to, "--to", tip.height - 48);
  await checkRange(client, opts.from, to);
  const seen = new Map(), repeats = [];
  let blocks = 0, txs = 0, appTxs = 0, toHash = "";
  for await (const b of verifiedBlocks(client, opts.from, to)) {
    blocks++;
    toHash = b.hash.toLowerCase();
    for (const t of b.txs) {
      txs++;
      const at = { height: b.height, pos: t.pos, app: t.tx.app.type };
      if (at.app !== "None") appTxs++;
      const id = t.txid.toLowerCase(), first = seen.get(id);
      if (first) repeats.push({ txid: id, first, again: at });
      else seen.set(id, at);
    }
  }
  console.log(JSON.stringify({
    from: opts.from, to, toHash, nodeTip: tip.height, blocks, txs, appTxs, distinctIds: seen.size,
    repeats: repeats.length, coinbaseRepeats: repeats.filter((r) => r.again.pos === 0).length,
    appRepeats: repeats.filter((r) => r.again.app !== "None").length, sample: repeats.slice(0, 5),
    seconds: Math.round((Date.now() - t0) / 1000),
  }, null, 1));
  process.exit(repeats.length === 0 ? 0 : 1);
} catch (e) { console.error(`scan-repeated-txids: FAIL: ${e.message}`); process.exit(1); }
