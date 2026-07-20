// v29-mux-crosslang.mjs: the v2.9 (§32, V29) JS<->Python differential for the M4 (event de-dup) + M5
// (open-holds-only concurrent cap) gate. Proves the shipping TS resolver and the INDEPENDENT Python oracle
// (cairnx_ref.py, derived from the finding text, not transliterated) agree byte-for-byte across the gate
// straddle and the cap deny/grant ladder. Every scenario is probed NON-vacuously (the intended branch fires).
// A divergence is a real consensus fork.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, requiredFillOutputs, deploy, mint, offer, fclaim,
        V28_HEIGHT, V29_HEIGHT, EPOCH_LEN, DEPLOY_FEE, SCORE_FILL, MAX_ACTIVE_CLAIMS, epochOf } = R;
const T = R.TREASURY_ADDR;
if (V29_HEIGHT <= V28_HEIGHT) throw new Error(`test misconfig: V29_HEIGHT=${V29_HEIGHT} must sit above V28=${V28_HEIGHT}`);

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();
const G = V29_HEIGHT;
const PE = (b, height, proposer, ee, pos = 0, paidTo = {}, id = nid()) =>
  ({ kind: "propose", id, proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo, score = SCORE_FILL, confidence = 0, pos = 0) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence, height, pos, paidTo });
const roots = () => ([
  PE(deploy({ ticker: "AAA", decimals: 0, supply: "100000", mint: "issuer" }), 40000, A, 9e9, 0, { [T]: String(DEPLOY_FEE) }),
  PE(mint({ ticker: "AAA", amount: "100000" }), 40001, A, 9e9, 0, {}),
]);
const mkOffer = (id, h, { value = "500000000", min } = {}) =>
  PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value, payto: A }, ...(min ? { min } : {}) }), h, A, 9e9, 0, {}, id);
const payFor = (events, offerId, pay, tip) => Object.fromEntries(requiredFillOutputs(resolve(events, tip).offers[offerId], pay).map((x) => [x.to, String(x.value)]));

const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const jsState = (ev, tip) => resolve(ev, tip);
const pyCanon = (ev, tip) => {
  const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname],
    { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status) throw new Error(r.stderr);
  return JSON.parse(r.stdout).resolve[0];
};
let pass = 0, fail = 0;
const both = (n, ev, tip) => { const j = jsCanon(ev, tip), p = pyCanon(ev, tip); const c = j === p; c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}: JS${c ? "≡" : "≠"}Python`); if (!c) { console.log("    JS:", j.slice(0, 320)); console.log("    PY:", p.slice(0, 320)); } };
const probe = (label, cond) => { if (!cond) { fail++; console.log(`  ✗ ${label}: VACUOUS (intended branch did not fire)`); } };

console.log(`v29 mux crosslang (V28=${V28_HEIGHT}, V29=${G}, EPOCH_LEN=${EPOCH_LEN}, cap=${MAX_ACTIVE_CLAIMS}):`);

// ── M5: 3 fclaim buys by B, each optionally FILLED, then a 4th fclaim on a fresh offer at `fourthH`. Holds are
//    granted below the gate with windows extending past it, so at the 4th grant every prior hold is still live. ──
function m5(fourthH, { fill } = { fill: true }) {
  const gh = G - 20;                       // 87,980; claimUntilHeight = (epochOf(gh)+3)*30 = 88,050 > 88,000
  const E = epochOf(gh) + 2;
  const o1 = nid(), o2 = nid(), o3 = nid(), o4 = nid();
  const ev = [...roots(), mkOffer(o1, gh), mkOffer(o2, gh), mkOffer(o3, gh), mkOffer(o4, gh)];
  const g1 = PE(fclaim({ offer: o1 }), gh, B, E, 0, {}); ev.push(g1);
  const g2 = PE(fclaim({ offer: o2 }), gh, B, E, 1, {}); ev.push(g2);
  const g3 = PE(fclaim({ offer: o3 }), gh, B, E, 2, {}); ev.push(g3);
  if (fill) for (const [oid, g] of [[o1, g1], [o2, g2], [o3, g3]]) ev.push(AE(g.id, B, gh + 5, payFor(ev, oid, "500000000", gh + 5)));
  ev.push(PE(fclaim({ offer: o4 }), fourthH, B, epochOf(fourthH) + 2, 0, {}));
  return { ev, tip: G + 100, o1, o4 };
}
// grant/deny ladder
{ const s = m5(G, { fill: true });   // 3 FILLED holds -> 4th GRANTED at the gate (the relaxation)
  probe("ladder: filled holds don't count at V29", jsState(s.ev, s.tip).offers[s.o4].claimedBy === B && jsState(s.ev, s.tip).offers[s.o1].status === "filled");
  both("ladder GRANT: 3 filled holds + 4th @ V29", s.ev, s.tip); }
{ const s = m5(G - 1, { fill: true });   // same, one block below -> 4th DENIED (non-retroactive)
  probe("ladder: filled holds STILL count below V29", jsState(s.ev, s.tip).offers[s.o4].claimedBy === undefined);
  both("ladder DENY (below gate): 3 filled holds + 4th @ V29-1", s.ev, s.tip); }
{ const s = m5(G, { fill: false });  // 3 OPEN holds -> the cap is STILL enforced at V29 (4th DENIED)
  probe("ladder: OPEN holds still count at V29 (cap intact)", jsState(s.ev, s.tip).offers[s.o4].claimedBy === undefined && jsState(s.ev, s.tip).offers[s.o1].status === "open");
  both("ladder DENY: 3 OPEN holds + 4th @ V29 (cap not removed)", s.ev, s.tip); }

// M5 straddle: sweep the 4th grant across the exact boundary; each side agrees JS==Python.
for (const h of [G - 3, G - 2, G - 1, G, G + 1, G + 2]) {
  const s = m5(h, { fill: true });
  const granted = jsState(s.ev, s.tip).offers[s.o4].claimedBy === B;
  probe(`straddle@${h} expected ${h >= G ? "GRANT" : "DENY"}`, granted === (h >= G));
  both(`M5 straddle 4th-fclaim @ ${h} (${h >= G ? "granted" : "denied"})`, s.ev, s.tip);
}

// ── M4: a duplicated partial-fill event. Below V29 both copies apply (double-credit); at/above V29 the second is
//    dropped (single credit). Also: a NON-duplicated fill is unaffected, and a duplicated PROPOSE is de-duped too. ──
function m4dupFill(fillH) {
  const gh = fillH - 5, E = epochOf(gh) + 2, oid = nid();
  const ev = [...roots(), mkOffer(oid, gh, { value: "500000000", min: "100000000" })];
  const g = PE(fclaim({ offer: oid }), gh, B, E, 0, {}); ev.push(g);
  const fill = AE(g.id, B, fillH, payFor(ev, oid, "400000000", gh + 2));
  ev.push(fill); ev.push({ ...fill });   // duplicate: same txid, distinct object
  return { ev, tip: fillH + 20, oid };
}
for (const h of [G - 1, G]) {
  const s = m4dupFill(h);
  const o = jsState(s.ev, s.tip).offers[s.oid];
  probe(`M4 dup-fill @ ${h} expected ${h >= G ? "single(paid=400M,open)" : "double(paid=500M,filled)"}`,
    h >= G ? (o.paid === "400000000" && o.status === "open" && o.fills.length === 1)
           : (o.paid === "500000000" && o.status === "filled" && o.fills.length === 2));
  both(`M4 dup partial-fill @ ${h}`, s.ev, s.tip);
}
// non-duplicated honest partial fill at V29 is untouched by the dedup (no-op for unique ids)
{ const gh = G - 5, E = epochOf(gh) + 2, oid = nid();
  const ev = [...roots(), mkOffer(oid, gh, { value: "500000000", min: "100000000" })];
  const g = PE(fclaim({ offer: oid }), gh, B, E, 0, {}); ev.push(g);
  ev.push(AE(g.id, B, G, payFor(ev, oid, "400000000", gh + 2)));
  probe("M4 honest single fill @ V29 unaffected", jsState(ev, G + 20).offers[oid].paid === "400000000");
  both("M4 honest (non-duplicated) partial fill @ V29", ev, G + 20); }
// a duplicated PROPOSE (the offer anchored twice at the same id) at V29 is de-duped to one offer
{ const oid = nid(); const off = mkOffer(oid, G);
  const ev = [...roots(), off, { ...off }];  // duplicate propose, same id
  probe("M4 dup propose collapses to one offer", Object.keys(jsState(ev, G + 20).offers).length === 1);
  both("M4 duplicated propose @ V29 de-duped", ev, G + 20); }

console.log(`\nv29 mux crosslang: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
