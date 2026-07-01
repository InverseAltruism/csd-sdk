// ADVERSARIAL RACE HARNESS — internal audit tool. It REPORTS, it never gates.
//
// This automates how the operator actually finds bugs: open several wallets, act in the same and
// adjacent blocks, and watch who loses money. It models N actors including at least one ADVERSARIAL
// actor (name-blind pre-commit, back-dated displacement reveal, cancel-snipe, same-block front-run) on
// a shared name/token set, generates thousands of seeded race scenarios, and after resolving each one
// checks the money-safety properties and REPORTS every violation with a reproducible seed. It also
// re-runs the generated (adversarial) sequences through the independent Python resolver so an
// adversarial race can never hide a JS⇄Python fork the honest fuzz missed.
//
// Properties checked per scenario (all reported, none throw a gate):
//   P1 treasury-burn            a rejected record anchored a treasury/premium fee (findBurns)
//   P2 displacement-burn        a paying registrant was displaced by a back-dated reveal (fee lost)
//   P3 payment-without-delivery a rejected fill still paid the seller (buyer paid, got nothing)
//   P4 byte-identity            JS canonicalState == Python canonicalState (consensus determinism)
//
// Usage:
//   node conformance/race-harness.mjs [N] [seed]     # generate N scenarios (default 4000), report + diff
//   node conformance/race-harness.mjs --fixtures     # run only the seeded known-incident fixtures
//
// Imports the compiled dist; modifies nothing.

import { spawnSync } from "node:child_process";
import {
  resolve, canonicalState, TREASURY_ADDR, DEPLOY_FEE, V16_HEIGHT, V25_HEIGHT, V26_HEIGHT, COMMIT_MAX_BLOCKS,
  nameRegFee, nameClaim, nameCommit, nameCommitRecord, nameXfer,
  deploy, mint, offer, offerCancelAll, tradeFee, FEE_BPS_V16,
} from "../packages/cairnx/dist/index.js";
import { findBurns } from "./money-safety.mjs";

const T = TREASURY_ADDR;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const csd = (n) => (Number(n) / 1e8).toFixed(2);

const N = Number(process.argv[2] || 4000);
let SEED = Number(process.argv[3] || 0) >>> 0;
if (!Number.isFinite(SEED) || SEED === 0) SEED = (0xC0FFEE ^ (N * 2654435761 >>> 0)) >>> 0;
const SEED0 = SEED >>> 0; // the INITIAL seed (SEED is mutated by rng during generation); use this to reproduce
const rng = () => { SEED = (SEED * 1664525 + 1013904223) >>> 0; return SEED / 0x100000000; };
const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (a) => a[ri(0, a.length - 1)];
const chance = (p) => rng() < p;

let ID = 1; const nid = () => "0x" + (ID++).toString(16).padStart(64, "0");
const hexSalt = (n = 32) => Array.from({ length: n }, () => "0123456789abcdef"[ri(0, 15)]).join("");
const ACTORS = { A: "0x" + "a1".repeat(20), B: "0x" + "b2".repeat(20), C: "0x" + "c3".repeat(20), ADV: "0x" + "de".repeat(20) };
const prop = (who, rec, h, paidTo = {}, pos = 1) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos, expiresEpoch: 9_000_000_000_000_000, paidTo });
const att = (who, proposalId, h, paidTo = {}, score = 100, pos = 1) => ({ kind: "attest", txid: nid(), proposalId, attester: who, score, confidence: 0, height: h, pos, paidTo });

// ── additional money-safety detectors (findBurns handles P1) ────────────────────────────────────────

// P2: a back-dated reveal displaced a prior holder who had PAID a registration fee. The displacer's log
// entry is noted "displaced prior holder"; the displaced party's earlier register applied (ok:true) but
// they no longer hold the name → their fee is burned. (A `pending` reservation carries no fee, so a
// post-V25 "displaced prior reservation" is NOT a burn — this is exactly the V25 fix.)
export function findDisplacementBurns(events, tipHeight) {
  const st = resolve(events, tipHeight);
  const byId = new Map(events.map((e) => [e.kind === "propose" ? e.id : e.txid, e]));
  const out = [];
  for (const l of st.events) {
    if (!l.ok || l.note !== "displaced prior holder") continue;   // only a fee-bearing register can be so noted
    const ev = byId.get(l.id);
    out.push({ height: l.height, displacer: ev?.proposer, note: l.note });
  }
  return out;
}

// P3: a rejected attest (fill) that still paid a non-treasury address = the buyer paid the seller and
// received nothing. The treasury-fee portion is already covered by P1; here we surface the seller loss.
export function findPaymentWithoutDelivery(events, tipHeight) {
  const st = resolve(events, tipHeight);
  const byId = new Map(events.map((e) => [e.kind === "propose" ? e.id : e.txid, e]));
  const out = [];
  for (const l of st.events) {
    if (l.ok || l.kind !== "fill") continue;
    const ev = byId.get(l.id);
    if (!ev) continue;
    for (const [addr, v] of Object.entries(ev.paidTo || {})) {
      if (addr === T || !(typeof v === "string" && AMOUNT_RE.test(v)) || BigInt(v) === 0n) continue;
      out.push({ height: l.height, payer: ev.attester, paidTo: addr, amount: BigInt(v), reason: l.note || "(rejected fill)" });
    }
  }
  return out;
}

// ── scenario generators (each returns {label, events, tipHeight, cls}) ────────────────────────────────

// two actors race to register the same name. GATE-AWARE: below V25 both send the pay-now register, so the
// loser burns the reg fee (the bug). At/above V25 both use the sealed flow (commit → PAYMENT-FREE reveal),
// so the loser's reveal is rejected but costs no fee — the harness shows the V25 fix working, not noise.
function registerRace(h) {
  const nm = "rc" + ri(100, 9999);
  const [x, y] = chance(0.5) ? [ACTORS.A, ACTORS.B] : [ACTORS.B, ACTORS.A];
  if (h >= V25_HEIGHT) {
    const sx = hexSalt(32), sy = hexSalt(32);
    return { label: `register-race@${h} (sealed)`, cls: "register-race", tipHeight: h + 30, events: [
      prop(x, nameCommitRecord({ commit: nameCommit(nm, sx, x) }), h),
      prop(y, nameCommitRecord({ commit: nameCommit(nm, sy, y) }), h + 1),
      prop(x, nameClaim({ name: nm, salt: sx }), h + 3),    // payment-free reveal
      prop(y, nameClaim({ name: nm, salt: sy }), h + 4),    // loser — rejected, no fee
    ] };
  }
  const fee = nameRegFee(nm, h).toString();
  return { label: `register-race@${h}`, cls: "register-race", tipHeight: h + 20, events: [
    prop(x, nameClaim({ name: nm }), h, { [T]: fee }, 0),
    prop(y, nameClaim({ name: nm }), h + ri(0, 3), { [T]: fee }, 1),
  ] };
}

// ADVERSARIAL: Adv name-blind pre-commits; an honest victim registers and (momentarily) owns; Adv reveals
// the salt within the window, back-dating below the victim → displaces them. GATE-AWARE: pre-V25 the victim
// paid the reg fee and loses the name (P2 displacement burn); at/above V25 the victim only holds a
// payment-free reservation, so the displacement costs them nothing — again showing the fix, not noise.
function blindCommitDisplace(h) {
  const nm = "bd" + ri(100, 9999);
  const advSalt = hexSalt(ri(16, 40));
  const commitEv = prop(ACTORS.ADV, nameCommitRecord({ commit: nameCommit(nm, advSalt, ACTORS.ADV) }), h);
  if (h >= V25_HEIGHT) {
    const vicSalt = hexSalt(32);
    return { label: `blind-commit-displace@${h} (sealed)`, cls: "displacement", tipHeight: h + 60, events: [
      commitEv,
      prop(ACTORS.A, nameCommitRecord({ commit: nameCommit(nm, vicSalt, ACTORS.A) }), h + 1),
      prop(ACTORS.A, nameClaim({ name: nm, salt: vicSalt }), h + 3),    // victim reserves (payment-free)
      prop(ACTORS.ADV, nameClaim({ name: nm, salt: advSalt }), h + 5),  // back-dated reserve displaces — no fee lost
    ] };
  }
  const fee = nameRegFee(nm, h).toString();
  return { label: `blind-commit-displace@${h}`, cls: "displacement", tipHeight: h + 60, events: [
    commitEv,
    prop(ACTORS.A, nameClaim({ name: nm }), h + ri(1, 5), { [T]: fee }),          // honest direct register
    prop(ACTORS.ADV, nameClaim({ name: nm, salt: advSalt }), h + ri(6, 30), { [T]: fee }), // back-dates to commit h
  ] };
}

// the hard-adoption-gate risk, surfaced as its OWN class so it is not smeared across every generator: an
// un-upgraded wallet sends the old pay-now register (no salt + fee) at a height ≥ V25 → rejected
// "requires commit-reveal", fee already anchored → burn. Mitigation is process (ship the wallet first).
function staleWalletCrossesGate(h) {
  const hh = h >= V25_HEIGHT ? h : ri(V25_HEIGHT + 50, V26_HEIGHT + 8000);
  const nm = "sw" + ri(100, 9999);
  return { label: `stale-wallet-crosses-gate@${hh}`, cls: "stale-wallet-gate", tipHeight: hh + 10,
    events: [prop(ACTORS.A, nameClaim({ name: nm }), hh, { [T]: nameRegFee(nm, hh).toString() })] };
}

// a TAKER-BOUND offer whose primary fill succeeds, plus adversarial stranding: a non-taker competing fill
// and/or a post-settle double-fill (both anchor a payment then get rejected → payment-without-delivery),
// and a same-block cancel-snipe (fill-before-cancel must keep the primary fill from being stranded).
function offerFillRace(h) {
  const tk = "OF" + ri(10, 99);
  const val = "100000000";
  const dep = prop(ACTORS.A, deploy({ ticker: tk, decimals: 0, supply: "1000000", mint: "issuer" }), h, { [T]: DEPLOY_FEE.toString() });
  const mnt = prop(ACTORS.A, mint({ ticker: tk, amount: "1000000" }), h + 1);
  const off = prop(ACTORS.A, offer({ give: { ticker: tk, amount: "10" }, want: { value: val }, taker: ACTORS.B }), h + 2, {});
  const fee = tradeFee(BigInt(val), h + 2 >= V16_HEIGHT ? FEE_BPS_V16 : 100).toString();
  const pay = { [ACTORS.A]: val, [T]: fee };                       // correctly-priced taker-bound fill (no open-ask rebate)
  const ev = [dep, mnt, off, att(ACTORS.B, off.id, h + 4, pay, 100, 1)]; // primary fill SUCCEEDS
  if (chance(0.5)) ev.push(att(ACTORS.C, off.id, h + 4, pay, 100, 2));   // non-taker competing fill → rejected, C's payment stranded
  if (chance(0.5)) ev.push(prop(ACTORS.A, offerCancelAll({ ticker: tk }), h + 4, {}, 0)); // same-block cancel-snipe (must not strand the fill)
  if (chance(0.4)) ev.push(att(ACTORS.B, off.id, h + 6, pay));           // double-fill after settle → rejected, stranded
  return { label: `offer-fill-race@${h}`, cls: "offer-fill", tipHeight: h + 40, events: ev };
}

// list a name (offer with a name give → name locked) then try to nxfer/nset it while locked. The writes
// are rejected; they carry only the ~0.25 anchor (no treasury output), so this is a stuck/false-confirm
// signal rather than a treasury burn — included so the harness covers the class, and to confirm the name
// is never left stuck (still owned, unlockable).
function listThenTransfer(_h) {
  const h = ri(34000, V25_HEIGHT - 500);   // simple pay-now ownership below the gate (this class is gate-independent)
  const nm = "lt" + ri(100, 9999);
  const fee = nameRegFee(nm, h).toString();
  const reg = prop(ACTORS.A, nameClaim({ name: nm }), h, { [T]: fee });
  const list = prop(ACTORS.A, offer({ give: { name: nm }, want: { value: "100000000" } }), h + COMMIT_MAX_BLOCKS + 5, {});
  const xfer = prop(ACTORS.A, nameXfer({ name: nm, to: ACTORS.C }), h + COMMIT_MAX_BLOCKS + 7);
  return { label: `list-then-transfer@${h}`, cls: "list-transfer", tipHeight: h + COMMIT_MAX_BLOCKS + 40, events: [reg, list, xfer] };
}

const GENS = [registerRace, blindCommitDisplace, offerFillRace, listThenTransfer, staleWalletCrossesGate];
// height bands: below V25 (burns reachable), above V25/V26 (sealed — should be closed)
const bands = () => chance(0.55) ? ri(34000, V25_HEIGHT - 50) : ri(V26_HEIGHT + 50, V26_HEIGHT + 8000);

// ── check one scenario, return {violations[], jsState} ────────────────────────────────────────────────
function check(s) {
  const v = [];
  for (const b of findBurns(s.events, s.tipHeight)) v.push({ p: "P1 treasury-burn", amount: b.burned, detail: `${b.kind} "${b.reason}" by ${b.actor.slice(0, 8)}` });
  for (const d of findDisplacementBurns(s.events, s.tipHeight)) v.push({ p: "P2 displacement-burn", amount: 0n, detail: `back-dated reveal displaced a paying registrant (displacer ${String(d.displacer).slice(0, 8)})` });
  for (const w of findPaymentWithoutDelivery(s.events, s.tipHeight)) v.push({ p: "P3 payment-without-delivery", amount: w.amount, detail: `${csd(w.amount)} CSD to ${w.paidTo.slice(0, 8)} on rejected fill "${w.reason}"` });
  return v;
}

// ── seeded known-incident fixtures (a regression signal we consult; never a gate) ────────────────────
function fixtures() {
  const out = [];
  // the W2 "test" register-race burn @h44662
  { const fee = nameRegFee("test", 44660).toString();
    out.push({ label: "FIXTURE register-race (W2 'test' 6.7 CSD @h44662)", cls: "register-race", tipHeight: 44700,
      events: [prop(ACTORS.A, nameClaim({ name: "test" }), 44660, { [T]: fee }), prop(ACTORS.B, nameClaim({ name: "test" }), 44662, { [T]: fee })] }); }
  // blind-commit displacement burn below V25
  { out.push(blindCommitDisplace(44000)); out[out.length - 1].label = "FIXTURE blind-commit displacement (pre-V25)"; }
  // the SAME displacement above V25 must be a payment-free reservation displacement (no burn)
  { const nm = "sealedbd", advSalt = "de".repeat(16), vicSalt = "a1".repeat(16), h = V25_HEIGHT + 500;
    out.push({ label: "FIXTURE blind-commit displacement (post-V25, sealed → no burn)", cls: "displacement", tipHeight: h + 60, events: [
      prop(ACTORS.ADV, nameCommitRecord({ commit: nameCommit(nm, advSalt, ACTORS.ADV) }), h),
      prop(ACTORS.A, nameCommitRecord({ commit: nameCommit(nm, vicSalt, ACTORS.A) }), h + 1),
      prop(ACTORS.A, nameClaim({ name: nm, salt: vicSalt }), h + 3),          // victim reserves (payment-free)
      prop(ACTORS.ADV, nameClaim({ name: nm, salt: advSalt }), h + 5),        // adv back-dated reserve displaces — no fee lost
    ] }); }
  // double-fill payment-without-delivery
  { const h0 = 40000, tk = "DFX";
    const off = prop(ACTORS.A, offer({ give: { ticker: tk, amount: "10" }, want: { value: "100000000" }, taker: ACTORS.B }), h0 + 2, {});
    const fee = tradeFee(100000000n, FEE_BPS_V16).toString(); const pay = { [ACTORS.A]: "100000000", [T]: fee };
    out.push({ label: "FIXTURE double-fill (second payment stranded)", cls: "offer-fill", tipHeight: h0 + 40, events: [
      prop(ACTORS.A, deploy({ ticker: tk, decimals: 0, supply: "1000000", mint: "issuer" }), h0, { [T]: DEPLOY_FEE.toString() }),
      prop(ACTORS.A, mint({ ticker: tk, amount: "1000000" }), h0 + 1), off,
      att(ACTORS.B, off.id, h0 + 4, pay), att(ACTORS.B, off.id, h0 + 6, pay),
    ] }); }
  return out;
}

// ── driver ────────────────────────────────────────────────────────────────────────────────────────────
// batch the scenarios through the independent Python resolver; returns its canonicalState per scenario
function pyDiff(scen) {
  const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname],
    { input: JSON.stringify({ resolve: scen.map((s) => ({ events: s.events, tipHeight: s.tipHeight })) }), encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (py.status !== 0) { console.error("python ref crashed:\n", py.stderr.slice(0, 2000)); return { diverged: -1 }; }
  return { pj: JSON.parse(py.stdout).resolve, diverged: 0 };
}

function run() {
  const fixturesOnly = process.argv.includes("--fixtures");
  const scen = fixturesOnly ? fixtures() : Array.from({ length: N }, () => { const g = pick(GENS); return g(bands()); });
  console.log(`ADVERSARIAL RACE HARNESS — ${scen.length} scenarios (seed ${SEED0}, reproduce: node conformance/race-harness.mjs ${N} ${SEED0})  [report-only]\n`);

  // property checks
  const hits = new Map(); // cls → {count, samples[]}
  let burned = 0n, withViol = 0, sealedNameBurns = 0;
  for (const s of scen) {
    const v = check(s);
    // fix-health: a name-race at a height ≥ V25 must be burn-free (sealed reservation). Any burn here is a
    // regression, not the expected pre-gate behaviour.
    if (v.length && (s.cls === "register-race" || s.cls === "displacement") && s.events[0].height >= V25_HEIGHT) sealedNameBurns++;
    if (v.length) {
      withViol++;
      for (const x of v) burned += x.amount;
      const key = s.cls;
      if (!hits.has(key)) hits.set(key, { count: 0, samples: [] });
      const rec = hits.get(key); rec.count++;
      if (rec.samples.length < 4) rec.samples.push({ label: s.label, v });
    }
  }
  for (const [cls, rec] of hits) {
    console.log(`• ${cls}: ${rec.count} scenario(s) with a money-safety violation`);
    for (const s of rec.samples) { console.log(`    ${s.label}`); for (const x of s.v) console.log(`      ${x.p}${x.amount ? " " + csd(x.amount) + " CSD" : ""} — ${x.detail}`); }
  }
  console.log(`\n${scen.length} scenarios · ${withViol} with a violation · ${csd(burned)} CSD total money-loss surface`);
  console.log(`fix-health: sealed-band (≥V25) name-race burns = ${sealedNameBurns} (expect 0 — the V25 sealed-reservation fix holding)`);

  // byte-identity differential (batch through Python) — sample to keep it fast unless --fixtures
  const sample = fixturesOnly ? scen : scen.filter((_, i) => i % 4 === 0);
  const { pj, diverged } = pyDiff(sample);
  if (diverged === -1) { console.error("differential skipped (python crash)"); process.exit(1); }
  let div = 0;
  for (let i = 0; i < sample.length; i++) {
    let jsC; try { jsC = canonicalState(resolve(sample[i].events, sample[i].tipHeight)); } catch { jsC = "JS_THROW"; }
    if (jsC !== pj[i]) {
      div++;
      if (div <= 3) {
        const b = pj[i] ?? "<py-missing>"; let k = 0; while (k < jsC.length && k < b.length && jsC[k] === b[k]) k++;
        console.error(`✗ JS⇄PY DIVERGED: ${sample[i].label} @ offset ${k}`);
        console.error(`   JS : …${jsC.slice(Math.max(0, k - 40), k + 60)}`);
        console.error(`   PY : …${b.slice(Math.max(0, k - 40), k + 60)}`);
        console.error(`   events: ${JSON.stringify(sample[i].events).slice(0, 700)}`);
      }
    }
  }
  console.log(`byte-identity: ${sample.length - div}/${sample.length} JS⇄Python identical${div ? `  ✗ ${div} DIVERGED` : ""}`);
  process.exit(div ? 1 : 0);
}

run();
