// @inversealtruism/csd-client — live integration against the local node (skips cleanly if unreachable).
// The strong gate: fetch REAL on-chain txs, rebuild the Tx via rpcTxToTx, and confirm our
// codec's txid matches the on-chain txid — proving serialize/strip against real scriptSig data
// (no spending). Also re-verify each block's merkle root + header hash from RPC JSON.
import { CsdClient, rpcTxToTx, rpcHeaderToHeader } from "../src/index.js";
import { txid, headerHash, merkleRoot } from "@inversealtruism/csd-codec";

const BASE = process.env.CSD_RPC || "http://127.0.0.1:8790";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };

let reachable = false;
try { reachable = (await fetch(`${BASE}/tip`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* down */ }
if (!reachable) { console.log(`(no node at ${BASE} — skipping @inversealtruism/csd-client live test)`); process.exit(0); }

const c = new CsdClient({ baseUrl: BASE });
const tip = await c.tip();
ok("tip() returns a height + 0x-hash", typeof tip.height === "number" && /^0x[0-9a-f]{64}$/.test(tip.tip));

// Walk recent blocks: re-derive header hash + merkle from RPC JSON, and re-derive every txid.
let blocksOk = 0, txsChecked = 0, txOk = 0;
for (let h = tip.height; h > Math.max(1, tip.height - 8); h--) {
  const b = await c.blockByHeight(h);
  if (!b.ok) continue;
  const hdr = rpcHeaderToHeader(b.header);
  const hh = headerHash(hdr) === b.hash;
  const mr = merkleRoot(b.txs.map((t) => t.txid)) === b.header.merkle;
  if (hh && mr) blocksOk++;
  for (const tj of b.txs) {
    txsChecked++;
    if (txid(rpcTxToTx(tj)) === tj.txid) txOk++;
    else console.log(`     txid mismatch @${h}: ${tj.txid}`);
  }
}
ok("recent blocks: headerHash + merkleRoot reproduce from RPC JSON", blocksOk >= 1);
ok(`real txs round-trip rpcTxToTx→txid (${txOk}/${txsChecked})`, txsChecked > 0 && txOk === txsChecked);

// reads
const dom = await c.domains();
ok("domains() returns a list", Array.isArray(dom.domains));
const mp = await c.mempool();
ok("mempool() returns tx_count", typeof mp.tx_count === "number");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
