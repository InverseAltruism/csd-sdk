// A proposal's attestation list is appended to the scan's events one by one. Spread into push() as call arguments, a
// list longer than a call takes (about 125,000 on Node 22) threw a RangeError, so every full pull of a proposal with
// that many attestations failed, and a resolver that restarted never became ready again. Here a full pull of one
// proposal with 140,000 attestations completes and emits every one of them in the list's order.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const H = 100_000, PER_BLOCK = 2_000;
const tid = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const P = tid(1);

/** An indexer with one far-expiry proposal and `n` attestations of it; no chain-order feeds, so each scan is a full pull. */
function indexer(n: number) {
  // txid order follows the index, so (height, txid) order is the array order
  const atts = Array.from({ length: n }, (_, i) => ({ txid: tid(i + 2), attester: "0x" + "bb".repeat(20), score: 1, confidence: 0, height: H + 1 + Math.floor(i / PER_BLOCK), pos: i % PER_BLOCK }));
  const tip = H + 2 + Math.ceil(n / PER_BLOCK) + 20;
  const J = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
  return (async (url: string) => {
    const u = new URL(url), p = decodeURIComponent(u.pathname), q = u.searchParams;
    if (p === "/blocks/tip/height") return J(tip);
    if (p.startsWith("/block-height/")) return J("0x" + Number(p.slice("/block-height/".length)).toString(16).padStart(64, "0"));
    if (p === `/domain/${DOMAIN}/proposals`) return J([{ txid: P, domain: DOMAIN, payload_hash: "0x" + "00".repeat(32), uri: "x", expires_epoch: 10 ** 9, proposer: "0x" + "aa".repeat(20), height: H }]);
    if (p === `/proposal/${P}/attestations`) {
      const after = q.get("after_txid");
      const from = after === null ? 0 : Number(BigInt(after)) - 1;
      return J(atts.slice(from, from + Number(q.get("limit"))).map(({ pos: _pos, ...a }) => a));
    }
    const t = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
    if (t) {
      const i = Number(BigInt(t[1]!)) - 2;
      return J(i < 0 ? { txid: P, height: H, pos: 0, outputs: [] } : { txid: t[1], height: atts[i]!.height, pos: atts[i]!.pos, outputs: [] });
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

for (const n of [10, 140_000]) {
  const r = await new Scanner({ indexerUrl: "http://idx", fetch: indexer(n) }).scan();
  assert.equal(r.events.length, n + 1, `${n}: the proposal and every attestation`);
  assert.equal(r.events[0]!.kind, "propose");
  const ids = r.events.slice(1).map((e) => (e.kind === "attest" ? e.txid : ""));
  assert.deepEqual(ids, Array.from({ length: n }, (_, i) => tid(i + 2)), `${n}: in the list's order`);
  console.log(`  ok a full pull of a proposal with ${n} attestations emits all of them`);
}
console.log("scan-long-list: 2 passed");
