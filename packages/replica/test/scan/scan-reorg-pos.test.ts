// Regression: a long-running scanner must not serve a stale transaction POSITION
// after a SHALLOW reorg (one entirely above the tip−FINALITY freeze anchor). The old
// invalidateCacheOnDeepReorg only re-sampled the block hash at tip−FINALITY, so a same-height reorg that
// swapped two txs' positions above that anchor left the txCache untouched and the scanner emitted the OLD
// positions. Downstream that reorders an offer and its ocancel in one block: the offer looks "open", the
// wallet signs a payment-bearing fill, canonical replay rejects delivery, and the payment burns.
//
// The fix adds a second trigger: re-sample the block hash at the PREVIOUS scan's TIP height (every cached
// tx sits at or below it), and clear txCache/attCache on any change. This test pins BOTH the correctness
// (positions re-derive to a fresh scanner's values) and the non-degradation (a stable tip → no refetch).
// It FAILS on the pre-fix code: with the tip−FINALITY anchor unchanged, scan 3 would reuse the stale cache.
import assert from "node:assert/strict";
import http from "node:http";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const TIP = 50_000;                 // constant across scans: the reorg is same-height, positions swap
const FINAL_H = TIP - Scanner.FINALITY;
const A = "0x" + "a1".repeat(32);
const B = "0x" + "b2".repeat(32);
const H = 40_000;                   // both proposals mined in the same block, well below the tip

const mk = (txid: string) => ({ txid, payload_hash: "0x" + "00".repeat(32), uri: "x", expires_epoch: 10, proposer: "0x" + "cc".repeat(20), height: H });

let tipHash = "0x" + "de".repeat(32);          // the tip block hash (flip = simulate the reorg)
const finalHash = "0x" + "ff".repeat(32);      // the tip−FINALITY anchor hash: NEVER changes here (shallow reorg)
let pos: Record<string, number> = { [A]: 1, [B]: 2 };
let txHits = 0;

const mock = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  const p = decodeURIComponent(u.pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(TIP);
  if (p.startsWith("/block-height/")) {
    const h = Number(p.slice("/block-height/".length));
    return send(h === FINAL_H ? finalHash : tipHash);          // deep anchor constant; tip (and all else) flippable
  }
  if (p === `/domain/${DOMAIN}/proposals`) return send([mk(A), mk(B)]);
  if (/^\/proposal\/.+\/attestations$/.test(p)) return send([]);
  const m = p.match(/^\/tx\/(.+)$/);
  if (m) { txHits++; const txid = m[1]!; return send({ txid, height: H, pos: pos[txid] }); }
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", () => ok()));
const base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
const posOf = (r: { events: { kind: string; id?: string; pos: number }[] }, id: string) =>
  r.events.find((e) => e.kind === "propose" && e.id === id.toLowerCase())!.pos;

const s = new Scanner({ indexerUrl: base, pageSize: 10 });

// scan 1: cold, caches both positions
let r = await s.scan();
assert.equal(posOf(r, A), 1, "scan1 A.pos = 1");
assert.equal(posOf(r, B), 2, "scan1 B.pos = 2");
assert.equal(txHits, 2, "scan1 fetched both txs");

// scan 2: NO reorg (tip hash unchanged), cache reused, no refetch (efficiency preserved)
r = await s.scan();
assert.equal(txHits, 2, "no reorg → txCache reused, no refetch");
assert.equal(posOf(r, A), 1, "no reorg → stable cached position");
console.log("  ok non-degradation: a stable tip keeps the txCache (no false refetch)");

// SHALLOW reorg: the tip block changes identity while the tip−FINALITY anchor does NOT; positions swap.
tipHash = "0x" + "ab".repeat(32);
pos = { [A]: 2, [B]: 1 };

// scan 3: the fix re-samples the previous tip hash, sees the change, clears the cache, and refetches.
r = await s.scan();
assert.equal(txHits, 4, "shallow reorg → txCache cleared, both txs refetched (FAILS pre-fix: deep anchor unchanged)");
assert.equal(posOf(r, A), 2, "post-reorg A.pos = 2 (fresh canonical position)");
assert.equal(posOf(r, B), 1, "post-reorg B.pos = 1 (fresh canonical position)");
console.log("  ok shallow reorg: a tip-hash change above the deep anchor drops the stale positions");

// equivalence: a FRESH scanner over the post-reorg indexer must agree with the long-running one.
const fresh = await new Scanner({ indexerUrl: base, pageSize: 10 }).scan();
assert.equal(posOf(fresh, A), 2, "fresh scanner A.pos = 2");
assert.equal(posOf(fresh, B), 1, "fresh scanner B.pos = 1");
console.log("  ok equivalence: long-running scanner now matches a fresh scanner post-reorg");

mock.close();

// ---- fault-path coverage: the null/shrink branch of trigger (1), and the tip-sample
// keep-on-error residual (a failed tip-hash record must NOT keep a stale LOWER anchor, or the band above
// it goes unguarded). Uses an ADVANCING tip so prevTip.h < tip, isolating the record-failure. ----
{
  let tip = 1000;
  const H0 = 900;                                    // the proposal's (constant) block height
  const P = "0x" + "c1".repeat(32);
  const prop = { txid: P, payload_hash: "0x" + "00".repeat(32), uri: "x", expires_epoch: 10, proposer: "0x" + "dd".repeat(20), height: H0 };
  const hashAt = new Map<number, string>([[1000, "0x" + "10".repeat(32)], [1001, "0x" + "11".repeat(32)], [H0, "0x" + "90".repeat(32)]]);
  const fail = new Set<number>();                    // heights whose /block-height returns 404 (orphaned/absent/lagging)
  let hits = 0;

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const p = decodeURIComponent(u.pathname);
    const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (p === "/blocks/tip/height") return send(tip);
    if (p.startsWith("/block-height/")) {
      const h = Number(p.slice("/block-height/".length));
      if (fail.has(h)) { res.writeHead(404); return res.end("{}"); }
      return send(hashAt.get(h) ?? "0x" + "ee".repeat(32));
    }
    if (p === `/domain/${DOMAIN}/proposals`) return send([prop]);
    if (/^\/proposal\/.+\/attestations$/.test(p)) return send([]);
    if (/^\/tx\/.+$/.test(p)) { hits++; return send({ txid: P, height: H0, pos: 1 }); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const b2 = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const sc = new Scanner({ indexerUrl: b2, pageSize: 10 });

  // scan 1: cold → caches the tx; prevTip = {1000, hash1000}
  await sc.scan();
  assert.equal(hits, 1, "fault: scan1 fetched the tx");

  // scan 2: tip advances to 1001, but the tip-hash RECORD fails (indexer can't yet serve /block-height/1001).
  // The shallow check at prevTip.h=1000 is unchanged → no clear (correct, no reorg). The record must then
  // store the CURRENT height with a sentinel, NOT keep the stale {1000,...} anchor.
  tip = 1001;
  fail.add(1001);
  await sc.scan();
  assert.equal(hits, 1, "fault: no reorg → cache reused even though the tip-hash record failed");

  // scan 3: the indexer recovers (1001 now serves its real hash) and there is NO reorg. With the fix,
  // prevTip={1001,sentinel} forces a defensive clear (sentinel != real hash) → refetch. With the pre-fix
  // keep-prior behavior prevTip would be {1000,hash1000}, the shallow check at 1000 would match, and the
  // stale band (1000,1001] would stay unguarded → NO clear → hits would stay 1. So this pins the sentinel.
  fail.delete(1001);
  await sc.scan();
  assert.equal(hits, 2, "fault: sentinel from the failed record forces a defensive clear next scan (fails without the sentinel)");

  // scan 4: fully recovered, no reorg → cache reused (the defensive clear is one-shot, not a storm)
  await sc.scan();
  assert.equal(hits, 2, "fault: recovered → cache reused, no false refetch");

  // scan 5: the prior tip height 1001 now 404s (chain regressed / that block orphaned) → the null/shrink
  // branch of trigger (1) must clear and refetch (the branch the main test never exercises).
  fail.add(1001);
  await sc.scan();
  assert.equal(hits, 3, "fault: /block-height 404 at prevTip.h clears the cache (null/shrink branch)");

  srv.close();
  console.log("  ok fault paths: sentinel-on-record-failure + null/shrink clear both hold");
}

console.log("\nscan-reorg-pos: shallow-reorg position invalidation, passed");
