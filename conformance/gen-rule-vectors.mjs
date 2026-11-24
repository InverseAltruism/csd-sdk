// Generator for the rule vectors: eight vectors pinning five resolver rules that move canonical state and that no other
// vector, replay hash or differential decides (the within-block order, vectors 1 to 3; the canonical uri, 4; the
// same-ticker offer, 5; the partial fill's tail, 6; the name contest's last key, 7 and 8). expectedState is derived from the SHIPPING JS resolver (the built dist); the Python oracle
// replays the same events in crosscheck-resolve.mjs. Re-runnable: rewrites the whole cases-rules.json each run.
// Run: node conformance/gen-rule-vectors.mjs (after building packages/cairnx).
//
// The vectors live in their OWN file so cases.json (the B6-era pinned corpus, frozen by scripts/seal-differential.mjs)
// stays byte-identical, as cases-v29.json does.
//   1, 2. Within a block every Propose applies before every Attest (resolve.ts, the sort's second key). A fill mined in
//         the block of the fclaim it attests delivers only under that order, here with the fill at the lower position
//         and in the natural order.
//   3.    A seller cancel mined in its offer's own block, at the lower position, cancels it.
//   4.    A record whose uri is not its canonical JSON is invalid even when payloadHash is the canonical form's hash.
//   5.    A token offer whose give and want are the same ticker is invalid.
//   6.    A partial offer's remainder below its min is bought by paying exactly the remainder (CONVENTION section 19,
//         "the tail is always buyable"): 7 tokens for 10 units, min 4, filled 4, 4 and then 2.
//   7, 8. Two reveals of one name with one commit height and one position: the lower id holds the reservation,
//         whichever reveal is mined later (the contest's keys are effective height, position, id).
import { writeFileSync } from "node:fs";
import {
  resolve, canonicalState, requiredFillOutputs, canonicalJson, payloadHash, deploy, mint, offer, fclaim,
  nameCommit, nameCommitRecord, nameClaim, V28_HEIGHT, DEPLOY_FEE, SCORE_FILL, SCORE_CANCEL, TREASURY_ADDR, epochOf,
} from "../packages/cairnx/dist/index.js";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
let idn = 0x2a1e0000;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
const PE = (b, height, proposer, ee, pos = 0, paidTo = {}, id = nid()) =>
  ({ kind: "propose", id, proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo, score = SCORE_FILL, pos = 0) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence: 0, height, pos, paidTo });
// a record built by hand: the canonical builders refuse what these vectors need to carry
const raw = (uri, obj) => ({ uri, payloadHash: payloadHash(obj) });

const H = V28_HEIGHT + 1000;
const roots = () => [
  PE(deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H - 20, A, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE(mint({ ticker: "AAA", amount: "1000" }), H - 19, A, 9e9),
];
const built = [];
const add = (name, events, tipHeight) => built.push({ name, events, tipHeight, expectedState: JSON.parse(canonicalState(resolve(events, tipHeight))) });

// 1, 2. the same-block fclaim fill
for (const [name, fillPos, fclaimPos] of [["rules-same-block-fclaim-fill-attest-first", 0, 1], ["rules-same-block-fclaim-fill", 1, 0]]) {
  const o = nid();
  const ev = [...roots(), PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } }), H, A, epochOf(H) + 100, 0, {}, o)];
  const fc = PE(fclaim({ offer: o }), H + 5, B, epochOf(H + 5) + 2, fclaimPos);
  const pay = Object.fromEntries(requiredFillOutputs(resolve(ev, H + 4).offers[o], "500000000").map((x) => [x.to, String(x.value)]));
  ev.push(fc, AE(fc.id, B, H + 5, pay, SCORE_FILL, fillPos));
  add(name, ev, H + 10);
}
// 3. the cancel in its offer's own block, at the lower position
{
  const o = nid();
  const ev = [...roots(), AE(o, A, H, {}, SCORE_CANCEL, 0), PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } }), H, A, epochOf(H) + 100, 1, {}, o)];
  add("rules-same-block-cancel-attest-first", ev, H + 10);
}
// 4. a non-canonical uri (keys out of order) committed with the canonical form's hash
{
  const obj = { v: 1, t: "deploy", ticker: "BBB", decimals: 0, supply: "1000", mint: "issuer" };
  const uri = JSON.stringify({ t: "deploy", v: 1, ticker: "BBB", decimals: 0, supply: "1000", mint: "issuer" });
  if (uri === canonicalJson(obj)) throw new Error("the vector's uri must not be canonical");
  add("rules-noncanonical-uri-deploy", [PE(raw(uri, obj), H, A, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) })], H + 10);
}
// 5. a token offer whose give and want are one ticker
{
  const obj = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "AAA", amount: "5" } };
  add("rules-same-ticker-offer", [...roots(), PE(raw(canonicalJson(obj), obj), H, A, epochOf(H) + 100)], H + 10);
}

// 6. the partial fill's tail, paid exactly
{
  const o = nid();
  const ev = [...roots(), PE(offer({ give: { ticker: "AAA", amount: "7" }, want: { value: "10", payto: A }, min: "4", taker: B }), H, A, epochOf(H) + 100, 0, {}, o)];
  for (const [i, pay] of ["4", "4", "2"].entries()) {
    const outs = requiredFillOutputs(resolve(ev, H + i).offers[o], pay);
    if (!outs) throw new Error(`fill ${i} of ${pay} is not deliverable`);
    ev.push(AE(o, B, H + 1 + i, Object.fromEntries(outs.map((x) => [x.to, String(x.value)]))));
  }
  add("rules-partial-fill-tail-below-min", ev, H + 10);
}
// 7, 8. the name contest's last key: the id, when effective height and position are equal
for (const [name, laterLower] of [["rules-name-contest-id-later-reveal-lower", true], ["rules-name-contest-id-later-reveal-higher", false]]) {
  const lo = nid(), hi = nid(), sa = "aa".repeat(8), sb = "bb".repeat(8);
  const [aId, bId] = laterLower ? [hi, lo] : [lo, hi];
  add(name, [
    PE(nameCommitRecord({ commit: nameCommit("tiebreak", sa, A) }), H, A, epochOf(H) + 100, 0),
    PE(nameCommitRecord({ commit: nameCommit("tiebreak", sb, B) }), H, B, epochOf(H) + 100, 1),
    PE(nameClaim({ name: "tiebreak", salt: sa }), H + 1, A, epochOf(H) + 100, 0, {}, aId),
    PE(nameClaim({ name: "tiebreak", salt: sb }), H + 2, B, epochOf(H) + 100, 0, {}, bId),
  ], H + 3);
}

for (const c of built) {
  const s = c.expectedState;
  const offs = Object.values(s.offers || {}).map((o) => o.status).join(",");
  const names = Object.entries(s.names || {}).map(([n, v]) => `${n}:${v.owner.slice(0, 6)}`).join(",");
  console.log(`  ${c.name.padEnd(44)} tokens=[${Object.keys(s.tokens || {}).join(",")}] offers=[${offs}] names=[${names}]`);
}
const path = new URL("../packages/cairnx/test/vectors/cases-rules.json", import.meta.url);
writeFileSync(path, JSON.stringify({ format: 2, generatedFrom: "shipping JS resolver", cases: built }, null, 1) + "\n");
console.log(`\nwrote ${built.length} rule vectors -> cases-rules.json`);
