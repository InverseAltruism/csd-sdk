#!/usr/bin/env node
// Records the answers of a CSD node that test/node-blocks.test.ts replays offline: the body of /block/height/:h for
// each height from --from to --to, and of /tx/:id for the transaction that the first input of every transaction with
// an app payload spends (a superset of the event members, whose authors nodeBlocks binds). Read-only GET requests, one
// at a time and --pace-ms apart. Writes {format, from, to, answers: {path: body text}} with the bodies byte for byte,
// then prints the file's size and sha256. The node is --node, else CSD_RPC. Exit 2 when no node, range or output is
// named, 1 when a read fails.
//   node scripts/capture-node-blocks.mjs --node <url> --from 29860 --to 30300 --out test/fixtures/node-blocks-29860-30300.json
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const NAME = "capture-node-blocks";
const USAGE = "usage: capture-node-blocks.mjs [--node <url>, else CSD_RPC] --from <height> --to <height> --out <file> [--pace-ms <ms>]";
const { values: a } = parseArgs({ options: { node: { type: "string" }, from: { type: "string" }, to: { type: "string" }, out: { type: "string" }, "pace-ms": { type: "string" } } });
const height = (v) => (/^[0-9]+$/.test(v ?? "") ? Number(v) : Number.NaN);
const from = height(a.from), to = height(a.to), pace = a["pace-ms"] === undefined ? 25 : height(a["pace-ms"]);
const nodeUrl = a.node ?? process.env.CSD_RPC;
if (!nodeUrl || !a.out || !(from <= to) || Number.isNaN(pace)) {
  console.error(`${NAME}: no node, range or output named\n${USAGE}`);
  process.exit(2);
}
const base = nodeUrl.replace(/\/+$/, "");
const answers = {};
async function read(path) {
  await new Promise((go) => setTimeout(go, pace));
  const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (r.status !== 200) throw new Error(`GET ${path} answered ${r.status}`);
  return (answers[path] = await r.text());
}
try {
  for (let h = from; h <= to; h++) {
    const block = JSON.parse(await read(`/block/height/${h}`));
    for (const t of block.txs ?? []) {
      const spent = t.inputs?.[0]?.prev_txid;
      if (t.app?.type !== "None" && typeof spent === "string" && !(`/tx/${spent}` in answers)) await read(`/tx/${spent}`);
    }
  }
} catch (e) {
  console.error(`${NAME}: FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const text = `${JSON.stringify({ format: 1, from, to, answers }, null, 1)}\n`;
writeFileSync(a.out, text);
const bytes = Buffer.byteLength(text);
console.log(`${NAME}: ${Object.keys(answers).length} answers, ${bytes} bytes, sha256 ${createHash("sha256").update(text).digest("hex")}`);
