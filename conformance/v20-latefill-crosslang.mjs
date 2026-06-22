// v20-latefill-crosslang.mjs — regression for the V20 open-lane fix: bigger claim WINDOW (40) + a bounded
// FILL GRACE (5), applied SYMMETRICALLY (the claimer's fill is honored AND any new claim is blocked through
// claimUntilHeight + grace). Proves, against BOTH the JS resolver and the Python reference:
//   • a fill that mines past the window boundary but within the grace still DELIVERS (the late-fill fund-loss
//     fix) — at/above V20; below V20 the old strict 15-block window still REJECTS it (non-retroactive);
//   • a fill past the hold (window+grace) is rejected (bounded, not infinite);
//   • NO displacement race: during the hold a competing claim is rejected; only after the hold can another
//     address claim (clean handoff), and a displaced claimer's late fill is rejected;
//   • JS ≡ Python byte-identical in every case.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, CLAIM_WINDOW_BLOCKS, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS, V20_HEIGHT, makerRebate, tradeFee } = R;
const D = "0x" + "d0".repeat(20), B = "0x" + "b0".repeat(20), C = "0x" + "c0".repeat(20), TREAS = R.TREASURY_ADDR;
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();
const want = 4500000000n;
const fillPay = { [D]: (want + makerRebate(want)).toString(), [TREAS]: tradeFee(want, 150).toString() };

// deploy → mint → OPEN token offer at offH. Returns {ev, offerId} ready for claim/fill events to be appended.
function base(offH, expEpoch = Math.floor(offH / 30) + 99999) {
  const T = "TKN", ev = [];
  const P = (b, h, pt) => ({ kind: "propose", id: nid(), proposer: D, uri: b.uri, payloadHash: b.payloadHash, height: h, pos: 1, expiresEpoch: 9e15, paidTo: pt });
  ev.push(P(R.deploy({ ticker: T, decimals: 0, supply: "1000000", mint: "issuer" }), offH - 4, { [TREAS]: "100000000" }));
  ev.push(P(R.mint({ ticker: T, amount: "1000000" }), offH - 2, {}));
  const offerId = nid();
  ev.push({ kind: "propose", id: offerId, proposer: D, uri: R.offer({ give: { ticker: T, amount: "10" }, want: { value: want.toString() } }).uri, payloadHash: R.offer({ give: { ticker: T, amount: "10" }, want: { value: want.toString() } }).payloadHash, height: offH, pos: 1, expiresEpoch: expEpoch, paidTo: {} });
  return { ev, offerId };
}
const claim = (offerId, who, h) => ({ kind: "attest", txid: nid(), proposalId: offerId, attester: who, score: 50, confidence: 0, height: h, pos: 1, paidTo: {} });
const fill = (offerId, who, h) => ({ kind: "attest", txid: nid(), proposalId: offerId, attester: who, score: 100, confidence: 0, height: h, pos: 2, paidTo: fillPay });

const jsStatus = (ev, tip) => { const st = resolve(ev, tip); const o = st.offers[Object.keys(st.offers)[0]]; return { status: o?.status, buyer: o?.fill?.buyer, claimedBy: o?.claimedBy, canon: canonicalState(st) }; };
const pyCanon = (ev, tip) => { const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return JSON.parse(r.stdout).resolve[0]; };

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
// every assertion also checks JS≡Python on the same events
function check(name, ev, tip, want) {
  const js = jsStatus(ev, tip), py = pyCanon(ev, tip);
  ok(`${name}: offer ${want}`, js.status === want);
  ok(`${name}: JS≡Python`, js.canon === py);
}

const V = V20_HEIGHT + 1000;                 // an at/above-V20 anchor; window 40 + grace 5 = 45-block hold
const claimH = V, until = V + CLAIM_WINDOW_BLOCKS_V20, holdEnd = until + CLAIM_FILL_GRACE_BLOCKS; // V+40, V+45
console.log(`v20 grace regression (V20=${V20_HEIGHT}; window=${CLAIM_WINDOW_BLOCKS_V20} grace=${CLAIM_FILL_GRACE_BLOCKS}; claim@${claimH} claimUntil=${until} holdEnd=${holdEnd}):`);

// S1: fill AT the window boundary (the exact case that burned 69.csd) → within grace → DELIVERED
{ const { ev, offerId } = base(claimH - 10); ev.push(claim(offerId, B, claimH), fill(offerId, B, until)); check(`S1 fill@claimUntil(${until})`, ev, holdEnd + 5, "filled"); }
// S2: fill at the LAST grace block (holdEnd-1) → DELIVERED
{ const { ev, offerId } = base(claimH - 10); ev.push(claim(offerId, B, claimH), fill(offerId, B, holdEnd - 1)); check(`S2 fill@holdEnd-1(${holdEnd - 1})`, ev, holdEnd + 5, "filled"); }
// S3: fill at the hold END (claimUntil+grace) → past the bound → REJECTED (offer stays open) [bounded, not infinite]
{ const { ev, offerId } = base(claimH - 10); ev.push(claim(offerId, B, claimH), fill(offerId, B, holdEnd)); check(`S3 fill@holdEnd(${holdEnd})`, ev, holdEnd + 5, "open"); }
// S4: a competing claim DURING the hold (at claimUntil, within grace) is REJECTED → no displacement, B exclusive
{ const { ev, offerId } = base(claimH - 10); ev.push(claim(offerId, B, claimH), claim(offerId, C, until), fill(offerId, B, until + 2)); const js = jsStatus(ev, holdEnd + 5); ok(`S4 in-hold rival claim rejected → B still fills`, js.status === "filled" && js.buyer === B); ok(`S4 JS≡Python`, js.canon === pyCanon(ev, holdEnd + 5)); }
// S5: displacement — B's hold fully lapses, C claims AFTER holdEnd (accepted), then B's late fill is REJECTED (displaced); C is now the holder
{ const { ev, offerId } = base(claimH - 10); ev.push(claim(offerId, B, claimH), claim(offerId, C, holdEnd), fill(offerId, B, holdEnd + 1)); const js = jsStatus(ev, holdEnd + 20); ok(`S5 displaced B's late fill rejected (offer open, claimedBy=C)`, js.status === "open" && js.claimedBy === C); ok(`S5 JS≡Python`, js.canon === pyCanon(ev, holdEnd + 20)); }
// S6: clean handoff at holdEnd — C's claim accepted AND C fills → C buys (no overlap with B)
{ const { ev, offerId } = base(claimH - 10); ev.push(claim(offerId, B, claimH), claim(offerId, C, holdEnd), fill(offerId, C, holdEnd + 3)); const js = jsStatus(ev, holdEnd + 20); ok(`S6 handoff: C claims after hold, C fills → bought by C`, js.status === "filled" && js.buyer === C); ok(`S6 JS≡Python`, js.canon === pyCanon(ev, holdEnd + 20)); }
// S7: NON-RETROACTIVE — below V20 the same boundary fill (strict 15-window, no grace) is still REJECTED
{ const lo = V20_HEIGHT - 900, cH = lo, u = lo + CLAIM_WINDOW_BLOCKS; const { ev, offerId } = base(cH - 10); ev.push(claim(offerId, B, cH), fill(offerId, B, u)); check(`S7 below-V20 fill@claimUntil(${u})`, ev, u + 10, "open"); }
// S8: OFFER-EXPIRY inside the hold — a fill mining AT offerExpiryHeight (∈ the hold) is REJECTED (sweepExpired
// beats the held claim) → the buyer's payment would burn. Locks the class the client expiry-guard defends against.
{ const expEpoch = Math.floor(V / 30);                              // offer expires at the next epoch boundary after V
  const offExpH = (expEpoch + 1) * 30;                              // ∈ (V, V+45) = inside the hold
  const { ev, offerId } = base(V - 10, expEpoch); ev.push(claim(offerId, B, V), fill(offerId, B, offExpH));
  ok(`S8 fill@offerExpiry(${offExpH}) inside hold → REJECTED (expired, payment would burn): offExpH in hold`, offExpH > V && offExpH < holdEnd);
  check(`S8 fill@offerExpiry(${offExpH}) inside hold`, ev, holdEnd + 5, "expired"); }

console.log(`\nv20 grace cross-lang: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
