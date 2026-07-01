// v26-recapture-crosslang.mjs — regression for V26, the sealed-reservation cure applied to LAPSED-NAME
// RECAPTURE (the up-to-~300 CSD premium burn). Proves, against BOTH the JS resolver and the independent Python
// reference, byte-identical:
//   • a recapture `name` reveal on a lapsed name is PAYMENT-FREE (no treasury output; feesPaid unchanged) and
//     reserves the name in an internal `recaptures` map — the lapsed record in `names` stays UNTOUCHED;
//   • a CONTESTED recapture is decided by EARLIEST COMMIT and the LOSER burns nothing (the headline);
//   • the decaying premium is paid ONCE, by the winner's `nfinalize`, priced at the FINALIZE height;
//   • a finalized recapture is a NORMAL name (NOT viaFill) and displacement-immune by the freeze-window math;
//   • an un-finalized recapture auto-expires and the name stays LAPSED (recapturable), not available (no premium
//     bypass — the lapsed record was never destroyed);
//   • below V26 the pay-now reclaim is unchanged (non-retroactive).
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, payloadHash, canonicalJson, nameCommit, nameRegFee, expiredClaimFee,
        V26_HEIGHT, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS, EPOCH_LEN } = R;
const TREAS = R.TREASURY_ADDR;
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), OLD = "0x" + "0d".repeat(20);
const V = V26_HEIGHT, W = REG_COMMIT_MAX_BLOCKS, G = REG_FINALIZE_GRACE_BLOCKS;
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();
const cj = (r) => canonicalJson(r), ph = (r) => payloadHash(r);
const saltFor = (o) => o === A ? "a1a1a1a1a1a1a1a1" : o === B ? "b2b2b2b2b2b2b2b2" : "0d0d0d0d0d0d0d0d";
const epochOf = (h) => Math.floor(h / EPOCH_LEN);

// register a name pay-now (salt-less) at height h, owned by `owner`, paying the base reg fee (used to plant a
// name that will be LAPSED by V). h must be < V25 so this takes the classic pay-now path.
function regPayNow(h, name, owner) {
  const rec = { v: 1, t: "name", name };
  const fee = nameRegFee(name, h);
  return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos: 1, expiresEpoch: 9e14, paidTo: { [TREAS]: String(fee) } };
}
function commit(h, name, owner, pos = 1) {
  const rec = { v: 1, t: "ncommit", commit: nameCommit(name, saltFor(owner), owner) };
  return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} };
}
function reveal(h, name, owner, pos = 1) {                       // PAYMENT-FREE recapture reserve at >=V26
  const rec = { v: 1, t: "name", name, salt: saltFor(owner) };
  return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} };
}
function finalize(h, name, owner, premiumUnits, pos = 1) {        // carries the decaying premium
  const rec = { v: 1, t: "nfinalize", name, salt: saltFor(owner) };
  return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: { [TREAS]: String(premiumUnits) } };
}

const jsState = (ev, tip) => resolve(ev, tip);
const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const pyCanon = (ev, tip) => { const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return JSON.parse(r.stdout).resolve[0]; };

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };
const both = (n, ev, tip) => ok(`${n}: JS≡Python`, jsCanon(ev, tip) === pyCanon(ev, tip));

console.log(`v26 sealed-recapture (V26=${V}, window=${W}, grace=${G}):`);

// ── plant a LAPSED name: register "reco" pay-now at H0 so it is ~100 epochs past grace at V ──
// graceEnd epoch = epochOf(H0)+NAME_TERM+NAME_GRACE; want epochOf(V) - graceEnd ≈ 100 (premium ~17x).
const H0 = (epochOf(V) - 100 - NAME_TERM_EPOCHS - NAME_GRACE_EPOCHS) * EPOCH_LEN;   // < V25 → pay-now
const REG = Number(nameRegFee("reco", H0));
const paidThrough = epochOf(H0) + NAME_TERM_EPOCHS;
const premiumAt = (h) => Number(expiredClaimFee("reco", epochOf(h) - (paidThrough + NAME_GRACE_EPOCHS), h));
const plant = [regPayNow(H0, "reco", OLD)];
{
  const s = jsState(plant, V);
  ok("setup: 'reco' is planted and LAPSED at V (expired, recapturable)", s.names.reco?.expired === true && s.names.reco?.owner === OLD.toLowerCase());
  ok("setup: premium at V is a multiple of the base fee (decay live, not 1x)", premiumAt(V + 11) > REG && premiumAt(V + 11) <= 20 * REG);
  both("planted lapsed name", plant, V);
}

// 1) HAPPY PATH — reveal is payment-free (reserve); finalize pays the premium → NORMAL name (not viaFill)
{
  const evReveal = [...plant, commit(V, "reco", A), reveal(V + 2, "reco", A)];
  const sR = jsState(evReveal, V + 5);
  ok("recapture reveal is PAYMENT-FREE (name still lapsed, feesPaid == just the plant reg fee)", sR.names.reco?.expired === true && sR.names.reco?.owner === OLD.toLowerCase() && sR.feesPaid === String(REG));
  both("after payment-free recapture reveal (name unchanged)", evReveal, V + 5);

  const prem = premiumAt(V + W + 1);
  const evFinal = [...evReveal, finalize(V + W + 1, "reco", A, prem)];
  const sF = jsState(evFinal, V + W + 2);
  ok("finalize → 'reco' is now A's (fresh lease), NOT lapsed", sF.names.reco?.owner === A.toLowerCase() && !sF.names.reco?.expired && typeof sF.names.reco?.paidThroughEpoch === "number");
  ok("finalize → NOT viaFill (recapture finalize is not a purchase)", sF.names.reco?.viaFill === undefined);
  ok("finalize → the premium is paid exactly once", sF.feesPaid === String(REG + prem));
  both("after winner recapture finalize", evFinal, V + W + 2);
}

// 2) CONTESTED — earliest committer wins; the LOSER burns nothing
{
  const ev = [...plant, commit(V, "reco", A, 1), commit(V + 1, "reco", B, 2), reveal(V + 3, "reco", A, 1), reveal(V + 3, "reco", B, 2)];
  const s = jsState(ev, V + 5);
  ok("contested → NEITHER reveal paid (name still lapsed, feesPaid == plant reg fee only)", s.names.reco?.expired === true && s.feesPaid === String(REG));
  both("contested recapture reveals (loser burns nothing)", ev, V + 5);
  // only A (earliest commit) can finalize; B's finalize is rejected (not the reservation owner)
  const prem = premiumAt(V + W + 1);
  const ev2 = [...ev, finalize(V + W + 1, "reco", B, prem, 1), finalize(V + W + 1, "reco", A, prem, 2)];
  const s2 = jsState(ev2, V + W + 2);
  ok("only the earliest committer (A) recaptures; B's finalize rejected; premium paid once", s2.names.reco?.owner === A.toLowerCase() && s2.feesPaid === String(REG + prem));
  both("earliest committer wins the recapture", ev2, V + W + 2);
}

// 3) EXPIRED — an un-finalized recapture reservation expires; the name stays LAPSED (no premium bypass)
{
  const finBy = V + W + G;
  const prem = premiumAt(finBy + 1);
  const ev = [...plant, commit(V, "reco", A), reveal(V + 1, "reco", A), finalize(finBy + 1, "reco", A, prem)];  // finalize past finalizeBy
  const s = jsState(ev, finBy + 2);
  ok("expired recapture: the name is STILL lapsed/recapturable (NOT available, no premium bypass)", s.names.reco?.expired === true && s.names.reco?.owner === OLD.toLowerCase() && s.feesPaid === String(REG));
  both("expired recapture keeps the name lapsed", ev, finBy + 2);
}

// 4) TOO-EARLY finalize — before the freeze is rejected; the reservation survives, name still lapsed
{
  const prem = premiumAt(V + W);
  const ev = [...plant, commit(V, "reco", A), reveal(V + 1, "reco", A), finalize(V + W, "reco", A, prem)];  // == effHeight+W, not >
  const s = jsState(ev, V + W + 1);
  ok("early recapture finalize (height == effHeight+W) rejected → name still lapsed, no premium counted", s.names.reco?.expired === true && s.feesPaid === String(REG));
  both("early recapture finalize rejected", ev, V + W + 1);
}

// 5) BELOW V26 — the pay-now reclaim is unchanged (a separate lapsed name reclaimed at a height < V26)
{
  // plant "recb" so it lapses just before a below-V26 height Hr; reclaim pay-now there.
  const Hr = V - 10;                                             // < V26 (=V25) → pay-now reclaim
  const H0b = (epochOf(Hr) - 100 - NAME_TERM_EPOCHS - NAME_GRACE_EPOCHS) * EPOCH_LEN;
  const paidThroughB = epochOf(H0b) + NAME_TERM_EPOCHS;
  const premB = Number(expiredClaimFee("recb", epochOf(Hr) - (paidThroughB + NAME_GRACE_EPOCHS), Hr));
  const reclaim = { kind: "propose", id: nid(), proposer: A, uri: cj({ v: 1, t: "name", name: "recb" }), payloadHash: ph({ v: 1, t: "name", name: "recb" }), height: Hr, pos: 1, expiresEpoch: 9e14, paidTo: { [TREAS]: String(premB) } };
  const ev = [regPayNow(H0b, "recb", OLD), reclaim];
  const s = jsState(ev, Hr + 5);
  ok("<V26 pay-now reclaim still works: 'recb' recaptured by A at the premium (viaFill, immune)", s.names.recb?.owner === A.toLowerCase() && s.names.recb?.viaFill === true);
  both("below-V26 pay-now reclaim unchanged", ev, Hr + 5);
}

console.log(`\nv26 recapture crosslang: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
