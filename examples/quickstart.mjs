// Quickstart for the Compute Substrate SDK. Run against a node or the Cairn proxy:
//   CSD_RPC=http://127.0.0.1:8790 node examples/quickstart.mjs
//   CSD_RPC=https://cairn-substrate.com/api/rpc node examples/quickstart.mjs
// It only reads the chain; the broadcast step is shown but not executed. For step 5 pin a checkpoint you got from a
// source other than CSD_RPC: CSD_CHECKPOINT=<height>:<block hash>.
import { payloadHash } from "@inversealtruism/csd-codec";
import { keygen } from "@inversealtruism/csd-crypto";
import { buildSendVerified } from "@inversealtruism/csd-tx";
import { CsdClient, verifyInputValues } from "@inversealtruism/csd-client";
import { LightClient } from "@inversealtruism/csd-light";

const RPC = process.env.CSD_RPC || "http://127.0.0.1:8790";
const client = new CsdClient({ baseUrl: RPC });

// 1) Keys + addresses (hash160 of the compressed pubkey)
const me = keygen();
console.log("address:", me.addr);

// 2) Content addressing: the on-chain payload_hash of an off-chain record
console.log("payload_hash:", payloadHash({ v: 1, title: "hello CSD", body: "gm" }));

// 3) Read the chain
const tip = await client.tip().catch(() => null);
if (!tip) { console.log(`(no node at ${RPC}; skipping live steps)`); process.exit(0); }
console.log("tip height:", tip.height);

// 4) Build + sign a transfer locally (change returns to you). buildSendVerified checks the real value of
//    every selected input against its source tx, so an RPC that under-reports a coin cannot make the
//    change too small and burn the difference as fee. A fresh key has no coins, so this prints an error.
const { utxos } = await client.utxos(me.addr);
const send = await buildSendVerified({
  outputs: [{ to: "0x" + "cc".repeat(20), value: 100_000 }], // 0.001 CSD (base units; 1 CSD = 1e8)
  fee: 200_000,
  utxos,
  priv: me.priv,
  verify: (inputs) => verifyInputValues(client, inputs),
});
console.log("built tx:", send.ok ? send.txid : send.error);
// To broadcast: if (send.ok) await client.submitOrThrow(send.nodeJson);
// (submit() returns { ok: false, err } on a node rejection; submitOrThrow throws instead.)

// 5) Light client: verify every header after a checkpoint yourself (PoW + LWMA + chainwork). The checkpoint is the
//    one input it trusts, so it comes from CSD_CHECKPOINT, which you pin. Without it this demo asks CSD_RPC for one,
//    and every verdict below then rests on that RPC's answer. Pin a recent block: this example has no batch header
//    source, so it fetches one full block per header after the checkpoint (see headersBatchProvider in README.md).
const light = new LightClient({ client });
const [pinH, pinHash] = (process.env.CSD_CHECKPOINT ?? "").split(":");
const cpH = pinHash ? Number(pinH) : Math.max(46, tip.height - 20);
const cpHash = pinHash ?? (await client.blockByHeight(cpH)).hash;
if (!pinHash) console.log(`checkpoint ${cpH} taken from ${RPC} (set CSD_CHECKPOINT to pin your own)`);
await light.syncFromCheckpoint(cpH, cpHash); // trusts the checkpoint, verifies forward
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
console.log("balance trustLevel:", bal.trustLevel, "-", bal.note);
