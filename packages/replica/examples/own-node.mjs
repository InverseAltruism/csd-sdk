// Level 3, proof inclusion: a token balance from one's own node, every record in a complete block bound to the block's
// header and its author bound to the coin it spent (the README, "Entries", nodeBlocks). It reads every block from the
// activation height, so the first run takes as long as one's node takes to serve them.
//   node own-node.mjs <node url> <ticker> <address>
//   node own-node.mjs http://127.0.0.1:8789 CAIRN 0x6b09ce74e6070ebc982ab0fb793a211c4d24f016
import { local, open } from "@inversealtruism/cairnx-replica/server";

const [node, ticker, address] = process.argv.slice(2);
if (!node || !ticker || !address) { console.error("usage: node own-node.mjs <node url> <ticker> <address>"); process.exit(2); }

// One's own node is the header root, so no witness is needed for an answer to be verified.
const replica = await open({ ...local({ node }), step: { maxBlocks: 512, maxRequests: 600 } });
await replica.advance();
const a = await replica.balance(ticker, address);
// Act on `value` only when `verified` is true; `shown` is for display.
console.log(JSON.stringify({
  ticker, address, level: a.level, proof: a.proof, verified: a.verified, why: a.why.map((w) => w.code),
  at: a.at && { height: a.at.height, tipHeight: a.at.tipHeight }, balance: a.verified ? a.value : a.shown,
}, null, 2));
await replica.close();
