// OFFLINE light-client verification — runs in CI with NO node, against a committed fixture of
// REAL mainnet headers. The live light.test.ts exits 0 when no node is reachable, so without this
// the entire light client (PoW + LWMA re-derivation + checkpoint seed + inclusion + tamper
// rejection) was UNTESTED in CI. Real headers are used so PoW/LWMA are genuine, not synthetic.
import { LightClient, expectedBitsFromWindow, type HeaderProvider } from "../src/index.js";
import { LWMA_WINDOW, verifyMerkleProof, merkleBranch, headerHash, headerHashBytes, powOk,
  POW_LIMIT_BITS, type BlockHeader } from "@inversealtruism/csd-codec";
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

// 6) SG-2: a localStorage-POISONED snapshot (a MIN-DIFFICULTY header spliced into the saved chain)
//    must be REJECTED on restore — not silently restored and later trusted as `verified-inclusion`.
//    A real attacker forges hash + PoW to match: at POW_LIMIT (min difficulty) the PoW grind is cheap,
//    so PoW alone passes and ONLY the SG-2 LWMA re-derivation catches it. Grinding ~min-difficulty PoW
//    is too slow to do inline every CI run, so we bake the ground nonce as a fixed test vector against
//    the fixture's NON-trusted tip header (no child prev-link to break). The vector is asserted to
//    still pass PoW; if the fixture's tip bytes ever change, that assert fails loudly → regrind it.
{
  const honest = new LightClient({ headerProvider: provider });
  honest.seedTrusted(seed, cpHash);
  await honest.sync(FX.tip);
  const snap = honest.toSnapshot();
  const lastSnap = snap.headers[snap.headers.length - 1]!; // the forward-synced tip (trusted === false)
  ok("snapshot tip is a NON-trusted forward-synced header (LWMA applies)", lastSnap.trusted === false);

  // ground OFFLINE (test/_regrind-poison-nonce.mjs) against the committed fixture tip @27671.
  const POISON_NONCE = 6926799;
  const poison = { ...lastSnap.header, bits: POW_LIMIT_BITS, nonce: POISON_NONCE } as BlockHeader;
  ok("the baked min-difficulty poison header passes PoW (else: regrind the vector)", powOk(headerHashBytes(poison), POW_LIMIT_BITS));
  const lwmaExp = expectedBitsFromWindow(snap.headers.slice(-1 - LWMA_WINDOW, -1).map((e) => e.header), lastSnap.height);
  ok("the poison's min-difficulty bits differ from the LWMA expectation", POW_LIMIT_BITS !== lwmaExp);

  const pEntry = { ...lastSnap, header: poison, hash: headerHash(poison) }; // re-hash → the hash check passes (forged)
  const poisonedSnap = { ...snap, headers: [...snap.headers.slice(0, -1), pEntry] };
  let threw = false, msg = "";
  try { LightClient.fromSnapshot(poisonedSnap); } catch (e: any) { threw = true; msg = e?.message ?? String(e); }
  ok("a min-difficulty poisoned snapshot header is REJECTED by LWMA on restore (not verified-inclusion)", threw && /bits/.test(msg));

  // H4: the same poison header, now flagged trusted:true to try to SKIP the LWMA re-derivation, must
  // STILL be rejected — a forward header (full window present) is LWMA-checked regardless of `trusted`.
  const pTrusted = { ...lastSnap, header: poison, hash: headerHash(poison), trusted: true };
  const poisonedTrustedSnap = { ...snap, headers: [...snap.headers.slice(0, -1), pTrusted] };
  let threwH4 = false, msgH4 = "";
  try { LightClient.fromSnapshot(poisonedTrustedSnap); } catch (e: any) { threwH4 = true; msgH4 = e?.message ?? String(e); }
  ok("H4: a low-difficulty FORWARD header marked trusted:true CANNOT bypass LWMA (still rejected)", threwH4 && /bits/.test(msgH4));

  // and the honest snapshot still restores cleanly (no false-positive rejection)
  let restored = false;
  try { const r = LightClient.fromSnapshot(snap); restored = r.tip!.height === FX.tip && r.tip!.hash === lastSnap.hash; } catch { restored = false; }
  ok("the un-poisoned snapshot restores cleanly to the right tip", restored);
}

// 7) SG-2: the `checkpoints` option is no longer inert — a restored header at a pinned height that
//    doesn't match the pinned hash is REJECTED (the baked checkpoint is the one trust anchor).
{
  const honest = new LightClient({ headerProvider: provider });
  honest.seedTrusted(seed, cpHash);
  await honest.sync(FX.tip);
  const snap = honest.toSnapshot();
  let threw = false;
  try { LightClient.fromSnapshot(snap, { checkpoints: { [FX.tip]: "0x" + "00".repeat(32) } }); } catch { threw = true; }
  ok("fromSnapshot HONOURS a pinned checkpoint (wrong pinned hash rejected)", threw);
  // the matching pin passes
  let okPin = false;
  try { const r = LightClient.fromSnapshot(snap, { checkpoints: { [FX.tip]: snap.headers[snap.headers.length - 1]!.hash } }); okPin = r.tip!.height === FX.tip; } catch { okPin = false; }
  ok("fromSnapshot accepts a CORRECT pinned checkpoint", okPin);
}

// 8) H3: a forward header that violates the timestamp rules (min-spacing / MTP) is REJECTED on time,
//    BEFORE the bits/PoW checks (mirrors chain/index.rs ordering). We set time = parent.time, which
//    violates BOTH time ≥ parent+MIN_BLOCK_SPACING_SECS AND time > MTP — so the time gate fires first
//    and we don't need to grind a fresh PoW for the tampered header.
{
  const lcT = new LightClient({ headerProvider: provider });
  lcT.seedTrusted(seed, cpHash);
  await lcT.sync(FX.tip - 1);
  const victim = byH.get(FX.tip)!;
  const parentH = (lcT as any).at(FX.tip - 1) as { header: BlockHeader };
  const badTime = { ...victim.header, time: parentH.header.time } as BlockHeader;
  let threwT = false, msgT = "";
  try { lcT.ingest(FX.tip, badTime, headerHash(badTime)); } catch (e: any) { threwT = true; msgT = e?.message ?? String(e); }
  ok("H3: a header with time ≤ parent.time is REJECTED on the timestamp rule (before PoW)", threwT && /time/.test(msgT));
  // sanity: the REAL header at the tip (valid timestamp) still ingests cleanly (no false rejection)
  const okReal = (() => { try { lcT.ingest(FX.tip, victim.header, victim.hash); return true; } catch { return false; } })();
  ok("H3: the real header at the tip (valid timestamp) still ingests", okReal);
}

// ── syncFromCheckpoint prefers the batch provider (Plan 57 B4; Plan 56 A.3 finding 6) ──
// The common cold-start path used to fetch the ~45-header seed window one FULL BLOCK at a time
// even when a batch hook was configured; sync() already preferred the batch. Prove: (1) the seed
// now rides the batch (1 call, 0 per-height), (2) the batch-seeded client verifies forward to the
// same tip as the per-height client, (3) a tampered batch seed row is rejected (zero-trust kept).
{
  let perHeight = 0, batchCalls = 0;
  const cProv: HeaderProvider = async (h: number) => { perHeight++; const r = byH.get(h); if (!r) throw new Error(`no fixture at ${h}`); return { header: r.header, hash: r.hash, txids: r.txids }; };
  const cBatch = async (from: number, count: number) => {
    batchCalls++;
    const out: { header: BlockHeader; hash: string }[] = [];
    for (let h = from; h < from + count; h++) { const r = byH.get(h); if (!r) break; out.push({ header: r.header, hash: r.hash }); }
    return out;
  };
  const lcB = new LightClient({ headerProvider: cProv, headersBatchProvider: cBatch });
  // context = LWMA_WINDOW - 1: the fixture starts exactly one LWMA window before CP, so the
  // default context (one extra header of slack) would reach below the fixture's first height.
  await lcB.syncFromCheckpoint(CP, cpHash, LWMA_WINDOW - 1);
  ok("checkpoint seed rides the batch provider (1 batch call, 0 per-height fetches)", batchCalls === 1 && perHeight === 0);
  ok("batch-seeded window ends at the pinned checkpoint", lcB.tip!.height === CP && lcB.tip!.hash.toLowerCase() === cpHash.toLowerCase());
  const fwd = await lcB.sync(FX.tip);
  ok("forward sync from a batch-seeded checkpoint reaches the same verified tip", fwd.height === FX.tip && fwd.hash === verified.hash);

  const evilBatch = async (from: number, count: number) => {
    const rows = await cBatch(from, count);
    const mid = Math.floor(rows.length / 2);
    const h = { ...rows[mid]!.header, merkle: rows[mid]!.header.merkle.replace(/[0-9a-f]$/, (c) => (c === "0" ? "1" : "0")) };
    rows[mid] = { header: h, hash: rows[mid]!.hash }; // original hash + tampered header -> hash check must trip
    return rows;
  };
  let threwB = false;
  try { await new LightClient({ headerProvider: cProv, headersBatchProvider: evilBatch }).syncFromCheckpoint(CP, cpHash, LWMA_WINDOW - 1); } catch { threwB = true; }
  ok("a tampered batch seed header is REJECTED (the batch path carries zero trust)", threwB);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
