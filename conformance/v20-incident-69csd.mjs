// E2E: replay the REAL 69.csd incident through the FIXED resolver at V20-era heights.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
import { canonicalJson, payloadHash } from "../packages/codec/dist/index.js";
const { resolve, canonicalState, nameCommit, V20_HEIGHT, makerRebate, tradeFee, nameRegFee } = R;
const SELLER = "0x8d7b6aaeb9e6c2aa446b8d610127ac2f56b6d1a2";
const BUYER  = "0xc25117a104e2cba2a69ad3981a3c67299f550504";
const TREAS  = R.TREASURY_ADDR;
const SALT = "00ffee1122334455";
let idn = 0xe69000;
const nextId = () => "0x" + (idn++).toString(16).padStart(64, "0");
const ev = (record, { height, pos = 1, proposer = SELLER, expiresEpoch = 9e15, paidTo = {} }) =>
  ({ kind: "propose", id: nextId(), proposer, uri: canonicalJson(record), payloadHash: payloadHash(record), height, pos, expiresEpoch, paidTo });
const att = (proposalId, attester, score, height, pos, paidTo = {}) =>
  ({ kind: "attest", txid: nextId(), proposalId, attester, score, confidence: 0, height, pos, paidTo });

// V20-era heights preserving the REAL relative timing (offer→claim +8, claim→fill +15 = boundary under old window)
const commitH = V20_HEIGHT + 300, revealH = commitH + 2, offH = revealH + 300, claimH = offH + 8, fillH = offH + 23;
const want = 4500000000n;                       // real 45 CSD
const sellerNeed = (want + makerRebate(want));  // 45.475
const fee = tradeFee(want, 150);                // 0.675
const events = [
  ev({ v: 1, t: "ncommit", commit: nameCommit("69", SALT, SELLER) }, { height: commitH }),
  ev({ v: 1, t: "name", name: "69", salt: SALT }, { height: revealH, paidTo: { [TREAS]: String(nameRegFee("69", revealH)) } }),
];
const offExpEpoch = Math.floor(fillH / 30) + 50; // valid past the fill, WITHIN the name's lease (v1.5 rule)
const offer = ev({ v: 1, t: "offer", give: { name: "69" }, want: { value: want.toString() } }, { height: offH, expiresEpoch: offExpEpoch });
events.push(offer);
events.push(att(offer.id, BUYER, 50, claimH, 1));                                                  // buyer CLAIM
events.push(att(offer.id, BUYER, 100, fillH, 2, { [SELLER]: String(sellerNeed), [TREAS]: String(fee) })); // buyer FILL @ boundary

const st = resolve(events, fillH + 10);
const py = JSON.parse(spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname],
  { input: JSON.stringify({ resolve: [{ events, tipHeight: fillH + 10 }] }), encoding: "utf8" }).stdout).resolve[0];
const n69 = st.names["69"];
console.log("V20=" + V20_HEIGHT + "  commit@" + commitH + " reveal@" + revealH + " offer@" + offH + " claim@" + claimH + " fill@" + fillH);
console.log("payment-value vs on-chain 69.csd:", String(sellerNeed) === "4547500000" && String(fee) === "67500000" ? "✓ seller 4547500000 + treasury 67500000 EXACT" : "✗ " + sellerNeed + "/" + fee);
console.log("69.csd owner after fixed resolver:", n69?.owner, "viaFill=" + n69?.viaFill);
console.log("transferred to BUYER:", n69?.owner === BUYER ? "✓ YES — the purchase that burned ~46 CSD now completes" : "✗ NO (owner=" + n69?.owner + ")");
console.log("JS≡Python:", canonicalState(st) === py ? "✓" : "✗ DIVERGED");
// rejection trail
const bad = (st.events || []).filter(e => e.ok === false);
if (n69?.owner !== BUYER) { console.log("\nrejections:"); for (const b of bad) console.log("  ✗", b.kind, b.reason); }
const okAll = n69?.owner === BUYER && String(sellerNeed) === "4547500000" && String(fee) === "67500000" && canonicalState(st) === py;
console.log("\n" + (okAll ? "✓✓ E2E PASS" : "✗ E2E FAIL"));
process.exit(okAll ? 0 : 1);
