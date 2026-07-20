// proven-terms-classification.mjs (B6 rider; referenced from CONSENSUS_CHANGES.md "V28+ rollout checklist").
//
// The EXECUTABLE field-classification tripwire for the proven-terms model. The 2026-07-19 audit's theme 1:
// the terms model was shaped like a CSD invoice, and every field OUTSIDE that question (give, want type,
// fill progress) was fetched-but-never-consulted - W1/W2/W3/W7/W10 are that one defect from five consumers.
// The durable cure is not a bigger comparator; it is making "a field nobody classified" IMPOSSIBLE:
// every field a resolver can serve on an offer must be either BOUND by the shared term bind
// (bindOfferTerms + provenOfferTerms + verifyFillSpv's own re-derivation) or DELIBERATELY UNBOUND WITH A
// WRITTEN REASON. A new gate that adds an offer field (V29+) fails this script until the field is
// classified - that is the point; classify it in the same change.
//
// Also fails on a STALE classification (a listed field the resolver no longer produces), so the list
// cannot rot into false confidence.
import { resolve, deploy, mint, offer, bid, fclaim, requiredFillOutputs, nameCommit, nameCommitRecord, nameClaim, nameFinalize, nameRegFee, REG_COMMIT_MAX_BLOCKS, SCORE_FILL, V28_HEIGHT, EPOCH_LEN, DEPLOY_FEE, TREASURY_ADDR, epochOf } from "../packages/cairnx/dist/index.js";

const BOUND = {
  height: "bindOfferTerms height leg", feeBps: "bindOfferTerms feeBps leg (= feeBpsAt(proven height))",
  taker: "bindOfferTerms taker leg", bid: "bindOfferTerms bid leg", min: "bindOfferTerms min leg (presence + value)",
  "want.value": "bindOfferTerms value leg (proven-CSD offers)",
  "give.ticker": "bindOfferTerms give leg (B6a, opt-in)", "give.amount": "bindOfferTerms give leg (B6a, opt-in)",
  "give.name": "bindOfferTerms give leg (B6a, opt-in)",
};
const DELIBERATELY_UNBOUND_WITH_REASON = {
  id: "the lookup key itself; the caller selects the offer BY id and verifyFillSpv merkle-binds the id to the on-chain Propose",
  seller: "prevout-bound (consensus hash160 of input[0]); bound via bindProvenOffer's seller/payto derivation, not the terms comparator",
  status: "resolver-derived lifecycle; NEVER trusted served - verifyFillSpv replays it from merkle-proven events",
  expiresEpoch: "hold/expiry timing is re-derived (fclaimHoldEnd + the replay); a served value is display-only",
  paid: "running fill state, not merkle-provable; binding it would false-refuse every partially-filled offer - the B6a sums seam binds the CONSEQUENCE (per-address payment sums vs the replayed state)",
  delivered: "running fill state, same reason as paid (resolve.ts copies give verbatim and tracks delivered separately)",
  fills: "diagnostic history; excluded from what any payment sizes",
  claimedBy: "hold state; verifyFillSpv replays the grant (replayLiveHold) instead of trusting it",
  claimUntilHeight: "hold state; replayed, and claimWindowOf/claimGraceOf derive windows from it fclaim-aware (B6c)",
  claimTxid: "hold routing; replayed, and the Correction-1 target check (fillEndorsement/fillTargetId) consumes it",
  "want.payto": "bound via bindProvenOffer's payto derivation (record payto or proven author), not the terms comparator",
  "want.ticker": "PRESENCE (the want TYPE) is bound by the B6a wantType leg; the VALUE is a token-fill concern the CSD comparator does not size - a token-want filler must bind it against the proven record (W1 consumer-side bind)",
  "want.amount": "same as want.ticker: token-side settlement, outside the CSD payment comparator",
};

// ── a maximal fixture set: partial+filled+held, taker-bound, bid-answered, token-want, name-give ──
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
let n = 1; const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
const PE = (b_, h, who, ee, pos = 0, paidTo = {}, id = nid()) => ({ kind: "propose", id, proposer: who, uri: b_.uri, payloadHash: b_.payloadHash, expiresEpoch: ee, height: h, pos, paidTo });
const AE = (pid, who, h, paidTo, score = SCORE_FILL, conf = 0, pos = 0) => ({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence: conf, height: h, pos, paidTo });
const H = V28_HEIGHT;
const roots = [
  PE(deploy({ ticker: "AAA", decimals: 0, supply: "100000", mint: "issuer" }), 40000, A, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(mint({ ticker: "AAA", amount: "100000" }), 40001, A, 9e9),
  PE(deploy({ ticker: "BBB", decimals: 0, supply: "100000", mint: "issuer" }), 40002, A, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
];
// a sealed, finalized name owned by A (the v28-namegive recipe) so a give.name offer materializes too
const SALT = "a1a1a1a1a1a1a1a1", NAME = "tripname", W = REG_COMMIT_MAX_BLOCKS, C = H - 100;
const regRoots = [
  PE(nameCommitRecord({ commit: nameCommit(NAME, SALT, A) }), C, A, 9e14, 1, {}, nid()),
  PE(nameClaim({ name: NAME, salt: SALT }), C + 2, A, 9e14, 1, {}, nid()),
  PE(nameFinalize({ name: NAME, salt: SALT }), C + W + 2, A, 9e14, 1, { [TREASURY_ADDR]: String(nameRegFee(NAME, C + W + 2)) }, nid()),
];
const oPart = nid(), oTaker = nid(), oBid = nid(), oTok = nid(), oName = nid(), bidId = nid();
const ev = [...roots, ...regRoots,
  PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "1000000000", payto: A }, min: "100000000" }), H + 2, A, 9e9, 0, {}, oPart),
  PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "1", payto: A }, taker: B }), H + 2, A, 9e9, 0, {}, oTaker),
  PE(bid({ want: { ticker: "AAA", amount: "5" }, give: { value: "100000000" } }), H + 2, B, 9e9, 0, {}, bidId),
  PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "100000000", payto: A }, taker: B, bid: bidId }), H + 3, A, 9e9, 0, {}, oBid),
  PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5" } }), H + 3, A, 9e9, 0, {}, oTok),
  PE(offer({ give: { name: NAME }, want: { value: "1000000000", payto: A } }), H + 3, A, epochOf(H + 3) + 24, 0, {}, oName),
];
const g = PE(fclaim({ offer: oPart }), H + 3, B, epochOf(H + 3) + 2, 0, {}, nid());
const pay = Object.fromEntries(requiredFillOutputs(resolve([...ev, g], H + 5).offers[oPart], "400000000").map((x) => [x.to, String(x.value)]));
const st = resolve([...ev, g, AE(g.id, B, H + 6, pay)], H + 10);

// coverage floors, read back from the resolved artifact (a thin fixture must fail, not pass silently)
const oP = st.offers[oPart];
if (!(oP && oP.paid === "400000000" && oP.fills?.length === 1 && oP.claimTxid === g.id)) { console.error("FIXTURE VACUOUS: the partial+held offer did not materialize (paid/fills/claimTxid missing)"); process.exit(1); }
if (!(st.offers[oBid]?.bid === bidId)) { console.error("FIXTURE VACUOUS: the bid-answered offer did not link its bid"); process.exit(1); }
if (!(st.offers[oTok]?.want?.ticker === "BBB")) { console.error("FIXTURE VACUOUS: the token-want offer did not materialize"); process.exit(1); }
if (!(st.offers[oName]?.give?.name === NAME)) { console.error("FIXTURE VACUOUS: the name-give offer did not materialize"); process.exit(1); }

const seen = new Set();
for (const o of Object.values(st.offers)) {
  for (const k of Object.keys(o)) {
    if (k === "want" || k === "give") { for (const sk of Object.keys(o[k])) seen.add(`${k}.${sk}`); }
    else seen.add(k);
  }
}
const classified = new Set([...Object.keys(BOUND), ...Object.keys(DELIBERATELY_UNBOUND_WITH_REASON)]);
const unclassified = [...seen].filter((k) => !classified.has(k));
const stale = [...classified].filter((k) => !seen.has(k));
if (unclassified.length) {
  console.error(`UNCLASSIFIED offer field(s): ${unclassified.join(", ")}`);
  console.error("Every field a resolver can serve must be BOUND or DELIBERATELY_UNBOUND_WITH_REASON.");
  console.error("If a new gate added a field, classify it IN THE SAME CHANGE (see CONSENSUS_CHANGES.md V28+ checklist).");
  process.exit(1);
}
if (stale.length) { console.error(`STALE classification (listed but never produced): ${stale.join(", ")}`); process.exit(1); }
console.log(`proven-terms classification OK: ${seen.size} served offer fields all classified (${Object.keys(BOUND).length} BOUND, ${Object.keys(DELIBERATELY_UNBOUND_WITH_REASON).length} deliberately unbound with reasons)`);
