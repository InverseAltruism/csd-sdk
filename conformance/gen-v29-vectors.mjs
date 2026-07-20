// Generator for the v2.9 (§32, V29) conformance vectors: the JS byte-identity pin for the M4 (event de-dup)
// and M5 (open-holds-only concurrent cap) gate. The cross-impl JS<->Python proof lives in
// v29-mux-crosslang.mjs; expectedState here is derived from the SHIPPING JS resolver. Re-runnable: rewrites
// the whole cases-v29.json each run. Run: node conformance/gen-v29-vectors.mjs
//
// These vectors live in their OWN file (cases-v29.json), NOT appended to cases.json, so the B6-era pinned
// corpus (cases.json / replay-hashes.json / wa-parity) stays byte-frozen for the B6 seal differential. The
// V29 replay-hash RE-PIN (replay-hashes.json) is DEFERRED: it is a post-crossing runbook step that needs the
// live-indexer generator reachable into the V29 region (tip ~58.3k today). Do NOT pin V29 replay hashes here.
import { readFileSync, writeFileSync } from "node:fs";
import {
  resolve, canonicalState, requiredFillOutputs, deploy, mint, offer, fclaim,
  canonicalJson, payloadHash, V28_HEIGHT, V29_HEIGHT, EPOCH_LEN, DEPLOY_FEE, SCORE_FILL, epochOf,
} from "../packages/cairnx/dist/index.js";

if (V29_HEIGHT <= V28_HEIGHT) throw new Error(`V29_HEIGHT=${V29_HEIGHT} must be above V28_HEIGHT=${V28_HEIGHT}`);
const T = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
let idn = 0xfc290000;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
const G = V29_HEIGHT;                    // the gate
const PE = (b, height, proposer, ee, pos = 0, paidTo = {}, id = nid()) =>
  ({ kind: "propose", id, proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo, score = SCORE_FILL, confidence = 0, pos = 0) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence, height, pos, paidTo });
// A single early deploy+mint gives A a large AAA balance; offers can sit anywhere at/after V28.
const roots = () => ([
  PE(deploy({ ticker: "AAA", decimals: 0, supply: "100000", mint: "issuer" }), 40000, A, 9e9, 0, { [T]: String(DEPLOY_FEE) }),
  PE(mint({ ticker: "AAA", amount: "100000" }), 40001, A, 9e9, 0, {}),
]);
const mkOffer = (id, h, { value = "500000000", min } = {}) =>
  PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value, payto: A }, ...(min ? { min } : {}) }), h, A, 9e9, 0, {}, id);
const payFor = (events, offerId, pay, tip) => Object.fromEntries(requiredFillOutputs(resolve(events, tip).offers[offerId], pay).map((x) => [x.to, String(x.value)]));

const built = [];
const add = (name, events, tipHeight) => { built.push({ name, events, tipHeight, expectedState: JSON.parse(canonicalState(resolve(events, tipHeight))) }); };

// ── M5: the concurrent-hold cap. Three completed fclaim buys keep their (never-cleared) claim fields with holds
//    still live; a 4th honest fclaim by the SAME address is DENIED below V29 (filled holds still counted) and
//    GRANTED at/above V29 (only OPEN holds counted). ──
// grantsH: grants + fills all here (holds live past the gate); fourthH: the 4th fclaim, straddled across the gate.
function m5Scenario(fourthH) {
  const gh = G - 20;                       // 87,980: below the gate, hold windows extend past it
  const E = epochOf(gh) + 2;               // claimUntilHeight = (E+1)*EPOCH_LEN = 88,050 > 88,000
  const o1 = nid(), o2 = nid(), o3 = nid(), o4 = nid();
  const ev = [...roots(), mkOffer(o1, gh), mkOffer(o2, gh), mkOffer(o3, gh), mkOffer(o4, gh)];
  const g1 = PE(fclaim({ offer: o1 }), gh, B, E, 0, {}); ev.push(g1);
  const g2 = PE(fclaim({ offer: o2 }), gh, B, E, 1, {}); ev.push(g2);
  const g3 = PE(fclaim({ offer: o3 }), gh, B, E, 2, {}); ev.push(g3);
  for (const [oid, g] of [[o1, g1], [o2, g2], [o3, g3]]) ev.push(AE(g.id, B, gh + 5, payFor(ev, oid, "500000000", gh + 5)));
  ev.push(PE(fclaim({ offer: o4 }), fourthH, B, epochOf(fourthH) + 2, 0, {}));
  return { ev, tip: G + 100, o4 };
}
{ const s = m5Scenario(G); add("v29-m5-cap-open-holds-granted-at-gate", s.ev, s.tip); }        // 4th @ 88,000 -> GRANTED (>/>= boundary target)
{ const s = m5Scenario(G - 1); add("v29-m5-cap-filled-holds-denied-below-gate", s.ev, s.tip); } // 4th @ 87,999 -> DENIED (non-retroactivity)

// ── M4: a duplicated partial-fill event double-credits o.paid/o.delivered below V29 and is de-duped at/above. ──
function m4Scenario(fillH) {
  const gh = fillH - 5;
  const E = epochOf(gh) + 2;
  const oid = nid();
  const ev = [...roots(), mkOffer(oid, gh, { value: "500000000", min: "100000000" })];
  const g = PE(fclaim({ offer: oid }), gh, B, E, 0, {}); ev.push(g);
  const fill = AE(g.id, B, fillH, payFor(ev, oid, "400000000", gh + 2));
  ev.push(fill);
  ev.push({ ...fill });                    // DUPLICATE: same txid, distinct object (an overlapping scan page)
  return { ev, tip: fillH + 20, oid };
}
{ const s = m4Scenario(G); add("v29-m4-dedup-partial-single-at-gate", s.ev, s.tip); }         // dup @ 88,000 -> single credit (paid 400M, open)
{ const s = m4Scenario(G - 1); add("v29-m4-dup-double-credit-below-gate", s.ev, s.tip); }      // dup @ 87,999 -> double credit (paid 500M, filled)

for (const c of built) {
  const s = c.expectedState;
  const offs = Object.values(s.offers || {}).map((o) => `${o.status}${o.claimTxid ? "/held" : ""}${o.paid ? `/paid${o.paid}` : ""}`).join(",");
  console.log(`  ${c.name.padEnd(46)} offers=[${offs}]`);
}
const path = new URL("../packages/cairnx/test/vectors/cases-v29.json", import.meta.url);
writeFileSync(path, JSON.stringify({ format: 2, gate: "V29", generatedFrom: "shipping JS resolver", cases: built }, null, 1) + "\n");
console.log(`\nwrote ${built.length} v29 vectors -> cases-v29.json`);
