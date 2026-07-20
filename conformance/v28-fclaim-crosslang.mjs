// v28-fclaim-crosslang.mjs: the v2.8 fclaim (§31) JS<->Python differential. Proves the TS resolver and the
// independent Python reference agree byte-for-byte (canonical state) across the fclaim grid. Every scenario is
// probed to be NON-vacuous (the intended branch actually fires). A divergence is a real consensus bug.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, canonicalJson, payloadHash, requiredFillOutputs,
        deploy, mint, offer, offerCancelAll, fclaim, nameCommit, nameRegFee, nameFinalize,
        V28_HEIGHT, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS,
        CLAIM_COOLDOWN_BLOCKS, MAX_ACTIVE_CLAIMS, REG_COMMIT_MAX_BLOCKS, NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS,
        DEPLOY_FEE, FEE_BPS_V16, SCORE_FILL, SCORE_CANCEL, SCORE_CLAIM, tradeFee } = R;
const T = R.TREASURY_ADDR;
if (V28_HEIGHT <= 52000) throw new Error(`test misconfig: V28_HEIGHT=${V28_HEIGHT} must sit above live gates`);

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();
const cj = (r) => canonicalJson(r), ph = (r) => payloadHash(r);
const epochOf = (h) => Math.floor(h / EPOCH_LEN);
const H0 = V28_HEIGHT;

const PE = (b, height, proposer, ee, pos = 0, paidTo = {}, id = nid()) =>
  ({ kind: "propose", id, proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo, score = SCORE_FILL, confidence = 0, pos = 0) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence, height, pos, paidTo });

const jsState = (ev, tip) => resolve(ev, tip);
const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const pyCanon = (ev, tip) => {
  const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname],
    { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status) throw new Error(r.stderr);
  return JSON.parse(r.stdout).resolve[0];
};
let pass = 0, fail = 0;
const both = (n, ev, tip) => { const j = jsCanon(ev, tip), p = pyCanon(ev, tip); const c = j === p; c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}: JS${c ? "≡" : "≠"}Python`); if (!c) { console.log("    JS:", j.slice(0, 300)); console.log("    PY:", p.slice(0, 300)); } };
// non-vacuous probe: assert (on the JS side) that the scenario's intended branch actually fired
const probe = (label, cond) => { if (!cond) { fail++; console.log(`  ✗ ${label}: VACUOUS (intended branch did not fire)`); } };

// A single early deploy+mint gives A a large AAA balance reusable by every scenario; offers can sit anywhere.
const DEP = PE(deploy({ ticker: "AAA", decimals: 0, supply: "100000", mint: "issuer" }), 40000, A, 9e9, 0, { [T]: String(DEPLOY_FEE) }, nid());
const MNT = PE(mint({ ticker: "AAA", amount: "100000" }), 40001, A, 9e9, 0, {}, nid());
const roots = [DEP, MNT];
const mkOffer = (id, height, { amount = "10", value = "500000000", taker, min } = {}) =>
  PE(offer({ give: { ticker: "AAA", amount }, want: { value, payto: A }, ...(taker ? { taker } : {}), ...(min ? { min } : {}) }), height, A, 9e9, 0, {}, id);
const payFor = (events, offerId, pay, tip = H0 + 20) => { const o = jsState(events, tip).offers[offerId]; return Object.fromEntries(requiredFillOutputs(o, pay).map((x) => [x.to, String(x.value)])); };
const E = epochOf(H0 + 3) + 2, holdEnd = (E + 1) * EPOCH_LEN - 1;
const grant = (who, offerId, { e = E, pos = 0, height = H0 + 3 } = {}) => PE(fclaim({ offer: offerId }), height, who, e, pos, {}, nid());

console.log(`v28 fclaim crosslang (V28=${H0}, EPOCH_LEN=${EPOCH_LEN}, holdEnd=${holdEnd}, cap=${MAX_ACTIVE_CLAIMS}):`);

// 1. grant + fclaim fill delivers
{ const oid = nid(), o = mkOffer(oid, H0 + 2), g = grant(B, oid), pay = payFor([...roots, o], oid, "500000000");
  both("grant + fclaim fill delivers", [...roots, o, g, AE(g.id, B, holdEnd, pay)], holdEnd + 5);
  probe("s1 delivered", jsState([...roots, o, g, AE(g.id, B, holdEnd, pay)], holdEnd + 5).offers[oid].status === "filled"); }
// 2. holdEnd boundary (both sides)
{ const oid = nid(), o = mkOffer(oid, H0 + 2), g = grant(B, oid), pay = payFor([...roots, o], oid, "500000000");
  both("fill AT holdEnd delivers", [...roots, o, g, AE(g.id, B, holdEnd, pay)], holdEnd + 5);
  both("fill PAST holdEnd rejected", [...roots, o, g, AE(g.id, B, holdEnd + 1, pay)], holdEnd + 5);
  probe("s2 past-holdEnd not filled", jsState([...roots, o, g, AE(g.id, B, holdEnd + 1, pay)], holdEnd + 5).offers[oid].status === "open"); }
// 3. Correction 1: offer-txid fill during a hold rejected
{ const oid = nid(), o = mkOffer(oid, H0 + 2), g = grant(B, oid), pay = payFor([...roots, o], oid, "500000000");
  both("Correction 1 offer-txid fill during hold", [...roots, o, g, AE(oid, B, H0 + 10, pay)], H0 + 20);
  probe("s3 offer stayed open+held", (() => { const x = jsState([...roots, o, g, AE(oid, B, H0 + 10, pay)], H0 + 20).offers[oid]; return x.status === "open" && x.claimTxid === g.id; })()); }
// 4. denied fclaim (unknown offer) + fill on it delivers nothing
{ const g = grant(C, "0x" + "ee".repeat(32));
  both("denied fclaim (unknown offer)", [...roots, g], H0 + 10);
  both("fill on a denied fclaim (no delivery)", [...roots, g, AE(g.id, C, H0 + 10, { [A]: "500000000" })], H0 + 20); }
// 5. Correction 2 (ocancel): pos race + multi-block flush gap
{ const oid = nid(), o = mkOffer(oid, H0 + 2), oc = PE(offerCancelAll({}), H0 + 3, A, 9e9, 0, {}, nid()), g = grant(B, oid, { pos: 1 });
  both("Correction 2 ocancel pos0 + grant pos1 (offer survives)", [...roots, o, oc, g], H0 + 10);
  probe("s5 survived", jsState([...roots, o, oc, g], H0 + 10).offers[oid].status === "open");
  both("Correction 2 ocancel + grant, multi-block flush gap", [...roots, o, oc, g, AE(oid, C, H0 + 50, {}, SCORE_CANCEL)], H0 + 60); }
// 5b. ocancel while the hold is LIVE but in a later block (still frozen); and after holdEnd (cancel succeeds)
{ const oid = nid(), o = mkOffer(oid, H0 + 2), g = grant(B, oid);
  both("ocancel LATER block, hold live (frozen, offer survives)", [...roots, o, g, PE(offerCancelAll({}), H0 + 4, A, 9e9, 0, {}, nid())], H0 + 10);
  probe("s5b frozen", jsState([...roots, o, g, PE(offerCancelAll({}), H0 + 4, A, 9e9, 0, {}, nid())], H0 + 10).offers[oid].status === "open");
  both("ocancel AFTER holdEnd, hold lapsed (cancel succeeds)", [...roots, o, g, PE(offerCancelAll({}), holdEnd + 5, A, 9e9, 0, {}, nid())], holdEnd + 20);
  probe("s5b cancelled post-lapse", jsState([...roots, o, g, PE(offerCancelAll({}), holdEnd + 5, A, 9e9, 0, {}, nid())], holdEnd + 20).offers[oid].status === "cancelled"); }
// 6. Correction 2 (score-0 cancel), same block
{ const oid = nid(), o = mkOffer(oid, H0 + 2), g = grant(B, oid), can = AE(oid, A, H0 + 3, {}, SCORE_CANCEL, 0, 0);
  both("Correction 2 score-0 cancel same block (offer survives)", [...roots, o, g, can], H0 + 10); }
// 7. Lane B (both directions, both cancel paths)
{ const tOID = nid(), to = mkOffer(tOID, H0 + 3, { amount: "5", value: "1", taker: B });
  both("Lane B V28+ taker: score-0 cancel rejected", [...roots, to, AE(tOID, A, H0 + 5, {}, SCORE_CANCEL)], H0 + 10);
  both("Lane B V28+ taker: ocancel skips it", [...roots, to, PE(offerCancelAll({}), H0 + 5, A, 9e9, 0, {}, nid())], H0 + 10);
  probe("s7 taker offer stays open", jsState([...roots, to, AE(tOID, A, H0 + 5, {}, SCORE_CANCEL)], H0 + 10).offers[tOID].status === "open"); }
{ const preOID = nid(), preOff = mkOffer(preOID, 41300 + 5, { amount: "5", value: "1", taker: B });
  both("Lane B pre-V28 taker stays cancellable", [...roots, preOff, AE(preOID, A, H0 + 5, {}, SCORE_CANCEL)], H0 + 10);
  probe("s7 pre-V28 taker cancelled", jsState([...roots, preOff, AE(preOID, A, H0 + 5, {}, SCORE_CANCEL)], H0 + 10).offers[preOID].status === "cancelled"); }
// 8. SCORE_CLAIM sunset
{ const oid = nid(), o = mkOffer(oid, H0 + 2);
  both("SCORE_CLAIM at V28+ rejected", [...roots, o, AE(oid, B, H0 + 3, {}, SCORE_CLAIM)], H0 + 10);
  probe("s8 no hold granted", jsState([...roots, o, AE(oid, B, H0 + 3, {}, SCORE_CLAIM)], H0 + 10).offers[oid].claimedBy === undefined); }
// 9. last-write-wins re-grant + fill on the superseded fclaim rejected
{ const oid = nid(), o = mkOffer(oid, H0 + 2), e1 = epochOf(H0 + 3), bHoldEnd = (e1 + 1) * EPOCH_LEN - 1, cH = bHoldEnd + EPOCH_LEN;
  const bg = grant(B, oid, { e: e1 }), cg = grant(C, oid, { e: epochOf(cH), height: cH });
  both("last-write-wins re-grant + fill on superseded fclaim", [...roots, o, bg, cg, AE(bg.id, B, cH + 1, { [A]: "500000000" })], cH + 5);
  probe("s9 claimTxid moved to C's fclaim", jsState([...roots, o, bg, cg], cH + 5).offers[oid].claimTxid === cg.id); }
// 10. anti-squat (E too far ahead) denied
{ const oid = nid(), o = mkOffer(oid, H0 + 2), g = grant(B, oid, { e: epochOf(H0 + 3) + FCLAIM_MAX_EPOCH_AHEAD + 1 });
  both("anti-squat (E too far ahead) denied", [...roots, o, g], H0 + 10);
  probe("s10 denied", jsState([...roots, o, g], H0 + 10).offers[oid].claimedBy === undefined); }
// 11. cooldown straddle: a prior LEGACY (grace-5) hold extends the cooldown past a grace-0 boundary (B0-F1).
//     legacy claim at H0-30 -> claimUntil H0+10, grace 5 -> hold ends H0+14, cooldown to H0+30 (=claimUntil+5+15).
//     an fclaim by the SAME holder at H0+27 is DENIED with grace 5 (cooldown to H0+30) but would GRANT with grace 0
//     (cooldown to H0+25). Probe that the legacy claim actually landed AND the fclaim is denied.
{ const oid = nid(), o = mkOffer(oid, H0 - 40), lc = AE(oid, B, H0 - 30, {}, SCORE_CLAIM);
  const st1 = jsState([...roots, o, lc], H0); probe("s11 legacy claim landed", st1.offers[oid].claimedBy === B && st1.offers[oid].claimUntilHeight === H0 + 10);
  const fg = grant(B, oid, { e: epochOf(H0 + 27), height: H0 + 27 });
  both("cooldown straddle: prior legacy hold +5 grace blocks the fclaim", [...roots, o, lc, fg], H0 + 40);
  probe("s11 fclaim denied by cooldown", jsState([...roots, o, lc, fg], H0 + 40).offers[oid].claimTxid === undefined && jsState([...roots, o, lc, fg], H0 + 40).offers[oid].claimedBy === B); }
// 12. mixed legacy + fclaim MAX_ACTIVE_CLAIMS: 1 live legacy hold + 2 fclaim holds -> a 3rd fclaim is DENIED.
{ const oL = nid(), o2 = nid(), o3 = nid(), o4 = nid();
  const offs = [mkOffer(oL, H0 - 5, { amount: "1", value: "1" }), mkOffer(o2, H0 + 2, { amount: "1", value: "1" }), mkOffer(o3, H0 + 2, { amount: "1", value: "1" }), mkOffer(o4, H0 + 2, { amount: "1", value: "1" })];
  const legacy = AE(oL, B, H0 - 3, {}, SCORE_CLAIM);   // claimUntil H0+37, live at H0+3
  const g2 = grant(B, o2), g3 = grant(B, o3), g4 = grant(B, o4);
  const ev = [...roots, ...offs, legacy, g2, g3, g4];
  const st = jsState(ev, H0 + 10);
  probe("s12 legacy hold live", st.offers[oL].claimedBy === B && st.offers[oL].claimUntilHeight === H0 + 37);
  probe("s12 g2/g3 granted, g4 denied by cap", st.offers[o2].claimTxid === g2.id && st.offers[o3].claimTxid === g3.id && st.offers[o4].claimTxid === undefined);
  both("mixed legacy+fclaim MAX_ACTIVE_CLAIMS cap", ev, H0 + 10); }
// 13. deny ladder. resolve.ts declares TEN deny legs before the grant; this scenario asserts SEVEN of them.
//     The other three are covered elsewhere and deliberately not duplicated here: unknown-offer by
//     scenario 4, anti-squat by scenario 10, and the MAX_ACTIVE_CLAIMS cap by scenario 12. All ten are
//     individually mutation-proven (see the per-leg map in the B0a batch record).
//     Each leg is probed non-vacuously: the deny must be canonically observable, i.e. the offer's
//     claimedBy/claimTxid must NOT move.
//     REBIND B0a: this section previously advertised six legs and asserted three, and its `filled`
//     fixture was built and never referenced. The fixture was also WRONG: it called grant(B, oid)
//     twice, once into the array and once inside the jsState() used to read claimTxid, and grant()
//     mints a fresh id per call, so the fill attested a txid that was not in the sequence and the
//     offer stayed `open`. Hoisted into gF below and probed before it is relied on.
//     The unknown-offer leg is deliberately NOT re-asserted here: scenario 4 already covers it.
{ const oid = nid(), o = mkOffer(oid, H0 + 2), tOID = nid(), to = mkOffer(tOID, H0 + 2, { taker: B });
  // (a) not-open: grant, fill, then fclaim the now-FILLED offer.
  //     The re-claim must be by a DIFFERENT address and AFTER the hold plus cooldown has elapsed, or the
  //     deny is masked by the double-hold leg (B's hold is still live at H0+7) or by the cooldown leg,
  //     and the scenario passes while testing nothing. Caught by the B0a mutation run: removing the
  //     not-open leg from the Python oracle left canonical state identical because a later leg fired.
  const gF = grant(B, oid), baseF = [...roots, o, gF];
  const filled = [...baseF, AE(gF.id, B, H0 + 5, payFor(baseF, oid, "500000000"))];
  probe("s13 not-open fixture is genuinely filled", jsState(filled, H0 + 10).offers[oid].status === "filled");
  const noH = (E + 1) * EPOCH_LEN + CLAIM_COOLDOWN_BLOCKS + 1;   // hold over, cooldown over, and C != B anyway
  const notOpen = [...filled, grant(C, oid, { height: noH, e: epochOf(noH) + 2 })];
  both("deny: not-open (filled) offer", notOpen, noH + 50);
  probe("s13 not-open deny (hold stays B's, not C's)", (() => { const x = jsState(notOpen, noH + 50).offers[oid]; return x.status === "filled" && x.claimTxid === gF.id && x.claimedBy === B.toLowerCase(); })());
  // (b) taker-bound
  both("deny: taker-bound offer", [...roots, to, grant(C, tOID)], H0 + 10);
  probe("s13 taker deny", jsState([...roots, to, grant(C, tOID)], H0 + 10).offers[tOID].claimedBy === undefined);
  // (c) token-want: claims are for CSD-priced offers only (needs a second real ticker; give !== want)
  const DEP2 = PE(deploy({ ticker: "BBB", decimals: 0, supply: "100000", mint: "issuer" }), 40002, A, 9e9, 0, { [T]: String(DEPLOY_FEE) }, nid());
  const twOID = nid(), twOff = PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5" } }), H0 + 2, A, 9e9, 0, {}, twOID);
  const twEv = [...roots, DEP2, twOff, grant(B, twOID)];
  both("deny: token-want offer (claims are CSD-priced only)", twEv, H0 + 10);
  probe("s13 token-want deny (offer exists and is unheld)", (() => { const x = jsState(twEv, H0 + 10).offers[twOID]; return x !== undefined && x.claimedBy === undefined; })());
  // (d) E > effExpiry (the hold would outlive the offer)
  const shortOID = nid(), shortOff = PE(offer({ give: { ticker: "AAA", amount: "1" }, want: { value: "1", payto: A } }), H0 + 2, A, epochOf(H0 + 2), 0, {}, shortOID);
  const shortEv = [...roots, shortOff, grant(B, shortOID, { e: epochOf(H0 + 2) + 1 })];
  both("deny: E > effExpiry (hold outlives the offer)", shortEv, H0 + 10);
  probe("s13 effExpiry deny", jsState(shortEv, H0 + 10).offers[shortOID].claimedBy === undefined);
  // (e) epochOf(h) > E: the requested expiry is already in the past
  const pastE = epochOf(H0 + 3) - 1, pastEv = [...roots, o, grant(B, oid, { e: pastE })];
  both("deny: E already in the past (epochOf(h) > E)", pastEv, H0 + 10);
  probe("s13 past-expiry deny", jsState(pastEv, H0 + 10).offers[oid].claimedBy === undefined);
  // (f) double-hold: a second fclaim during a LIVE hold
  const g1 = grant(B, oid), g2b = grant(C, oid, { pos: 1 });
  both("deny: double-hold (second fclaim during a live hold)", [...roots, o, g1, g2b], H0 + 10);
  probe("s13 double-hold denied (claimTxid stays B's)", jsState([...roots, o, g1, g2b], H0 + 10).offers[oid].claimTxid === g1.id);
  // (g) cooldown: the SAME address re-claims after its own hold ended but inside CLAIM_COOLDOWN_BLOCKS.
  //     The positive control at +CLAIM_COOLDOWN_BLOCKS is what proves this is the cooldown leg and not
  //     the double-hold leg firing again.
  const cUntil = (E + 1) * EPOCH_LEN;                       // claimUntilHeight; fclaim holds carry 0 grace
  const cdEv = [...roots, o, g1, grant(B, oid, { height: cUntil, e: epochOf(cUntil) + 2 })];
  both("deny: claim cooldown (same address, hold just ended)", cdEv, cUntil + 50);
  probe("s13 cooldown deny (hold stays the first grant's)", jsState(cdEv, cUntil + 50).offers[oid].claimTxid === g1.id);
  const okH = cUntil + CLAIM_COOLDOWN_BLOCKS, okEv = [...roots, o, g1, grant(B, oid, { height: okH, e: epochOf(okH) + 2 })];
  probe("s13 cooldown positive control (re-claim AT +COOLDOWN is granted)", jsState(okEv, okH + 50).offers[oid].claimTxid !== g1.id); }
// 14. below-V28 fclaim inertness: an fclaim + a fill on its txid at ~46,600 both no-op (byte-identical either way)
{ const oid = nid(), o = mkOffer(oid, 46600), g = PE(fclaim({ offer: oid }), 46601, B, epochOf(46601) + 2, 0, {}, nid());
  both("below-V28 fclaim + fill are inert", [...roots, o, g, AE(g.id, B, 46605, { [A]: "500000000" })], 46700);
  probe("s14 no hold below gate", jsState([...roots, o, g], 46700).offers[oid].claimedBy === undefined); }
// 14b. B0a deferred F-2: the EXACT-BOUNDARY cross-language differential. The M3/M4 boundary pins are
//      JS-only assertions, so a Python-side >= vs > slip at the gate was caught only probabilistically by
//      fuzz; these two both() legs make it deterministic: an fclaim mined AT V28_HEIGHT is LIVE in both
//      impls, one block below it is INERT in both.
{ const oid = nid(), o = mkOffer(oid, H0 - 2);
  const gAt = PE(fclaim({ offer: oid }), H0, B, epochOf(H0) + 2, 0, {}, nid());
  both("F-2: fclaim AT exactly V28_HEIGHT is live", [...roots, o, gAt], H0 + 10);
  probe("s14b at-gate granted", jsState([...roots, o, gAt], H0 + 10).offers[oid].claimTxid === gAt.id);
  const gBelow = PE(fclaim({ offer: oid }), H0 - 1, B, epochOf(H0 - 1) + 2, 0, {}, nid());
  both("F-2: fclaim ONE block below V28_HEIGHT is inert", [...roots, o, gBelow], H0 + 10);
  probe("s14b below-gate inert", jsState([...roots, o, gBelow], H0 + 10).offers[oid].claimedBy === undefined); }
// 15. partial fclaim fill: a min-bearing CSD-priced token offer, fclaim, PARTIAL fill (hold persists), then completion
{ const oid = nid(), o = mkOffer(oid, H0 + 2, { amount: "10", value: "1000000000", min: "100000000" });  // 10 CSD, min 1
  const g = grant(B, oid);
  const partA = payFor([...roots, o], oid, "400000000");    // pay 4 CSD (>= min)
  const ev1 = [...roots, o, g, AE(g.id, B, H0 + 10, partA)];
  probe("s15 partial delivered + hold persists", (() => { const x = jsState(ev1, H0 + 20).offers[oid]; return x.status === "open" && x.claimTxid === g.id && x.paid === "400000000"; })());
  both("partial fclaim fill (hold persists)", ev1, H0 + 20);
  const partB = payFor(ev1, oid, "600000000");              // pay the remaining 6 CSD -> completes
  const ev2 = [...ev1, AE(g.id, B, H0 + 12, partB)];
  probe("s15 completion fills the offer", jsState(ev2, H0 + 20).offers[oid].status === "filled");
  both("partial fclaim fill completion", ev2, H0 + 20);
  both("Correction 1: offer-txid PARTIAL fill during hold rejected", [...roots, o, g, AE(oid, B, H0 + 10, partA)], H0 + 20); }
// 16. lease-lapse freeze: DEFENSIVELY INERT, and PROVABLY UNREACHABLE at the consensus level, so there is no
//     triggering differential to write. The offer handler's v1.5 guard (resolve.ts:50-51 / cairnx_ref.py) rejects
//     any name offer with `paidThrough(n) < offer.expiresEpoch` ("the lease must outlive the offer window, so a
//     fill can NEVER hit a lapsed name"), and the fclaim grant requires E <= effExpiry(offer) <= offer.expiresEpoch
//     <= paidThrough. So the hold ends at holdEnd_epoch = E <= paidThrough, strictly before the lease lapses at
//     paidThrough + NAME_GRACE_EPOCHS. A held name-offer therefore NEVER coexists with a lapsed/recapturable name;
//     the freeze predicate in void_open_name_offers can only ever short-circuit on claimTxid===undefined. The
//     freeze is kept as defense-in-depth (harmless, V28-gated, identical in both impls) against a FUTURE relaxation
//     of the v1.5 guard. Neither the buyer-burn nor the recapturer-loss earlier drafts feared is reachable today.

console.log(`\nv28 fclaim crosslang: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
