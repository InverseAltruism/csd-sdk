#!/usr/bin/env node
// Capture the block fixture of CONVENTION §33 (packages/cairnx/test/fixtures/events-blocks.json): every block from
// `--from` to `--to` read from a node as a complete block (chain-read.mjs: headers checked by csd-light, each body
// bound to its header's merkle root), and of each block every transaction with an app payload, any domain, in the
// form of test/vectors/events.json with its bound author. Only blocks holding such a transaction are written.
// events.test.ts and events-crosslang.mjs apply the rule to the fixture and require the pinned replay corpus.
//
// The output is a function of the chain alone (no date, no tip), so two captures of one range are the same bytes.
// Read-only: GETs to the node, one file written.
//
//   node conformance/capture-events-fixture.mjs --rpc <node url> --to <height> [--from 29860] [--out FILE]
//   (--rpc defaults to CSD_RPC; the node is meant to be a local one, e.g. http://127.0.0.1:8795)
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ACTIVATION_HEIGHT, canonicalJson } from "../packages/cairnx/dist/index.js";
import { boundAuthor, checkRange, fixtureTx, heightArg, nodeClient, parseArgs, verifiedBlocks } from "./chain-read.mjs";

const USAGE = "usage: node conformance/capture-events-fixture.mjs --rpc <node url> --to <height> [--from 29860] [--out FILE]";
let opts;
try {
  opts = parseArgs(process.argv.slice(2), ["rpc", "from", "to", "out"]);
  opts.rpc ??= process.env.CSD_RPC;
  if (!opts.rpc) throw new Error("no node: pass --rpc or set CSD_RPC");
  opts.from = heightArg(opts.from, "--from", ACTIVATION_HEIGHT);
  opts.to = heightArg(opts.to, "--to");
} catch (e) { console.error(`capture-events-fixture: ${e.message}\n${USAGE}`); process.exit(2); }

try {
  const t0 = Date.now();
  const client = nodeClient(opts.rpc);
  await checkRange(client, opts.from, opts.to);
  const kept = [];
  let read = 0, toHash = "";
  for await (const b of verifiedBlocks(client, opts.from, opts.to)) {
    read++;
    toHash = b.hash.toLowerCase();
    const payload = b.txs.filter((t) => t.tx.app.type !== "None");
    if (payload.length === 0) continue;
    const txs = [];
    for (const t of payload) txs.push(fixtureTx(t, await boundAuthor(client, t)));
    kept.push({ height: b.height, hash: b.hash.toLowerCase(), txs });
  }
  // One block per line, each in canonicalJson form.
  const text = `{"format":1,"from":${opts.from},"to":${opts.to},"toHash":${JSON.stringify(toHash)},"blocks":[\n` +
    kept.map((b) => canonicalJson(b)).join(",\n") + "\n]}\n";
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  if (opts.out) writeFileSync(opts.out, text);
  console.log(JSON.stringify({
    from: opts.from, to: opts.to, toHash, blocksRead: read, blocksKept: kept.length,
    txsKept: kept.reduce((n, b) => n + b.txs.length, 0), bytes, sha256, out: opts.out ?? null, seconds: Math.round((Date.now() - t0) / 1000),
  }));
} catch (e) { console.error(`capture-events-fixture: FAIL: ${e.message}`); process.exit(1); }
