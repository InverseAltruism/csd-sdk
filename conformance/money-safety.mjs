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
  resolve, TREASURY_ADDR, DEPLOY_FEE, V11_HEIGHT, V25_HEIGHT, V26_HEIGHT, V27_HEIGHT, REG_COMMIT_MAX_BLOCKS,
  NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS, EPOCH_LEN,
  nameRegFee, nameClaim, nameCommit, nameCommitRecord, nameFinalize,
  deploy, mint, offer, tradeFee, FEE_BPS_V16,
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
