// META-4 regression: the closed-window attestation cache must NOT survive a reorg that crosses its
// freeze horizon. Before the fix, a long-running scanner served a stale `filled`/attestation set a
// fresh scanner would not (resolve.ts:2-3 byte-identity violated). The fix re-samples the block hash
// at tip−FINALITY each scan and drops the closed cache when it changes (a deep reorg). This test
// also asserts NON-degradation: with a stable hash the cache is still reused (no false re-fetch).
// The block at the tip keeps its hash, so the shallow check (scan-reorg-pos) does not clear: only the
// freeze-horizon hash moves. On a consistent chain both would change; this isolates the deep trigger.
import assert from "node:assert/strict";
import http from "node:http";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const TIP = 50_000;
const PID = "0x" + "11".repeat(64 / 2);
const ATT = "0x" + "22".repeat(64 / 2);

// one CLOSED-window proposal (expiry far below tip−FINALITY) → eligible for the forever-cache
const prop = { txid: PID, payload_hash: "0x" + "00".repeat(32), uri: "x", expires_epoch: 10, proposer: "0x" + "aa".repeat(20), height: 100 };

let anchorHash = "0x" + "de".repeat(32);   // the freeze-boundary block hash (flip = simulate reorg)
const tipHash = "0x" + "aa".repeat(32);    // the block at the tip: unchanged
let attSet: Array<Record<string, unknown>> = [{ txid: ATT, attester: "0x" + "bb".repeat(20), score: 100, confidence: 0, height: 200 }];
let attHits = 0;

const mock = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  const p = decodeURIComponent(u.pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(TIP);
  if (p.startsWith("/block-height/")) return send(Number(p.slice("/block-height/".length)) === TIP ? tipHash : anchorHash);
  if (p === `/domain/${DOMAIN}/proposals`) return send([prop]);
  if (/^\/proposal\/.+\/attestations$/.test(p)) { attHits++; return send(attSet); }
  if (/^\/tx\/.+$/.test(p)) return send({ txid: PID, height: 100, pos: 1, outputs: [] });
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", () => ok()));
const base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
const atts = (r: { events: { kind: string }[] }) => r.events.filter((e) => e.kind === "attest").length;

const s = new Scanner({ indexerUrl: base, pageSize: 10 });

// scan 1: caches the closed-window attestation
let r = await s.scan();
assert.equal(atts(r), 1, "scan1 sees the attestation");
assert.equal(attHits, 1, "fetched once");

// scan 2, NO reorg (anchor hash unchanged): the closed cache is reused — NOT re-fetched (non-degradation).
attSet = []; // the indexer would now serve a different set, but a stable chain must keep the cached view
r = await s.scan();
assert.equal(attHits, 1, "no reorg → closed cache reused, no re-fetch (efficiency preserved)");
assert.equal(atts(r), 1, "no reorg → stable cached view");
console.log("  ok non-degradation: a stable freeze boundary keeps the closed cache (no false re-fetch)");

// scan 3, DEEP reorg (freeze-boundary block changes identity): cache invalidated, attestation re-fetched.
anchorHash = "0x" + "ee".repeat(32);
r = await s.scan();
assert.equal(attHits, 2, "deep reorg → attCache cleared, attestation re-fetched");
assert.equal(atts(r), 0, "post-reorg the stale 'filled' attestation is gone (matches a fresh scanner)");
console.log("  ok deep reorg: the freeze-horizon hash change drops the stale closed cache");

mock.close();
console.log("\nscan-reorg: META-4 deep-reorg attCache invalidation — 2/2 passed");
