// Scanner with verifyInclusion on: the indexer's merkle proof must carry the header's root AND a branch that folds the
// txid to it. Here the root is the node's own, so the header compare passes and only the fold can refuse the proof.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { deploy, mint } from "@inversealtruism/cairnx-core";
import { H0, KA, KB, KEYS, buildChain, type Spec } from "./scan-chain.js";

let passed = 0;
const failed: string[] = [];
const at = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log("  ok", name); }
  catch (e) { failed.push(name); console.log("  FAIL", name, "\n   ", (e as Error).message.split("\n").slice(0, 4).join("\n    ")); }
};

const specs: Spec[] = [
  { kind: "propose", rec: deploy({ ticker: "FND", decimals: 0, supply: "1000", mint: "open", mintLimit: "10" }), proposer: KA, height: H0 },
  { kind: "propose", rec: mint({ ticker: "FND", amount: "2" }), proposer: KB, height: H0 + 2 },
];
const TIP = H0 + 30;
const chain = buildChain(specs, { keys: KEYS });
const [DEP, MINT] = chain.txs.map((x) => x.txid) as [string, string];
type Fetch = typeof fetch;
/** The chain's indexer at TIP with the merkle branch of MINT's proof replaced by `merkle` (root, height, pos kept). */
const proofBranch = (merkle: string[] | null): Fetch => {
  const base = chain.indexer({ tip: TIP });
  return (async (url: string) => {
    const r = await base(url);
    if (merkle === null || new URL(url).pathname !== `/tx/${MINT}/merkle-proof`) return r;
    const proof = await r.json() as Record<string, unknown>;
    return { ok: true, status: 200, json: async () => ({ ...proof, merkle }) } as unknown as Response;
  }) as unknown as Fetch;
};
const scan = (f: Fetch) => new Scanner({ indexerUrl: "http://idx", fetch: f, ...chain.verified({ verifiedTip: TIP }) }).scan();

await at("paired: the honest proofs fold to the header root and both records are read", async () => {
  const r = await scan(proofBranch(null));
  assert.equal(r.anchor.branch, "one");
  assert.deepEqual(r.events.map((e) => (e.kind === "propose" ? e.id : e.txid)).sort(), [DEP, MINT].sort());
});

await at("a proof with the header's root and a branch that does not fold the txid to it fails the scan", async () => {
  let msg = "(resolved)";
  try { await scan(proofBranch(["0x" + "ab".repeat(32)])); } catch (e) { msg = String((e as Error).message); }
  assert.match(msg, new RegExp(`^F4: tx ${MINT} does not merkle-prove into block ${H0 + 2}$`));
});

console.log(`scan-merkle-fold: ${passed} passed, ${failed.length} failed`);
assert.deepEqual(failed, []);
