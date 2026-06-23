// Generator for the post-v1.8 conformance vectors — the classes that ship in consensus but were NOT in
// the regenerable cases.json bar (a 3rd-party resolver could pass all prior vectors and still fork on
// these): v1.9 nprofile, v2.0 (V20) claim grace/late-fill, v2.1 (V21) offer-duration cap, name ops
// (nset/nxfer/nrenew/tmeta), lapsed-lease premium reclaim, claim cooldown + MAX_ACTIVE_CLAIMS, and key
// rejection paths. expectedState is derived from the SHIPPING JS resolver; the cross-impl harness then
// proves the Python reference is byte-identical on every one. Re-runnable: strips its own cases first.
// Run: node conformance/gen-post-v18-vectors.mjs   (build dist first)
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, payloadHash } from "@inversealtruism/csd-codec";
import {
  nameCommit, resolve, canonicalState, makerRebate, tradeFee, epochOf,
  V17_HEIGHT, V19_HEIGHT, V20_HEIGHT, V21_HEIGHT, MAX_OFFER_EPOCHS,
  NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS, MAX_ACTIVE_CLAIMS,
} from "../packages/cairnx/dist/index.js";

const TREASURY = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const SALT = "00ffee1122334455";
let idn = 0xf1900000;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
const BIGFEE = { [TREASURY]: "100000000000" };  // 1000 CSD — generous overpay (covers even the ~134 CSD max lapsed-reclaim premium); resolver charges the REQUIRED fee into feesPaid (overpay never inflates canonical state)

// a Propose event carrying a CairnX record
const P = (record, { height, pos = 1, proposer = A, expiresEpoch = 5000, paidTo = {} }) => ({
  kind: "propose", id: nid(), proposer, uri: canonicalJson(record), payloadHash: payloadHash(record), height, pos, expiresEpoch, paidTo,
});
// attest events (claim score=50, fill score=100, cancel score=0)
const claim = (offerId, who, height) => ({ kind: "attest", txid: nid(), proposalId: offerId, attester: who, score: 50, confidence: 0, height, pos: 1, paidTo: {} });
const fill = (offerId, who, height, paidTo, confidence = 0) => ({ kind: "attest", txid: nid(), proposalId: offerId, attester: who, score: 100, confidence, height, pos: 2, paidTo });
// commit→reveal registration paying a generous fee (overpay accepted; required fee lands in feesPaid)
const register = (name, cH, rH, owner = A) => [
  P({ v: 1, t: "ncommit", commit: nameCommit(name, SALT, owner) }, { height: cH, proposer: owner }),
  P({ v: 1, t: "name", name, salt: SALT }, { height: rH, proposer: owner, paidTo: BIGFEE }),
];

const built = [];
const add = (name, events, tipHeight) => {
  const st = JSON.parse(canonicalState(resolve(events, tipHeight)));
  built.push({ name, events, tipHeight, expectedState: st });
  return st;
};

// ─────────────────────────── v1.9 nprofile (≥ V19; place ≥ V18 so the simple 2-tier name fee applies) ───────────────────────────
const NB = 40050; // name-base height (≥V18 ⇒ ≥5-char fee = 3 CSD; ≥V19 ⇒ nprofile active)
add("v19-nprofile-set", [
  ...register("alice", NB, NB + 2),
  P({ v: 1, t: "nprofile", name: "alice", p: { url: "https://alice.example", "eth.address": "0xdead" } }, { height: NB + 4 }),
], NB + 10);
add("v19-nprofile-empty-clears", [
  ...register("alice", NB, NB + 2),
  P({ v: 1, t: "nprofile", name: "alice", p: { url: "x" } }, { height: NB + 4 }),
  P({ v: 1, t: "nprofile", name: "alice", p: {} }, { height: NB + 6 }),
], NB + 10);
add("v19-nprofile-cleared-on-xfer", [
  ...register("alice", NB, NB + 2),
  P({ v: 1, t: "nprofile", name: "alice", p: { url: "x" } }, { height: NB + 4 }),
  P({ v: 1, t: "nset", name: "alice", addr: B }, { height: NB + 5 }),
  P({ v: 1, t: "nxfer", name: "alice", to: B }, { height: NB + 6 }),
], NB + 10);
add("v19-nprofile-nonowner-noop", [
  ...register("alice", NB, NB + 2),
  P({ v: 1, t: "nprofile", name: "alice", p: { url: "evil" } }, { height: NB + 4, proposer: C }),
], NB + 10);
add("v19-nprofile-dormant-below-gate", [   // nprofile before V19 = forward-compat no-op
  ...register("bob", V19_HEIGHT - 50, V19_HEIGHT - 48),
  P({ v: 1, t: "nprofile", name: "bob", p: { url: "x" } }, { height: V19_HEIGHT - 40 }),
], V19_HEIGHT - 30);

// ─────────────────────────── name ops (nset / nxfer / nrenew / tmeta) ───────────────────────────
add("nameop-nset-resolves", [...register("carol", NB, NB + 2), P({ v: 1, t: "nset", name: "carol", addr: B }, { height: NB + 4 })], NB + 10);
add("nameop-nxfer-clears-addr", [
  ...register("carol", NB, NB + 2),
  P({ v: 1, t: "nset", name: "carol", addr: B }, { height: NB + 4 }),
  P({ v: 1, t: "nxfer", name: "carol", to: C }, { height: NB + 6 }),
], NB + 10);
add("nameop-nrenew-extends-term", [...register("dave", NB, NB + 2), P({ v: 1, t: "nrenew", name: "dave" }, { height: NB + 4, paidTo: BIGFEE })], NB + 10);
// tmeta (issuer-only token metadata)
const DEPLOY = (ticker, owner = A, mint = "issuer", supply = "1000000", height = NB - 5) =>
  P({ v: 1, t: "deploy", ticker, decimals: 0, supply, mint, ...(mint === "open" ? { mintLimit: "1000" } : {}) }, { height, proposer: owner, paidTo: { [TREASURY]: "100000000" } });
add("tmeta-issuer-sets", [DEPLOY("TKN"), P({ v: 1, t: "tmeta", ticker: "TKN", hash: "0x" + "ab".repeat(32) }, { height: NB, proposer: A })], NB + 10);
add("tmeta-nonissuer-noop", [DEPLOY("TKN"), P({ v: 1, t: "tmeta", ticker: "TKN", hash: "0x" + "cd".repeat(32) }, { height: NB, proposer: C })], NB + 10);

// ─────────────────────────── v2.0 (V20) claim grace / late-fill (the 69.csd class) — open CSD-priced token offer ───────────────────────────
const want = 4500000000n;                                  // 45 CSD
const sellPay = (seller) => ({ [seller]: (want + makerRebate(want)).toString(), [TREASURY]: tradeFee(want, 150).toString() });
// open offer: A sells 10 TKN for `want` CSD, no taker ⇒ V17 claim-to-fill lane
const openOffer = (offH, seller = A, exp = epochOf(offH) + 200) => {
  const offerId = nid();
  const evs = [
    DEPLOY("TKN", seller, "issuer", "1000000", offH - 5),
    P({ v: 1, t: "mint", ticker: "TKN", amount: "100" }, { height: offH - 2, proposer: seller }),
    { kind: "propose", id: offerId, proposer: seller, uri: canonicalJson({ v: 1, t: "offer", give: { ticker: "TKN", amount: "10" }, want: { value: want.toString() } }), payloadHash: payloadHash({ v: 1, t: "offer", give: { ticker: "TKN", amount: "10" }, want: { value: want.toString() } }), height: offH, pos: 1, expiresEpoch: exp, paidTo: {} },
  ];
  return { evs, offerId };
};
{ const V = V20_HEIGHT + 50, until = V + CLAIM_WINDOW_BLOCKS_V20;          // claim ≥V20 ⇒ window 40 + grace 5
  const { evs, offerId } = openOffer(V - 10);
  add("v20-fill-at-window-boundary-delivered", [...evs, claim(offerId, B, V), fill(offerId, B, until, sellPay(A))], until + CLAIM_FILL_GRACE_BLOCKS + 5); }
{ const V = V20_HEIGHT + 50, holdEnd = V + CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS;
  const { evs, offerId } = openOffer(V - 10);
  add("v20-fill-past-hold-rejected", [...evs, claim(offerId, B, V), fill(offerId, B, holdEnd, sellPay(A))], holdEnd + 5); }
{ const V = V20_HEIGHT + 50, until = V + CLAIM_WINDOW_BLOCKS_V20;
  const { evs, offerId } = openOffer(V - 10);                              // rival claim during hold rejected; B still fills
  add("v20-in-hold-rival-claim-rejected", [...evs, claim(offerId, B, V), claim(offerId, C, until), fill(offerId, B, until + 2, sellPay(A))], until + CLAIM_FILL_GRACE_BLOCKS + 5); }
{ const V = V20_HEIGHT + 50, holdEnd = V + CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS; // clean handoff: C claims after hold, C fills
  const { evs, offerId } = openOffer(V - 10);
  add("v20-handoff-after-hold", [...evs, claim(offerId, B, V), claim(offerId, C, holdEnd), fill(offerId, C, holdEnd + 3, sellPay(A))], holdEnd + 20); }
// MAX_ACTIVE_CLAIMS: one address holding the cap, a 4th concurrent claim rejected
{ const V = V20_HEIGHT + 50;
  const offers = Array.from({ length: MAX_ACTIVE_CLAIMS + 1 }, () => openOffer(V - 10));
  const evs = offers.flatMap((o) => o.evs).concat(offers.map((o) => claim(o.offerId, B, V)));
  add("v20-max-active-claims-cap", evs, V + 5); }

// ─────────────────────────── v2.1 (V21) offer-duration cap ───────────────────────────
const offerAt = (offH, exp, give = { ticker: "TKN", amount: "10" }) => {
  const id = nid();
  return { id, ev: [DEPLOY("TKN", A, "issuer", "1000000", offH - 5), P({ v: 1, t: "mint", ticker: "TKN", amount: "100" }, { height: offH - 2 }),
    { kind: "propose", id, proposer: A, uri: canonicalJson({ v: 1, t: "offer", give, want: { value: "100000000" }, taker: B }), payloadHash: payloadHash({ v: 1, t: "offer", give, want: { value: "100000000" }, taker: B }), height: offH, pos: 1, expiresEpoch: exp, paidTo: {} }] };
};
{ const offH = V21_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS + 1; const { ev } = offerAt(offH, exp); add("v21-overcap-offer-rejected", ev, offH + 5); }
{ const offH = V21_HEIGHT + 100, exp = epochOf(offH) + MAX_OFFER_EPOCHS;     const { ev } = offerAt(offH, exp); add("v21-atcap-offer-accepted", ev, offH + 5); }
{ const offH = V21_HEIGHT - 5000, exp = epochOf(offH) + 1000; const { ev } = offerAt(offH, exp);  // created pre-V21 (accepted, over-cap); its capped expiry (anchorEp+168) sits below V21 ⇒ swept the moment tip ≥ V21
  add("v21-precap-overcap-swept-at-gate", ev, V21_HEIGHT + 2000); }

// ─────────────────────────── lapsed-lease premium reclaim (viaFill basis) ───────────────────────────
{ const cH = NB, rH = NB + 2;
  const claimEpoch = epochOf(rH); const lapseEpoch = claimEpoch + NAME_TERM_EPOCHS + NAME_GRACE_EPOCHS + 5;
  const reclaimH = lapseEpoch * 30 + 3;                                     // a height whose epoch is past lease+grace
  add("nameop-lapsed-premium-reclaim", [
    ...register("erin", cH, rH),                                            // A owns erin, lease = claimEpoch + 8760
    P({ v: 1, t: "name", name: "erin" }, { height: reclaimH, proposer: C, paidTo: BIGFEE }),  // C reclaims lapsed name (DIRECT claim, no salt) at the decaying premium
  ], reclaimH + 10); }

// ─────────────────────────── key rejection paths ───────────────────────────
add("reject-issuer-only-mint", [DEPLOY("TKN"), P({ v: 1, t: "mint", ticker: "TKN", amount: "5" }, { height: NB, proposer: C })], NB + 10);           // non-deployer mint of an issuer token → no-op
add("reject-supply-exhausted", [DEPLOY("TKN", A, "issuer", "10"),
  P({ v: 1, t: "mint", ticker: "TKN", amount: "10" }, { height: NB, proposer: A }),
  P({ v: 1, t: "mint", ticker: "TKN", amount: "5" }, { height: NB + 1, proposer: A })], NB + 10);                                                     // 2nd mint clamps to 0
add("reject-name-too-young-to-sell", [   // direct claim (no commit) then offer within COMMIT_MAX_BLOCKS → offer rejected (v1.3 age-gate)
  P({ v: 1, t: "name", name: "frank" }, { height: NB, paidTo: BIGFEE }),
  P({ v: 1, t: "offer", give: { name: "frank" }, want: { value: "100000000" }, taker: B }, { height: NB + 5, expiresEpoch: epochOf(NB) + 50 }),
], NB + 10);
add("reject-token-fill-no-confidence", [   // token-priced offer; fill without the confidence=1e6 opt-in marker → rejected
  DEPLOY("TKN"), DEPLOY("PAY", B), P({ v: 1, t: "mint", ticker: "TKN", amount: "100" }, { height: NB - 1 }),
  P({ v: 1, t: "mint", ticker: "PAY", amount: "100" }, { height: NB - 1, proposer: B }),
  (() => { const id = nid(); globalThis.__rid = id; return { kind: "propose", id, proposer: A, uri: canonicalJson({ v: 1, t: "offer", give: { ticker: "TKN", amount: "10" }, want: { ticker: "PAY", amount: "5" }, taker: B }), payloadHash: payloadHash({ v: 1, t: "offer", give: { ticker: "TKN", amount: "10" }, want: { ticker: "PAY", amount: "5" }, taker: B }), height: NB, pos: 1, expiresEpoch: 5000, paidTo: {} }; })(),
  fill(globalThis.__rid, B, NB + 2, {}, 0),   // confidence 0, not 1000000 → no-op
], NB + 10);

// ─── report a one-line sanity summary per vector so a human can verify intent ───
for (const c of built) {
  const s = c.expectedState;
  const names = Object.keys(s.names || {}); const offers = Object.values(s.offers || {});
  const offStatus = offers.map((o) => o.status).join(",");
  const bal = Object.entries(s.balances || {}).map(([t, m]) => `${t}:${Object.keys(m).length}`).join(" ");
  console.log(`  ${c.name.padEnd(38)} feesPaid=${s.feesPaid} names=[${names}] offers=[${offStatus}] bal{${bal}}` +
    (names.length ? ` profile=${names.map((n) => s.names[n].profile ? "Y" : "-").join("")} viaFill=${names.map((n) => s.names[n].viaFill ? "F" : "-").join("")}` : ""));
}

const path = new URL("../packages/cairnx/test/vectors/cases.json", import.meta.url);
const doc = JSON.parse(readFileSync(path, "utf8"));
const PREFIXES = ["v19-", "v20-", "v21-", "nameop-", "tmeta-", "reject-"];
const before = doc.cases.length;
doc.cases = doc.cases.filter((c) => !PREFIXES.some((p) => c.name.startsWith(p))).concat(built);
writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
console.log(`\nwrote ${built.length} post-v18 vectors → cases.json (${before} → ${doc.cases.length} total)`);
