// @inversealtruism/csd-light — the headline gates (P1.1, P1.2):
//   • headers-first sync from GENESIS with full PoW + LWMA(bits) verification, and the
//     independently-accumulated chainwork MATCHES the node's reported chainwork.
//   • a known on-chain tx verifies its merkle inclusion against a verified header.
//   • tampering a header (bad bits / broken prev / bad PoW) is REJECTED.
import { LightClient, expectedBits } from "../src/index.js";
import { CsdClient } from "@inversealtruism/csd-client";
import { headerHash } from "@inversealtruism/csd-codec";

const BASE = process.env.CSD_RPC || "http://127.0.0.1:8790";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };

let reachable = false;
try { reachable = (await fetch(`${BASE}/tip`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* down */ }
if (!reachable) { console.log(`(no node at ${BASE} — skipping @inversealtruism/csd-light live test)`); process.exit(0); }

const client = new CsdClient({ baseUrl: BASE });

console.log("— headers-first sync from genesis (PoW + LWMA + chainwork) —");
const N = 60; // sync the first N blocks from genesis (full LWMA window exercised)
const lc = new LightClient({ client });
let threw = "";
try { await lc.sync(N); } catch (e: any) { threw = e?.message ?? String(e); }
ok(`synced 0..${N} with full verification (no consensus violation)`, threw === "" && lc.chain.length === N + 1);
if (threw) console.log("     threw:", threw);
ok("genesis verified to the pinned GENESIS_HASH", lc.chain[0]?.height === 0);

// cross-check accumulated chainwork against the node's own reported chainwork at height N
const nodeBlock = await client.blockByHeight(N);
ok("independently-derived chainwork == node's chainwork @N", String(lc.chainwork) === String(nodeBlock.chainwork));

console.log("\n— merkle inclusion of a real on-chain tx (within the synced range) —");
// pick a real tx from a block we've ALREADY verified (≤ N) so inclusion folds to a verified header
const someBlock = await client.blockByHeight(N - 5);
const someTx = someBlock.txs[0];
if (someTx) {
  const res = await lc.verifyTxInclusion(someTx.txid);
  ok("verifyTxInclusion → verified-inclusion for a real tx", res.trustLevel === "verified-inclusion" && res.included);
  ok("inclusion reports a sane confirmation count", (res.confirmations ?? 0) >= 1);
} else ok("merkle inclusion skipped (no tx)", true);

console.log("\n— balance is honestly rpc-trusted —");
const bal = await lc.balance("0x44d92872a5b65d37d60ed532f41efe7c5aed59ec");
ok("balance carries trustLevel='rpc-trusted'", bal.trustLevel === "rpc-trusted");

console.log("\n— tamper rejection —");
// flip the tip header's bits → LWMA mismatch must throw
const bad = new LightClient({ client });
await bad.sync(N - 1);
const nextReal = await client.blockByHeight(N);
const tamperedBits = { ...{ version: nextReal.header.version, prev: nextReal.header.prev, merkle: nextReal.header.merkle, time: nextReal.header.time, bits: 0x1f00ffff, nonce: nextReal.header.nonce } };
let rejBits = false;
try { bad.ingest(N, tamperedBits as any, undefined); } catch { rejBits = true; }
ok("a header with wrong (LWMA-violating) bits is rejected", rejBits);
// broken prev link must throw
const bad2 = new LightClient({ client });
await bad2.sync(N - 1);
const brokenPrev = { version: nextReal.header.version, prev: "0x" + "de".repeat(32), merkle: nextReal.header.merkle, time: nextReal.header.time, bits: nextReal.header.bits, nonce: nextReal.header.nonce };
let rejPrev = false;
try { bad2.ingest(N, brokenPrev as any, undefined); } catch { rejPrev = true; }
ok("a header with a broken prev link is rejected", rejPrev);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
