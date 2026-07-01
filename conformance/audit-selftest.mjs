// Self-test for the audit tooling itself: asserts the DETECTORS in money-safety.mjs (findBurns) and
// race-harness.mjs (findDisplacementBurns / findPaymentWithoutDelivery) fire on known positives, stay
// silent on negatives, handle the false-positive vectors (self-pay, non-fill payments), and survive edge
// inputs. This tests the tools, not the resolver. Exit 1 on any failed assertion.
//   node conformance/audit-selftest.mjs
import { findBurns } from "./money-safety.mjs";
import { findDisplacementBurns, findPaymentWithoutDelivery } from "./race-harness.mjs";
import * as R from "../packages/cairnx/dist/index.js";

const T = R.TREASURY_ADDR;
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20), ADV = "0x" + "de".repeat(20);
let ID = 1; const nid = () => "0x" + (ID++).toString(16).padStart(64, "0");
const prop = (who, rec, h, paidTo = {}, pos = 1) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos, expiresEpoch: 9e15, paidTo });
const att = (who, proposalId, h, paidTo = {}, score = 100, pos = 1) => ({ kind: "attest", txid: nid(), proposalId, attester: who, score, confidence: 0, height: h, pos, paidTo });

let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = got === want; console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${got}, want ${want}`}`); ok ? pass++ : fail++; };

// ── P1 findBurns ────────────────────────────────────────────────────────────────────────────────────
{
  const fee = R.nameRegFee("test", 44660).toString();
  const evs = [prop(A, R.nameClaim({ name: "test" }), 44660, { [T]: fee }), prop(B, R.nameClaim({ name: "test" }), 44662, { [T]: fee })];
  const b = findBurns(evs, 44700);
  eq("P1 register-race: exactly 1 burn", b.length, 1);
  eq("P1 register-race: burn == reg fee", b[0]?.burned?.toString(), fee);
  eq("P1 register-race: burned by loser B", b[0]?.actor, B);
}
{
  const fee = R.nameRegFee("alice", 44660).toString();
  eq("P1 clean register: 0 burns", findBurns([prop(A, R.nameClaim({ name: "alice" }), 44660, { [T]: fee })], 44700).length, 0);
}
{
  // generality: a rejected deploy burns DEPLOY_FEE — no record-type enumeration in the detector
  const rec = R.deploy({ ticker: "GOLD", decimals: 0, supply: "1000000", mint: "issuer" });
  const evs = [{ ...prop(A, rec, 40000, { [T]: R.DEPLOY_FEE.toString() }), pos: 0 }, { ...prop(B, rec, 40000, { [T]: R.DEPLOY_FEE.toString() }), pos: 1 }];
  const b = findBurns(evs, 40040);
  eq("P1 deploy-taken: exactly 1 burn", b.length, 1);
  eq("P1 deploy-taken: burn == DEPLOY_FEE", b[0]?.burned?.toString(), R.DEPLOY_FEE.toString());
}
{
  // false-positive vector: the payer IS the treasury (self-pay). A rejected treasury->treasury fee is a wash.
  const fee = R.nameRegFee("test", 44660).toString();
  const evs = [prop(A, R.nameClaim({ name: "selfpay" }), 44660, { [T]: fee }), prop(T, R.nameClaim({ name: "selfpay" }), 44662, { [T]: fee })];
  eq("P1 self-pay treasury loser: 0 burns (wash)", findBurns(evs, 44700).length, 0);
}
{
  eq("P1 empty events: 0 burns", findBurns([], 40000).length, 0);
  eq("P1 orphan attest: 0 burns", findBurns([att(B, nid(), 40000, {})], 40040).length, 0);
}

// ── P3 findPaymentWithoutDelivery ─────────────────────────────────────────────────────────────────────
function doubleFillSeq(h0, secondTaker) {
  const tkr = "PAY";
  const dep = prop(A, R.deploy({ ticker: tkr, decimals: 0, supply: "1000000", mint: "issuer" }), h0, { [T]: R.DEPLOY_FEE.toString() });
  const mnt = prop(A, R.mint({ ticker: tkr, amount: "1000000" }), h0 + 1);
  const off = prop(A, R.offer({ give: { ticker: tkr, amount: "10" }, want: { value: "100000000" }, taker: B }), h0 + 2, {});
  const pay = { [A]: "100000000", [T]: R.tradeFee(100000000n, R.FEE_BPS_V16).toString() };
  return [dep, mnt, off, att(B, off.id, h0 + 4, pay), att(secondTaker, off.id, h0 + 6, pay)];
}
{
  const evs = doubleFillSeq(40000, B);
  const pwd = findPaymentWithoutDelivery(evs, 40040);
  eq("P3 double-fill: 1 stranded payment", pwd.length, 1);
  eq("P3 double-fill: stranded amount == want", pwd[0]?.amount?.toString(), "100000000");
  eq("P3 double-fill: paid to seller A", pwd[0]?.paidTo, A);
  eq("P1 double-fill: treasury fee also burned", findBurns(evs, 40040).length, 1);
}
{
  const evs = doubleFillSeq(40000, B).slice(0, 4); // single clean fill
  eq("P3 clean fill: 0 stranded", findPaymentWithoutDelivery(evs, 40040).length, 0);
  eq("P1 clean fill: 0 burns", findBurns(evs, 40040).length, 0);
}
{
  // P3 must not fire on a rejected NON-fill record even if it carries a paidTo
  const evs = [prop(A, R.nameXfer({ name: "nope", to: C }), 40000, { [B]: "100000000" })];
  eq("P3 non-fill rejected record: 0 stranded", findPaymentWithoutDelivery(evs, 40040).length, 0);
}

// ── P2 findDisplacementBurns ──────────────────────────────────────────────────────────────────────────
{
  const nm = "bd" + (ID % 9000 + 100), salt = "a".repeat(32), fee = R.nameRegFee(nm, 44000).toString();
  const evs = [
    prop(ADV, R.nameCommitRecord({ commit: R.nameCommit(nm, salt, ADV) }), 44000),
    prop(A, R.nameClaim({ name: nm }), 44003, { [T]: fee }),
    prop(ADV, R.nameClaim({ name: nm, salt }), 44008, { [T]: fee }),
  ];
  const d = findDisplacementBurns(evs, 44060);
  eq("P2 pre-V25 displacement: 1 event", d.length, 1);
  eq("P2 pre-V25 displacement: displacer is ADV", d[0]?.displacer, ADV);
}
{
  const nm = "sb" + (ID % 9000 + 100), h = R.V25_HEIGHT + 500, aS = "a".repeat(32), vS = "b".repeat(32);
  const evs = [
    prop(ADV, R.nameCommitRecord({ commit: R.nameCommit(nm, aS, ADV) }), h),
    prop(A, R.nameCommitRecord({ commit: R.nameCommit(nm, vS, A) }), h + 1),
    prop(A, R.nameClaim({ name: nm, salt: vS }), h + 3),
    prop(ADV, R.nameClaim({ name: nm, salt: aS }), h + 5),
  ];
  eq("P2 post-V25 sealed displacement: 0 (fix holds)", findDisplacementBurns(evs, h + 60).length, 0);
}

// ── determinism ───────────────────────────────────────────────────────────────────────────────────────
{
  const fee = R.nameRegFee("det", 44660).toString();
  const mk = () => [prop(A, R.nameClaim({ name: "det" }), 44660, { [T]: fee }), prop(B, R.nameClaim({ name: "det" }), 44662, { [T]: fee })];
  const s = (x) => JSON.stringify(findBurns(x, 44700).map((b) => ({ ...b, burned: b.burned.toString() })));
  eq("determinism: findBurns identical across runs", s(mk()), s(mk()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
