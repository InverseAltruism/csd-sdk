// Scanner cursor protocol: paging, saturation fail-loud, and the closed-window attestation cache.
// (the scan-cliff fix: a truncated proposal feed must THROW, never resolve to wrong state)
import assert from "node:assert/strict";
import http from "node:http";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN, EPOCH_LEN } from "@inversealtruism/cairnx-core";

let n = 0;
const id = () => "0x" + (++n).toString(16).padStart(64, "0");
const TIP = 50_000;

// 7 proposals across heights 100..106; page size 3 forces multi-page pulls
const props = Array.from({ length: 7 }, (_, i) => ({
  txid: id(), payload_hash: "0x" + "00".repeat(32), uri: "x", // unparseable → resolver no-op; scanner doesn't care
  // first 5 windows closed LONG before tip-FINALITY; last 2 still live
  expires_epoch: i < 5 ? 10 : Math.floor(TIP / EPOCH_LEN) + 100,
  proposer: "0x" + "aa".repeat(20), height: 100 + i,
}));
const txs: Record<string, unknown> = {};
for (const p of props) txs[p.txid] = { txid: p.txid, height: p.height, pos: 1, outputs: [] };

let attHits: Record<string, number> = {};
let legacyMode = false; // legacy = ignore ?from=, always serve the same newest-first full page

const mock = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  const p = decodeURIComponent(u.pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(TIP);
  if (p === `/domain/${DOMAIN}/proposals`) {
    const limit = Number(u.searchParams.get("limit") ?? 100);
    if (legacyMode) return send([...props].sort((a, b) => b.height - a.height).slice(0, limit));
    const from = Number(u.searchParams.get("from") ?? 0);
    return send(props.filter((x) => x.height >= from).sort((a, b) => a.height - b.height).slice(0, limit));
  }
  // /block-height/:h is REQUIRED by the scanner's reorg guards (invalidateCacheOnReorg, src/scanner.ts):
  // both the shallow tip check and the deep freeze-horizon check sample the block
  // hash here, and the shallow one CLEARS attCache when the prior tip hash is UNCONFIRMABLE (its
  // documented fail-closed posture). Without this route the mock 404s, so pass 2 always cleared the
  // cache and test 2 below failed 2 !== 1 -- which had been mislabelled an environmental flake.
  // The hash must be STABLE per height across passes, or the guard correctly clears every time.
  let m = /^\/block-height\/(\d+)$/.exec(p);
  if (m) return send("0x" + Number(m[1]).toString(16).padStart(64, "0"));
  m = /^\/proposal\/(0x[0-9a-f]{64})\/attestations$/.exec(p);
  if (m) { attHits[m[1]!] = (attHits[m[1]!] ?? 0) + 1; return send([]); }
  m = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
  if (m && txs[m[1]!]) return send(txs[m[1]!]);
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", () => ok()));
const base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

// 1. cursor paging: page size 3 over 7 rows → complete, de-duplicated history
{
  const s = new Scanner({ indexerUrl: base, pageSize: 3 });
  const { events } = await s.scan();
  assert.equal(events.filter((e) => e.kind === "propose").length, 7);
  console.log("  ok cursor paging: 7 proposals complete across 3-row pages (boundary de-duped)");
}

// 2. closed-window attestation cache: closed windows fetched once EVER; live windows every pass
{
  attHits = {};
  const s = new Scanner({ indexerUrl: base, pageSize: 10 });
  await s.scan();
  await s.scan();
  const closed = props.slice(0, 5), live = props.slice(5);
  for (const p of closed) assert.equal(attHits[p.txid], 1, `closed ${p.txid} fetched once`);
  for (const p of live) assert.equal(attHits[p.txid], 2, `live ${p.txid} fetched per pass`);
  console.log("  ok closed-window cache: closed-window attestations fetched once; live windows every pass");
}

// 3. saturation fail-loud: a legacy indexer (ignores ?from=) serving exactly a full page must THROW
{
  legacyMode = true;
  const s = new Scanner({ indexerUrl: base, pageSize: 7 }); // 7 rows == full page, never advances
  await assert.rejects(() => s.scan(), /saturated.*cursor/);
  console.log("  ok saturation: truncated legacy feed throws loudly instead of resolving wrong state");
  legacyMode = false;
}

mock.close();
console.log("\nscan-cursor: 3/3 passed");
