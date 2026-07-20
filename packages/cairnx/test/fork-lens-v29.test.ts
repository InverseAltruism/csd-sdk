// fork-lens-v29.test.ts - the permanent FORK-LENS fixture for the V29 gate (REBIND B9, the mandatory extra
// lens the escalated gate requires). It constructs the exact event sequences on which an UPGRADED (v2.9-aware)
// resolver and a STALE (pre-v2.9) resolver produce DIFFERENT canonical state, and PROVES that divergence can
// only occur at height >= 88,000 (the operator-decided gate). The complementary proof - that NO sequence below
// the gate diverges - is the byte-identity differential in scripts/v29-below-gate-differential.mjs.
//
// How "stale vs upgraded" is modelled WITHOUT a second build: by the gate's own design, the shipping resolver
// BELOW V29 is byte-identical to the pre-V29 (stale) resolver (that is exactly what the below-gate differential
// proves empirically). So the stale replayer's verdict for a rigid scenario is the shipping resolver's verdict
// when that scenario sits below the gate, and the divergence appears precisely at the height where the shipping
// resolver's behaviour flips. This fixture locates that flip and pins it to the operator floor.
//
// THE THRESHOLD IS HARDCODED (OPERATOR_V29 = 88_000), NOT imported from V29_HEIGHT, ON PURPOSE: the guarantee
// under test is "the disagreement cannot occur below 88,000". If V29_HEIGHT is mutated DOWN, the observed
// divergence height drops below 88,000 and the assertions below RED. (Importing the constant would move the
// behaviour and the threshold together and the fixture would never catch the mutation.)
import assert from "node:assert/strict";
import { resolve, canonicalState, requiredFillOutputs, deploy, mint, offer, fclaim,
         V28_HEIGHT, V29_HEIGHT, EPOCH_LEN, DEPLOY_FEE, SCORE_FILL, MAX_ACTIVE_CLAIMS, TREASURY_ADDR } from "../src/index.js";

const OPERATOR_V29 = 88_000;   // the operator decision (2026-07-20). The divergence MUST NOT occur below this.
assert.equal(V29_HEIGHT, OPERATOR_V29, `sanity: shipped V29_HEIGHT ${V29_HEIGHT} != operator floor ${OPERATOR_V29}`);
assert.ok(OPERATOR_V29 > V28_HEIGHT, "V29 must sit above V28");

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
let n = 1; const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
const epochOf = (h: number) => Math.floor(h / EPOCH_LEN);
type Ev = Parameters<typeof resolve>[0][number];
const PE = (b: { uri: string; payloadHash: string }, h: number, who: string, ee: number, pos = 0, paidTo: Record<string, string> = {}, id = nid()): Ev =>
  ({ kind: "propose", id, proposer: who, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height: h, pos, paidTo });
const AE = (pid: string, who: string, h: number, paidTo: Record<string, string>, score = SCORE_FILL, confidence = 0, pos = 0): Ev =>
  ({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence, height: h, pos, paidTo });
const roots = (): Ev[] => ([
  PE(deploy({ ticker: "AAA", decimals: 0, supply: "100000", mint: "issuer" }), 40000, A, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(mint({ ticker: "AAA", amount: "100000" }), 40001, A, 9e9, 0, {}),
]);
const mkOffer = (id: string, h: number, min?: string): Ev =>
  PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A }, ...(min ? { min } : {}) }), h, A, 9e9, 0, {}, id);
const payFor = (ev: Ev[], oid: string, pay: string, tip: number) =>
  Object.fromEntries(requiredFillOutputs(resolve(ev, tip).offers[oid]!, pay)!.map((x) => [x.to, String(x.value)]));

// ── M5 (the RELAXATION) divergence, RIGID in `h` (the 4th fclaim's height): the whole scenario translates with
//    h so the three prior holds are always live at the 4th claim regardless of h. Stale DENIES the 4th; upgraded
//    GRANTS it at h >= V29. Observable: is the 4th claim granted? ──
function m5Granted(h: number): boolean {
  n = 1;
  const gh = h - 20, E = epochOf(gh) + 2;            // holds live: claimUntil = (E+1)*30 > h for every h
  const o1 = nid(), o2 = nid(), o3 = nid(), o4 = nid();
  const ev = [...roots(), mkOffer(o1, gh), mkOffer(o2, gh), mkOffer(o3, gh), mkOffer(o4, gh)];
  const g1 = PE(fclaim({ offer: o1 }), gh, B, E, 0, {}); ev.push(g1);
  const g2 = PE(fclaim({ offer: o2 }), gh, B, E, 1, {}); ev.push(g2);
  const g3 = PE(fclaim({ offer: o3 }), gh, B, E, 2, {}); ev.push(g3);
  for (const [oid, g] of [[o1, g1], [o2, g2], [o3, g3]] as const) ev.push(AE(g.id, B, gh + 5, payFor(ev, oid, "500000000", gh + 5)));
  ev.push(PE(fclaim({ offer: o4 }), h, B, epochOf(h) + 2, 0, {}));
  return resolve(ev, h + 60).offers[o4]!.claimedBy === B;
}
// ── M4 (reject-more) divergence, RIGID in `h` (the duplicated fill's height): stale DOUBLE-credits; upgraded
//    de-dupes at h >= V29. Observable: is only ONE credit applied (paid == the single payment, offer still open)? ──
function m4Deduped(h: number): boolean {
  n = 1;
  const gh = h - 5, E = epochOf(gh) + 2, oid = nid();
  const ev = [...roots(), mkOffer(oid, gh, "100000000")];
  const g = PE(fclaim({ offer: oid }), gh, B, E, 0, {}); ev.push(g);
  const fill = AE(g.id, B, h, payFor(ev, oid, "400000000", gh + 2));
  ev.push(fill); ev.push({ ...fill });
  const o = resolve(ev, h + 20).offers[oid]!;
  return o.paid === "400000000" && o.status === "open";   // single credit == de-duped
}

// firstFlip: the smallest height at which the observable flips away from its deep-stale value (a monotonic step).
function firstFlip(observe: (h: number) => boolean, staleH: number, lo: number, hi: number): number {
  const stale = observe(staleH);
  assert.equal(stale, observe(OPERATOR_V29 - 1), "stale reference must equal the just-below-gate verdict (no fork below the gate)");
  let flip = -1;
  for (let h = lo; h <= hi; h++) if (observe(h) !== stale) { flip = h; break; }
  return flip;
}

let checks = 0;
const V28plus = V28_HEIGHT + 500;   // a deep-below-gate reference height (valid fclaim, far under any real gate)

// ── M5 fork-lens ──
{
  assert.equal(m5Granted(OPERATOR_V29 - 1), false, "M5: a STALE replayer denies the 4th claim just below the gate (upgraded agrees below the gate)");
  assert.equal(m5Granted(OPERATOR_V29), true, "M5: an UPGRADED replayer GRANTS the 4th claim at the gate (the divergence)");
  const flip = firstFlip(m5Granted, V28plus, OPERATOR_V29 - 8, OPERATOR_V29 + 8);
  assert.equal(flip, OPERATOR_V29, `M5 divergence height must be exactly the operator floor ${OPERATOR_V29}, got ${flip}`);
  assert.ok(flip >= 88_000, `M5 fork sequence must not diverge below 88,000 (got ${flip})`);
  checks += 3;
}
// ── M4 fork-lens ──
{
  assert.equal(m4Deduped(OPERATOR_V29 - 1), false, "M4: a STALE replayer double-credits just below the gate (upgraded agrees below the gate)");
  assert.equal(m4Deduped(OPERATOR_V29), true, "M4: an UPGRADED replayer de-dupes at the gate (single credit)");
  const flip = firstFlip(m4Deduped, V28plus, OPERATOR_V29 - 8, OPERATOR_V29 + 8);
  assert.equal(flip, OPERATOR_V29, `M4 divergence height must be exactly the operator floor ${OPERATOR_V29}, got ${flip}`);
  assert.ok(flip >= 88_000, `M4 fork sequence must not diverge below 88,000 (got ${flip})`);
  checks += 3;
}

console.log(`fork-lens-v29: ${checks} divergence-height assertions pass; the M4+M5 upgraded/stale disagreement occurs at exactly ${OPERATOR_V29} and never below it (cap=${MAX_ACTIVE_CLAIMS}).`);
