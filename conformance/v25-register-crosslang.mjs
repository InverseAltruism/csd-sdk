// v25-register-crosslang.mjs — regression for V25, the "sealed reservation" registration root-fix. Proves,
// against BOTH the JS resolver and the independent Python reference, byte-identical:
//   • a v2.5 `name` reveal is PAYMENT-FREE and creates a `pending` reservation (no treasury output, feesPaid=0);
//   • a CONTESTED reveal race is resolved by EARLIEST COMMIT (back-date), and the LOSER burns nothing (the whole
//     point of the fix) — regardless of the reveal ORDER within the block;
//   • the reg fee is paid ONCE, by the winner's `nfinalize`, and ONLY after the displacement contest freezes
//     (ev.height > effHeight + REG_COMMIT_MAX_BLOCKS); an early finalize is rejected;
//   • a finalized name is a NORMAL registered name (NOT viaFill — a viaFill flag would trip the wallet's namespv
//     caution on every fresh name) and is displacement-immune by the freeze-window arithmetic;
//   • an un-finalized reservation auto-expires at finalizeBy and the name reopens (swept from state);
//   • MAX_PENDING_REG bounds concurrent reservations per address;
//   • a `pending` name is not actionable (nxfer/nset/offer/nrenew are no-ops) until finalized;
//   • below V25 a `nfinalize` is an inert no-op and pay-now registration is unchanged (non-retroactive).
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, payloadHash, canonicalJson, nameCommit, nameRegFee,
        V25_HEIGHT, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, MAX_PENDING_REG } = R;
const TREAS = R.TREASURY_ADDR;
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const V = V25_HEIGHT, W = REG_COMMIT_MAX_BLOCKS, G = REG_FINALIZE_GRACE_BLOCKS;
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();
const cj = (rec) => canonicalJson(rec), ph = (rec) => payloadHash(rec);
const saltFor = (owner) => owner === A ? "a1a1a1a1a1a1a1a1" : "b2b2b2b2b2b2b2b2";

function commit(h, name, owner, pos = 1) {
  const rec = { v: 1, t: "ncommit", commit: nameCommit(name, saltFor(owner), owner) };
  return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} };
}
function reveal(h, name, owner, pos = 1) {                              // PAYMENT-FREE at V25
  const rec = { v: 1, t: "name", name, salt: saltFor(owner) };
  return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} };
}
function finalize(h, name, owner, feeUnits, pos = 1) {                  // carries the reg fee
  const rec = { v: 1, t: "nfinalize", name, salt: saltFor(owner) };
  return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: { [TREAS]: String(feeUnits) } };
}
// helpers to exercise the pending-name guards
function nxfer(h, name, owner, to, pos = 1) { const rec = { v: 1, t: "nxfer", name, to }; return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} }; }
function nset(h, name, owner, addr, pos = 1) { const rec = { v: 1, t: "nset", name, addr }; return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} }; }
function nameOffer(h, name, owner, pos = 1) { const rec = { v: 1, t: "offer", give: { name }, want: { value: "1000" } }; return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} }; }
function nrenew(h, name, owner, feeUnits, pos = 1) { const rec = { v: 1, t: "nrenew", name }; return { kind: "propose", id: nid(), proposer: owner, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: { [TREAS]: String(feeUnits) } }; }

const jsState = (ev, tip) => resolve(ev, tip);
const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const pyCanon = (ev, tip) => { const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return JSON.parse(r.stdout).resolve[0]; };

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };
const both = (n, ev, tip) => ok(`${n}: JS≡Python`, jsCanon(ev, tip) === pyCanon(ev, tip));

console.log(`v25 sealed-reservation registration (V25=${V}, window=${W}, grace=${G}, maxPending=${MAX_PENDING_REG}):`);
const FEE = Number(nameRegFee("swap", V));   // 4-char at a >=V24 height
const feeOf = (name) => Number(nameRegFee(name, V));   // price each finalize by its actual name length

// 1) HAPPY PATH — reveal is payment-free (pending, feesPaid=0); finalize pays the fee → NORMAL name (not viaFill)
{
  const evReveal = [commit(V, "swap", A), reveal(V + 2, "swap", A)];        // back-dates to V (effHeight=V)
  const sR = jsState(evReveal, V + 5);
  ok("reveal → name is pending, owner A", sR.names.swap?.pending === true && sR.names.swap?.owner === A.toLowerCase());
  ok("reveal is PAYMENT-FREE (feesPaid == 0)", sR.feesPaid === "0");
  ok("reservation carries finalizeBy = effHeight + W + G", sR.names.swap?.finalizeBy === V + W + G);
  both("after payment-free reveal", evReveal, V + 5);

  const evFinal = [...evReveal, finalize(V + W + 1, "swap", A, FEE)];       // > effHeight + W → allowed
  const sF = jsState(evFinal, V + W + 2);
  ok("finalize → name NO LONGER pending", !sF.names.swap?.pending);
  ok("finalize → NOT viaFill (fresh registration is not a purchase)", sF.names.swap?.viaFill === undefined);
  ok("finalize → owner A, has a lease (paidThroughEpoch)", sF.names.swap?.owner === A.toLowerCase() && typeof sF.names.swap?.paidThroughEpoch === "number");
  ok("finalize → the reg fee is paid exactly once", sF.feesPaid === String(FEE));
  both("after winner finalize", evFinal, V + W + 2);
}

// 2) CONTESTED RACE — earliest committer wins; the LOSER burns nothing (headline property), order-independent
for (const [label, aPos, bPos] of [["A reveals first", 1, 2], ["B reveals first", 2, 1]]) {
  // A commits at V (earliest), B commits at V+1; both reveal at V+3
  const ev = [commit(V, "race", A, 1), commit(V + 1, "race", B, 2), reveal(V + 3, "race", A, aPos), reveal(V + 3, "race", B, bPos)];
  const s = jsState(ev, V + 5);
  ok(`contested (${label}) → earliest committer A holds the reservation`, s.names.race?.pending === true && s.names.race?.owner === A.toLowerCase() && s.names.race?.effectiveHeight === V);
  ok(`contested (${label}) → NEITHER reveal paid a fee (loser burns nothing)`, s.feesPaid === "0");
  both(`contested race (${label})`, ev, V + 5);
}

// 3) EARLY FINALIZE — before the freeze (ev.height == effHeight + W, not strictly greater) is rejected
{
  const ev = [commit(V, "early", A), reveal(V + 1, "early", A), finalize(V + W, "early", A, FEE)]; // effHeight=V, gate needs > V+W
  const s = jsState(ev, V + W + 1);
  ok("early finalize (height == effHeight+W) rejected → still pending, fee not counted", s.names.early?.pending === true && s.feesPaid === "0");
  both("early finalize rejected", ev, V + W + 1);
}

// 4) EXPIRY + REOPEN — an un-finalized reservation past finalizeBy is swept (name reopens); a late finalize fails
{
  const finBy = V + W + G;                                                  // effHeight=V → finalizeBy = V+W+G
  const evLate = [commit(V, "gone", A), reveal(V + 1, "gone", A), finalize(finBy + 1, "gone", A, FEE)]; // > finalizeBy → expired
  const s = jsState(evLate, finBy + 2);
  ok("expired reservation is swept and the late finalize fails → name absent", s.names.gone === undefined && s.feesPaid === "0");
  both("expired reservation reopens", evLate, finBy + 2);

  // reopen: a fresh commit/reveal after expiry registers anew (B this time)
  const evReopen = [...evLate, commit(finBy + 2, "gone", B), reveal(finBy + 3, "gone", B)];
  const s2 = jsState(evReopen, finBy + 5);
  ok("after expiry the name is claimable again (B reserves it)", s2.names.gone?.pending === true && s2.names.gone?.owner === B.toLowerCase());
  both("name reopened after expiry", evReopen, finBy + 5);
}

// 5) MAX_PENDING_REG — a 4th concurrent reservation by the same address is rejected
{
  const ev = [];
  for (let i = 0; i < 4; i++) { ev.push(commit(V, `nm${i}`, A, i + 1)); }
  for (let i = 0; i < 4; i++) { ev.push(reveal(V + 1, `nm${i}`, A, i + 1)); }
  const s = jsState(ev, V + 3);
  const held = ["nm0", "nm1", "nm2", "nm3"].filter((n) => s.names[n]?.pending).length;
  ok(`MAX_PENDING_REG caps A at ${MAX_PENDING_REG} live reservations (4th rejected)`, held === MAX_PENDING_REG && s.names.nm3 === undefined);
  both("per-address reservation cap", ev, V + 3);
}

// 6) A pending name is NOT actionable — nxfer/nset/offer/nrenew are all no-ops until finalized
{
  const ev = [commit(V, "hold", A), reveal(V + 2, "hold", A),
    nxfer(V + 3, "hold", A, B, 1), nset(V + 3, "hold", A, B, 2), nameOffer(V + 3, "hold", A, 3), nrenew(V + 3, "hold", A, FEE, 4)];
  const s = jsState(ev, V + 5);
  ok("pending name: nxfer/nset/offer/nrenew all no-op (still pending, owner A, no addr, no offer)",
    s.names.hold?.pending === true && s.names.hold?.owner === A.toLowerCase() && s.names.hold?.addr === undefined && Object.keys(s.offers).length === 0 && s.feesPaid === "0");
  both("pending name is inert to owner actions", ev, V + 5);
}

// 7) DISPLACED-THEN-WRONG-FINALIZE — the displaced (losing) committer cannot finalize; only the winner can
{
  // A commit at V (earliest), B commit at V+1; both reveal (A wins); then B tries to finalize (must fail), then A finalizes
  const ev = [commit(V, "who", A, 1), commit(V + 1, "who", B, 2), reveal(V + 3, "who", A, 1), reveal(V + 3, "who", B, 2),
    finalize(V + W + 1, "who", B, feeOf("who"), 1), finalize(V + W + 1, "who", A, feeOf("who"), 2)];
  const s = jsState(ev, V + W + 2);
  ok("only the winner (A) finalizes; B's finalize is rejected; fee paid once", !s.names.who?.pending && s.names.who?.owner === A.toLowerCase() && s.feesPaid === String(feeOf("who")));
  both("displaced committer cannot finalize", ev, V + W + 2);
}

// 8) BELOW V25 — nfinalize is an inert no-op; pay-now registration is unchanged (non-retroactive)
{
  const H = 45_000;                                                        // < V25 (any close gate is >= 49_300)
  const feeH = Number(nameRegFee("belowv25", H));
  const payNow = { kind: "propose", id: nid(), proposer: A, uri: cj({ v: 1, t: "name", name: "belowv25" }), payloadHash: ph({ v: 1, t: "name", name: "belowv25" }), height: H, pos: 1, expiresEpoch: 9e14, paidTo: { [TREAS]: String(feeH) } };
  const ev = [payNow, finalize(H + 1, "belowv25", A, feeH)];               // finalize below V25 = no-op
  const s = jsState(ev, H + 5);
  ok("<V25: pay-now registration works and is NOT pending; nfinalize is a no-op", s.names.belowv25 && !s.names.belowv25.pending && s.feesPaid === String(feeH));
  both("below-V25 pay-now + inert nfinalize", ev, H + 5);
}

// 9) POST-FREEZE DISPLACEMENT IMMUNITY — a finalized name cannot be stolen by a late back-dated reveal. Any
//    window-valid challenger has effHeight within REG_COMMIT_MAX_BLOCKS of "now", hence strictly greater than
//    the frozen winner's; a challenger claiming an EARLIER commit cannot satisfy the reveal window. This is why
//    a finalized registration is safe WITHOUT a viaFill flag.
{
  const ev = [commit(V, "safe", A), reveal(V + 1, "safe", A), finalize(V + W + 1, "safe", A, feeOf("safe")),
    // B committed EARLIER (V-1) but can only reveal post-finalize; V+W+3 - (V-1) = W+4 > W → out of window → rejected
    commit(V - 1, "safe", B, 2), reveal(V + W + 3, "safe", B, 2)];
  const s = jsState(ev, V + W + 5);
  ok("finalized name survives a too-late back-dated challenger (window rejects it)", !s.names.safe?.pending && s.names.safe?.owner === A.toLowerCase() && s.names.safe?.viaFill === undefined);
  both("post-freeze displacement immunity", ev, V + W + 5);
}

// 10) DETERMINISM — numeric (ECMAScript array-index) pending names must enumerate identically (JS emits
//     integer-index keys first, ascending; the Python mirror replicates via _js_obj_key_order).
{
  const ev = [commit(V, "10", A, 1), commit(V, "9", A, 2), commit(V, "town", A, 3),
    reveal(V + 1, "10", A, 1), reveal(V + 1, "9", A, 2), reveal(V + 1, "town", A, 3)];
  const s = jsState(ev, V + 3);
  ok("numeric + string reservations all pending (array-index key handling)", s.names["9"]?.pending && s.names["10"]?.pending && s.names.town?.pending);
  both("numeric + string pending-name key enumeration", ev, V + 3);
}

// 11) FINALIZE BOUNDARIES — valid AT exactly finalizeBy; rejected one block past it
{
  const base = [commit(V, "edge", A), reveal(V + 1, "edge", A)];           // effHeight=V, finalizeBy=V+W+G
  const finBy = V + W + G;
  const atLimit = [...base, finalize(finBy, "edge", A, feeOf("edge"))];     // ev.height == finalizeBy → allowed
  const sAt = jsState(atLimit, finBy + 1);
  ok("finalize AT finalizeBy succeeds", !sAt.names.edge?.pending && sAt.feesPaid === String(feeOf("edge")));
  both("finalize at the last valid block", atLimit, finBy + 1);
  const past = [...base, finalize(finBy + 1, "edge", A, feeOf("edge"))];    // one past → expired/swept → rejected
  const sPast = jsState(past, finBy + 2);
  ok("finalize one block past finalizeBy is rejected (name reopens)", sPast.names.edge === undefined && sPast.feesPaid === "0");
  both("finalize one past the deadline", past, finBy + 2);
}

console.log(`\nv25 register crosslang: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
