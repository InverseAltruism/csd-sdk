// SG-CONTENT-BIND-1 (A1) — verifyTxInclusion surfaces the MERKLE-PROVEN tx + its committed
// app.payload_hash, folding the branch over a txid RE-DERIVED from each tx BODY (never the
// server-reported `.txid`). OFFLINE + deterministic: a synthetic block whose real merkle root we
// compute locally, injected under a hand-built verified header (no PoW grind needed — the merkle
// bind is orthogonal to the header PoW/LWMA checks the other suites cover).
//
// The security property proved here: a lying read path that swaps a tx BODY (e.g. a Propose whose
// app.payload_hash now commits to an attacker record) while keeping the honest reported `.txid`
// is REJECTED — the re-derived id no longer matches the requested txid nor folds to the PoW-verified
// root. The companion assertion shows the OLD server-reported-txid fold STILL succeeds on that same
// forged block, so the re-derivation is exactly what closes the hole.
import { LightClient, bindBlockBody } from "../src/index.js";
import { rpcTxToTx, type RpcTxJson } from "@inversealtruism/csd-client";
import { txid as codecTxid, merkleRoot, merkleBranch, verifyMerkleProof, type BlockHeader } from "@inversealtruism/csd-codec";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n); } };

console.log("— SG-CONTENT-BIND-1: verifyTxInclusion body-binding (offline) —");

const H_REAL = "0x" + "ab".repeat(32);       // the GENUINE on-chain committed payload_hash
const H_ATTACKER = "0x" + "cd".repeat(32);   // an attacker's substituted payload_hash

// A coinbase-shaped tx (app None) + a Propose tx carrying the committed payload_hash.
const coinbase: RpcTxJson = {
  txid: "", version: 1,
  inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 0xffffffff, script_sig: "0x00" }],
  outputs: [{ value: 5_000_000_000, script_pubkey: "0x" + "11".repeat(20) }],
  locktime: 0, app: { type: "None" },
};
const proposeGenuine: RpcTxJson = {
  txid: "", version: 1,
  inputs: [{ prev_txid: "0x" + "22".repeat(32), vout: 0, script_sig: "0x" + "33".repeat(10) }],
  outputs: [{ value: 1000, script_pubkey: "0x" + "44".repeat(20) }],
  locktime: 0,
  app: { type: "Propose", domain: "cairnx:v1", payload_hash: H_REAL, uri: "{\"t\":\"offer\"}", expires_epoch: 999 },
};
// re-derive the REAL ids/root from the bodies (exactly what verifyTxInclusion now does internally)
const coinbaseId = codecTxid(rpcTxToTx(coinbase));
const proposeId = codecTxid(rpcTxToTx(proposeGenuine));
const derivedIds = [coinbaseId, proposeId];
const root = merkleRoot(derivedIds);
const HEIGHT = 40000;
const blockHash = "0x" + "77".repeat(32);
const header: BlockHeader = { version: 1, prev: "0x" + "66".repeat(32), merkle: root, time: 1, bits: 0x1e00ffff, nonce: 0 };

// A LightClient with a hand-injected VERIFIED header at HEIGHT whose merkle == the block's real root.
// (Bypasses PoW/LWMA on purpose — those are the concern of light.test / light-offline.test; here we
// isolate the inclusion/body-bind logic.)
function clientWith(txs: RpcTxJson[]) {
  const mock = {
    tx: async (_id: string) => ({ ok: true, txid: proposeId, height: HEIGHT }),
    blockByHeight: async (_h: number) => ({ ok: true, hash: blockHash, height: HEIGHT, header, txs }),
  };
  const lc = new LightClient({ client: mock as any });
  lc.baseHeight = HEIGHT;
  (lc.chain as any).push({ height: HEIGHT, hash: blockHash, header, chainwork: 1n });
  return lc;
}

// 1) HONEST block: the proven Propose tx + its committed payload_hash are surfaced.
{
  // server reports honest .txid fields (the id it claims) — verifyTxInclusion ignores them and re-derives
  const honestTxs = [{ ...coinbase, txid: coinbaseId }, { ...proposeGenuine, txid: proposeId }];
  const lc = clientWith(honestTxs);
  const res = await lc.verifyTxInclusion(proposeId);
  ok("honest block → verified-inclusion", res.trustLevel === "verified-inclusion" && res.included === true);
  ok("surfaces the proven tx body", !!res.tx && res.tx.app.type === "Propose");
  ok("surfaces the MERKLE-PROVEN committed appPayloadHash (== on-chain H_REAL)", res.appPayloadHash === H_REAL);
  ok("caller can re-derive txid(tx) === requested id (the SG bind contract)",
    !!res.tx && codecTxid(rpcTxToTx(res.tx)).toLowerCase() === proposeId.toLowerCase());
}

// 2) FORGED body: attacker swaps the Propose payload_hash (points at THEIR record) but keeps the
//    honest reported `.txid`. Must be REJECTED (re-derived id != requested id, no fold to the root).
{
  const proposeForged: RpcTxJson = { ...proposeGenuine, app: { ...proposeGenuine.app, type: "Propose", payload_hash: H_ATTACKER } as any };
  // KEEP the honest `.txid` field so the OLD server-reported-txid path would still "find" it.
  const forgedTxs = [{ ...coinbase, txid: coinbaseId }, { ...proposeForged, txid: proposeId }];
  const lc = clientWith(forgedTxs);
  const res = await lc.verifyTxInclusion(proposeId);
  ok("FORGED body (swapped payload_hash, honest reported txid) → REJECTED (not verified-inclusion)",
    !(res.included && res.trustLevel === "verified-inclusion"));
  ok("rejection surfaces no attacker payload_hash", res.appPayloadHash === undefined);

  // MUTATION-EVIDENCE: the OLD behavior (fold the SERVER-REPORTED txid) STILL succeeds on this exact
  // forged block — proving the body RE-DERIVATION is the one and only thing that catches the swap.
  const reportedIds = forgedTxs.map((t) => t.txid);
  const oldFold = verifyMerkleProof(reportedIds[1]!, 1, merkleBranch(reportedIds, 1), header.merkle);
  ok("the OLD server-reported-txid fold WOULD have accepted the forged block (re-derivation is load-bearing)", oldFold === true);
}

// 3) FORGED body that ALSO rewrites the reported `.txid` to its real (forged) id: the merkle fold
//    fails against the PoW-verified root (the requested id isn't even present). Fail closed.
{
  const proposeForged: RpcTxJson = { ...proposeGenuine, app: { ...proposeGenuine.app, type: "Propose", payload_hash: H_ATTACKER } as any };
  const forgedId = codecTxid(rpcTxToTx(proposeForged));
  const forgedTxs = [{ ...coinbase, txid: coinbaseId }, { ...proposeForged, txid: forgedId }];
  const lc = clientWith(forgedTxs);
  const res = await lc.verifyTxInclusion(proposeId);
  ok("FORGED body with a re-derived reported txid → REJECTED (requested id not in block)",
    !(res.included && res.trustLevel === "verified-inclusion"));
}

// 4) the block bind (bind.ts), shared by verifyTxInclusion and bindBlockBody.
console.log("— the block bind: repeated txid and exact u64 —");
{
  const attest: RpcTxJson = {
    txid: "", version: 1,
    inputs: [{ prev_txid: "0x" + "55".repeat(32), vout: 1, script_sig: "0x" + "33".repeat(10) }],
    outputs: [{ value: 7, script_pubkey: "0x" + "44".repeat(20) }],
    locktime: 0, app: { type: "Attest", proposal_id: proposeId, score: 1, confidence: 0 },
  };
  const attestId = codecTxid(rpcTxToTx(attest));
  const root3 = merkleRoot([coinbaseId, proposeId, attestId]);
  const header3: BlockHeader = { ...header, merkle: root3 };
  const verified3 = { height: HEIGHT, hash: blockHash, header: header3, chainwork: 1n };
  const repeated = [coinbase, proposeGenuine, attest, attest];
  ok("premise: a body repeating its odd last tx hashes to the honest root (CVE-2012-2459)",
    merkleRoot(repeated.map((t) => codecTxid(rpcTxToTx(t)))) === root3);
  const lcOf = (txs: RpcTxJson[]) => {
    const lc = new LightClient({ client: { tx: async () => ({ ok: true, txid: attestId, height: HEIGHT }), blockByHeight: async () => ({ ok: true, hash: blockHash, height: HEIGHT, header: header3, txs }) } as any });
    lc.baseHeight = HEIGHT;
    (lc.chain as any).push(verified3);
    return lc;
  };
  const honestIncl = await lcOf([coinbase, proposeGenuine, attest]).verifyTxInclusion(attestId);
  ok("verifyTxInclusion: the honest 3-tx block proves the attest", honestIncl.included && honestIncl.trustLevel === "verified-inclusion");
  const repIncl = await lcOf(repeated).verifyTxInclusion(attestId);
  ok("verifyTxInclusion: a body repeating a txid is refused", !repIncl.included && /repeats a txid/.test(repIncl.reason ?? ""));

  // the raw-text entry: the node writes expires_epoch as a bare u64 literal, here 2^53 + 1
  const EE = 9007199254740993n;
  const bigTx = { ...proposeGenuine, app: { ...proposeGenuine.app, expires_epoch: EE } } as unknown as RpcTxJson;
  const bigId = codecTxid(rpcTxToTx(bigTx));
  const verifiedBig = { height: HEIGHT, hash: blockHash, header: { ...header, merkle: merkleRoot([coinbaseId, bigId]) }, chainwork: 1n };
  const text = (txs: RpcTxJson[]) => JSON.stringify({ ok: true, hash: blockHash, height: HEIGHT, header, txs }, (_k, v) => (typeof v === "bigint" ? `@@${v}@@` : v)).replace(/"@@(\d+)@@"/g, "$1");
  const honest = bindBlockBody(text([coinbase, bigTx]), verifiedBig);
  ok("bindBlockBody: an honest body with a u64 above 2^53 binds, txids in block order",
    honest.ok && honest.txs.map((t) => t.txid).join() === [coinbaseId, bigId].join() && honest.txs[1]!.pos === 1);
  const { app: _dropped, ...coinbaseNoApp } = coinbase;
  ok("bindBlockBody: a tx served without app binds as app None", bindBlockBody(text([coinbaseNoApp as RpcTxJson, bigTx]), verifiedBig).ok);
  const rep = bindBlockBody(text([coinbase, proposeGenuine, attest, attest]), verified3);
  ok("bindBlockBody: a body repeating a txid is refused as duplicate-txid", !rep.ok && rep.kind === "duplicate-txid");
  const swapped = bindBlockBody(text([coinbase, { ...bigTx, outputs: [{ value: 8, script_pubkey: "0x" + "44".repeat(20) }] }]), verifiedBig);
  ok("bindBlockBody: an altered body is refused as body-mismatch", !swapped.ok && swapped.kind === "body-mismatch");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
