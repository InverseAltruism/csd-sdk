// With verifyInclusion ON, the scanner binds every payment/fee-feeding tx to consensus
// (txid-recompute + merkle inclusion in a PoW-verified block + conf-depth) and fails CLOSED on any
// gap. Non-self-fulfilling: the proposal txid is the REAL codec txid of a constructed tx, the merkle
// proof is built with the codec's own merkle primitives, and each attack mutates exactly one input.
import assert from "node:assert/strict";
import { txid as codecTxid, merkleRoot, merkleBranch } from "@inversealtruism/csd-codec";
import { deploy } from "@inversealtruism/cairnx-core";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN, EPOCH_LEN, ACTIVATION_HEIGHT } from "@inversealtruism/cairnx-core";
import { KA, KEYS, signInput0 } from "./scan-chain.js";

let pass = 0;
const ok = (n: string, c: boolean) => { if (!c) { console.error("  ✗ " + n); process.exitCode = 1; } else { pass++; console.log("  ✓ " + n); } };

const A = KA;                                     // key-derived: the scanner recovers the signer from input 0
const H = ACTIVATION_HEIGHT + 40;                 // below V11 → fee-free deploy (outputs don't gate)
const TIP = H + 100;                              // deep enough to clear confDepth
const dep = deploy({ ticker: "DUST", decimals: 2, supply: "1000000", mint: "open", mintLimit: "1000" });
// a REAL consensus tx carrying the deploy record; its codec txid is the proposal id
// the coin input 0 spends: output 0 of a source tx that pays A (authorOf reads the author from it)
const source = { version: 1, inputs: [{ prevTxid: "0x" + "01".repeat(32), vout: 0, scriptSig: "" }], outputs: [{ value: 2, scriptPubkey: A.slice(2) }], locktime: 0, app: { type: "None" as const } };
const SOURCE = codecTxid(source as any);
const tx = signInput0({ version: 1, inputs: [{ prevTxid: SOURCE, vout: 0, scriptSig: "" }], outputs: [{ value: 1, scriptPubkey: A.slice(2) }], locktime: 0,
  app: { type: "Propose" as const, domain: DOMAIN, payloadHash: dep.payloadHash, uri: dep.uri, expiresEpoch: Math.floor(H / EPOCH_LEN) + 1000 } }, KEYS[KA]!);
const PID = codecTxid(tx as any);
const ROOT = merkleRoot([PID]);
const BRANCH = merkleBranch([PID], 0);

const proposals = [{ txid: PID, domain: DOMAIN, payload_hash: dep.payloadHash, uri: dep.uri, expires_epoch: Math.floor(H / EPOCH_LEN) + 1000, proposer: A, height: H, time: 0 }];
// mock indexer fetch (only the data endpoints; rawTx/header/merkle come via options)
const mockFetch = (async (url: string) => {
  const p = decodeURIComponent(new URL(url).pathname);
  const J = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as any);
  if (p === "/blocks/tip/height") return J(TIP);
  if (p === `/domain/${DOMAIN}/proposals`) return J(proposals);
  if (p.startsWith("/block-height/")) return J("0x" + "00".repeat(32));
  if (p === `/tx/${PID}`) return J({ txid: PID, height: H, pos: 0, outputs: [{ addr: A, value: 1 }] });
  if (p.endsWith("/attestations")) return J([]);
  return { ok: false, status: 404, json: async () => ({}) } as any;
}) as unknown as typeof fetch;

const baseOpts = {
  indexerUrl: "http://idx", fetch: mockFetch, verifyInclusion: true, confDepth: 12,
  headerMerkleAt: async (_h: number) => ROOT,
  rawTxAt: async (t: string) => (t === SOURCE ? source : tx) as any,
  merkleProofAt: async (_t: string) => ({ block_height: H, pos: 0, merkle: BRANCH, merkle_root: ROOT }),
  verifiedTipHeight: async () => TIP,             // PoW-verified depth reference (required when F4 is on)
};

console.log("=== F4: verified-inclusion scan ===");

// (a) honest: everything binds → scan succeeds and the deploy resolves
await (async () => {
  const s = new Scanner({ ...baseOpts });
  const { events } = await s.scan();
  ok("honest verified scan succeeds (txid bind + merkle + PoW header + depth)", events.some((e) => e.kind === "propose" && e.id === PID));
})();

// (b) forged body: rawTxAt returns a tx whose recomputed txid != PID → REJECT
await (async () => {
  const forged = { ...tx, outputs: [{ value: 999999, scriptPubkey: "bb".repeat(20) }] };
  const s = new Scanner({ ...baseOpts, rawTxAt: async () => forged as any });
  let threw = false; try { await s.scan(); } catch { threw = true; }
  ok("forged raw tx (recomputes to a different txid) is REJECTED", threw);
})();

// (c) merkle root != PoW-verified header merkle → REJECT
await (async () => {
  const s = new Scanner({ ...baseOpts, headerMerkleAt: async () => "0x" + "ff".repeat(32) });
  let threw = false; try { await s.scan(); } catch { threw = true; }
  ok("proof root disagreeing with the PoW-verified header is REJECTED", threw);
})();

// (d) too-shallow (depth < confDepth) → not yet final: the record is left out of this scan (deferred, see
// scan-defer.test.ts), so its outputs feed nothing. The depth is measured against the PoW-VERIFIED tip, so a
// lying INDEXER tip cannot help: this shrinks the VERIFIED tip (verifiedTipHeight) to make the tx shallow.
await (async () => {
  const s = new Scanner({ ...baseOpts, verifiedTipHeight: async () => H + 1 }); // verified depth 1 < 12
  const { events } = await s.scan();
  ok("a tx shallower than confDepth (vs the PoW-verified tip) is NOT RESOLVED (reorg-exposed, deferred)", !events.some((e) => e.kind === "propose" && e.id === PID));
})();

// (d2) the indexer inflates its OWN tip to fake depth, but the gate uses the
// PoW-verified tip, so an honestly-mined-but-SHALLOW tx is still rejected regardless of the indexer's tip.
await (async () => {
  const liar = (async (url: string) => {
    const p = decodeURIComponent(new URL(url).pathname);
    if (p === "/blocks/tip/height") return { ok: true, status: 200, json: async () => H + 100000 } as any; // indexer lies: "very deep"
    return (mockFetch as any)(url);
  }) as unknown as typeof fetch;
  const s = new Scanner({ ...baseOpts, fetch: liar, verifiedTipHeight: async () => H + 3 }); // real depth 3 < 12
  const { events } = await s.scan();
  ok("an inflated INDEXER tip cannot fake depth: the PoW-verified tip governs → shallow tx NOT RESOLVED", !events.some((e) => e.kind === "propose" && e.id === PID));
})();

// (f) claim-deep / prove-shallow: the indexer claims a DEEP height for the tx but the merkle
// proof proves it sits in a DIFFERENT (near-tip, shallow) block. The claimed height must equal the proven
// one, so the mismatch is rejected (the old gate ran on the claimed height and accepted this).
await (async () => {
  const s = new Scanner({ ...baseOpts, merkleProofAt: async () => ({ block_height: H + 95, pos: 0, merkle: BRANCH, merkle_root: ROOT }) });
  let threw = false; try { await s.scan(); } catch { threw = true; }
  ok("indexer-claimed height != merkle-proven height is REJECTED (claim-deep / prove-shallow)", threw);
})();

// (g) NaN proof height: a garbled merkle-proof block_height must not slip through the depth gate (in the
// old code NaN < confDepth was false, so the shallow-check passed). The isSafeInteger guard rejects it.
await (async () => {
  const s = new Scanner({ ...baseOpts, merkleProofAt: async () => ({ block_height: NaN as any, pos: 0, merkle: BRANCH, merkle_root: ROOT }) });
  let threw = false; try { await s.scan(); } catch { threw = true; }
  ok("a NaN merkle-proof block_height is REJECTED (not silently passed as depth NaN)", threw);
})();

// (h) the indexer's decoded outputs disagree with the consensus-bound ones: the scan keeps the verified outputs and
// logs the divergence once, with its whole text
await (async () => {
  const lying = (async (url: string) => {
    const p = decodeURIComponent(new URL(url).pathname);
    if (p === `/tx/${PID}`) return { ok: true, status: 200, json: async () => ({ txid: PID, height: H, pos: 0, outputs: [{ addr: A, value: 999 }] }) } as any;
    return (mockFetch as any)(url);
  }) as unknown as typeof fetch;
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  let events;
  try { ({ events } = await new Scanner({ ...baseOpts, fetch: lying }).scan()); } finally { console.warn = warn; }
  ok("a divergent indexer decode is logged once with its whole text and the verified outputs are kept",
    events.some((e) => e.kind === "propose" && e.id === PID) &&
    JSON.stringify(warned) === JSON.stringify([`F4: indexer decode for ${PID} differs from the consensus-bound outputs (indexer=1 verified=1). Using verified outputs; the indexer is lying or buggy`]));
  if (warned.length !== 1) console.error("    warned:", warned);
})();

// (e) misconfiguration: verifyInclusion without ALL required sources → constructor throws
ok("verifyInclusion without any sources throws at construction",
  (() => { try { new Scanner({ indexerUrl: "http://idx", verifyInclusion: true }); return false; } catch { return true; } })());
ok("verifyInclusion missing verifiedTipHeight throws at construction",
  (() => { try { new Scanner({ indexerUrl: "http://idx", verifyInclusion: true, headerMerkleAt: async () => ROOT, rawTxAt: async () => tx as any }); return false; } catch { return true; } })());

console.log(`\nF4 verified-inclusion: ${pass}/10`);
assert.equal(process.exitCode ?? 0, 0, "F4 test failed");
