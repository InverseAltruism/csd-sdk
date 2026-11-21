// The scanner half of attestation de-dup.
// The attestation pull (scanner.ts allAttestations) pushes the indexer's pages VERBATIM. A duplicated
// attestation (a buggy/hostile indexer, or overlapping pages) would ride into resolve() twice and
// double-apply, double-crediting o.paid / o.delivered on the partial-fill path. The
// resolve() half is V29-gated in cairnx-core (dedup only for events at height >= V29); this test
// pins the un-gated service-half fix: the scanner de-dups by txid so each attest reaches resolve() once.
//
// The scenario is a PARTIAL CSD-priced fill at a height far below V29, so resolve() does NOT dedup and a
// duplicate would visibly double o.delivered. RED-FIRST: remove the scanner de-dup and both assertions red
// (the attest appears twice in the events, and resolve() then double-credits delivered 10 -> 20).
import assert from "node:assert/strict";
import http from "node:http";
import { deploy, mint, offer } from "@inversealtruism/cairnx-core";
import { resolve } from "@inversealtruism/cairnx-core";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN, EPOCH_LEN, SCORE_FILL, TREASURY_ADDR, V12_HEIGHT, tradeFee } from "@inversealtruism/cairnx-core";

const A = "0x" + "aa".repeat(20); // seller (deploys + mints DUST, lists the offer)
const B = "0x" + "bb".repeat(20); // buyer (partial-fills)
const H = V12_HEIGHT + 40;        // v1.2+ (partial fills active), pre-V16 (feeBps 100), FAR below V29 (88,000)
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const ee = Math.floor(H / EPOCH_LEN) + 1000;

const PARTIAL = 10_000_000;                 // 0.1 CSD paid to the seller
const FEE = Number(tradeFee(BigInt(PARTIAL))); // the offer's stored feeBps at H (pre-V16 → 100 bps) → 100_000

const dep = deploy({ ticker: "DUST", decimals: 0, supply: "1000", mint: "open", mintLimit: "1000" });
const mnt = mint({ ticker: "DUST" });
// a PARTIAL CSD-priced offer: 100 DUST for 1 CSD total, min 0.1 CSD → a 0.1 CSD fill buys 10 DUST.
const off = offer({ give: { ticker: "DUST", amount: "100" }, want: { value: "100000000" }, min: "10000000" });

const proposals = [
  { txid: id(1), domain: DOMAIN, payload_hash: dep.payloadHash, uri: dep.uri, expires_epoch: ee, proposer: A, height: H },
  { txid: id(2), domain: DOMAIN, payload_hash: mnt.payloadHash, uri: mnt.uri, expires_epoch: ee, proposer: A, height: H + 1 },
  { txid: id(3), domain: DOMAIN, payload_hash: off.payloadHash, uri: off.uri, expires_epoch: Math.floor(H / EPOCH_LEN) + 24, proposer: A, height: H + 2 },
];
// THE DUPLICATED ATTESTATION: the SAME fill attest txid id(4) is served TWICE in the feed for offer id(3).
const attestations: Record<string, unknown[]> = {
  [id(3)]: [
    { txid: id(4), proposal_id: id(3), attester: B, score: SCORE_FILL, height: H + 3 },
    { txid: id(4), proposal_id: id(3), attester: B, score: SCORE_FILL, height: H + 3 }, // exact duplicate
  ],
};
const txs: Record<string, unknown> = {
  [id(1)]: { txid: id(1), height: H, pos: 1, outputs: [{ addr: TREASURY_ADDR, value: 100_000_000 }] }, // deploy fee (v11+)
  [id(2)]: { txid: id(2), height: H + 1, pos: 1, outputs: [{ addr: A, value: 1 }] },
  [id(3)]: { txid: id(3), height: H + 2, pos: 1, outputs: [{ addr: A, value: 1 }] },
  // the fill: pays seller A 0.1 CSD (a partial) + the treasury the 1% protocol fee
  [id(4)]: { txid: id(4), height: H + 3, pos: 2, outputs: [{ addr: A, value: PARTIAL }, { addr: TREASURY_ADDR, value: FEE }] },
};

const mock = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(H + 10);
  if (p === `/domain/${DOMAIN}/proposals`) return send(proposals);
  let m = /^\/proposal\/(0x[0-9a-f]{64})\/attestations$/.exec(p);
  if (m) return send(attestations[m[1]!] ?? []);
  m = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
  if (m && txs[m[1]!]) return send(txs[m[1]!]);
  res.writeHead(404); res.end("{}");
});

await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", () => ok()));
const port = (mock.address() as { port: number }).port;

const { events, tipHeight } = await new Scanner({ indexerUrl: `http://127.0.0.1:${port}` }).scan();
mock.close();

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`); };

// direct scanner-half assertion: the duplicated attest txid is emitted ONCE, not verbatim-twice.
const fillEvents = events.filter((e) => e.kind === "attest" && (e as { txid: string }).txid === id(4));
ok("a duplicated attestation is de-duped in the scanner (emitted once, not twice)", fillEvents.length === 1);

// applied-once: resolve() (below V29, so it does NOT dedup) credits the partial fill exactly once.
const s = resolve(events, tipHeight);
const o = s.offers[id(3)];
ok("the partial fill is APPLIED ONCE, delivered = 10 DUST (a double-apply would be 20)", o?.delivered === "10");
ok("the partial fill is APPLIED ONCE, paid = 0.1 CSD (a double-apply would be 0.2)", o?.paid === "10000000");
ok("exactly one accepted fill event in resolved state", s.events.filter((e) => e.kind === "fill" && e.ok).length === 1);

console.log(`\nscan-attest-dedup: ${pass} passed, ${fail} failed`);
if (fail) { assert.fail(`${fail} scan-attest-dedup assertions failed`); }
