// Scanner with verifyInclusion on: a record's proposer or attester is its author (csd-crypto authorOf), the owner of
// the coin the first input spends when that input's scriptSig is the owner's signature over the tx's sighash (the
// node's own spend rule: compute-substrate src/state/utxo.rs parse_scriptsig + src/crypto/mod.rs verify_sig, and the
// pubkey's hash160 equal to the spent script_pubkey). The scriptSig is outside the txid, so a node could serve
// another one with the same txid; each case below does that, and the indexer row agrees with the node's copy (an
// indexer fed by the same node). A body with no author fails the scan.
import assert from "node:assert/strict";
import { recoverSigner, buildScriptSig, parseScriptSig, pubFromPriv, signDigest } from "@inversealtruism/csd-crypto";
import { sighash, type Tx } from "@inversealtruism/csd-codec";
import { Scanner } from "../../src/scanner.js";
import { resolve } from "@inversealtruism/cairnx-core";
import { type ProposeEvent } from "@inversealtruism/cairnx-core";
import { deploy, mint } from "@inversealtruism/cairnx-core";
import { H0, KA, KB, KC, KEYS, PAYEE, buildChain, type Forge, type Spec } from "./scan-chain.js";

let passed = 0;
const failed: string[] = [];
const at = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log("  ok", name); }
  catch (e) { failed.push(name); console.log("  FAIL", name, "\n   ", (e as Error).message.split("\n").slice(0, 4).join("\n    ")); }
};
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  let msg = "(resolved)";
  try { await p; } catch (e) { msg = String((e as Error).message); }
  assert.match(msg, re);
};

await at("sighash vector: a real on-chain Attest (block 21043, cairn-wallet test/selftest.ts) recovers its signer with the codec sighash", async () => {
  const ss = "0x4016e7795e7626209cbe8ba924beffec0480cc50335e946fbd532be8dfc2d4d27f3bc6bf031c82f92f3ee424fcb0d11dcc4b387efee81855fc3284685511a41297210225bde0772dec16dfb50d04b832d9ddfe7f0cc11d88d8a074167c4ad8e1a14024";
  const tx: Tx = {
    version: 1, locktime: 0,
    inputs: [{ prevTxid: "0x436e0101f16fd3469c5916c8d6985fac3e0fd21649bb64baa88b6400acfdebe3", vout: 0, scriptSig: ss }],
    outputs: [{ value: 25000000, scriptPubkey: "0x6eda635deaa2f710213942cc97c19b7e008fc694" }],
    app: { type: "Attest", proposalId: "0xd46770cdef6fc5d0c7b0680ed58d1af04be939f3739b9d34c174e5071341048b", score: 100, confidence: 90 },
  };
  assert.equal(recoverSigner(ss, sighash(tx)), "0x6eda635deaa2f710213942cc97c19b7e008fc694");
  assert.equal(recoverSigner(ss, sighash({ ...tx, app: { ...tx.app, score: 99 } as Tx["app"] })), null, "and only over this tx");
});

const dep = deploy({ ticker: "DUST", decimals: 2, supply: "1000000", mint: "open", mintLimit: "1000" });
const specs: Spec[] = [
  { kind: "propose", rec: dep, proposer: KA, height: H0 },
  { kind: "propose", rec: mint({ ticker: "DUST", amount: "100" }), proposer: KB, height: H0 + 2 },
  { kind: "attest", of: 0, attester: KB, score: 7, confidence: 100, height: H0 + 4 },
  { kind: "propose", rec: mint({ ticker: "DUST", amount: "300" }), proposer: KC, height: H0 + 6, bare: true },
];
const TIP = H0 + 40;
const chain = buildChain(specs, { keys: KEYS });
const [T0, , T2, T3] = chain.txs.map((x) => x.txid) as [string, string, string, string];
const txOf = (id: string) => chain.txs.find((x) => x.txid === id)!.tx;

/** The node serves `tx` for `id` with input 0's scriptSig replaced (the txid is unchanged: it strips scriptSigs), and
 *  with `payTo` the source tx of that input's coin paying another address under the same txid. */
const nodeServes = (id: string, scriptSig: string, payTo?: string) => {
  const v = chain.verified({ verifiedTip: TIP });
  const honest = v.rawTxAt!;
  const source = txOf(id).inputs[0]!.prevTxid;
  return { ...v, rawTxAt: async (t: string) => {
    const tx = await honest(t);
    if (t === source && payTo) return { ...tx, outputs: tx.outputs.map((o, n) => (n === 0 ? { ...o, scriptPubkey: payTo.slice(2) } : o)) };
    return t === id ? { ...tx, inputs: tx.inputs.map((i, n) => (n === 0 ? { ...i, scriptSig } : i)) } : tx;
  } };
};
const scan = (forge: Forge, node = chain.verified({ verifiedTip: TIP })) =>
  new Scanner({ indexerUrl: "http://idx", fetch: chain.indexer({ tip: TIP, forge }), ...node }).scan();
const off = () => new Scanner({ indexerUrl: "http://idx", fetch: chain.indexer({ tip: TIP }) }).scan();
const ev = (evs: { kind: string }[], id: string) => evs.find((e) => (e as ProposeEvent).id === id || (e as { txid?: string }).txid === id) as Record<string, unknown> | undefined;

await at("paired: honest signed records with the flag on resolve exactly as with the flag off", async () => {
  const [a, b] = [await scan({}), await off()];
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(resolve(a.events, TIP), resolve(b.events, TIP));
  assert.equal(ev(a.events, T0)?.proposer, KA);
  assert.equal(ev(a.events, T2)?.attester, KB);
  assert.equal(ev(a.events, T3)?.proposer, KC, "a tx with no outputs still has its signer");
});

const honestSig = parseScriptSig(txOf(T0).inputs[0]!.scriptSig)!;
const cases: { name: string; id: string; scriptSig: string; row: Record<string, unknown> }[] = [
  { name: "a well-formed scriptSig with another key's pubkey (KC) and KA's signature", id: T0,
    scriptSig: buildScriptSig(honestSig.sig64, pubFromPriv(KEYS[KC]!)).slice(2), row: { proposer: KC } },
  { name: "KA's pubkey with a signature that does not verify", id: T0,
    scriptSig: buildScriptSig("0x" + "11".repeat(64), honestSig.pub33).slice(2), row: {} },
  { name: "an attestation's scriptSig swapped to another key's pubkey (KA)", id: T2,
    scriptSig: buildScriptSig(parseScriptSig(txOf(T2).inputs[0]!.scriptSig)!.sig64, pubFromPriv(KEYS[KA]!)).slice(2), row: { attester: KA } },
  { name: "an empty scriptSig on a tx with no outputs (identity-less)", id: T3, scriptSig: "", row: { proposer: null } },
  { name: "an empty scriptSig on a tx whose first output is an address", id: T0, scriptSig: "", row: { proposer: PAYEE } },
];
for (const c of cases) {
  await at(`${c.name}: the scan fails`, async () => {
    await rejects(scan({ [c.id]: c.row }, nodeServes(c.id, c.scriptSig)), /^F4: tx 0x[0-9a-f]+ has no author: /);
  });
}

// The node re-signs a body. Any key can sign the sighash (it strips scriptSigs), so the signature verifies and
// recoverSigner names KC; the coin input 0 spends is KA's, so KA is the author and a body signed by KC has none.
const resigned = (() => { const { sig64, pub33 } = signDigest(sighash(txOf(T0)), KEYS[KC]!); return buildScriptSig(sig64, pub33).slice(2); })();
await at("red-first: a body the node re-signed with another key's valid signature (KC) has no author: the scan fails", async () => {
  assert.equal(recoverSigner(resigned, sighash(txOf(T0))), KC, "the signature itself verifies");
  await rejects(scan({ [T0]: { proposer: KC } }, nodeServes(T0, resigned)), /^F4: tx 0x[0-9a-f]+ has no author: /);
});
await at("the same body with the coin's source tx served paying KC does not recompute: the scan fails", async () => {
  await rejects(scan({ [T0]: { proposer: KC } }, nodeServes(T0, resigned, KC)), /^F4: source tx 0x[0-9a-f]+ of 0x[0-9a-f]+ recomputes to a different txid/);
});

console.log(`scan-verify-signer: ${passed} passed, ${failed.length} failed`);
assert.deepEqual(failed, []);
