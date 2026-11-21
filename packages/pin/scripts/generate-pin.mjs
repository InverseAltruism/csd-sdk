#!/usr/bin/env node
// The pin generator, run by hand on a host with a node of its own, in no CI step and no package script:
//   node packages/pin/scripts/generate-pin.mjs [--rpc <node url>, else CSD_RPC] --anchor <height>:<hash> [--check]
// The anchor is the newest entry of a released header anchor table. The pin is the highest epoch boundary at or
// below it. Refusals, each before anything is written: an anchor less than FINAL_DEPTH below the node's tip; an anchor
// the node's chain does not hold; a previous pin (the newest delta's end, else the base fixture's) that is not the
// node's block at the height below the new range; a walk of verified headers from the pin that does not reach the
// anchor; the two derivations of the log differing (the recorded blocks through derivePin, and the replica's
// nodeBlocks loop from the activation height), or a new log that does not extend the committed pin's; a gate table
// that differs from the replica's built one at or below the pin, or from the committed pin's at or below its height.
// Then it writes fixtures/delta-<from>-<to>.json (the blocks of the range that hold an event, each with every payload
// transaction of its block, in the recorder's form) and pin.json. --check regenerates the newest delta and the pin
// and compares them with the committed files; it writes nothing. Read-only GETs to the node, at most 8 in flight.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EPOCH_LEN, FINAL_DEPTH, canonicalJson, payloadHash } from "@inversealtruism/cairnx-core";
import { BUILT_GATES, derivePin, gatesDiffer, memoryStore, nodeBlocks, replicaLoop } from "@inversealtruism/cairnx-replica/server";
import { CsdClient } from "@inversealtruism/csd-client";
import { boundedFetch, captureBlocks, renderFixture, verifiedBlocks } from "../../../conformance/chain-read.mjs";
import { DELTAS, PIN_FILE, baseFixture, differing, fixtureOf, readDeltas } from "./shipped.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const refused = (why) => new Error(`refused: ${why}`);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The log the replica's own nodeBlocks loop reads from the activation height to `to`, the node's /tip held at `to`.
async function nodeLog(rpc, fetch, to, hash) {
  const held = (input, init) => new URL(String(input)).pathname.endsWith("/tip")
    ? Promise.resolve(new Response(JSON.stringify({ tip: hash, height: to, chainwork: "0" }), { headers: { "content-type": "application/json" } }))
    : fetch(input, init);
  const loop = replicaLoop({ source: nodeBlocks({ node: rpc, fetch: held }), store: memoryStore(), maxBlocks: 512, maxRequests: 1_000 });
  const s = await loop.advance(), events = loop.rows(0).flatMap((r) => r.events);
  await loop.close();
  if (s.lastError !== null || s.cursor?.height !== to || s.cursor.hash !== hash) throw refused(`the nodeBlocks loop stopped at ${s.cursor?.height}: ${s.lastError?.reason}`);
  return new TextEncoder().encode(canonicalJson(events));
}

/** The new pin and delta from the node at `rpc`, or a thrown refusal. `base`, `deltas` and `pin` are the committed
 *  state (pin null before the first); `built` the replica's gate table; `fetch` reaches the node. */
export async function generate({ rpc, anchor, check = false, fetch = boundedFetch, base = baseFixture(), deltas = readDeltas(), pin = null, built = BUILT_GATES }) {
  const client = new CsdClient({ baseUrl: rpc, fetch, timeoutMs: 20_000, retries: 3 });
  const tip = await client.tip();
  if (!(anchor.height <= tip.height - FINAL_DEPTH)) throw refused(`the anchor ${anchor.height} is less than ${FINAL_DEPTH} below the node's tip ${tip.height}`);
  const atAnchor = String((await client.blockByHeight(anchor.height)).hash).toLowerCase();
  if (atAnchor !== anchor.hash) throw refused(`the node's chain does not hold the anchor: its block ${anchor.height} is ${atAnchor}`);
  const height = Math.floor(anchor.height / EPOCH_LEN) * EPOCH_LEN, kept = check ? deltas.slice(0, -1) : deltas, prev = kept.at(-1) ?? base;
  if (check && (deltas.at(-1)?.to !== height || pin?.height !== height)) throw refused(`--check: the committed pin and newest delta are not at ${height}`);
  if (height <= prev.to) throw refused(`nothing to add: the pin height ${height} is not above ${prev.to}`);
  const atPrev = String((await client.blockByHeight(prev.to)).hash).toLowerCase();
  if (atPrev !== prev.toHash) throw refused(`the previous pin ${prev.to} ${prev.toHash} is not the node's block there, ${atPrev}`);

  const from = prev.to + 1, cap = await captureBlocks(client, from, height);
  let reached = cap.toHash;
  for await (const b of verifiedBlocks(client, height + 1, anchor.height)) reached = b.hash.toLowerCase();
  if (reached !== anchor.hash) throw refused(`the headers verified from the pin reach ${reached} at ${anchor.height}, not the anchor`);

  const whole = { from, to: height, toHash: cap.toHash, blocks: cap.blocks }, one = await derivePin(fixtureOf(base, [...kept, whole]));
  const events = JSON.parse(new TextDecoder().decode(one.log)), evH = new Set(events.filter((e) => e.height > prev.to).map((e) => e.height));
  const delta = { ...whole, blocks: cap.blocks.filter((b) => evH.has(b.height)) }, d = await derivePin(fixtureOf(base, [...kept, delta]));
  if (!same(d.log, one.log)) throw refused("the range's event blocks alone do not give the log its whole capture gives");
  const two = await nodeLog(rpc, fetch, height, cap.toHash);
  if (!same(two, d.log)) throw refused(`the two derivations differ: the recorded blocks give ${d.pin.logSha256}, the nodeBlocks loop ${payloadHash(JSON.parse(new TextDecoder().decode(two)))}`);
  if (!check && pin !== null && (pin.height !== prev.to || payloadHash(events.filter((e) => e.height <= pin.height)) !== pin.logSha256)) {
    throw refused(`the new log does not extend the committed pin at ${pin.height}`);
  }
  if (gatesDiffer(d.pin.gates, built, height)) throw refused(`the gate table differs from the replica's built one at or below ${height}`);
  if (pin !== null && gatesDiffer(d.pin.gates, pin.gates, Math.min(pin.height, height))) throw refused(`the gate table differs from the committed pin's at or below ${pin.height}`);
  const text = renderFixture(delta);
  if (check) {
    const bad = [...differing(d.pin, pin), ...(text === renderFixture(deltas.at(-1)) ? [] : ["the delta"])];
    if (bad.length > 0) throw refused(`--check: the node gives another ${bad.join(", ")} than the committed files`);
  }
  return { pin: d.pin, delta, text, file: `delta-${from}-${height}.json` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const [h, hash] = String(flag("--anchor") ?? "").split(":"), rpc = flag("--rpc") ?? process.env.CSD_RPC, check = argv.includes("--check");
  if (!rpc || !/^[0-9]+$/.test(h ?? "") || !HASH.test(hash ?? "")) {
    console.error("generate-pin: no node, or no anchor <height>:<0x hash>, named\nusage: generate-pin.mjs [--rpc <node url>, else CSD_RPC] --anchor <height>:<0x hash> [--check]");
    process.exit(2);
  }
  const pin = existsSync(PIN_FILE) ? JSON.parse(readFileSync(PIN_FILE, "utf8")) : null;
  generate({ rpc: rpc.replace(/\/+$/, ""), anchor: { height: Number(h), hash }, check, pin }).then((r) => {
    if (!check) { writeFileSync(join(DELTAS, r.file), r.text); writeFileSync(PIN_FILE, `${JSON.stringify(r.pin, null, 2)}\n`); }
    console.log(`generate-pin: ${check ? "check passed, nothing written" : `wrote pin.json and fixtures/${r.file}`}: the pin at ${r.pin.height}, ${r.delta.blocks.length} delta blocks, log sha256 ${r.pin.logSha256}`);
  }, (e) => { console.error(`generate-pin: FAIL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
