// M3-B1-03: a steady scan reads only what is new. Before the chain-order feed, every scan pulled the whole attestation
// list of each proposal whose window was still open, so its request count grew with that count (a far expiry keeps a
// window open for good, 0.25 CSD per proposal). Here the count of a scan with nothing new, and of one with one new
// block, is the same for 10, 100 and 1,000 far-expiry proposals; every scan still emits what a fresh scanner does.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { deploy, mint } from "@inversealtruism/cairnx-core";
import { A, B, H0, buildChain, type Spec } from "./scan-chain.js";

const PER_BLOCK = 50;

async function costs(n: number) {
  const specs: Spec[] = [{ kind: "propose", rec: deploy({ ticker: "FAR", decimals: 0, supply: "1000000", mint: "open", mintLimit: "10" }), proposer: A, height: H0 }];
  for (let i = 0; i < n; i++) specs.push({ kind: "propose", rec: mint({ ticker: "FAR", amount: String(1 + (i % 9)) }), proposer: A, height: H0 + 1 + Math.floor(i / PER_BLOCK) });
  const last = H0 + 1 + Math.ceil(n / PER_BLOCK);
  // one more block: a new proposal and an attestation on the first far-expiry one
  specs.push({ kind: "propose", rec: mint({ ticker: "FAR", amount: "7" }), proposer: B, height: last + 20 });
  specs.push({ kind: "attest", of: 1, attester: B, score: 1, confidence: 0, height: last + 20 });
  const chain = buildChain(specs);
  let tip = last + 19, reqs = 0, txReads = 0;
  const counting = (async (url: string) => {
    reqs++;
    if (/^\/tx\//.test(new URL(url).pathname)) txReads++;
    return chain.indexer({ tip })(url);
  }) as unknown as typeof fetch;
  const fresh = () => new Scanner({ indexerUrl: "http://idx", fetch: chain.indexer({ tip }) }).scan();
  const s = new Scanner({ indexerUrl: "http://idx", fetch: counting });
  const cold = await s.scan();
  assert.equal(cold.events.length, n + 1);
  reqs = 0;
  const quiet = await s.scan();
  const quietReqs = reqs;
  assert.deepEqual(quiet.events, (await fresh()).events, "a scan with nothing new emits what a fresh scanner does");
  tip = last + 20;
  reqs = 0; txReads = 0;
  const grown = await s.scan();
  const grownReqs = reqs, grownTx = txReads;
  assert.equal(grown.events.length, n + 3);
  assert.deepEqual(grown.events, (await fresh()).events, "a scan with one new block emits what a fresh scanner does");
  return { quietReqs, grownReqs, grownTx };
}

const seen: Record<number, { quietReqs: number; grownReqs: number; grownTx: number }> = {};
for (const n of [10, 100, 1000]) seen[n] = await costs(n);
console.log("  steady scan requests by far-expiry proposal count:", JSON.stringify(seen));
const quiet = new Set(Object.values(seen).map((c) => c.quietReqs));
const grown = new Set(Object.values(seen).map((c) => c.grownReqs));
assert.equal(quiet.size, 1, `a scan with nothing new costs the same whatever the open-window count: ${JSON.stringify(seen)}`);
assert.equal(grown.size, 1, `a scan with one new block costs the same whatever the open-window count: ${JSON.stringify(seen)}`);
assert.ok(seen[1000]!.quietReqs <= 8, `a quiet scan is a handful of requests (${seen[1000]!.quietReqs})`);
assert.equal(seen[1000]!.grownTx, 2, "one new proposal and one new attestation cost one /tx read each");
console.log("  ok the steady scan's request count does not grow with the open-window proposal count");
console.log("scan-feed-cost: 1 passed");
