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
// V26_HEIGHT is the GATE. A name can only physically LAPSE ~1 year after the earliest V11 registration
// (term 8760 + grace 720 epochs), so recapture must be exercised at a height where a real lapse exists —
// independent of where the gate sits. V is that fixed recapture height; the gate just has to be <= it.
const V26 = V26_HEIGHT, W = REG_COMMIT_MAX_BLOCKS, G = REG_FINALIZE_GRACE_BLOCKS;
const V = 320_000;   // recapture height: a name planted at H0 (below) is ~86 epochs past grace here (live premium)
if (V < V26) throw new Error(`test misconfig: recapture height V=${V} must be >= gate V26=${V26}`);
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

console.log(`v26 sealed-recapture (gate V26=${V26}, recapture-height V=${V}, window=${W}, grace=${G}):`);

// ── plant a LAPSED name: register "reco" pay-now at a FIXED H0 (>= V11 so names are live, < V25 so it takes
// the classic pay-now path) so it is ~86 epochs past grace at the fixed recapture height V (premium ~17x). ──
const H0 = 33_000;   // epoch 1100: graceEnd = 1100+8760+720 = 10580 (h 317400); V=320000 (epoch 10666) is lapsed
const REG = Number(nameRegFee("reco", H0));
const paidThrough = epochOf(H0) + NAME_TERM_EPOCHS;
const premiumAt = (h) => Number(expiredClaimFee("reco", epochOf(h) - (paidThrough + NAME_GRACE_EPOCHS), h));
const plant = [regPayNow(H0, "reco", OLD)];
{
  const s = jsState(plant, V);
  ok("setup: 'reco' is planted and LAPSED at V (expired, recapturable)", s.names.reco?.expired === true && s.names.reco?.owner === OLD.toLowerCase());
  // the premium is priced at the RECAPTURE height (V24 schedule), which differs from the plant-height REG
  // (H0 is under the old pre-V18 curve), so sanity-check the premium against its OWN base, not REG.
  const baseAtV = Number(nameRegFee("reco", V + 11));
  ok("setup: premium at V is a live multiple of the base fee (decay, not 1x)", premiumAt(V + 11) > baseAtV && premiumAt(V + 11) <= 20 * baseAtV);
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

// 5) NON-RETROACTIVITY of the reclaim path. NOTE: with a close V26 gate (< ~314k) NO name can physically be
// LAPSED below the gate (a lapse needs term+grace ~9480 epochs after the earliest V11 registration), so the
// pre-V26 pay-now reclaim path is UNREACHABLE in production — recapture protection is universal from the very
// first lapse. Below-gate byte-identity is proven by the full pinned corpus + 1500-fuzz staying byte-identical
// (crosscheck-resolve + fuzz-resolve). There is no lapsed name to reclaim below the gate, so nothing to test here.

console.log(`\nv26 recapture crosslang: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
