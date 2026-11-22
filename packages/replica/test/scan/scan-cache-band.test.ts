// A block that lands while a scan pulls sits above the tip that scan sampled. The shallow-reorg check of the next
// scan samples that old tip, so a re-mine of the new block that swaps two of its txs is not seen there. If the first
// scan had cached those positions, the long-running scanner keeps them and its canonical state forks from a fresh
// scanner's: two same-height deploys of one ticker, where position decides which one wins.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { canonicalState, resolve } from "@inversealtruism/cairnx-core";
import { deploy } from "@inversealtruism/cairnx-core";
import { ACTIVATION_HEIGHT, DOMAIN, EPOCH_LEN } from "@inversealtruism/cairnx-core";

const T = ACTIVATION_HEIGHT + 50;        // the tip scan 1 samples; below V11, so a deploy needs no fee output
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const A = id(0xa), B = id(0xb);
const depA = deploy({ ticker: "BAND", decimals: 0, supply: "1000", mint: "open", mintLimit: "10" });
const depB = deploy({ ticker: "BAND", decimals: 2, supply: "5000", mint: "open", mintLimit: "50" });
const row = (txid: string, rec: { uri: string; payloadHash: string }, proposer: string) => ({
  txid, domain: DOMAIN, payload_hash: rec.payloadHash, uri: rec.uri,
  expires_epoch: Math.floor(T / EPOCH_LEN) + 1000, proposer, height: T + 1,
});
const rows = [row(A, depA, "0x" + "aa".repeat(20)), row(B, depB, "0x" + "bb".repeat(20))];

// The chain as the indexer serves it. `tip` is what /blocks/tip/height answers; block T + 1 is already listed while
// the tip still reads T (it landed after the sample). `remined` swaps A and B inside block T + 1.
const chain = { tip: T, remined: false, txHits: 0 };
const blockHash = (h: number) => "0x" + (h === T + 1 && chain.remined ? "f" : "0") + h.toString(16).padStart(63, "0");
const indexer = (async (url: string) => {
  const p = decodeURIComponent(new URL(url).pathname);
  const J = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
  if (p === "/blocks/tip/height") return J(chain.tip);
  if (p.startsWith("/block-height/")) return J(blockHash(Number(p.slice("/block-height/".length))));
  if (p === `/domain/${DOMAIN}/proposals`) return J(rows);
  if (p.endsWith("/attestations")) return J([]);
  const m = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
  if (m) {
    chain.txHits++;
    const first = chain.remined ? B : A;
    return J({ txid: m[1], height: T + 1, pos: m[1] === first ? 0 : 1, outputs: [] });
  }
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as unknown as typeof fetch;

const opts = { indexerUrl: "http://idx", fetch: indexer, pageSize: 10 };
const stateOf = (r: Awaited<ReturnType<Scanner["scan"]>>) => resolve(r.events, r.tipHeight);
const posOf = (r: Awaited<ReturnType<Scanner["scan"]>>, txid: string) => r.events.find((e) => e.kind === "propose" && e.id === txid)?.pos;

const long = new Scanner(opts);
const r1 = await long.scan();
assert.equal(r1.tipHeight, T);
assert.equal(posOf(r1, A), 0, "scan 1 reads A first in block T + 1");

// Block T + 1 is re-mined with B first and becomes the tip; block T keeps its hash.
chain.tip = T + 1;
chain.remined = true;
const hitsBefore = chain.txHits;
const r2 = await long.scan();
assert.equal(chain.txHits - hitsBefore, 2, "the txs scan 1 saw above its tip are read again");
const fresh = await new Scanner(opts).scan();
assert.equal(posOf(fresh, B), 0, "a fresh scanner reads B first after the re-mine");
assert.equal(posOf(r2, B), 0, "the long-running scanner reads the re-mined positions");
assert.equal(stateOf(r2).tokens.BAND?.deployId, B, "B's deploy wins in the long-running scanner");
assert.equal(canonicalState(stateOf(r2)), canonicalState(stateOf(fresh)), "the long-running scanner's state equals a fresh scanner's");
console.log("  ok a re-mine of the block that landed during scan 1 reaches the next scan");

// Paired honest path: with the chain unchanged, txs at or below the tip stay cached and nothing is read again.
const hitsSteady = chain.txHits;
const r3 = await long.scan();
assert.equal(chain.txHits, hitsSteady, "a stable chain reuses the cached txs at or below the tip");
assert.equal(canonicalState(stateOf(r3)), canonicalState(stateOf(fresh)));
console.log("  ok a stable chain keeps the cache for txs at or below the tip");

console.log("\nscan-cache-band: 2 passed");
