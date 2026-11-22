// Scanner.reorgEpoch, the signal a caller's per-block memo follows: it moves
// when a scan drops its caches because the chain changed under them or could not be confirmed, and only then.
import assert from "node:assert/strict";
import http from "node:http";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const TIP = 50_000;
let chainId = "aa";              // every block hash derives from it: a new id is a reorg deeper than any window
let heightsDown = false;         // the indexer cannot answer /block-height
const mock = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (p === "/blocks/tip/height") return send(TIP);
  if (p.startsWith("/block-height/")) {
    if (heightsDown) { res.writeHead(503); return res.end("{}"); }
    return send("0x" + chainId.repeat(28) + Number(p.slice(14)).toString(16).padStart(8, "0"));
  }
  if (p === `/domain/${DOMAIN}/proposals`) return send([]);
  res.writeHead(404); res.end("{}");
});
await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", () => ok()));
const s = new Scanner({ indexerUrl: `http://127.0.0.1:${(mock.address() as { port: number }).port}` });

await s.scan();
assert.equal(s.reorgEpoch, 0, "a first scan has nothing to compare");
await s.scan();
assert.equal(s.reorgEpoch, 0, "the same chain: no move (the memo keeps its old heights)");
chainId = "bb";
await s.scan();
const afterDeep = s.reorgEpoch;
assert.ok(afterDeep > 0, "every block replaced: the epoch moves");
await s.scan();
assert.equal(s.reorgEpoch, afterDeep, "settled on the new chain: no further move");
heightsDown = true;
await s.scan().catch(() => undefined);
heightsDown = false;
await s.scan().catch(() => undefined);
assert.ok(s.reorgEpoch > afterDeep, "an unconfirmable previous tip hash moves it");
console.log("  ok reorgEpoch: still on a stable chain, moves on a replaced chain and on an unconfirmable tip hash");
mock.close();
