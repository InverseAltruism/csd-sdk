// Level 1, proof served: a .csd name from a csd-indexer's records, complete on the indexer's word (the README, "A
// csd-indexer feed"). Nothing in the answer is proven to be on the chain.
//   node feed.mjs <indexer base> <name>
//   node feed.mjs https://cairn-substrate.com/explorer/api cairn
import { indexerFeed, open } from "@inversealtruism/cairnx-replica/server";

const [indexerUrl, name] = process.argv.slice(2);
if (!indexerUrl || !name) { console.error("usage: node feed.mjs <indexer base> <name>"); process.exit(2); }

// One wide step reads to the tip: the loop's default step is sized for a replica that keeps reading.
const replica = await open({ source: indexerFeed({ indexerUrl }), step: { maxBlocks: 100_000, maxRequests: 100_000 } });
await replica.advance();
const a = await replica.name(name);
// `value` only when verified, which needs level 3: a feed's answer is in `shown`, with the reasons in `why`.
console.log(JSON.stringify({
  name, level: a.level, proof: a.proof, verified: a.verified, why: a.why.map((w) => w.code),
  at: a.at && { height: a.at.height, tipHeight: a.at.tipHeight }, record: a.verified ? a.value : a.shown,
}, null, 2));
await replica.close();
