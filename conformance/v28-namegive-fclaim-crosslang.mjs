// v28-namegive-fclaim-crosslang.mjs: the v2.8 fclaim (§31) NAME-GIVE delivery JS<->Python differential.
//
// Independence note (Plan 70 R2/R3 I1). Every other fclaim crosslang vector sells a TOKEN. The v2.8
// name-give delivery path (an offer whose `give` is a .csd NAME, settled through an fclaim hold + fill)
// had ZERO dedicated cross-impl vector, and the Python oracle's fclaim/name-give block was authored as a
// transliteration of resolve.ts, so a SHARED spec-comprehension bug on that path could ship CI-green.
// This harness closes that gap: the scenario and its ASSERTED OUTCOME are derived from CONVENTION.md, not
// from resolve.ts. The same event set is fed to BOTH the shipping TS resolver and the independent Python
// reference; a divergence is a real consensus bug.
//
// Spec basis for every assertion below (CONVENTION.md, this package):
//   §9 / §15:  "Selling a name: an offer with give:{name}. Anchoring locks the name; a fill transfers
//              ownership to the buyer and pays the seller (+ protocol fee), atomically, in one tx." A name
//              fill marks the record `viaFill` and re-stamps its basis to the fill (displacement-immune).
//   §10 / §19: the trade fill fee is `ceil(FEE_BPS_V16 * want.value)` (1.5%) to the treasury; a whole fill
//              of a resting-liquidity (v1.7 open-ask) CSD offer also pays the maker a rebate in the SAME tx.
//   §17:       a name offer is a no-op unless the lease covers the whole fill window (paidThrough >= expiry).
//   §25 / §27: sealed registration (commit -> payment-free reveal -> winner-only nfinalize) and the young-name
//              sale embargo (REG_COMMIT_MAX_BLOCKS at >= V27): the offer height must clear effHeight+embargo.
//   §31:       fclaim: the claim is a short-expiry Propose (expires_epoch = E), the fill is a SCORE_FILL
//              Attest on the FCLAIM TXID (not the offer id), routed to the linked offer, which then runs the
//              EXISTING §4/§19 whole-fill delivery machinery unchanged. Correction 1: during a live hold an
//              offer-txid fill is rejected. Hold = [grantHeight, holdEnd], holdEnd = (E+1)*EPOCH_LEN - 1.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, canonicalJson, payloadHash, requiredFillOutputs,
        offer, fclaim, nameCommit, nameCommitRecord, nameClaim, nameFinalize, nameRegFee,
        tradeFee, makerRebate, epochOf,
        V28_HEIGHT, V27_HEIGHT, EPOCH_LEN, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS,
        FCLAIM_MAX_EPOCH_AHEAD, FEE_BPS_V16, SCORE_FILL } = R;
const T = R.TREASURY_ADDR;
if (V28_HEIGHT <= 52000) throw new Error(`test misconfig: V28_HEIGHT=${V28_HEIGHT} must sit above live gates`);
if (V28_HEIGHT < V27_HEIGHT) throw new Error(`test misconfig: V28 must be ≥ V27 (embargo era)`);

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const SALT = "a1a1a1a1a1a1a1a1";
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();
const cj = (r) => canonicalJson(r), ph = (r) => payloadHash(r);

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
const both = (n, ev, tip) => { const j = jsCanon(ev, tip), p = pyCanon(ev, tip); const c = j === p; c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}: JS${c ? "≡" : "≠"}Python`); if (!c) { let k = 0; while (k < j.length && k < p.length && j[k] === p[k]) k++; console.log(`    first divergence @${k}`); console.log("    JS:", j.slice(Math.max(0, k - 30), k + 80)); console.log("    PY:", p.slice(Math.max(0, k - 30), k + 80)); } };
// CONVENTION-derived assertion: prove the intended outcome fired (also guards against a vacuous scenario).
const probe = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}: FAILED (scenario did not produce the CONVENTION-derived outcome)`); } };

// ── build a sealed, finalized, sellable name owned by A (CONVENTION §25/§27) ──────────────────────────
//   commit at C (effHeight = C) → payment-free reveal at C+2 → winner-only nfinalize at C+W+2 (past the
//   displacement freeze W = REG_COMMIT_MAX_BLOCKS, within finalizeBy = C+W+G). The offer then anchors past
//   the young-name sale embargo (also W at ≥ V27) and inside the lease window.
const W = REG_COMMIT_MAX_BLOCKS, G = REG_FINALIZE_GRACE_BLOCKS;
const C = V28_HEIGHT;                                   // register at the gate; whole scenario lives ≥ V28
const NAME = "gemname";                                 // 7 chars → not RESERVED, reg-fee tier 6–9 = 0.5 CSD
const commit = PE(nameCommitRecord({ commit: nameCommit(NAME, SALT, A) }), C, A, 9e14, 1, {}, nid());
const reveal = PE(nameClaim({ name: NAME, salt: SALT }), C + 2, A, 9e14, 1, {}, nid());
const finalizeH = C + W + 2;
const REGFEE = nameRegFee(NAME, finalizeH);             // §10 length curve, 4-tier at ≥ V24
const finalize = PE(nameFinalize({ name: NAME, salt: SALT }), finalizeH, A, 9e14, 1, { [T]: String(REGFEE) }, nid());
const regRoots = [commit, reveal, finalize];

const OFF_H = C + W + 3;                                 // > effHeight(C) + saleEmbargo(W) → sellable; > finalizeH
const OFF_EE = epochOf(OFF_H) + 24;                     // fill window; lease (paidThrough) covers it comfortably
const WANT = "1000000000";                              // 10 CSD asking price
const mkNameOffer = (id) => PE(offer({ give: { name: NAME }, want: { value: WANT, payto: A } }), OFF_H, A, OFF_EE, 0, {}, id);

// fclaim + fill timing (§31): grant one block after the offer; E = epochOf(grant)+2 (== the anti-squat cap and
// ≤ the offer's effExpiry), so holdEnd = (E+1)*EPOCH_LEN − 1 is the last L0-minable fill height.
const G_H = OFF_H + 1;
const E = epochOf(G_H) + FCLAIM_MAX_EPOCH_AHEAD;
const holdEnd = (E + 1) * EPOCH_LEN - 1;
const grant = (oid) => PE(fclaim({ offer: oid }), G_H, B, E, 0, {}, nid());
// the whole-fill required outputs, computed by the client preflight helper (payto A sums want+rebate; treasury fee)
const payFor = (oid, events) => Object.fromEntries(requiredFillOutputs(jsState(events, holdEnd + 5).offers[oid], WANT).map((x) => [x.to, String(x.value)]));

console.log(`v28 NAME-GIVE fclaim crosslang (V28=${V28_HEIGHT}, EPOCH_LEN=${EPOCH_LEN}, name="${NAME}", E=${E}, holdEnd=${holdEnd}):`);

// setup sanity: the name is finalized (non-pending), owned by A, NOT viaFill, lease covers the offer window.
{
  const s = jsState(regRoots, OFF_H);
  probe("setup: name finalized, owner A, not-viaFill, lease covers offer",
    s.names[NAME]?.owner === A.toLowerCase() && !s.names[NAME]?.pending && s.names[NAME]?.viaFill === undefined
      && s.names[NAME]?.paidThroughEpoch >= OFF_EE);
  probe("setup: only the reg fee has been paid so far (feesPaid == REGFEE)", s.feesPaid === String(REGFEE));
}

// 1. the headline path: offer gives the NAME, buyer B fclaims + whole-fills -> the name transfers to B.
{
  const oid = nid(), o = mkNameOffer(oid), g = grant(oid);
  const held = jsState([...regRoots, o, g], holdEnd + 5);
  probe("s1 grant: offer is held (claimTxid = fclaim txid, claimedBy B, name locked)",
    held.offers[oid].claimTxid === g.id && held.offers[oid].claimedBy === B.toLowerCase() && held.names[NAME].locked === true);

  const pay = payFor(oid, [...regRoots, o]);
  const ev = [...regRoots, o, g, AE(g.id, B, holdEnd, pay)];
  const s = jsState(ev, holdEnd + 5);
  // CONVENTION §15: the fill transfers ownership to the buyer, re-stamps a displacement-immune viaFill basis,
  // clears the resolver addr, and releases the lock.
  probe("s1 delivered: name owner → B, viaFill, unlocked, addr cleared",
    s.names[NAME].owner === B.toLowerCase() && s.names[NAME].viaFill === true
      && s.names[NAME].locked === false && s.names[NAME].addr === undefined);
  probe("s1 offer filled", s.offers[oid].status === "filled");
  // CONVENTION §10/§19: the fill adds ceil(1.5% × want) to the treasury on top of the reg fee already paid.
  const expectFees = REGFEE + tradeFee(BigInt(WANT), FEE_BPS_V16);
  probe(`s1 feesPaid == REGFEE + tradeFee(want,150) (${expectFees})`, s.feesPaid === String(expectFees));
  both("name-give fclaim whole-fill delivers the name to B", ev, holdEnd + 5);
}

// 2. hold-deadline boundary: a fill AT holdEnd delivers; a fill one block PAST holdEnd is L0-invalid, so the
//     hold has lapsed → no delivery (name stays with A, offer reopens/stays open). Both are byte-identical.
{
  const oid = nid(), o = mkNameOffer(oid), g = grant(oid), pay = payFor(oid, [...regRoots, o]);
  both("fill AT holdEnd delivers the name", [...regRoots, o, g, AE(g.id, B, holdEnd, pay)], holdEnd + 5);
  const past = [...regRoots, o, g, AE(g.id, B, holdEnd + 1, pay)];
  probe("s2 fill PAST holdEnd does NOT deliver (name still A, offer open)",
    jsState(past, holdEnd + 5).names[NAME].owner === A.toLowerCase() && jsState(past, holdEnd + 5).offers[oid].status === "open");
  both("fill PAST holdEnd rejected (hold lapsed)", past, holdEnd + 5);
}

// 3. Correction 1 (§31): during the hold, a fill routed through the OFFER id (not the fclaim txid) is
//     rejected; otherwise the payment would ride the offer's far-off L0 expiry and reopen the delayed-fill
//     burn. The name is NOT delivered; the offer stays open and held.
{
  const oid = nid(), o = mkNameOffer(oid), g = grant(oid), pay = payFor(oid, [...regRoots, o]);
  const ev = [...regRoots, o, g, AE(oid, B, G_H + 5, pay)];   // attest the OFFER id, mid-hold
  const s = jsState(ev, holdEnd + 5);
  probe("s3 offer-txid fill during hold does NOT deliver (name still A, offer open+held)",
    s.names[NAME].owner === A.toLowerCase() && s.offers[oid].status === "open" && s.offers[oid].claimTxid === g.id);
  both("Correction 1: offer-txid name fill during a hold rejected", ev, holdEnd + 5);
}

console.log(`\nv28 name-give fclaim crosslang: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
