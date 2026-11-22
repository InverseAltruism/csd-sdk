// CairnX scanner hardening: real Scanner against a MOCK indexer that returns MALFORMED outputs.
// A bad output (non-numeric/hex value, missing/garbage addr,
// huge array) is SKIPPED (not thrown, not counted) → a fill whose payment came via a malformed
// output is REJECTED (conservative), and one weird tx never crashes the scan.
import assert from "node:assert/strict";
import http from "node:http";
import { deploy, mint, offer } from "@inversealtruism/cairnx-core";
import { resolve } from "@inversealtruism/cairnx-core";
import { Scanner } from "../../src/scanner.js";
import { ACTIVATION_HEIGHT, DOMAIN, EPOCH_LEN, SCORE_FILL } from "@inversealtruism/cairnx-core";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const H = ACTIVATION_HEIGHT + 40; // pre-v11 → no protocol fee, isolates the payment check
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const ee = Math.floor(H / EPOCH_LEN) + 1000;

const dep = deploy({ ticker: "DUST", decimals: 0, supply: "1000", mint: "open", mintLimit: "1000" });
const mnt = mint({ ticker: "DUST" });
const off = offer({ give: { ticker: "DUST", amount: "100" }, want: { value: "50000000" } }); // wants 0.5 CSD

const proposals = [
  { txid: id(1), domain: DOMAIN, payload_hash: dep.payloadHash, uri: dep.uri, expires_epoch: ee, proposer: A, height: H },
  { txid: id(2), domain: DOMAIN, payload_hash: mnt.payloadHash, uri: mnt.uri, expires_epoch: ee, proposer: A, height: H + 1 },
  { txid: id(3), domain: DOMAIN, payload_hash: off.payloadHash, uri: off.uri, expires_epoch: Math.floor(H / EPOCH_LEN) + 24, proposer: A, height: H + 2 },
];
// TWO fill attempts on the same offer: #1 pays the seller via a MALFORMED output (must be skipped
// → rejected); #2 pays via well-formed outputs (must succeed).
const attestations: Record<string, unknown[]> = {
  [id(3)]: [
    { txid: id(4), proposal_id: id(3), attester: B, score: SCORE_FILL, height: H + 3 },
    { txid: id(5), proposal_id: id(3), attester: B, score: SCORE_FILL, height: H + 4 },
  ],
};
const txs: Record<string, unknown> = {
  [id(1)]: { txid: id(1), height: H, pos: 1, outputs: [{ addr: A, value: 1 }] },
  [id(2)]: { txid: id(2), height: H + 1, pos: 1, outputs: [{ addr: A, value: 1 }] },
  [id(3)]: { txid: id(3), height: H + 2, pos: 1, outputs: [{ addr: A, value: 1 }] },
  // fill #1: the seller "payment" is malformed (hex-string value + a null-addr output) → both skipped
  [id(4)]: { txid: id(4), height: H + 3, pos: 2, outputs: [{ addr: A, value: "0x2faf080" }, { addr: null, value: 50000000 }, { addr: B, value: 10 }] },
  // fill #2: well-formed payment → counts
  [id(5)]: { txid: id(5), height: H + 4, pos: 2, outputs: [{ addr: A, value: 50000000 }, { addr: B, value: 99 }] },
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
const state = resolve(events, tipHeight);

assert.equal(events.length, 5, "scan did not crash on the malformed tx (skipped, not thrown)");
console.log("  ok malformed outputs do NOT crash the scan (one weird tx can't DoS it)");

const o = state.offers[id(3)]!;
assert.equal(o.status, "filled");
assert.equal(o.fill!.buyer, B);
assert.equal(o.fill!.txid, id(5), "the WELL-FORMED fill won; the malformed-payment fill was rejected");
console.log("  ok malformed-payment fill REJECTED (hex value + null addr skipped → payment not counted)");

assert.equal(state.balances.DUST![B]!.available, "100");
assert.equal(state.events.filter((e) => e.kind === "fill" && !e.ok).length, 1); // the malformed attempt
console.log("  ok conservative skip: malformed outputs shrink the payment, never inflate it");

mock.close();
console.log("\nscan-hardening: 3/3 passed");
