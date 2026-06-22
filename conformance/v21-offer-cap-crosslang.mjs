// v21-offer-cap-crosslang.mjs — regression for the V21 max offer/bid duration cap (MAX_OFFER_EPOCHS = 168
// epochs = 7 days). Proves, against BOTH the JS resolver and the Python reference, byte-identical:
//   • ≥V21: an offer/bid whose duration (expiresEpoch − anchorEpoch) exceeds the cap is REJECTED at creation;
//   • ≥V21: one exactly at the cap is ACCEPTED;
//   • <V21: a long-duration offer is ACCEPTED (non-retroactive) and stays open while the tip is below V21,
//     then is SWEPT to "expired" once the sweep height crosses V21 (the gated auto-expire of long-resters);
//   • JS ≡ Python canonicalState in every case.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, V21_HEIGHT, MAX_OFFER_EPOCHS, epochOf } = R;
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
const jsOfferStatus = (ev, tip, id) => { const st = resolve(ev, tip); return st.offers[id]?.status; };
const jsBidStatus = (ev, tip, id) => { const st = resolve(ev, tip); return st.bids[id]?.status; };
const pyCanon = (ev, tip) => { const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return JSON.parse(r.stdout).resolve[0]; };

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };
const both = (n, ev, tip) => ok(`${n}: JS≡Python`, jsCanon(ev, tip) === pyCanon(ev, tip));

console.log(`v21 offer-cap (V21=${V21_HEIGHT}, MAX_OFFER_EPOCHS=${MAX_OFFER_EPOCHS}):`);

// C1: ≥V21, duration > cap → REJECTED
{ const offH = V21_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS + 1; const { ev, offerId } = offerAt(offH, exp);
  ok(`C1 over-cap offer @≥V21 rejected (dur ${exp - epochOf(offH)})`, jsOfferStatus(ev, offH + 5, offerId) === undefined); both("C1", ev, offH + 5); }
// C2: ≥V21, duration == cap → ACCEPTED (open)
{ const offH = V21_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS; const { ev, offerId } = offerAt(offH, exp);
  ok(`C2 at-cap offer @≥V21 accepted (dur ${exp - epochOf(offH)})`, jsOfferStatus(ev, offH + 5, offerId) === "open"); both("C2", ev, offH + 5); }
// C3: OLD over-cap offer created <V21 → open below V21, auto-expired once the sweep crosses V21
{ const offH = 35_000, exp = epochOf(offH) + 1000; const { ev, offerId } = offerAt(offH, exp);  // dur 1000 ≫ cap, anchored long ago
  ok(`C3 old over-cap offer open while tip<V21`, jsOfferStatus(ev, V21_HEIGHT - 1000, offerId) === "open"); both("C3a tip<V21", ev, V21_HEIGHT - 1000);
  ok(`C3 same offer SWEPT expired once tip≥V21`, jsOfferStatus(ev, V21_HEIGHT + 2000, offerId) === "expired"); both("C3b tip≥V21", ev, V21_HEIGHT + 2000); }
// C4: ≥V21, over-cap BID → REJECTED
{ const offH = V21_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS + 1; const { ev, bidId } = bidAt(offH, exp);
  ok(`C4 over-cap bid @≥V21 rejected`, jsBidStatus(ev, offH + 5, bidId) === undefined); both("C4", ev, offH + 5); }
// C5: BELOW V21, over-cap offer accepted (non-retroactive) — sanity that the cap doesn't fire early
{ const offH = V21_HEIGHT - 5000, exp = epochOf(offH) + 1000; const { ev, offerId } = offerAt(offH, exp);
  ok(`C5 over-cap offer @<V21 accepted (non-retroactive)`, jsOfferStatus(ev, offH + 5, offerId) === "open"); both("C5", ev, offH + 5); }

console.log(`\nv21 offer-cap cross-lang: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
