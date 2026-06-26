// v22-uncap-crosslang.mjs — regression for V22 REMOVING the offer/bid duration cap from consensus (it
// becomes a UI-only policy). Proves, against BOTH the JS resolver and the Python reference, byte-identical:
//   • offer/bid ANCHORED >= V22: an over-old-cap duration is ACCEPTED (no creation reject) and rests to its
//     raw expiresEpoch (NOT swept at the old 168-epoch cap);
//   • offer ANCHORED in [V21,V22): an over-cap duration is STILL REJECTED (the V21 era is byte-identical /
//     non-retroactive — history preserved);
//   • the Number.isSafeInteger(expiresEpoch) guard is the SOLE remaining bound: a >=V22 offer with a
//     non-safe-integer expiresEpoch is REJECTED on both sides (no fork);
//   • JS ≡ Python canonicalState in every case.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, V21_HEIGHT, V22_HEIGHT, MAX_OFFER_EPOCHS, epochOf } = R;
const D = "0x" + "d0".repeat(20), TREAS = R.TREASURY_ADDR;
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();

// deploy → mint → a token offer at offH with explicit expiresEpoch. Returns {ev, offerId}.
function offerAt(offH, expEpoch) {
  const T = "TKN", ev = [];
  const P = (b, h, pt) => ({ kind: "propose", id: nid(), proposer: D, uri: b.uri, payloadHash: b.payloadHash, height: h, pos: 1, expiresEpoch: 9e15, paidTo: pt });
  ev.push(P(R.deploy({ ticker: T, decimals: 0, supply: "1000000", mint: "issuer" }), offH - 4, { [TREAS]: "100000000" }));
  ev.push(P(R.mint({ ticker: T, amount: "1000000" }), offH - 2, {}));
  const offerId = nid(), o = R.offer({ give: { ticker: T, amount: "10" }, want: { value: "1000" } });
  ev.push({ kind: "propose", id: offerId, proposer: D, uri: o.uri, payloadHash: o.payloadHash, height: offH, pos: 1, expiresEpoch: expEpoch, paidTo: {} });
  return { ev, offerId };
}
function bidAt(offH, expEpoch) {
  const ev = [], bidId = nid(), b = R.bid({ want: { ticker: "TKN", amount: "10" }, give: { value: "1000" } });
  ev.push({ kind: "propose", id: bidId, proposer: D, uri: b.uri, payloadHash: b.payloadHash, height: offH, pos: 1, expiresEpoch: expEpoch, paidTo: {} });
  return { ev, bidId };
}
const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const jsOfferStatus = (ev, tip, id) => resolve(ev, tip).offers[id]?.status;
const jsBidStatus = (ev, tip, id) => resolve(ev, tip).bids[id]?.status;
const pyCanon = (ev, tip) => { const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return JSON.parse(r.stdout).resolve[0]; };

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };
const both = (n, ev, tip) => ok(`${n}: JS≡Python`, jsCanon(ev, tip) === pyCanon(ev, tip));

console.log(`v22 un-cap (V21=${V21_HEIGHT}, V22=${V22_HEIGHT}, MAX_OFFER_EPOCHS=${MAX_OFFER_EPOCHS}):`);

// D1: anchored >=V22, duration > old cap → ACCEPTED (open) — the cap is gone
{ const offH = V22_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS + 500; const { ev, offerId } = offerAt(offH, exp);
  ok(`D1 over-cap offer @>=V22 accepted (dur ${exp - epochOf(offH)} > ${MAX_OFFER_EPOCHS})`, jsOfferStatus(ev, offH + 5, offerId) === "open"); both("D1", ev, offH + 5); }
// D2: anchored >=V22, huge duration → still OPEN well past where the old cap would have swept it
{ const offH = V22_HEIGHT + 100, exp = epochOf(offH) + 5000; const { ev, offerId } = offerAt(offH, exp);
  const pastOldCap = (epochOf(offH) + MAX_OFFER_EPOCHS + 10) * 30; // a tip beyond the old cap's sweep height
  ok(`D2 over-cap offer @>=V22 NOT swept at old cap`, jsOfferStatus(ev, pastOldCap, offerId) === "open"); both("D2", ev, pastOldCap); }
// D3: anchored >=V22, over-cap BID → ACCEPTED
{ const offH = V22_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS + 500; const { ev, bidId } = bidAt(offH, exp);
  ok(`D3 over-cap bid @>=V22 accepted`, jsBidStatus(ev, offH + 5, bidId) === "open"); both("D3", ev, offH + 5); }
// D4: anchored in [V21,V22), over-cap → STILL REJECTED (history preserved, non-retroactive)
{ const offH = V21_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS + 1; const { ev, offerId } = offerAt(offH, exp);
  ok(`D4 over-cap offer @[V21,V22) still rejected`, jsOfferStatus(ev, offH + 5, offerId) === undefined); both("D4", ev, offH + 5); }
// D5: anchored >=V22, expiresEpoch NOT a safe integer → REJECTED on both (the sole remaining bound)
{ const offH = V22_HEIGHT + 100, exp = Number.MAX_SAFE_INTEGER + 1; const { ev, offerId } = offerAt(offH, exp);
  ok(`D5 >=V22 offer with non-safe-int expiresEpoch rejected (fork-guard)`, jsOfferStatus(ev, offH + 5, offerId) === undefined); both("D5", ev, offH + 5); }

console.log(`\nv22 un-cap cross-lang: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
