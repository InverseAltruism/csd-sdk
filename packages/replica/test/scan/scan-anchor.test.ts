// Plan 80 C1 (CX-13): the scanner reports the tip hash it saw before AND after its pull.
import assert from "node:assert/strict";
import http from "node:http";
import { Scanner, branchRefusal } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const TIP = 50_000;
let tip = TIP;
let flipDuringPull = false;     // the block at TIP is replaced while the proposals page is being served
let advanceDuringPull = false;  // a new block lands above TIP while the pull runs (normal)
let branch = "a";
let hashGoneAfterPull = false;  // the indexer stops answering /block-height once the proposals page is served
let hashGoneBeforePull = false; // the indexer does not answer /block-height until the proposals page is served
let pulled = false;
const hashAt = (h: number) => "0x" + (branch === "b" && h === TIP ? "bb" : "aa") + h.toString(16).padStart(62, "0");
const mock = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(tip);
  if (p === `/domain/${DOMAIN}/proposals`) {
    if (flipDuringPull) branch = "b";
    if (advanceDuringPull) tip = TIP + 1;
    pulled = true;
    return send([]);
  }
  const m = /^\/block-height\/(\d+)$/.exec(p);
  if (m && ((hashGoneAfterPull && pulled) || (hashGoneBeforePull && !pulled))) { res.writeHead(502); return res.end("<html>bad gateway</html>"); }
  if (m) return send(hashAt(Number(m[1])));
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", () => ok()));
const base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

{
  const { anchor, tipHeight } = await new Scanner({ indexerUrl: base }).scan();
  assert.equal(tipHeight, TIP);
  assert.equal(anchor.hashBefore, anchor.hashAfter);
  assert.ok(anchor.hashBefore);
  assert.equal(anchor.branch, "one");
  console.log("  ok a quiet chain: the same hash before and after the pull");
}
{
  branch = "a"; tip = TIP; advanceDuringPull = true;
  const { anchor } = await new Scanner({ indexerUrl: base }).scan();
  assert.equal(anchor.height, TIP);
  assert.equal(anchor.hashBefore, anchor.hashAfter, "a newer block above the declared tip does not reject the scan");
  assert.equal(anchor.branch, "one");
  advanceDuringPull = false; tip = TIP;
  console.log("  ok paired: a tip advancing during the pull keeps the declared height's hash equal");
}
{
  branch = "a"; flipDuringPull = true;
  const { anchor } = await new Scanner({ indexerUrl: base }).scan();
  assert.notEqual(anchor.hashBefore, anchor.hashAfter, "red-first: a same-height reorg during the pull shows as two hashes");
  assert.equal(anchor.branch, "moved");
  flipDuringPull = false;
  console.log("  ok a same-height reorg during the pull is visible to the caller");
}
{
  branch = "a"; hashGoneAfterPull = true; pulled = false;
  const { anchor } = await new Scanner({ indexerUrl: base }).scan();
  assert.equal(anchor.hashAfter, null);
  assert.equal(anchor.branch, "unread", "a hash that could not be read after the pull proves no branch");
  hashGoneAfterPull = false;
  console.log("  ok an unreadable hash after the pull leaves the branch unread");
}
{
  // a reorg during the pull while either anchor read fails: the scan may mix two branches, and no caller may act on it
  for (const side of ["before", "after"] as const) {
    branch = "a"; pulled = false; flipDuringPull = true;
    hashGoneBeforePull = side === "before"; hashGoneAfterPull = side === "after";
    const { anchor } = await new Scanner({ indexerUrl: base }).scan();
    assert.equal(anchor.branch, "unread", side);
    assert.equal(branchRefusal(anchor), "the indexer's tip hash could not be read before and after the scan", side);
  }
  flipDuringPull = false; hashGoneBeforePull = false; hashGoneAfterPull = false; branch = "a"; pulled = false;
  const { anchor } = await new Scanner({ indexerUrl: base }).scan();
  assert.equal(branchRefusal(anchor), null, "paired: a quiet scan is one branch, which every caller acts on");
  console.log("  ok a reorg with either anchor read failing is refused by branchRefusal; a quiet scan is not");
}
mock.close();
console.log("scan-anchor: 5 passed");
