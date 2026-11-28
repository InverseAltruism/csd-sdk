// Scanner with verifyInclusion on: an event's position in its block is its merkle proof's, so the proof must prove
// that position. csd-codec verifyMerkleProof refuses a position the transaction does not hold, and the Scanner refuses
// a position that is not a safe integer >= 0 as SOURCE_MALFORMED before the fold. Every other answer here is honest.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { SourceError } from "../../src/errors.js";
import { deploy, mint, resolve } from "@inversealtruism/cairnx-core";
import { H0, KA, KB, KC, KEYS, buildChain, type Spec } from "./scan-chain.js";

let passed = 0;
const failed: string[] = [];
const at = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log("  ok", name); }
  catch (e) { failed.push(name); console.log("  FAIL", name, "\n   ", (e as Error).message.split("\n").slice(0, 4).join("\n    ")); }
};

type Fetch = typeof fetch;
const TIP = H0 + 30;
/** `chain`'s indexer at TIP with the position of `txid`'s merkle proof replaced by `pos` (branch, root, height kept). */
const proofPos = (chain: ReturnType<typeof buildChain>, txid: string, pos: unknown): Fetch => {
  const base = chain.indexer({ tip: TIP });
  return (async (url: string) => {
    const r = await base(url);
    if (pos === undefined || new URL(url).pathname !== `/tx/${txid}/merkle-proof`) return r;
    const proof = await r.json() as Record<string, unknown>;
    return { ok: true, status: 200, json: async () => ({ ...proof, pos }) } as unknown as Response;
  }) as unknown as Fetch;
};
const scan = (chain: ReturnType<typeof buildChain>, f: Fetch) =>
  new Scanner({ indexerUrl: "http://idx", fetch: f, ...chain.verified({ verifiedTip: TIP }) }).scan();
const refusal = async (p: Promise<unknown>): Promise<unknown> => {
  try { await p; } catch (e) { return e; }
  return null;
};

// Two mints of an open token in one block: KA's at 0, KB's at 1; supply 15, so the first takes 10 and the second 5.
const mints = buildChain([
  { kind: "propose", rec: deploy({ ticker: "POSX", decimals: 0, supply: "15", mint: "open", mintLimit: "10" }), proposer: KA, height: H0 },
  { kind: "propose", rec: mint({ ticker: "POSX", amount: "10" }), proposer: KA, height: H0 + 2 },
  { kind: "propose", rec: mint({ ticker: "POSX", amount: "10" }), proposer: KB, height: H0 + 2 },
] satisfies Spec[], { keys: KEYS });
const MINT_A = mints.txs[1]!.txid;

await at("paired: the honest proofs give the mints their positions, KA 10 and KB 5", async () => {
  const r = await scan(mints, proofPos(mints, MINT_A, undefined));
  assert.equal(r.anchor.branch, "one");
  assert.deepEqual(r.events.filter((e) => e.height === H0 + 2).map((e) => e.pos).sort((a, b) => a - b), [0, 1]);
  const b = resolve(r.events, r.tipHeight).balances.POSX ?? {};
  assert.equal(b[KA]?.available, "10");
  assert.equal(b[KB]?.available, "5");
});

await at("KA's mint proven at 2 (0 + 2^levels), which once moved 5 POSX to KB, fails the scan", async () => {
  const e = await refusal(scan(mints, proofPos(mints, MINT_A, 2)));
  assert.match(String((e as Error)?.message), new RegExp(`^F4: tx ${MINT_A} does not merkle-prove into block ${H0 + 2}$`));
});

await at("a proof position that is not a safe integer >= 0 is SOURCE_MALFORMED", async () => {
  for (const pos of [-2, 0.5, "0", null, 2 ** 53, Number.NaN]) {
    const e = await refusal(scan(mints, proofPos(mints, MINT_A, pos)));
    assert.ok(e instanceof SourceError, `${String(pos)}: ${String(e)}`);
    assert.equal(e.code, "SOURCE_MALFORMED");
    assert.match(e.message, /merkle proof has a position that is not a safe integer >= 0/);
  }
});

// A block of 6: four other deploys, then two deploys of one ticker, KA's at 4 and KB's at 5. The first holds the ticker.
const six = buildChain([
  ...["FILA", "FILB", "FILC", "FILD"].map((ticker) =>
    ({ kind: "propose", rec: deploy({ ticker, decimals: 0, supply: "1", mint: "issuer" }), proposer: KC, height: H0 + 2 }) as Spec),
  { kind: "propose", rec: deploy({ ticker: "DUPE", decimals: 0, supply: "1", mint: "issuer" }), proposer: KA, height: H0 + 2 },
  { kind: "propose", rec: deploy({ ticker: "DUPE", decimals: 0, supply: "2", mint: "issuer" }), proposer: KB, height: H0 + 2 },
], { keys: KEYS });
const DEP_A = six.txs[4]!.txid;

await at("paired: in the block of 6 the honest proofs put KA's deploy at 4 and KA holds the ticker", async () => {
  const r = await scan(six, proofPos(six, DEP_A, undefined));
  assert.equal(r.anchor.branch, "one");
  assert.deepEqual(r.events.filter((e) => e.height === H0 + 2).map((e) => e.pos).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(resolve(r.events, r.tipHeight).tokens.DUPE?.deployer, KA);
});

await at("KA's deploy proven at 6 with its own branch (the odd row's duplicate), which once gave KB the ticker, fails the scan", async () => {
  const e = await refusal(scan(six, proofPos(six, DEP_A, 6)));
  assert.match(String((e as Error)?.message), new RegExp(`^F4: tx ${DEP_A} does not merkle-prove into block ${H0 + 2}$`));
});

console.log(`scan-proof-pos: ${passed} passed, ${failed.length} failed`);
assert.deepEqual(failed, []);
