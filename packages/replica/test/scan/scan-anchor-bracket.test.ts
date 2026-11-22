// The hash a scan samples at its own tip before the pull must also bracket the check of the rows it keeps cached. An
// accepted scan caches branch A; the next scan confirms the block at the previous tip is still A's, and the chain
// switches to B before that scan samples its tip. If the tip sample came after the cache check, both tip samples
// would read B, the scan would read one branch and be published with A's cached in-block positions. Sampled first,
// a switch after it shows up either in the cache check or as a moved tip.
import assert from "node:assert/strict";
import http from "node:http";
import { Scanner, branchRefusal } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const X = "0x" + "a1".repeat(32), Y = "0x" + "b2".repeat(32);
let tip = 50_000;
const H = 49_998;                                   // both txs in one block below the tip, above the deep anchor
const forkAt = 49_998;                              // blocks from here up differ between the branches
const mk = (txid: string) => ({ txid, payload_hash: "0x" + "00".repeat(32), uri: "x", expires_epoch: 10, proposer: "0x" + "cc".repeat(20), height: H });
const pos: Record<"A" | "B", Record<string, number>> = { A: { [X]: 1, [Y]: 2 }, B: { [X]: 2, [Y]: 1 } };
let br: "A" | "B" = "A";
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(tip);
  if (p.startsWith("/block-height/")) {
    const h = Number(p.slice("/block-height/".length));
    return send("0x" + (h >= forkAt ? (br === "A" ? "aa" : "bb") : "ff") + h.toString(16).padStart(62, "0"));
  }
  if (p === `/domain/${DOMAIN}/proposals`) return send([mk(X), mk(Y)]);
  if (/^\/proposal\/.+\/attestations$/.test(p)) return send([]);
  const m = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
  if (m) return send({ txid: m[1], height: H, pos: pos[br][m[1]!] });
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const posOf = (r: { events: { kind: string; id?: string; pos: number }[] }, id: string) => r.events.find((e) => e.kind === "propose" && e.id === id)!.pos;
/** A fetch that moves the chain to B right after the scan's first block-hash read once `armed` is set. */
let armed = false;
const switching: typeof fetch = async (input, init) => {
  const r = await fetch(input, init);
  if (armed && new URL(String(input)).pathname.startsWith("/block-height/")) { armed = false; br = "B"; }
  return r;
};
const fresh = async () => new Scanner({ indexerUrl: base, pageSize: 10 }).scan();
/** No accepted scan may carry positions a fresh scanner on the same chain does not. */
async function published(s: Scanner) {
  const r = await s.scan();
  if (branchRefusal(r.anchor) !== null) return null;
  const f = await fresh();
  assert.deepEqual([posOf(r, X), posOf(r, Y)], [posOf(f, X), posOf(f, Y)], "an accepted scan carries the chain's positions");
  return [posOf(r, X), posOf(r, Y)];
}

try {
  for (const advance of [0, 1]) {   // the next scan at the same tip height, and one block higher
    br = "A"; tip = 50_000;
    const s = new Scanner({ indexerUrl: base, pageSize: 10, fetch: switching });
    assert.deepEqual(await published(s), [1, 2], "setup: the first scan caches A's positions");
    tip += advance;
    armed = true;                                    // B replaces the fork blocks right after the next scan's first read
    await published(s);                              // accepted only with B's positions, or refused
    assert.deepEqual(await published(s), [2, 1], "the scan after it is accepted with B's positions");
    console.log(`  ok a switch to another branch after the scan's first block-hash read is never published with the old cached positions (tip +${advance})`);
  }
  // paired: on a stable chain the reordered reads still reuse the caches (no refetch)
  {
    br = "A"; tip = 50_000;
    let txReads = 0;
    const counting: typeof fetch = async (input, init) => { if (/\/tx\//.test(String(input))) txReads++; return fetch(input, init); };
    const s = new Scanner({ indexerUrl: base, pageSize: 10, fetch: counting });
    await s.scan();
    const before = txReads;
    const r = await s.scan();
    assert.equal(branchRefusal(r.anchor), null);
    assert.equal(txReads, before, "a stable chain refetches nothing");
    console.log("  ok paired: on a stable chain the next scan reads no /tx again");
  }
} finally {
  srv.close();
}
console.log("scan-anchor-bracket: 3 passed");
