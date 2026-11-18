// Opt-in, from `pnpm test:live`: CSD_RPC names one's own node (loopback, a private range or a host listed in
// CAIRNX_OWN_NODE_HOSTS). nodeBlocks from the server entry drives the loop from the activation height to
// CAIRNX_LIVE_TO (default 117,000, where cairnx-core's corpus ends), the node's /tip held at that block, and both
// hashes are compared at every height of hashes.json up to it, as the cold sync of 2026-11-18 compared them.
// CAIRNX_LIVE_PACE_MS spaces the requests (default 0); a production node is read with a pace and a short range.
import { stateHash } from "@inversealtruism/cairnx-core";
import { memoryStore, nodeBlocks, replicaLoop } from "../src/server.js";
import { done, ok } from "./check.js";
import { pinned } from "./core-files.js";

const BASE = process.env.CSD_RPC;
if (!BASE) { console.log("SKIP: cairnx-replica live test: CSD_RPC unset (live-node tests are opt-in)"); process.exit(0); }
const reachable = await fetch(`${BASE}/tip`).then((r) => r.ok, () => false);
if (!reachable) { console.error(`FAIL: cairnx-replica live test: CSD_RPC=${BASE} set but no node answers /tip`); process.exit(1); }
const to = Number(process.env.CAIRNX_LIVE_TO ?? 117_000);
const end = (await (await fetch(`${BASE}/block/height/${to}`)).json()) as { hash: string; chainwork: string };
const held: typeof fetch = (input, init) => new URL(String(input)).pathname.endsWith("/tip")
  ? Promise.resolve(new Response(JSON.stringify({ tip: end.hash, height: to, chainwork: end.chainwork }), { headers: { "content-type": "application/json" } }))
  : fetch(input, init);
const paceMs = Number(process.env.CAIRNX_LIVE_PACE_MS ?? 0);
const loop = replicaLoop({ source: nodeBlocks({ node: BASE, fetch: held, paceMs }), store: memoryStore(), maxBlocks: 512, maxRequests: 1_000 });
const t0 = performance.now(), s = await loop.advance(), seconds = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`${to - 29_859} blocks to ${to} in ${seconds} s, ${s.eventCount} events`);
ok(`the drive ends at ${to} on the node's hash with nothing refused`, s.cursor?.height === to && s.cursor.hash === end.hash && s.lastError === null,
  JSON.stringify(s.lastError));
const heights = Object.keys(pinned).map(Number).filter((h) => h <= to);
const wrong = heights.filter((h) => loop.eventsHashAt(h) !== pinned[String(h)]!.eventsHash || stateHash(loop.stateAt(to, to - h)!) !== pinned[String(h)]!.stateHash);
ok(`both hashes equal hashes.json at the ${heights.length} heights up to ${to} (wrong at: ${wrong.join() || "none"})`, heights.length > 0 && wrong.length === 0);
done("cairnx-replica live");
