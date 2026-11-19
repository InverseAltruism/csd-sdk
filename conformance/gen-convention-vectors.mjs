// Generator for the convention vectors: rules that move canonical state on records any funded address can anchor, which
// CONVENTION.md left out or contradicted until the 2026-11-19 text correction, and which no other vector decided. Each
// vector is one an implementation following the earlier text fails. expectedState is derived from the SHIPPING JS
// resolver (the built dist); the Python oracle replays the same events in crosscheck-resolve.mjs. Re-runnable: rewrites
// the whole cases-convention.json each run, and refuses to write when a vector no longer shows the rule it pins.
// Run: node conformance/gen-convention-vectors.mjs (after building packages/cairnx).
//
// The vectors live in their own file so the files scripts/seal-differential.mjs freezes against its baseline
// (cases.json, cases-rules.json, cases-v29.json) keep their bytes.
//   pending-name-refuses-owner-ops  §28: nset, nprofile, a name offer, nrenew (by anyone) and nxfer on a reservation.
//   pending-name-shape              §28: a reservation is materialized with eight keys, no paidThroughEpoch.
//   closing-sweep-tip-29-mod-30     §5: offers and bids expire at the tip + 1 sweep, a name's `expired` at the tip epoch.
//   partial-zero-delivery           §12: a partial fill that delivers no unit is a no-op.
//   recommit-same-hash              §9: a re-anchored commit keeps its first height, so the window does not reopen.
//   salt-and-hash-forms             §3, §9: salt is 16 to 128 hex digits in either case; record hashes are lowercase.
//   bid-link-and-done               §13: any offer naming a known bid is linked; `done` only from `open`.
//   contest-reveal-position         §9, §28: the contest compares the reveal's position, not the commit's.
//   token-want-zero                 §3, §11: a token-priced offer may want "0".
//   recapture-premium-staircase     §17, §29: the premium is base × (1 + floor(19 × (720 − e) / 720)); the record keeps
//                                   the reveal's anchor.
//   ocancel-same-block-repost       §12b, §16: the give an ocancel releases is still locked in the cancel's block.
//   fees-owed-and-fill-paid         §5, §10: feesPaid counts fees owed; a whole fill's `paid` is what it paid; a treasury
//                                   offer names a payto.
//   bid-anchored-after-offer        §13: `done` looks the bid up at the fill; an offer is linked only when it applies.
//   fee-bps-zero-below-v11          §19: an offer anchored below V11 carries feeBps 0 and owes no trade fee.
//   csd-want-zero                   §3, §4.4: a CSD-priced offer may want "0".
//   reservation-at-finalize-by      §28: at a tip equal to finalizeBy the reservation is gone; a finalize there applied.
import { writeFileSync } from "node:fs";
import {
  resolve, canonicalState, canonicalJson, payloadHash, requiredFillOutputs, tradeFee, nameCommit, nameRegFee,
  expiredClaimFee, deploy, mint, transfer, offer, bid, offerCancelAll, nameCommitRecord, nameClaim, nameFinalize, nameSet,
  nameProfile, nameRenew, nameXfer, epochOf, V29_HEIGHT, V11_HEIGHT, ACTIVATION_HEIGHT, DEPLOY_FEE, SCORE_FILL,
  SCORE_CANCEL, CONF_TOKEN_FILL, TREASURY_ADDR, EPOCH_LEN, NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS,
} from "../packages/cairnx/dist/index.js";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
let idn = 0xc0e50000;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
const FAR = 9_000_000_000;
const PE = (b, height, proposer, ee, pos = 0, paidTo = {}, id = nid()) =>
  ({ kind: "propose", id, proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo = {}, score = SCORE_FILL, pos = 0, confidence = 0) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence, height, pos, paidTo });
// a canonical record the builders refuse
const raw = (obj) => ({ uri: canonicalJson(obj), payloadHash: payloadHash(obj) });
const toTreasury = (v) => ({ [TREASURY_ADDR]: String(v) });
const outputs = (o, value) => Object.fromEntries(requiredFillOutputs(o, value).map((x) => [x.to, String(x.value)]));

const H = V29_HEIGHT + 12_000;
const tokenRoots = (ticker = "AAA", who = A, h = H - 20, pos = 0) => [
  PE(deploy({ ticker, decimals: 0, supply: "1000", mint: "issuer" }), h, who, FAR, pos, toTreasury(DEPLOY_FEE)),
  PE(mint({ ticker, amount: "1000" }), h + 1, who, FAR, pos),
];
const register = (name, salt, who, h) => [
  PE(nameCommitRecord({ commit: nameCommit(name, salt, who) }), h, who, FAR),
  PE(nameClaim({ name, salt }), h + 1, who, FAR),
  PE(nameFinalize({ name, salt }), h + 10, who, FAR, 0, toTreasury(nameRegFee(name, h + 10))),
];

const built = [];
const fail = (name, what) => { throw new Error(`vector ${name} no longer shows the rule it pins: ${what}`); };
const codeOf = (st, id) => st.events.find((e) => e.id === id)?.code;
const add = (name, events, tipHeight, checks) => {
  const st = resolve(events, tipHeight);
  const s = JSON.parse(canonicalState(st));
  for (const [what, ok] of checks(st, s)) if (!ok) fail(name, what);
  built.push({ name, events, tipHeight, expectedState: s });
};

// §28: the owner of a reservation, and anyone renewing, acts on it only by nfinalize
{
  const name = "pendingops", salt = "00112233445566778899aabbccddeeff";
  const ops = [
    PE(nameSet({ name, addr: C }), H + 9, A, FAR, 0),
    PE(nameProfile({ name, p: { url: "https://example.org" } }), H + 9, A, FAR, 1),
    PE(offer({ give: { name }, want: { value: "100000000" }, taker: B }), H + 9, A, epochOf(H + 9) + 2, 2),
    PE(nameRenew({ name }), H + 9, B, FAR, 3, toTreasury(nameRegFee(name, H + 9))),
    PE(nameXfer({ name, to: C }), H + 9, A, FAR, 4),
  ];
  const ev = [
    PE(nameCommitRecord({ commit: nameCommit(name, salt, A) }), H, A, FAR),
    PE(nameClaim({ name, salt }), H + 1, A, FAR),
    ...ops,
    PE(nameFinalize({ name, salt }), H + 10, A, FAR, 0, toTreasury(nameRegFee(name, H + 10))),
  ];
  add("convention-pending-name-refuses-owner-ops", ev, H + 12, (st, s) => [
    ["every op on the reservation is NAME_PENDING", ops.every((e) => codeOf(st, e.id) === "NAME_PENDING")],
    ["the finalized name has its first owner and no addr or profile", s.names[name].owner === A && !("addr" in s.names[name]) && !("profile" in s.names[name])],
    ["no offer exists and feesPaid is the finalize fee alone", Object.keys(s.offers).length === 0 && s.feesPaid === String(nameRegFee(name, H + 10))],
  ]);
}

// §28: the materialized reservation
{
  const name = "pendingshape", salt = "0123456789abcdef0123456789abcdef";
  const ev = [PE(nameCommitRecord({ commit: nameCommit(name, salt, A) }), H, A, FAR), PE(nameClaim({ name, salt }), H + 1, A, FAR)];
  add("convention-pending-name-shape", ev, H + 5, (_st, s) => [
    ["the reservation has exactly the eight keys", JSON.stringify(Object.keys(s.names[name]).sort()) ===
      JSON.stringify(["claimId", "effectiveHeight", "finalizeBy", "height", "locked", "name", "owner", "pending"])],
  ]);
}

// §5: the closing sweep runs at tipHeight + 1 for offers and bids; a name lapses at the tip's own epoch
{
  const name = "sweepname", salt = "a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6";
  const lapseEpoch = epochOf(H + 10) + NAME_TERM_EPOCHS + NAME_GRACE_EPOCHS;   // the last epoch of the name's grace
  const tip = lapseEpoch * EPOCH_LEN + EPOCH_LEN - 1;                         // the last height of that epoch
  const E = epochOf(tip);
  const o = PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "1000" }, taker: B }), tip - 19, A, E, 0);
  const b = PE(bid({ want: { ticker: "AAA", amount: "10" }, give: { value: "1000" } }), tip - 19, B, E, 1);
  const ev = [...tokenRoots(), ...register(name, salt, A, H), o, b];
  add("convention-closing-sweep-tip-29-mod-30", ev, tip, (_st, s) => {
    const before = JSON.parse(canonicalState(resolve(ev, tip - 1)));
    return [
      ["the tip is 29 mod 30 and the offer and bid expire in its epoch", tip % EPOCH_LEN === EPOCH_LEN - 1 && E === lapseEpoch],
      ["offer and bid read expired and the give is unlocked", s.offers[o.id].status === "expired" && s.bids[b.id].status === "expired" && s.balances.AAA[A].locked === "0"],
      ["one height earlier both read open", before.offers[o.id].status === "open" && before.bids[b.id].status === "open"],
      ["the name is not expired at the tip epoch", !("expired" in s.names[name])],
      ["the name is expired one epoch later", JSON.parse(canonicalState(resolve(ev, tip + 1))).names[name].expired === true],
    ];
  });
}

// §12: a partial fill that delivers no unit
{
  const o = PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "1000" }, min: "1", taker: B }), H, A, epochOf(H) + 100);
  const zero = AE(o.id, B, H + 1, { [A]: "50", ...toTreasury(tradeFee(50n, 150)) });
  const one = AE(o.id, B, H + 2, { [A]: "100", ...toTreasury(tradeFee(100n, 150)) });
  add("convention-partial-zero-delivery", [...tokenRoots(), o, zero, one], H + 5, (st, s) => [
    ["the 50-unit payment is FILL_ZERO_DELIVERY", codeOf(st, zero.txid) === "FILL_ZERO_DELIVERY"],
    ["only the 100-unit fill is recorded", s.offers[o.id].paid === "100" && s.offers[o.id].delivered === "1" && s.offers[o.id].fills.length === 1],
  ]);
}

// §9: the commit's height is the first anchoring of its hash
{
  const name = "retryname", salt = "fedcba9876543210fedcba9876543210";
  const commit = nameCommitRecord({ commit: nameCommit(name, salt, A) });
  const reveal = PE(nameClaim({ name, salt }), H + 42, A, FAR);
  add("convention-recommit-same-hash", [PE(commit, H, A, FAR), PE(commit, H + 40, A, FAR), reveal], H + 45, (st, s) => [
    ["the reveal two blocks after the re-commit is NAME_NO_COMMIT", codeOf(st, reveal.id) === "NAME_NO_COMMIT"],
    ["no name is reserved", Object.keys(s.names).length === 0],
  ]);
}

// §3, §9: the salt form and the lowercase record hashes
{
  const salts = [["saltbad", "s3cret"], ["saltshort", "0123456789abcde"], ["saltupper", "0123456789ABCDEF"]];
  const reveals = salts.map(([name, salt], i) => [
    PE(nameCommitRecord({ commit: nameCommit(name, salt, A) }), H, A, FAR, i),
    PE(raw({ v: 1, t: "name", name, salt }), H + 1, A, FAR, i),
  ]);
  const b = PE(bid({ want: { ticker: "AAA", amount: "5" }, give: { value: "1000" } }), H, B, epochOf(H) + 10, 3);
  const upperBid = "0x" + b.id.slice(2).toUpperCase();
  if (upperBid === b.id) fail("convention-salt-and-hash-forms", "the bid id must hold hex letters");
  const tm = PE(raw({ v: 1, t: "tmeta", ticker: "AAA", hash: "0x" + "AB".repeat(32) }), H + 2, A, FAR, 0);
  const o = PE(raw({ v: 1, t: "offer", give: { ticker: "AAA", amount: "5" }, want: { value: "1000" }, taker: B, bid: upperBid }), H + 2, A, epochOf(H) + 10, 1);
  add("convention-salt-and-hash-forms", [...tokenRoots(), ...reveals.flat(), b, tm, o], H + 5, (st, s) => [
    ["a non-hex and a 15-digit salt are RECORD_BAD_SALT", codeOf(st, reveals[0][1].id) === "RECORD_BAD_SALT" && codeOf(st, reveals[1][1].id) === "RECORD_BAD_SALT"],
    ["16 upper-case hex digits reserve the name", codeOf(st, reveals[2][1].id) === "NAME_RESERVED" && JSON.stringify(Object.keys(s.names)) === '["saltupper"]'],
    ["an upper-case tmeta hash and bid id are RECORD_BAD_HASH", codeOf(st, tm.id) === "RECORD_BAD_HASH" && codeOf(st, o.id) === "RECORD_BAD_HASH"],
    ["no tmeta, no offer, no lock", !("tmeta" in s.tokens.AAA) && Object.keys(s.offers).length === 0 && s.balances.AAA[A].locked === "0"],
  ]);
}

// §13: the bid link and `done`
{
  const bidOf = (h, pos, ee) => PE(bid({ want: { ticker: "AAA", amount: "5" }, give: { value: "1000" } }), h, B, ee, pos);
  const b1 = bidOf(H, 0, epochOf(H) + 1), b2 = bidOf(H, 1, epochOf(H) + 10);
  const cancel2 = AE(b2.id, B, H, {}, SCORE_CANCEL);
  const answer = (pos, extra) => PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "1000" }, ...extra }), H + 1, A, epochOf(H) + 100, pos);
  const unknown = "0x" + "e7".repeat(32);
  const o1 = answer(0, { taker: C, bid: b1.id });                                    // another taker
  const o2 = PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "2000" }, taker: B, bid: b1.id }), H + 1, A, epochOf(H) + 100, 1); // above the bid
  const o3 = answer(2, { bid: b1.id });                                              // no taker
  const o4 = answer(3, { taker: B, bid: b1.id });                                    // the honest answer
  const o5 = answer(4, { taker: B, bid: b2.id });                                    // a cancelled bid
  const o6 = answer(5, { taker: B, bid: unknown });                                  // no such bid
  const ev = [...tokenRoots(), b1, b2, cancel2, o1, o2, o3, o4, o5, o6];
  const hFill = (epochOf(H) + 2) * EPOCH_LEN + 5;                                    // b1 has expired
  ev.push(AE(o4.id, B, hFill, outputs(resolve(ev, hFill - 1).offers[o4.id], "1000")));
  add("convention-bid-link-and-done", ev, hFill + 5, (_st, s) => [
    ["every offer naming b1 is linked, in apply order", JSON.stringify(s.bids[b1.id].offers) === JSON.stringify([o1.id, o2.id, o3.id, o4.id])],
    ["the offer naming the cancelled bid is linked", JSON.stringify(s.bids[b2.id].offers) === JSON.stringify([o5.id]) && s.bids[b2.id].status === "cancelled"],
    ["the bidder's fill after b1 expired leaves it expired", s.offers[o4.id].status === "filled" && s.bids[b1.id].status === "expired"],
    ["an offer naming no bid keeps its bid field", s.offers[o6.id].bid === unknown && s.offers[o6.id].status === "open"],
  ]);
}

// §9, §28: the contest key is the reveal's own position
{
  const name = "contest", sa = "aaaaaaaaaaaaaaaa1111111111111111", sb = "bbbbbbbbbbbbbbbb2222222222222222";
  const rA = PE(nameClaim({ name, salt: sa }), H + 3, A, FAR, 1), rB = PE(nameClaim({ name, salt: sb }), H + 4, B, FAR, 7);
  const ev = [
    PE(nameCommitRecord({ commit: nameCommit(name, sb, B) }), H, B, FAR, 2),
    PE(nameCommitRecord({ commit: nameCommit(name, sa, A) }), H, A, FAR, 5),
    rA, rB,
  ];
  add("convention-contest-reveal-position", ev, H + 6, (st, s) => [
    ["A, with the earlier reveal position and the later commit position, holds the reservation", s.names[name].owner === A && codeOf(st, rB.id) === "NAME_TAKEN_EARLIER"],
  ]);
}

// §3, §11: a token-priced offer that wants "0"
{
  const o = PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { ticker: "BBB", amount: "0" } }), H, A, epochOf(H) + 10);
  const f = AE(o.id, B, H + 1, {}, SCORE_FILL, 0, CONF_TOKEN_FILL);
  add("convention-token-want-zero", [...tokenRoots(), ...tokenRoots("BBB", C, H - 20, 1), o, f], H + 5, (st, s) => [
    ["the fill by an attester holding no BBB applies", codeOf(st, f.txid) === "FILL_APPLIED" && s.balances.AAA[B].available === "5" && s.balances.BBB?.[B] === undefined],
    ["it paid and owed nothing", s.offers[o.id].fill.paid === "0" && s.offers[o.id].fill.fee === "0"],
  ]);
}

// §17, §29: the recapture premium and the recaptured record's anchor
{
  const name = "lapsename", sa = "1234567890abcdef1234567890abcdef", sb = "abcdef1234567890abcdef1234567890";
  const graceEnd = epochOf(H + 10) + NAME_TERM_EPOCHS + NAME_GRACE_EPOCHS;
  const h0 = (graceEnd + 1) * EPOCH_LEN;                                            // the first height of the first lapsed epoch
  const commit = PE(nameCommitRecord({ commit: nameCommit(name, sb, B) }), h0, B, FAR);
  const reveal = PE(nameClaim({ name, salt: sb }), h0 + 2, B, FAR);
  const hFin = h0 + 12, e = epochOf(hFin) - graceEnd;
  const premium = expiredClaimFee(name, e, hFin), base = nameRegFee(name, hFin);
  const fin = PE(nameFinalize({ name, salt: sb }), hFin, B, FAR, 0, toTreasury(premium));
  add("convention-recapture-premium-staircase", [...register(name, sa, A, H), commit, reveal, fin], hFin + 8, (st, s) => [
    ["one epoch past the grace end the premium is 19 times the fee", e === 1 && premium === 19n * base],
    ["a linear reading asks more than the vector pays", 20n * base - (19n * base * BigInt(e)) / 720n > premium],
    ["the finalize applies", codeOf(st, fin.id) === "NAME_RECAPTURE_FINALIZED" && s.names[name].owner === B],
    ["the record keeps the reveal's anchor", s.names[name].claimId === reveal.id && s.names[name].height === reveal.height && s.names[name].effectiveHeight === commit.height],
    ["the lease runs from the finalize epoch", s.names[name].paidThroughEpoch === epochOf(hFin) + NAME_TERM_EPOCHS],
  ]);
}

// §12b, §16: a same-block re-post of what an ocancel releases
{
  const name = "laddername", salt = "0f1e2d3c4b5a69780f1e2d3c4b5a6978";
  const exp = epochOf(H + 20) + 100;
  const tokenOffer = (amount, h, pos) => PE(offer({ give: { ticker: "AAA", amount }, want: { value: "1000" } }), h, A, exp, pos);
  const nameOffer = (h, pos) => PE(offer({ give: { name }, want: { value: "1000" } }), h, A, exp, pos);
  const t1 = tokenOffer("600", H + 20, 0), n1 = nameOffer(H + 20, 1);
  const cancel = PE(offerCancelAll(), H + 30, A, FAR, 0);
  const t2 = tokenOffer("600", H + 30, 1), n2 = nameOffer(H + 30, 2), free = tokenOffer("400", H + 30, 3);
  const t3 = tokenOffer("600", H + 31, 0), n3 = nameOffer(H + 31, 1);
  add("convention-ocancel-same-block-repost", [...tokenRoots(), ...register(name, salt, A, H), t1, n1, cancel, t2, n2, free, t3, n3], H + 35, (st, s) => [
    ["the same-block re-posts of the released give are refused", codeOf(st, t2.id) === "TOKEN_BALANCE_LOW" && codeOf(st, n2.id) === "NAME_LOCKED"],
    ["the same-block offer from unlocked balance stands past the flush", s.offers[free.id].status === "open"],
    ["the ocancel closes the earlier offers", s.offers[t1.id].status === "cancelled" && s.offers[n1.id].status === "cancelled"],
    ["the next block's re-posts open", s.offers[t3.id].status === "open" && s.offers[n3.id].status === "open"],
  ]);
}

// §5, §10: feesPaid counts what applied records owed; a whole fill's `paid` is what it paid; a treasury offer
{
  const ev = [
    PE(deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H - 20, A, FAR, 0, toTreasury(5n * BigInt(DEPLOY_FEE))),
    PE(mint({ ticker: "AAA", amount: "1000" }), H - 19, A, FAR),
    PE(transfer({ ticker: "AAA", to: TREASURY_ADDR, amount: "20" }), H - 18, A, FAR, 0, toTreasury(200_000_000)),
  ];
  const tNoPayto = PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "1000" } }), H, TREASURY_ADDR, epochOf(H) + 10, 0);
  const tPayto = PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "1000", payto: C } }), H, TREASURY_ADDR, epochOf(H) + 10, 1);
  const o = PE(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "1000", payto: C }, taker: B }), H, A, epochOf(H) + 10, 2);
  const owed = tradeFee(1000n, 150);
  const f = AE(o.id, B, H + 1, { [C]: "3000", ...toTreasury(2n * owed) });
  ev.push(tNoPayto, tPayto, o, f);
  add("convention-fees-owed-and-fill-paid", ev, H + 5, (st, s) => [
    ["feesPaid is the deploy fee and the fee the fill owed", s.feesPaid === String(BigInt(DEPLOY_FEE) + owed)],
    ["the fill's paid is the 3000 it paid to payto", s.offers[o.id].fill.paid === "3000" && s.offers[o.id].fill.fee === String(owed)],
    ["the treasury's offer without payto is refused, with payto created", codeOf(st, tNoPayto.id) === "OFFER_PAYTO_TREASURY" && s.offers[tPayto.id].status === "open"],
  ]);
}

// §13: `done` looks the bid up at the fill; the link is made only when the offer applies
{
  const bidId = nid();
  const o = PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "1000" }, taker: B, bid: bidId }), H, A, epochOf(H) + 50);
  const b = PE(bid({ want: { ticker: "AAA", amount: "5" }, give: { value: "1000" } }), H + 1, B, epochOf(H) + 50, 0, {}, bidId);
  const ev = [...tokenRoots(), o, b];
  ev.push(AE(o.id, B, H + 2, outputs(resolve(ev, H + 1).offers[o.id], "1000")));
  add("convention-bid-anchored-after-offer", ev, H + 5, (_st, s) => [
    ["the bid anchored after the offer naming it ends done with no linked offer", s.offers[o.id].status === "filled" && s.bids[bidId].status === "done" && s.bids[bidId].offers.length === 0],
  ]);
}

// §19: an offer anchored below V11 carries feeBps 0 and its fill owes no trade fee
{
  const h = V11_HEIGHT - 90;
  const o = PE(offer({ give: { ticker: "OLD", amount: "10" }, want: { value: "1000" } }), h + 10, A, epochOf(h) + 50);
  const f = AE(o.id, B, h + 20, { [A]: "1000" });
  const ev = [PE(deploy({ ticker: "OLD", decimals: 0, supply: "100", mint: "issuer" }), h, A, FAR), PE(mint({ ticker: "OLD", amount: "100" }), h + 1, A, FAR), o, f];
  add("convention-fee-bps-zero-below-v11", ev, h + 30, (st, s) => [
    ["the offer is below V11 and above activation", o.height < V11_HEIGHT && h >= ACTIVATION_HEIGHT],
    ["feeBps 0, filled with no treasury output, fee 0", s.offers[o.id].feeBps === 0 && codeOf(st, f.txid) === "FILL_APPLIED" && s.offers[o.id].fill.fee === "0" && s.feesPaid === "0"],
  ]);
}

// §3, §4.4: a CSD-priced offer that wants "0"
{
  const o = PE(offer({ give: { ticker: "AAA", amount: "5" }, want: { value: "0" }, taker: B }), H, A, epochOf(H) + 10);
  const f = AE(o.id, B, H + 1, {});
  add("convention-csd-want-zero", [...tokenRoots(), o, f], H + 5, (st, s) => [
    ["the taker's fill with no outputs applies", codeOf(st, f.txid) === "FILL_APPLIED" && s.balances.AAA[B].available === "5"],
    ["it paid and owed nothing", s.offers[o.id].fill.paid === "0" && s.offers[o.id].fill.fee === "0"],
  ]);
}

// §28: at a tip equal to finalizeBy an un-finalized reservation is gone, and a finalize mined at that height applied
{
  const [n1, n2] = ["lastcall", "justintime"], [s1, s2] = ["1111222233334444aaaabbbbccccdddd", "5555666677778888eeeeffff00001111"];
  const ev = [
    PE(nameCommitRecord({ commit: nameCommit(n1, s1, A) }), H, A, FAR, 0), PE(nameCommitRecord({ commit: nameCommit(n2, s2, A) }), H, A, FAR, 1),
    PE(nameClaim({ name: n1, salt: s1 }), H + 1, A, FAR, 0), PE(nameClaim({ name: n2, salt: s2 }), H + 1, A, FAR, 1),
  ];
  const F = resolve(ev, H + 2).names[n1].finalizeBy;
  const fin = PE(nameFinalize({ name: n2, salt: s2 }), F, A, FAR, 0, toTreasury(nameRegFee(n2, F)));
  ev.push(fin);
  add("convention-reservation-at-finalize-by", ev, F, (st, s) => [
    ["both reservations end at the tip", F === resolve(ev.slice(0, 4), H + 2).names[n2].finalizeBy],
    ["the un-finalized one is gone at the tip", !(n1 in s.names)],
    ["the finalize at finalizeBy applied", codeOf(st, fin.id) === "NAME_FINALIZED" && !("pending" in s.names[n2])],
  ]);
}

for (const c of built) {
  const s = c.expectedState;
  console.log(`  ${c.name.padEnd(44)} events=${String(c.events.length).padStart(2)} tip=${c.tipHeight} names=[${Object.keys(s.names).join(",")}] offers=[${Object.values(s.offers).map((o) => o.status).join(",")}]`);
}
const path = new URL("../packages/cairnx/test/vectors/cases-convention.json", import.meta.url);
writeFileSync(path, JSON.stringify({ format: 2, generatedFrom: "shipping JS resolver", cases: built }, null, 1) + "\n");
console.log(`\nwrote ${built.length} convention vectors -> cases-convention.json`);
