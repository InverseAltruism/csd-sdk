// MONEY-SAFETY ANALYSIS PASS — internal audit tool. It REPORTS, it never gates.
//
// The class of bug the operator kept finding by racing two wallets: an honest user pays a fee, the
// base node anchors the fee output (it is a pure data-anchor with only a feerate floor), and the
// off-chain resolver then REJECTS the record. The fee is a real on-chain UTXO to the treasury and is
// never returned. Past audits scored "can an ATTACKER steal?" (no) and missed this. This tool asks the
// right question: "did an honest, correctly-formed record get rejected AFTER its treasury fee was
// already anchored?" — i.e. a silent honest-user burn.
//
// Mechanism (no consensus-code change): the compiled resolver already returns its applied-event log
// (resolve().events = [{height,pos,id,kind,ok,note}], stripped from canonicalState) and every event
// carries paidTo. A burn is EXACTLY a rejected event whose paidTo pays the treasury. We do not
// enumerate record types — the treasury-output test covers every fee-bearing record, including any
// future one. The ~0.25 CSD miner propose fee is separate from paidTo and is NOT counted (it is the
// unavoidable anchor cost of touching the chain at all).
//
// Usage:
//   node conformance/money-safety.mjs             # run the built-in scenario corpus, print the burn table
//   node conformance/money-safety.mjs --selftest  # additionally assert the DETECTOR classifies correctly
//                                                 # (exit 1 only if the tool itself is broken, never because
//                                                 #  a burn exists — a burn is an informational finding)
//   cat seqs.json | node conformance/money-safety.mjs --stdin   # detect over your own sequences
//        seqs.json = {"sequences":[{"label":"...","events":[...],"tipHeight":N}, ...]}
//
// This file imports the compiled dist and modifies nothing.

import {
  resolve, TREASURY_ADDR, DEPLOY_FEE, V11_HEIGHT, V25_HEIGHT, V26_HEIGHT, V27_HEIGHT, V28_HEIGHT, REG_COMMIT_MAX_BLOCKS,
  REG_FINALIZE_GRACE_BLOCKS, NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS, EPOCH_LEN, epochOf,
  nameRegFee, nameClaim, nameCommit, nameCommitRecord, nameFinalize,
  deploy, mint, offer, fclaim, tradeFee, makerRebate, FEE_BPS_V16, SCORE_CLAIM, SCORE_FILL,
} from "../packages/cairnx/dist/index.js";

const T = TREASURY_ADDR;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const csd = (n) => (Number(n) / 1e8).toFixed(2);
// read a paidTo treasury amount with the SAME fail-closed contract the resolver uses (ptAmt): a
// non-canonical value reads as 0 in the resolver, so it also anchors nothing spendable here.
const ptTreas = (pt) => { const v = pt && pt[T]; return (typeof v === "string" && AMOUNT_RE.test(v)) ? BigInt(v) : 0n; };

// ── the detector ──────────────────────────────────────────────────────────────────────────────────
// Given a sequence, return the burns: rejected events that anchored a treasury output. Pure, read-only.
export function findBurns(events, tipHeight) {
  const st = resolve(events, tipHeight);
  const byId = new Map();
  for (const e of events) byId.set(e.kind === "propose" ? e.id : e.txid, e);
  const burns = [];
  for (const l of st.events) {
    if (l.ok) continue;                                  // applied → nothing burned
    const ev = byId.get(l.id);
    if (!ev) continue;
    const actor = ev.proposer || ev.attester || "?";
    if (actor === T) continue;                           // treasury paying itself is a wash, not a burn
    const t = ptTreas(ev.paidTo);                        // the treasury/premium output on this rejected record
    if (t > 0n) burns.push({ height: l.height, kind: l.kind, reason: l.note || "(rejected)", actor, burned: t });
  }
  return burns;
}

// ── scenario corpus (seeded, deterministic; each labelled with what we EXPECT the detector to find) ──
let ID = 1; const nid = () => "0x" + (ID++).toString(16).padStart(64, "0");
const A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20), C = "0x" + "cc".repeat(20);
const prop = (who, rec, h, paidTo = {}, pos = 1) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos, expiresEpoch: 9_000_000_000_000_000, paidTo });
const att = (who, proposalId, h, paidTo = {}, score = 100, pos = 1) => ({ kind: "attest", txid: nid(), proposalId, attester: who, score, confidence: 0, height: h, pos, paidTo });
// a valid sealed commit→reveal pair; fee=null means the payment-free V25 reveal
const commitReveal = (name, salt, owner, hCommit, hReveal, fee) => [
  prop(owner, nameCommitRecord({ commit: nameCommit(name, salt, owner) }), hCommit),
  prop(owner, nameClaim({ name, salt }), hReveal, fee ? { [T]: fee } : {}),
];

function corpus() {
  const out = [];
  const push = (label, expect, events, tipHeight, note) => out.push({ label, expect, events, tipHeight, note });

  // 1. REGISTER RACE, pre-V25 (reachable at any tip < 51000). A registers "test" and wins; B reveals the
  //    same name two blocks later, paying the full reg fee, and is rejected "name taken" → B burns 6.7 CSD.
  //    This is the W2 "test" @h44662 incident, reproduced. Closed for registrations at height ≥ V25.
  {
    const fee = nameRegFee("test", 44660).toString();
    push("register-race pre-V25 (loser pays reg fee)", "burn", [
      prop(A, nameClaim({ name: "test" }), 44660, { [T]: fee }),
      prop(B, nameClaim({ name: "test" }), 44662, { [T]: fee }),
    ], 44700, "W2 'test' @h44662 incident; reachable until tip crosses V25=" + V25_HEIGHT);
  }

  // 2. REGISTER RACE, post-V25 sealed reservation. Both parties commit→reveal PAYMENT-FREE; the loser's
  //    reveal is rejected but anchored NO treasury output → no burn. Demonstrates the V25 fix closes it.
  {
    const h = V25_HEIGHT + 500;
    push("register-race post-V25 (sealed, payment-free reveal)", "clean", [
      ...commitReveal("swap", "a".repeat(32), A, h, h + 2, null),      // A commits earlier → wins
      ...commitReveal("swap", "b".repeat(32), B, h + 1, h + 3, null),  // B loses, pays nothing
    ], h + 10, "the sealed-reservation fix: a losing reveal costs only the ~0.25 anchor");
  }

  // 3. LEGACY FEE-BEARING REVEAL crossing the V25 gate (the hard-adoption-gate risk). An un-upgraded
  //    wallet sends the old pay-now register (no salt, fee attached) at height ≥ V25 → rejected
  //    "v2.5: registration requires a commit-reveal" while the fee is already anchored → burn. This is
  //    why the wallet must ship BEFORE the gate flips; the tool makes the risk concrete.
  {
    const h = V25_HEIGHT + 500;
    push("legacy fee-reveal crossing V25 (un-upgraded wallet)", "burn", [
      prop(A, nameClaim({ name: "abcd" }), h, { [T]: nameRegFee("abcd", h).toString() }),
    ], h + 5, "mitigation is process (ship wallet first), not code — surfaced so it is not forgotten");
  }

  // 3b. V27 YOUNG-NAME SALE. A name registered under the sealed model is finalized, then LISTED and SOLD
  //     ~16 min after finalize (age within the new REG_COMMIT_MAX_BLOCKS embargo but under the old 240).
  //     The point: the V27 relaxation introduces NO new burn; the finalized name is displacement-immune
  //     (freeze-window arithmetic), so the buyer's fill delivers the name and NOTHING is stranded. The
  //     offer itself pays no treasury fee; the fill pays the seller + the trade fee correctly.
  {
    const W = REG_COMMIT_MAX_BLOCKS, base = V27_HEIGHT + 100;
    const cH = base, rH = base + 2, fH = base + W + 2;          // commit / payment-free reveal / finalize
    const salt = "e".repeat(32);
    const off = offer({ give: { name: "flip" }, want: { value: "100000000" }, taker: B });
    const offEv = prop(A, off, fH + 3, {});                    // list at fH+3 (age = W+5 > W, still << 240); >= V27
    const fee = tradeFee(100000000n, FEE_BPS_V16).toString();
    const fill = att(B, offEv.id, fH + 5, { [A]: "100000000", [T]: fee });  // B pays seller A + trade fee → delivers
    push("V27 young-name sale (sealed reg → finalize → sell ~16min later → fill)", "clean", [
      prop(A, nameCommitRecord({ commit: nameCommit("flip", salt, A) }), cH),
      prop(A, nameClaim({ name: "flip", salt }), rH),                        // payment-free sealed reveal
      prop(A, nameFinalize({ name: "flip", salt }), fH, { [T]: nameRegFee("flip", fH).toString() }),
      offEv, fill,
    ], fH + 20, "V27 relaxation adds no burn: a finalized name is displacement-immune, the sale delivers");
  }

  // ── THE LOSER'S FOLLOW-ON FEE-BEARING TX (deep-review 2026-07-03 §5) ──────────────────────────────────
  // The root cause of the misses: prior V25/V26 fixtures STOP at the payment-free reveal ("the loser's
  // reveal is rejected but costs no fee") and never construct the loser's follow-on nfinalize / fill, which
  // is where the fee actually rides. These scenarios build that follow-on so `findBurns` re-surfaces the
  // C1/C2/C4/C5 classes forever. (The client-side cure is the Tier 0 sign-time re-check / previewFill /
  // live-claim gate; these fixtures prove the burn EXISTS if a client skips it.)

  // C1. REGISTER-RACE displaced nfinalize (operator edge case #1). A commits earlier (pos 0) → wins the
  //     reservation; B commits+reveals later → displaced (payment-FREE, no burn); then B ALSO finalizes,
  //     paying the reg fee → owner=A ≠ B → rejected "no matching pending reservation you own" → B burns it.
  {
    const h = V25_HEIGHT + 500, saltA = "a".repeat(32), saltB = "b".repeat(32), fH = h + REG_COMMIT_MAX_BLOCKS + 2;
    push("C1 register-race displaced nfinalize (loser's finalize burns the reg fee)", "burn", [
      { ...prop(A, nameCommitRecord({ commit: nameCommit("gm", saltA, A) }), h), pos: 0 },
      { ...prop(B, nameCommitRecord({ commit: nameCommit("gm", saltB, B) }), h), pos: 1 },
      { ...prop(A, nameClaim({ name: "gm", salt: saltA }), h + 2), pos: 0 },   // A reveals → pending winner
      { ...prop(B, nameClaim({ name: "gm", salt: saltB }), h + 2), pos: 1 },   // B reveals → displaced, payment-free
      prop(A, nameFinalize({ name: "gm", salt: saltA }), fH, { [T]: nameRegFee("gm", fH).toString() }),       // A owns
      prop(B, nameFinalize({ name: "gm", salt: saltB }), fH + 1, { [T]: nameRegFee("gm", fH + 1).toString() }), // B → BURN
    ], fH + 40, "cure: sign-time winner re-fetch on registration-finalize (previewFill/finalizeWinnerCheck)");
  }

  // C5. nfinalize confirming OUTSIDE the (effHeight+8, effHeight+28] window. The reservation auto-expires
  //     (sweepExpired), the name reopens, and a finalize one block late is rejected AFTER its fee anchored.
  {
    const h = V25_HEIGHT + 700, salt = "c".repeat(32);
    const finalizeBy = h + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS;
    push("C5 late nfinalize (past finalizeBy → swept → fee burned)", "burn", [
      prop(A, nameCommitRecord({ commit: nameCommit("late", salt, A) }), h),
      prop(A, nameClaim({ name: "late", salt }), h + 2),                                                  // payment-free reveal
      prop(A, nameFinalize({ name: "late", salt }), finalizeBy + 1, { [T]: nameRegFee("late", finalizeBy + 1).toString() }),
    ], finalizeBy + 10, "irreducible timing residual — a client refuses to sign without runway before finalizeBy");
  }

  // C2. Non-claimant OPEN-CSD name fill (operator edge case #2). An open (untaken) CSD name offer uses
  //     claim-to-fill: B claims (wins), C fills WITHOUT a live claim → rejected "claim it first" AFTER the
  //     treasury fee anchored → C burns it (and the seller payment is a separate payment-without-delivery).
  {
    const H = V27_HEIGHT + 200, salt = "d".repeat(32), cH = H, rH = H + 2, fH = H + REG_COMMIT_MAX_BLOCKS + 2;
    const listH = fH + 300, exp = epochOf(listH) + 50, val = 100000000n, fee = tradeFee(val, FEE_BPS_V16), reb = makerRebate(val);
    const offEv = { ...prop(A, offer({ give: { name: "alicexyz" }, want: { value: val.toString() } }), listH, {}), expiresEpoch: exp };
    push("C2 non-claimant open-CSD fill (full payment lost by a non-claimer)", "burn", [
      prop(A, nameCommitRecord({ commit: nameCommit("alicexyz", salt, A) }), cH),
      prop(A, nameClaim({ name: "alicexyz", salt }), rH),
      prop(A, nameFinalize({ name: "alicexyz", salt }), fH, { [T]: nameRegFee("alicexyz", fH).toString() }),
      offEv,
      att(B, offEv.id, listH + 5, {}, SCORE_CLAIM, 0),                                          // B claims → wins
      att(C, offEv.id, listH + 6, { [A]: (val + reb).toString(), [T]: fee.toString() }, SCORE_FILL, 1), // C fills → BURN
    ], listH + 20, "cure: wallet/SDK open-CSD fill gated on a live buried claim (fillIsSafe/hasLiveClaim)");
  }

  // C4. SAME-BLOCK claim+fill race loser. Two buyers each bundle claim+fill in one block; B's claim wins by
  //     pos, so C's fill lands into an already-filled offer → rejected → C's anchored treasury fee burns.
  {
    const H = V27_HEIGHT + 400, salt = "e".repeat(32), cH = H, rH = H + 2, fH = H + REG_COMMIT_MAX_BLOCKS + 2;
    const listH = fH + 300, exp = epochOf(listH) + 50, bh = listH + 5, val = 100000000n, fee = tradeFee(val, FEE_BPS_V16), reb = makerRebate(val);
    const offEv = { ...prop(A, offer({ give: { name: "racey" }, want: { value: val.toString() } }), listH, {}), expiresEpoch: exp };
    const pay = { [A]: (val + reb).toString(), [T]: fee.toString() };
    push("C4 same-block claim+fill loser (loser's bundled fill burns)", "burn", [
      prop(A, nameCommitRecord({ commit: nameCommit("racey", salt, A) }), cH),
      prop(A, nameClaim({ name: "racey", salt }), rH),
      prop(A, nameFinalize({ name: "racey", salt }), fH, { [T]: nameRegFee("racey", fH).toString() }),
      offEv,
      att(B, offEv.id, bh, {}, SCORE_CLAIM, 0),
      att(C, offEv.id, bh, {}, SCORE_CLAIM, 1),
      att(B, offEv.id, bh, pay, SCORE_FILL, 2),   // B won the claim → fill applies
      att(C, offEv.id, bh, pay, SCORE_FILL, 3),   // C's fill → offer already filled → BURN
    ], bh + 20, "cure: never bundle claim+fill in one block; require a confirmation between them");
  }

  // C3. PARTIAL-FILL zero-delivery trap (maker-craftable, operator edge case #4). A partial offer with a
  //     tiny give and huge want: any partial payment floors to 0 tokens (floor(give*pay/want)=0) and is
  //     rejected AFTER the CSD moved. Taker-bound here so the fill reaches the delivery math (not the claim
  //     gate). The website already refuses (got===0n); this proves off-website clients burn without the guard.
  {
    const h0 = V27_HEIGHT + 600;
    const off = offer({ give: { ticker: "RARE", amount: "1" }, want: { value: "100000000000" }, min: "100000000", taker: B }); // 1000 CSD, min 1
    const offEv = prop(A, off, h0 + 2, {});
    const fee = tradeFee(50000000000n, FEE_BPS_V16); // fee on the clamped 500 CSD payment
    push("C3 partial zero-delivery trap (taker pays, receives 0 tokens)", "burn", [
      prop(A, deploy({ ticker: "RARE", decimals: 0, supply: "1", mint: "issuer" }), h0, { [T]: DEPLOY_FEE.toString() }),
      prop(A, mint({ ticker: "RARE", amount: "1" }), h0 + 1),
      offEv,
      att(B, offEv.id, h0 + 4, { [A]: "50000000000", [T]: fee.toString() }),   // pay 500 CSD → 0 tokens → BURN
    ], h0 + 40, "cure: lift the website got===0 refuse into the shared previewFill gate in every fill builder");
  }

  // 4. DEPLOY-TAKEN race. Two deploys of the same ticker; the loser is rejected "ticker taken" but paid
  //    the 1 CSD deploy fee → burn. Deploy has no commit-reveal, so a same-block race is reachable.
  {
    const rec = deploy({ ticker: "GOLD", decimals: 0, supply: "1000000", mint: "issuer" });
    push("deploy-taken race (loser pays deploy fee)", "burn", [
      { ...prop(A, rec, 40000, { [T]: DEPLOY_FEE.toString() }), pos: 0 },
      { ...prop(B, rec, 40000, { [T]: DEPLOY_FEE.toString() }), pos: 1 },
    ], 40040, "same-block deploy race; loser burns the 1 CSD deploy fee");
  }

  // 5. DOUBLE-FILL. An offer is filled twice; the second fill pays the treasury fee (and the seller) but
  //    the offer is already filled → rejected → the treasury fee is burned (and the seller payment, which
  //    the race harness flags as payment-without-delivery). Payment-anchored-then-rejected.
  {
    const h0 = 40000;
    const dep = deploy({ ticker: "PAY", decimals: 0, supply: "1000000", mint: "issuer" });
    const depEv = prop(A, dep, h0, { [T]: DEPLOY_FEE.toString() });
    const mintEv = prop(A, mint({ ticker: "PAY", amount: "1000000" }), h0 + 1);
    const off = offer({ give: { ticker: "PAY", amount: "10" }, want: { value: "100000000" }, taker: B });
    const offEv = prop(A, off, h0 + 2, {});
    const fee = tradeFee(100000000n, FEE_BPS_V16).toString(); // 1.5% at h ≥ V16
    const pay = { [A]: "100000000", [T]: fee };
    const fill1 = att(B, offEv.id, h0 + 4, pay);            // correctly priced → fills the offer
    const fill2 = att(B, offEv.id, h0 + 6, pay);            // second fill → offer already filled → treasury fee burned
    push("double-fill (second fill pays into a filled offer)", "burn",
      [depEv, mintEv, offEv, fill1, fill2], h0 + 40, "buyer's second payment is anchored then rejected");
  }

  // 6. CLEAN register win (false-positive check): a single winning registration must report NO burn.
  {
    const fee = nameRegFee("alice", 40000).toString();
    push("clean single register (no race)", "clean",
      [prop(A, nameClaim({ name: "alice" }), 40000, { [T]: fee })], 40040, "guarded happy path — must be silent");
  }

  // 7. CLEAN happy fill: deploy→mint→offer→fill, correctly priced → no burn.
  {
    const h0 = 40000;
    const dep = deploy({ ticker: "TKN", decimals: 0, supply: "1000000", mint: "issuer" });
    const off = offer({ give: { ticker: "TKN", amount: "10" }, want: { value: "100000000" }, taker: B });
    const depEv = prop(A, dep, h0, { [T]: DEPLOY_FEE.toString() });
    const mintEv = prop(A, mint({ ticker: "TKN", amount: "1000000" }), h0 + 1);
    const offEv = prop(A, off, h0 + 2, {});
    const fillEv = att(B, offEv.id, h0 + 4, { [A]: "100000000", [T]: tradeFee(100000000n, FEE_BPS_V16).toString() });
    push("clean happy fill (deploy→mint→offer→fill)", "clean",
      [depEv, mintEv, offEv, fillEv], h0 + 40, "guarded happy path — must be silent");
  }

  // 8. v2.8 FCLAIM lane (§31). The honest open-lane fclaim buy is CLEAN; a denied-fclaim fill and an
  //    offer-txid fill during a live hold are BURNS the detector must surface (the client-side grant replay
  //    and the Correction-1 target guard, B4/B5, are what PREVENT building them). These assert the detector
  //    classifies the v2.8 routing correctly, so `audit:all --selftest` FAILS if a future change reopens the
  //    honest lane as a burn or lets a denied-fclaim fill deliver.
  {
    const h0 = V28_HEIGHT + 100;
    const depEv = prop(A, deploy({ ticker: "FCL", decimals: 0, supply: "1000000", mint: "issuer" }), h0, { [T]: DEPLOY_FEE.toString() });
    const mintEv = prop(A, mint({ ticker: "FCL", amount: "1000000" }), h0 + 1);
    const offEv = prop(A, offer({ give: { ticker: "FCL", amount: "10" }, want: { value: "100000000", payto: A } }), h0 + 2);
    const E = epochOf(h0 + 3) + 1;
    const val = 100000000n, fee = tradeFee(val, FEE_BPS_V16), reb = makerRebate(val);
    const pay = { [A]: (val + reb).toString(), [T]: fee.toString() };

    const grant = { ...prop(B, fclaim({ offer: offEv.id }), h0 + 3), expiresEpoch: E };
    push("v2.8 clean fclaim fill (grant then fclaim-txid fill delivers)", "clean",
      [depEv, mintEv, offEv, grant, att(B, grant.id, h0 + 5, pay)], h0 + 60, "the honest open-lane fclaim buy (must be silent)");

    const grant2 = { ...prop(B, fclaim({ offer: offEv.id }), h0 + 3), expiresEpoch: E };
    push("v2.8 offer-txid fill during a hold (Correction 1 rejects, buyer would burn)", "burn",
      [depEv, mintEv, offEv, grant2, att(B, offEv.id, h0 + 5, pay)], h0 + 60, "a client that ignored fillTargetId: Correction 1 rejects the offer-txid fill after it paid");

    const denied = { ...prop(C, fclaim({ offer: nid() }), h0 + 3), expiresEpoch: E };
    push("v2.8 denied-fclaim fill (pay-without-delivery burn)", "burn",
      [depEv, mintEv, offEv, denied, att(C, denied.id, h0 + 5, { [A]: val.toString(), [T]: fee.toString() })], h0 + 60, "a client that skipped grant replay: the denied fclaim mines and the payment burns");
  }

  return out;
}

// ── structural note on recapture (finding #1 from the go-live race audit) ────────────────────────────
// The recapture-premium burn (a lost lapsed-name reclaim burning up to ~300 CSD) was real pre-V26. With
// V26 staged at height 51200 it is now STRUCTURALLY unreachable: a lease can only lapse term+grace after
// its earliest possible registration (V11), which is far above V26. Report the arithmetic so the closure
// is auditable rather than assumed.
function recaptureClosureNote() {
  const minLapse = V11_HEIGHT + (NAME_TERM_EPOCHS + NAME_GRACE_EPOCHS) * EPOCH_LEN;
  const closed = minLapse > V26_HEIGHT;
  return { minLapse, V26_HEIGHT, closed };
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────
function reportOne(label, note, burns) {
  if (burns.length === 0) { console.log(`  ✓ ${label} — no burn`); return; }
  const total = burns.reduce((s, b) => s + b.burned, 0n);
  console.log(`  ✗ ${label} — ${burns.length} burn(s), ${csd(total)} CSD total${note ? `  (${note})` : ""}`);
  for (const b of burns.sort((x, y) => (y.burned > x.burned ? 1 : -1))) {
    console.log(`      h${b.height} ${b.kind}  ${csd(b.burned)} CSD  by ${b.actor.slice(0, 8)}  — "${b.reason}"`);
  }
}

function runCorpus(selftest) {
  console.log("MONEY-SAFETY ANALYSIS PASS (report-only; a burn is a finding, not a build failure)\n");
  const rc = recaptureClosureNote();
  console.log(`recapture-premium burn: ${rc.closed ? "CLOSED" : "OPEN"} — earliest possible lapse height ${rc.minLapse} vs V26=${rc.V26_HEIGHT}\n`);

  const scen = corpus();
  let misclassified = 0, totalBurnScenarios = 0, totalBurned = 0n;
  for (const s of scen) {
    const burns = findBurns(s.events, s.tipHeight);
    reportOne(s.label, s.note, burns);
    const got = burns.length > 0 ? "burn" : "clean";
    if (burns.length) { totalBurnScenarios++; totalBurned += burns.reduce((a, b) => a + b.burned, 0n); }
    if (got !== s.expect) { misclassified++; console.log(`      ⚠ DETECTOR MISCLASSIFIED: expected ${s.expect}, got ${got}`); }
  }
  console.log(`\n${scen.length} scenarios · ${totalBurnScenarios} with burns · ${csd(totalBurned)} CSD total burn surface in the corpus`);

  if (selftest) {
    if (misclassified) { console.error(`\n✗ SELFTEST FAILED: the detector misclassified ${misclassified} scenario(s) — the tool is broken.`); process.exit(1); }
    console.log("\n✓ SELFTEST: the detector re-surfaced every known burn and stayed silent on every guarded flow.");
  }
  process.exit(0);
}

function runStdin() {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const { sequences } = JSON.parse(chunks.join(""));
    console.log("MONEY-SAFETY (stdin sequences; report-only)\n");
    let n = 0;
    for (const s of sequences) { const burns = findBurns(s.events, s.tipHeight); reportOne(s.label || `seq#${n}`, undefined, burns); n++; }
    process.exit(0);
  });
}

// only run the CLI when invoked directly (not when findBurns is imported by race-harness.mjs)
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes("--stdin")) runStdin();
  else runCorpus(argv.includes("--selftest"));
}
