// Generator for the v2.8 fclaim (§31) conformance vectors: the JS byte-identity pin for cases.json (the
// cross-impl JS<->Python proof lives in v28-fclaim-crosslang.mjs). expectedState is derived from the SHIPPING
// JS resolver. Re-runnable: strips its own "v28-" cases first. Run: node conformance/gen-v28-vectors.mjs
import { readFileSync, writeFileSync } from "node:fs";
import {
  resolve, canonicalState, requiredFillOutputs, deploy, mint, offer, offerCancelAll, fclaim,
  nameCommit, nameCommitRecord, nameClaim, nameFinalize, nameRegFee,
  canonicalJson, payloadHash, V28_HEIGHT, EPOCH_LEN, DEPLOY_FEE, SCORE_FILL, SCORE_CANCEL, SCORE_CLAIM, epochOf,
  REG_COMMIT_MAX_BLOCKS, FCLAIM_MAX_EPOCH_AHEAD,
} from "../packages/cairnx/dist/index.js";

const T = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
let idn = 0xfc280000;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
const H0 = V28_HEIGHT, OID = "0x" + "0f".repeat(32);
const PE = (b, height, proposer, ee, pos = 0, paidTo = {}, id = nid()) =>
  ({ kind: "propose", id, proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo, score = SCORE_FILL, confidence = 0, pos = 0) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence, height, pos, paidTo });
const base = () => ([
  PE(deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H0, A, 9e9, 0, { [T]: String(DEPLOY_FEE) }, nid()),
  PE(mint({ ticker: "AAA", amount: "1000" }), H0 + 1, A, 9e9, 0, {}, nid()),
  PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } }), H0 + 2, A, 9e9, 0, {}, OID),
]);
const OFF = resolve(base(), H0 + 5).offers[OID];
const pay = Object.fromEntries(requiredFillOutputs(OFF, "500000000").map((x) => [x.to, String(x.value)]));
const E = epochOf(H0 + 3) + 2, holdEnd = (E + 1) * EPOCH_LEN - 1;
const grant = (who, pos = 0, offerId = OID, id = nid()) => PE(fclaim({ offer: offerId }), H0 + 3, who, E, pos, {}, id);

const built = [];
const add = (name, events, tipHeight) => { built.push({ name, events, tipHeight, expectedState: JSON.parse(canonicalState(resolve(events, tipHeight))) }); };

{ const g = grant(B); add("v28-grant-fclaim-fill", [...base(), g, AE(g.id, B, holdEnd, pay)], holdEnd + 5); }
{ const g = grant(B); add("v28-correction1-offer-txid-fill-rejected", [...base(), g, AE(OID, B, H0 + 10, pay)], H0 + 20); }
{ const oc = PE(offerCancelAll({}), H0 + 3, A, 9e9, 0, {}, nid()), g = grant(B, 1); add("v28-correction2-ocancel-pos-race", [...base(), oc, g], H0 + 10); }
{ const g = grant(B, 0), can = AE(OID, A, H0 + 3, {}, SCORE_CANCEL, 0, 0); add("v28-correction2-score0-cancel", [...base(), g, can], H0 + 10); }
{ const g = grant(C, 0, "0x" + "ee".repeat(32)); add("v28-denied-fclaim-fill-no-delivery", [...base(), g, AE(g.id, C, H0 + 10, { [A]: "500000000" })], H0 + 20); }
{ const tOID = nid(), to = PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "1", payto: A }, taker: B }), H0 + 3, A, 9e9, 0, {}, tOID);
  add("v28-laneb-taker-uncancellable", [...base(), to, AE(tOID, A, H0 + 5, {}, SCORE_CANCEL)], H0 + 10); }
add("v28-score-claim-sunset-rejected", [...base(), AE(OID, B, H0 + 3, {}, SCORE_CLAIM)], H0 + 10);

// v28 NAME-GIVE fclaim delivery (Plan 70 R2/R3 I1): an offer selling a .csd NAME, settled via an fclaim hold
// + whole fill → ownership transfers to the buyer (viaFill). This is the scenario the crosslang harness
// (v28-namegive-fclaim-crosslang.mjs) also drives against the independent Python oracle; pinning it here puts
// it through the golden vector self-check AND the crosscheck-resolve JS⇄Python differential. Derived from
// CONVENTION §15 (name fill delivery), §25/§27 (sealed reg + young-name sale embargo), §31 (fclaim).
{
  const SALT = "a1a1a1a1a1a1a1a1", NAME = "gemname", W = REG_COMMIT_MAX_BLOCKS;
  const cm = PE(nameCommitRecord({ commit: nameCommit(NAME, SALT, A) }), H0, A, 9e14, 1, {}, nid());
  const rv = PE(nameClaim({ name: NAME, salt: SALT }), H0 + 2, A, 9e14, 1, {}, nid());
  const finH = H0 + W + 2;
  const fin = PE(nameFinalize({ name: NAME, salt: SALT }), finH, A, 9e14, 1, { [T]: String(nameRegFee(NAME, finH)) }, nid());
  const offH = H0 + W + 3, nOID = nid();                       // clears effHeight + saleEmbargo(W); past finalize
  const nOffer = PE(offer({ give: { name: NAME }, want: { value: "1000000000", payto: A } }), offH, A, epochOf(offH) + 24, 0, {}, nOID);
  const gH = offH + 1, nE = epochOf(gH) + FCLAIM_MAX_EPOCH_AHEAD, nHoldEnd = (nE + 1) * EPOCH_LEN - 1;
  const ng = PE(fclaim({ offer: nOID }), gH, B, nE, 0, {}, nid());
  const roots = [cm, rv, fin, nOffer, ng];
  const nPay = Object.fromEntries(requiredFillOutputs(resolve(roots, nHoldEnd + 5).offers[nOID], "1000000000").map((x) => [x.to, String(x.value)]));
  add("v28-namegive-fclaim-fill", [...roots, AE(ng.id, B, nHoldEnd, nPay)], nHoldEnd + 5);
}

for (const c of built) { const s = c.expectedState; const offs = Object.values(s.offers || {}).map((o) => `${o.status}${o.claimTxid ? "/held" : ""}`).join(","); console.log(`  ${c.name.padEnd(42)} offers=[${offs}] feesPaid=${s.feesPaid}`); }

const path = new URL("../packages/cairnx/test/vectors/cases.json", import.meta.url);
const doc = JSON.parse(readFileSync(path, "utf8"));
const before = doc.cases.length;
doc.cases = doc.cases.filter((c) => !c.name.startsWith("v28-")).concat(built);
writeFileSync(path, JSON.stringify(doc, null, 1) + "\n");  // match the file's existing 1-space indent (minimal diff)
console.log(`\nwrote ${built.length} v28 vectors -> cases.json (${before} -> ${doc.cases.length} total)`);
