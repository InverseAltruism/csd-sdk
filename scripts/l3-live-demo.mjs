// L3 live end-to-end: build a csd:gateways record, anchor it on-chain (treasury key),
// publish its canonical bytes to a content origin (cairn), and confirm the full
// dogfood loop L0(build/sign/broadcast) → L1(content) → L2(index) → L3(resolve).
import { CsdClient } from "@inversealtruism/csd-client";
import { buildPropose } from "@inversealtruism/csd-tx";
import { canonicalJson } from "@inversealtruism/csd-codec";
import { buildGatewayRecord } from "@inversealtruism/csd-registry";
import { readFileSync } from "node:fs";

const t = JSON.parse(readFileSync(process.env.CAIRN_KEY || `${process.env.HOME}/.config/cairn/treasury.json`, "utf8"));
const priv = t.privkey;
const addr = "0x" + String(t.addr20).replace(/^0x/, "");
const node = new CsdClient({ baseUrl: "http://127.0.0.1:8790" });
const CAIRN = "http://127.0.0.1:7777";

// 1) build the signed gateway record (binds url↔address)
const rec = buildGatewayRecord({ priv, url: "https://cairn-substrate.com/content/0x{hash}", address: addr });
const bytes = canonicalJson(rec.content);
console.log(`[1] gateway record  domain=${rec.domain}  payload_hash=${rec.payloadHash}`);

// 2) build + sign the Propose (dogfood L0)
const u = await node.utxos(addr);
const utxos = u.utxos.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, confirmations: x.confirmations, coinbase: x.coinbase }));
const tip = await node.tip();
const uri = "csd:gw:v1:" + rec.payloadHash.slice(2, 14);
const expiresEpoch = Math.floor(tip.height / 30) + 240; // ~10 days
const built = buildPropose({ domain: rec.domain, payloadHash: rec.payloadHash, uri, expiresEpoch, fee: 25_000_000, utxos, priv });
if (!built.ok) { console.error("[x] build failed:", built.error); process.exit(1); }
console.log(`[2] built+signed   txid=${built.txid}  fee=0.25 CSD  change=${(built.change / 1e8).toFixed(4)} CSD`);

// 3) broadcast
const sub = await node.submit(built.nodeJson);
console.log(`[3] submit         ${JSON.stringify(sub)}`);
if (!sub.ok) { console.error("[x] submit rejected"); process.exit(1); }
const txid = sub.txid || built.txid;

// 4) wait for inclusion + publish content (cairn self-certifies vs the on-chain hash)
console.log(`[4] waiting for inclusion + publishing content…`);
let published = false;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 8000));
  const r = await fetch(`${CAIRN}/api/content`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bytes, txid }) })
    .then((r) => r.json()).catch(() => null);
  if (r && r.ok) { console.log(`    published content @ ${r.payload_hash} (mined + self-certified)`); published = true; break; }
  if (i % 4 === 0) console.log(`    …not mined yet (${r?.error || "pending"})`);
}
if (!published) { console.error("[x] not mined within timeout"); process.exit(1); }

// 5) verify the origin serves byte-identical, self-certifying content
const served = await fetch(`${CAIRN}/content/${rec.payloadHash}`).then((r) => r.text());
console.log(`[5] origin serves content: ${served === bytes ? "✅ byte-identical" : "❌ MISMATCH"}`);
console.log(`\nDONE. Now index past block ~${tip.height} and GET /registry/gateways.`);
console.log(`txid=${txid}`);
