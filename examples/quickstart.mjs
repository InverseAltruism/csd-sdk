// Quickstart for the Compute Substrate SDK. Run against a node or the Cairn proxy:
//   CSD_RPC=http://127.0.0.1:8790 node examples/quickstart.mjs
//   CSD_RPC=https://cairn-substrate.com/api/rpc node examples/quickstart.mjs
import { txid, sighash, payloadHash } from "@inversealtruism/csd-codec";
import { keygen } from "@inversealtruism/csd-crypto";
import { buildSend, buildPropose } from "@inversealtruism/csd-tx";
import { CsdClient } from "@inversealtruism/csd-client";
import { LightClient } from "@inversealtruism/csd-light";

const RPC = process.env.CSD_RPC || "http://127.0.0.1:8790";
const client = new CsdClient({ baseUrl: RPC });

// 1) Keys + addresses (hash160 of the compressed pubkey)
const me = keygen();
console.log("address:", me.addr);

// 2) Build + sign a transfer locally (change returns to you; coin selection is hardened).
//    Pass real UTXOs from client.utxos(addr); here we illustrate with a sample.
const send = buildSend({
  outputs: [{ to: "0x" + "cc".repeat(20), value: 100_000 }], // 0.001 CSD (base units; 1 CSD = 1e8)
  fee: 200_000,
  utxos: [{ txid: "0x" + "ab".repeat(32), vout: 0, value: 1_000_000, confirmations: 6 }],
  priv: me.priv,
});
console.log("built tx:", send.ok ? send.txid : send.error);
// To broadcast a REAL one: const r = await client.submit(send.nodeJson)

// 3) Content addressing — the on-chain payload_hash of an off-chain record
console.log("payload_hash:", payloadHash({ v: 1, title: "hello CSD", body: "gm" }));

// 4) Read the chain
const tip = await client.tip().catch(() => null);
if (!tip) { console.log(`(no node at ${RPC} — skipping live steps)`); process.exit(0); }
console.log("tip height:", tip.height);

// 5) Light client — verify the chain yourself (PoW + LWMA + chainwork), no trust in the RPC.
//    From a recent checkpoint so you don't fetch all of history:
const light = new LightClient({ client });
const cpH = Math.max(46, tip.height - 20);
const cpBlock = await client.blockByHeight(cpH);
await light.syncFromCheckpoint(cpH, cpBlock.hash); // trusts the pinned checkpoint, verifies forward
await light.sync(tip.height);
console.log("light tip verified:", light.tip.hash === tip.tip, "(fullyVerified:", light.fullyVerified, ")");

// 6) Prove a transaction's inclusion against a verified header (merkle proof)
const blk = await client.blockByHeight(tip.height - 1);
if (blk.txs[0]) {
  const inc = await light.verifyTxInclusion(blk.txs[0].txid);
  console.log("inclusion:", inc.trustLevel, "confirmations:", inc.confirmations);
}

// 7) Balances are honestly flagged (a header chain can't prove non-spend)
const bal = await light.balance(me.addr);
console.log("balance trustLevel:", bal.trustLevel, "—", bal.note);
