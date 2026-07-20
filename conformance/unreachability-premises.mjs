// unreachability-premises.mjs (B6 rider; the R3 deferral from the B0a batch record, re-routed docs -> test).
//
// The v2.8 lease-lapse freeze (resolve.ts voidOpenNameOffers, "a name-offer carrying a live fclaim hold is
// FROZEN") was argued STRUCTURALLY UNREACHABLE by the B0a gate: a held name-offer can never coexist with a
// lapsed/recapturable name. That argument is a chain of three premises, each enforced by a named guard:
//   P1  the v1.5 lease guard: a name offer whose lease ends inside the offer window is REJECTED at
//       creation ("the lease must outlive the offer window"), so hold end <= offer expiry <= paidThrough;
//   P2  the no-salt rule: at V25+ no bare `name` record can register, and at V26+ none can recapture a
//       lapsed name - every takeover path goes through commit-reveal;
//   P3  the anchor-window property: a reveal back-dates AT MOST REG_COMMIT_MAX_BLOCKS, so no displacement
//       can anchor deep enough to jump an established owner's basis.
// If ANY of these is ever relaxed, the freeze stops being dead code and its coverage gap becomes real.
// This script PINS each premise executably (deny leg + positive control, all read back from resolve()'s
// own events log / state - never from generation-side math). Test-only: no shipping source, no re-vendor.
import {
  resolve, offer, nameCommit, nameCommitRecord, nameClaim, nameFinalize, nameRegFee,
  REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS,
  TREASURY_ADDR, V28_HEIGHT, EPOCH_LEN, epochOf,
} from "../packages/cairnx/dist/index.js";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
let n = 1; const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
const PE = (b, h, who, ee, pos = 0, paidTo = {}, id = nid()) => ({ kind: "propose", id, proposer: who, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height: h, pos, paidTo });
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`); };
const noteOf = (st, id) => st.events.find((e) => e.id === id && e.ok === false)?.note ?? "";

// a sealed, finalized name owned by A (commit -> payment-free reveal -> winner-only nfinalize)
const SALT = "a1a1a1a1a1a1a1a1", NAME = "pinname", W = REG_COMMIT_MAX_BLOCKS, C = V28_HEIGHT;
const reg = [
  PE(nameCommitRecord({ commit: nameCommit(NAME, SALT, A) }), C, A, 9e14, 1, {}, nid()),
  PE(nameClaim({ name: NAME, salt: SALT }), C + 2, A, 9e14, 1, {}, nid()),
  PE(nameFinalize({ name: NAME, salt: SALT }), C + W + 2, A, 9e14, 1, { [TREASURY_ADDR]: String(nameRegFee(NAME, C + W + 2)) }, nid()),
];
const OFF_H = C + W + 3;
const paidThrough = epochOf(C) + NAME_TERM_EPOCHS;   // expected lease end (verified via P1's own legs)

console.log("R3 unreachability premises (v2.8 freeze coverage argument):");

// ── P1: the v1.5 lease guard ──
{
  const oBad = nid(), oGood = nid();
  const bad = PE(offer({ give: { name: NAME }, want: { value: "1000000000", payto: A } }), OFF_H, A, paidThrough + 1, 0, {}, oBad);
  const good = PE(offer({ give: { name: NAME }, want: { value: "1000000000", payto: A } }), OFF_H, A, paidThrough, 0, {}, oGood);
  const st = resolve([...reg, bad, good], OFF_H + 2);
  ok("P1 deny: an offer outliving the lease is REJECTED with the v1.5 reason", st.offers[oBad] === undefined && /v1\.5: lease ends inside the offer window/.test(noteOf(st, oBad)));
  ok("P1 control: an offer ending AT paidThrough is accepted (guard is exact, not over-wide)", st.offers[oGood]?.status === "open");
}

// ── P2: the no-salt rule (register + recapture) ──
{
  const idReg = nid();
  const bare = PE(nameClaim({ name: "freshpin" }), OFF_H, B, 9e14, 1, {}, idReg);
  const st1 = resolve([...reg, bare], OFF_H + 2);
  ok("P2 deny: a no-salt register at V25+ is REJECTED", st1.names["freshpin"] === undefined && /v2\.5: registration requires a commit-reveal/.test(noteOf(st1, idReg)));
  // lapse A's lease (epoch > paidThrough + grace), then attempt a bare no-salt takeover
  const lapseH = (paidThrough + NAME_GRACE_EPOCHS + 2) * EPOCH_LEN;
  const idRec = nid();
  const bareRec = PE(nameClaim({ name: NAME }), lapseH, B, 9e15, 1, {}, idRec);
  const st2 = resolve([...reg, bareRec], lapseH + 2);
  ok("P2 deny: a no-salt RECAPTURE of a lapsed name at V26+ is REJECTED", st2.names[NAME]?.owner === A && /v2\.6: recapture requires a commit-reveal/.test(noteOf(st2, idRec)));
}

// ── P3: the anchor-window property ──
{
  const SALT2 = "b2b2b2b2b2b2b2b2";
  const mk = (gap) => {
    const cid = nid(), rid = nid();
    const evs = [
      PE(nameCommitRecord({ commit: nameCommit("anchorpin", SALT2, B) }), OFF_H, B, 9e14, 1, {}, cid),
      PE(nameClaim({ name: "anchorpin", salt: SALT2 }), OFF_H + gap, B, 9e14, 1, {}, rid),
    ];
    return { st: resolve(evs, OFF_H + gap + 1), rid };
  };
  const over = mk(W + 1);
  ok("P3 deny: a reveal past the anchor window is REJECTED (no back-dated anchor)", over.st.names["anchorpin"] === undefined && /no valid in-window commit/.test(noteOf(over.st, over.rid)));
  const at = mk(W);
  ok("P3 control: a reveal AT the window edge back-dates to the COMMIT height exactly", at.st.names["anchorpin"]?.effectiveHeight === OFF_H);
}

console.log(`\nR3 premise pins: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
