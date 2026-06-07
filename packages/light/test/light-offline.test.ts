// OFFLINE light-client verification — runs in CI with NO node, against a committed fixture of
// REAL mainnet headers. The live light.test.ts exits 0 when no node is reachable, so without this
// the entire light client (PoW + LWMA re-derivation + checkpoint seed + inclusion + tamper
// rejection) was UNTESTED in CI. Real headers are used so PoW/LWMA are genuine, not synthetic.
import { LightClient, type HeaderProvider } from "../src/index.js";
import { LWMA_WINDOW, verifyMerkleProof, merkleBranch, type BlockHeader } from "@inversealtruism/csd-codec";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures-headers.json"), "utf8")) as {
  from: number; tip: number;
  headers: { height: number; hash: string; header: BlockHeader; txids: string[] }[];
};
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n); } };
const byH = new Map(FX.headers.map((h) => [h.height, h]));
const provider: HeaderProvider = async (h: number) => {
  const r = byH.get(h); if (!r) throw new Error(`no fixture header at ${h}`);
  return { header: r.header, hash: r.hash, txids: r.txids };
};

console.log("— offline light client (real-header fixture, no node) —");
const CP = FX.from + LWMA_WINDOW - 1; // checkpoint after a full LWMA window of context
const seed = FX.headers.slice(0, LWMA_WINDOW).map((h) => ({ height: h.height, header: h.header, hash: h.hash }));
const cpHash = byH.get(CP)!.hash;

// 1) seed a trusted window at a pinned checkpoint, then sync forward (verifies PoW + LWMA bits)
const lc = new LightClient({ headerProvider: provider });
lc.seedTrusted(seed, cpHash);
ok("seedTrusted accepts a real header window pinned to its checkpoint hash", true);
const verified = await lc.sync(FX.tip);
ok("sync verified forward to tip (every header's PoW + LWMA bits re-derived offline)", verified.height === FX.tip);

// 2) merkle inclusion against the light-client-VERIFIED header root (the trust property
//    verifyTxInclusion provides; done at the primitive level since the full method needs a node
//    RPC to LOCATE the tx). The header root here was just verified for PoW + LWMA above.
const inclBlock = FX.headers.find((h) => h.height > CP && h.txids.length > 1);
if (inclBlock) {
  const vh = (lc as any).at(inclBlock.height);
  ok(`the containing header at ${inclBlock.height} is PoW+LWMA-verified`, !!vh);
  const txids = inclBlock.txids.map((t) => t.replace(/^0x/, ""));
  const pos = 1;
  const folds = verifyMerkleProof(inclBlock.txids[pos]!, pos, merkleBranch(txids, pos), vh!.header.merkle);
  ok(`a real tx folds via merkle branch to the VERIFIED header root (trustless inclusion)`, folds);
  // a bogus txid must NOT fold to the verified root
  const bogus = verifyMerkleProof("0x" + "de".repeat(32), pos, merkleBranch(txids, pos), vh!.header.merkle);
  ok("a bogus txid does NOT fold to the verified root (no false inclusion)", bogus === false);
} else {
  console.log("  (no multi-tx block in the synced range — inclusion check skipped)");
}

// 3) TAMPER: a header with a flipped nonce fails PoW on ingest (the chain must reject it)
{
  const lc2 = new LightClient({ headerProvider: provider });
  lc2.seedTrusted(seed, cpHash);
  const tampered = new Map(byH);
  const victim = byH.get(CP + 1)!;
  tampered.set(CP + 1, { ...victim, header: { ...victim.header, nonce: (victim.header.nonce ^ 0x1) >>> 0 } });
  const lc2t = new LightClient({ headerProvider: async (h) => { const r = tampered.get(h)!; return { header: r.header, hash: r.hash, txids: r.txids }; } });
  lc2t.seedTrusted(seed, cpHash);
  let threw = false; try { await lc2t.sync(CP + 2); } catch { threw = true; }
  ok("a header with a flipped nonce is REJECTED (bad PoW) on ingest", threw);
}

// 4) checkpoint integrity: seeding with a WRONG checkpoint hash must be rejected
{
  const lc3 = new LightClient({ headerProvider: provider });
  let threw = false; try { lc3.seedTrusted(seed, "0x" + "00".repeat(32)); } catch { threw = true; }
  ok("seedTrusted REJECTS a window that doesn't hash to the pinned checkpoint", threw);
}

// 5) out-of-order ingest rejected
{
  const lc4 = new LightClient({ headerProvider: provider });
  lc4.seedTrusted(seed, cpHash);
  let threw = false; try { const h = byH.get(CP + 5)!; lc4.ingest(CP + 5, h.header, h.hash); } catch { threw = true; }
  ok("out-of-order ingest (skipping heights) is REJECTED", threw);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
