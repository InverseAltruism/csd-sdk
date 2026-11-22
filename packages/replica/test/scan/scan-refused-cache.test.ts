// A scan that branchRefusal rejects must not leave what it read in the caches. Here the block at the tip changes from
// branch A to branch B during scan 1's pull, so scan 1 caches B's in-block positions and is refused ("moved"); the
// chain returns to A before scan 2, whose shallow reorg check compares the tip block with the A hash sampled before
// scan 1's pull, sees no change and keeps the caches. Scan 2 reads one branch and is published: it must carry A's
// positions, as a fresh scanner does, not B's (two transfers of one balance in one block resolve by position).
import assert from "node:assert/strict";
import http from "node:http";
import { Scanner, branchRefusal } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const TIP = 50_000, H = TIP - 2;                   // both txs in one block 2 below the tip, above the deep anchor
const X = "0x" + "a1".repeat(32), Y = "0x" + "b2".repeat(32), Z = "0x" + "c3".repeat(32);
const props = [X, Y];
const mk = (txid: string) => ({ txid, payload_hash: "0x" + "00".repeat(32), uri: "x", expires_epoch: 10, proposer: "0x" + "cc".repeat(20), height: H });
const branches = { A: { pos: { [X]: 1, [Y]: 2, [Z]: 3 } as Record<string, number>, tag: "aa" }, B: { pos: { [X]: 2, [Y]: 1, [Z]: 3 } as Record<string, number>, tag: "bb" } };
let br: "A" | "B" = "A";
let flipOnTx = false;                              // move to B when the scanner first asks for a /tx (mid-pull)
let txReads = 0;
const readsOf = new Map<string, number>();
const deep = "0x" + "ff".repeat(32);               // the block at tip-12: below the fork, unchanged
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(TIP);
  if (p.startsWith("/block-height/")) {
    const h = Number(p.slice("/block-height/".length));
    return send(h <= TIP - 12 ? deep : "0x" + branches[br].tag + h.toString(16).padStart(62, "0"));
  }
  if (p === `/domain/${DOMAIN}/proposals`) return send(props.map(mk));
  if (/^\/proposal\/.+\/attestations$/.test(p)) return send([]);
  const m = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
  if (m) { txReads++; readsOf.set(m[1]!, (readsOf.get(m[1]!) ?? 0) + 1); if (flipOnTx) { br = "B"; flipOnTx = false; } return send({ txid: m[1], height: H, pos: branches[br].pos[m[1]!] }); }
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const posOf = (r: { events: { kind: string; id?: string; pos: number }[] }, id: string) => r.events.find((e) => e.kind === "propose" && e.id === id)!.pos;

try {
  const s = new Scanner({ indexerUrl: base, pageSize: 10 });
  flipOnTx = true;
  const r1 = await s.scan();
  assert.equal(r1.anchor.branch, "moved", "setup: scan 1 straddled the switch to B");
  assert.notEqual(branchRefusal(r1.anchor), null);
  br = "A";                                        // back on A before the next poll
  const r2 = await s.scan();
  assert.equal(branchRefusal(r2.anchor), null, "setup: scan 2 reads one branch and is published");
  const fresh = await new Scanner({ indexerUrl: base, pageSize: 10 }).scan();
  assert.deepEqual([posOf(r2, X), posOf(r2, Y)], [posOf(fresh, X), posOf(fresh, Y)], "the published scan carries A's positions");
  assert.deepEqual([posOf(r2, X), posOf(r2, Y)], [1, 2]);
  console.log("  ok a scan refused as moved leaves nothing cached: the next accepted scan reads branch A's positions");

  // paired: on a stable chain the caches still save the reads (no refetch once a scan was accepted)
  const before = txReads;
  const r3 = await s.scan();
  assert.equal(branchRefusal(r3.anchor), null);
  assert.equal(txReads, before, "a stable chain refetches nothing");
  console.log("  ok paired: after an accepted scan on a stable chain the next scan reads no /tx again");

  // A scan that throws part way (here the attestation request after the switch to B fails) is as unsuccessful as a
  // refused one: what it cached of B must not survive into the next scan after the chain returns to A.
  let failAtts = false;
  const flaky: typeof fetch = async (input, init) => {
    if (failAtts && /\/attestations$/.test(new URL(String(input)).pathname)) throw new Error("injected: attestation request failed");
    return fetch(input, init);
  };
  br = "A";
  const s2 = new Scanner({ indexerUrl: base, pageSize: 10, fetch: flaky });
  flipOnTx = true; failAtts = true;
  await assert.rejects(s2.scan(), /injected: attestation request failed/, "the original error comes through");
  failAtts = false; br = "A";
  const r4 = await s2.scan();
  assert.equal(branchRefusal(r4.anchor), null);
  assert.deepEqual([posOf(r4, X), posOf(r4, Y)], [1, 2], "the scan after a failed one carries A's positions");
  console.log("  ok a scan that throws after caching another branch's rows leaves none of them for the next scan");

  // paired: rows an earlier accepted scan cached survive a scan that throws (no refetch of the whole history); a new
  // proposal Z is read, its attestation request fails, and only Z is read again by the next scan
  props.push(Z);
  const readsBefore = new Map(readsOf);
  failAtts = true;
  await assert.rejects(s2.scan(), /injected/);
  failAtts = false;
  const r5 = await s2.scan();
  assert.equal(branchRefusal(r5.anchor), null);
  const again = (t: string) => (readsOf.get(t) ?? 0) - (readsBefore.get(t) ?? 0);
  assert.deepEqual([again(X), again(Y), again(Z)], [0, 0, 2], "X and Y stay cached; Z, which the failed scan cached, is read again");
  console.log("  ok paired: a failed scan drops only what it cached itself; the rows of accepted scans stay cached");
} finally {
  srv.close();
}
console.log("scan-refused-cache: 4 passed");
