// Generator for the token-move vectors (CONVENTION §41): each case is an event list, a tip and, written here by hand, the
// log entries of resolve(events, tip) that carry moves, in log order, each as { id, kind, moves }; every other entry
// carries none. The built dist must give exactly them, each case must still show the state it pins and pass
// conformance/moves-check.mjs, or nothing is written. Re-runnable: rewrites the whole moves.json each run.
// Run: node conformance/gen-moves-vectors.mjs (after building packages/cairnx).
//   mint-open            an open mint credits the request, the mint limit when it names none, and the mint limit when it
//                        asks for more: the move carries the credit, not the request.
//   mint-remaining       the last open mint is capped at the remaining supply; one past it is refused and moves nothing.
//   mint-issuer          an issuer mint credits its amount, then the remaining supply; another key's mint moves nothing.
//   transfer             a transfer, one to the sender itself, and a transfer above the available balance (refused).
//   offer-cancel-expiry  two open offers lock, a cancel and an expiry release, all on one address: no moves.
//   csd-whole-fill       a whole fill of a CSD-priced token offer: the give, seller to buyer.
//   csd-partial-fill     three partial fills paying a payto that is not the seller: each move is the give units
//                        delivered, not the CSD paid, and comes from the seller.
//   token-fill-token     a token-for-token fill: the sale to payto, the fee to the treasury, then the give.
//   token-fill-name      a name sold for tokens: the sale and the fee, no give move.
//   token-fill-zero      a token-priced offer wanting "0": its fill writes only the give.
//   csd-name-fill        a name sold for CSD moves no token: no moves.
//   refused-fills        a token fill above the buyer's balance, one without the marker, a CSD fill short of the price.
//   token-fill-name-payto  a name sold for tokens with a payto that is neither the seller nor the buyer: the sale goes
//                        to payto.
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  resolve, deploy, mint, transfer, offer, nameCommit, nameRegFee, nameCommitRecord, nameClaim, nameFinalize,
  requiredFillOutputs, epochOf, V29_HEIGHT, SCORE_FILL, SCORE_CANCEL, CONF_TOKEN_FILL, TREASURY_ADDR, DEPLOY_FEE, EPOCH_LEN,
} from "../packages/cairnx/dist/index.js";
import { checkMoves } from "./moves-check.mjs";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20), T = TREASURY_ADDR;
let idn = 0xf0d00000;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
const FAR = 9_000_000_000;
const SALT = "00112233445566778899aabbccddeeff";
const PE = (b, height, proposer, ee = FAR, pos = 0, paidTo = {}) =>
  ({ kind: "propose", id: nid(), proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo = {}, score = SCORE_FILL, confidence = 0) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score, confidence, height, pos: 0, paidTo });
const toTreasury = (v) => ({ [T]: String(v) });
const H = V29_HEIGHT + 12_000;

const dep = (ticker, who, h, r) => PE(deploy({ ticker, decimals: 0, ...r }), h, who, FAR, 0, toTreasury(DEPLOY_FEE));
const open = (ticker, who, h, supply = "1000000", mintLimit = "1000000") => dep(ticker, who, h, { supply, mint: "open", mintLimit });
const mintOf = (ticker, who, h, amount) => PE(mint(amount === undefined ? { ticker } : { ticker, amount }), h, who);
const mv = (leg, ticker, from, to, amount) => ({ leg, ticker, from, to, amount });
const at = (e, kind, ...moves) => ({ id: e.kind === "propose" ? e.id : e.txid, kind, moves });
// a CSD fill paying what requiredFillOutputs asks for `pay` on the offer as it stands before the fill
const csdFill = (events, offerId, who, h, pay) => {
  const o = resolve(events, h - 1).offers[offerId];
  const outs = requiredFillOutputs(o, pay);
  if (!outs) throw new Error(`no outputs for ${offerId} at ${pay}`);
  return AE(offerId, who, h, Object.fromEntries(outs.map((x) => [x.to, String(x.value)])));
};
const tokenFill = (offerId, who, h) => AE(offerId, who, h, {}, SCORE_FILL, CONF_TOKEN_FILL);
// commit at h, reveal at h + 1, finalize at h + 10 (past the freeze of §28)
const register = (name, who, h) => [
  PE(nameCommitRecord({ commit: nameCommit(name, SALT, who) }), h, who),
  PE(nameClaim({ name, salt: SALT }), h + 1, who),
  PE(nameFinalize({ name, salt: SALT }), h + 10, who, FAR, 0, toTreasury(nameRegFee(name, h + 10))),
];

const built = [];
const fail = (name, what) => { throw new Error(`vector ${name} no longer shows what it pins: ${what}`); };
const add = (name, events, tipHeight, moves, shows) => {
  const st = resolve(events, tipHeight);
  for (const [what, ok] of shows(st)) if (!ok) fail(name, what);
  const got = st.events.filter((e) => Object.hasOwn(e, "moves")).map((e) => ({ id: e.id, kind: e.kind, moves: e.moves }));
  if (!isDeepStrictEqual(got, moves)) fail(name, `moves ${JSON.stringify(got)}, written ${JSON.stringify(moves)}`);
  const check = checkMoves(st, T, events);
  if (check.problems.length) fail(name, `moves-check: ${check.problems.join("; ")}`);
  built.push({ name, tipHeight, events, moves });
};
const bal = (st, t, a) => st.balances[t]?.[a];
const refusedAs = (st, e, code) => st.events.some((x) => x.id === (e.kind === "propose" ? e.id : e.txid) && !x.ok && x.code === code);

{
  const d = open("DUST", A, H, "1000", "100"), m1 = mintOf("DUST", A, H + 1), m2 = mintOf("DUST", B, H + 2, "30"), m3 = mintOf("DUST", C, H + 3, "500");
  add("mint-open", [d, m1, m2, m3], H + 4,
    [at(m1, "mint", mv("mint", "DUST", null, A, "100")), at(m2, "mint", mv("mint", "DUST", null, B, "30")), at(m3, "mint", mv("mint", "DUST", null, C, "100"))],
    (st) => [["minted 230", st.tokens.DUST?.minted === "230"], ["C asked 500, got 100", bal(st, "DUST", C)?.available === "100"]]);
}
{
  const d = open("DUST", A, H, "150", "100"), m1 = mintOf("DUST", A, H + 1), m2 = mintOf("DUST", B, H + 2), m3 = mintOf("DUST", C, H + 3);
  add("mint-remaining", [d, m1, m2, m3], H + 4,
    [at(m1, "mint", mv("mint", "DUST", null, A, "100")), at(m2, "mint", mv("mint", "DUST", null, B, "50"))],
    (st) => [["minted the supply", st.tokens.DUST?.minted === "150"], ["the third is refused", refusedAs(st, m3, "TOKEN_SUPPLY_EXHAUSTED")]]);
}
{
  const d = dep("ISSU", A, H, { supply: "1000", mint: "issuer" }), m1 = mintOf("ISSU", A, H + 1, "600"), m3 = mintOf("ISSU", B, H + 2, "1"), m2 = mintOf("ISSU", A, H + 3, "600");
  add("mint-issuer", [d, m1, m3, m2], H + 4,
    [at(m1, "mint", mv("mint", "ISSU", null, A, "600")), at(m2, "mint", mv("mint", "ISSU", null, A, "400"))],
    (st) => [["minted the supply", st.tokens.ISSU?.minted === "1000"], ["B is not the issuer", refusedAs(st, m3, "TOKEN_NOT_ISSUER")]]);
}
{
  const d = open("DUST", A, H), m = mintOf("DUST", A, H + 1, "100");
  const x1 = PE(transfer({ ticker: "DUST", to: B, amount: "40" }), H + 2, A), x2 = PE(transfer({ ticker: "DUST", to: A, amount: "10" }), H + 3, A);
  const x3 = PE(transfer({ ticker: "DUST", to: C, amount: "41" }), H + 4, B), x4 = PE(transfer({ ticker: "DUST", to: C, amount: "60" }), H + 5, A);
  add("transfer", [d, m, x1, x2, x3, x4], H + 6,
    [at(m, "mint", mv("mint", "DUST", null, A, "100")), at(x1, "transfer", mv("xfer", "DUST", A, B, "40")),
      at(x2, "transfer", mv("xfer", "DUST", A, A, "10")), at(x4, "transfer", mv("xfer", "DUST", A, C, "60"))],
    (st) => [["B's is above its balance", refusedAs(st, x3, "TOKEN_BALANCE_LOW")], ["A holds none", bal(st, "DUST", A) === undefined], ["C holds 60", bal(st, "DUST", C)?.available === "60"]]);
}
{
  const d = open("DUST", A, H), m = mintOf("DUST", A, H + 1, "100");
  const o1 = PE(offer({ give: { ticker: "DUST", amount: "30" }, want: { value: "100000000" } }), H + 2, A, epochOf(H) + 50);
  const c1 = AE(o1.id, A, H + 3, {}, SCORE_CANCEL);
  const o2 = PE(offer({ give: { ticker: "DUST", amount: "20" }, want: { value: "100000000" } }), H + 4, A, epochOf(H + 4) + 1);
  const tip = (epochOf(H + 4) + 2) * EPOCH_LEN;
  add("offer-cancel-expiry", [d, m, o1, c1, o2], tip, [at(m, "mint", mv("mint", "DUST", null, A, "100"))],
    (st) => [["cancelled", st.offers[o1.id]?.status === "cancelled"], ["expired", st.offers[o2.id]?.status === "expired"],
      ["A holds 100, none locked", bal(st, "DUST", A)?.available === "100" && bal(st, "DUST", A)?.locked === "0"]]);
}
{
  const d = open("DUST", A, H), m = mintOf("DUST", A, H + 1, "100");
  const o = PE(offer({ give: { ticker: "DUST", amount: "25" }, want: { value: "300000000" }, taker: B }), H + 2, A, epochOf(H) + 50);
  const ev = [d, m, o];
  const f = csdFill(ev, o.id, B, H + 3, "300000000");
  add("csd-whole-fill", [...ev, f], H + 4, [at(m, "mint", mv("mint", "DUST", null, A, "100")), at(f, "fill", mv("fill", "DUST", A, B, "25"))],
    (st) => [["filled", st.offers[o.id]?.status === "filled"], ["paid in CSD", st.offers[o.id]?.fill?.paid === "300000000"]]);
}
{
  const d = open("DUST", A, H), m = mintOf("DUST", A, H + 1, "100");
  const o = PE(offer({ give: { ticker: "DUST", amount: "10" }, want: { value: "1000000000", payto: C }, min: "200000000", taker: B }), H + 2, A, epochOf(H) + 50);
  const ev = [d, m, o];
  const f1 = csdFill(ev, o.id, B, H + 3, "200000000"); ev.push(f1);
  const f2 = csdFill(ev, o.id, B, H + 4, "350000000"); ev.push(f2);
  const f3 = csdFill(ev, o.id, B, H + 5, "500000000"); ev.push(f3);
  add("csd-partial-fill", ev, H + 6,
    [at(m, "mint", mv("mint", "DUST", null, A, "100")), at(f1, "fill", mv("fill", "DUST", A, B, "2")), at(f2, "fill", mv("fill", "DUST", A, B, "3")),
      at(f3, "fill", mv("fill", "DUST", A, B, "5"))],
    (st) => [["filled by the third", st.offers[o.id]?.status === "filled"], ["got 2, 3, 5", st.offers[o.id]?.fills?.map((x) => x.got).join() === "2,3,5"],
      ["the third pays 450000000 of its 500000000", st.offers[o.id]?.fills?.[2]?.paid === "450000000"], ["payto is C, not the seller", st.offers[o.id]?.want.payto === C]]);
}
const gems = (h) => [open("GEMS", B, h), mintOf("GEMS", B, h + 1, "100000")];
{
  const ev = [open("DUST", A, H), mintOf("DUST", A, H + 1, "100"), ...gems(H + 2)];
  const o = PE(offer({ give: { ticker: "DUST", amount: "10" }, want: { ticker: "GEMS", amount: "2000", payto: C } }), H + 4, A, epochOf(H) + 50);
  const f = tokenFill(o.id, B, H + 5);
  add("token-fill-token", [...ev, o, f], H + 6,
    [at(ev[1], "mint", mv("mint", "DUST", null, A, "100")), at(ev[3], "mint", mv("mint", "GEMS", null, B, "100000")),
      at(f, "fill", mv("sale", "GEMS", B, C, "2000"), mv("fee", "GEMS", B, T, "30"), mv("fill", "DUST", A, B, "10"))],
    (st) => [["paid 2000, fee 30", st.offers[o.id]?.fill?.paid === "2000" && st.offers[o.id]?.fill?.fee === "30"], ["the treasury holds 30 GEMS", bal(st, "GEMS", T)?.available === "30"]]);
}
{
  const ev = [...register("gemsale", A, H), ...gems(H + 2)];
  const o = PE(offer({ give: { name: "gemsale" }, want: { ticker: "GEMS", amount: "500" } }), H + 20, A, epochOf(H + 20) + 2);
  const f = tokenFill(o.id, B, H + 21);
  add("token-fill-name", [...ev, o, f], H + 22,
    [at(ev[4], "mint", mv("mint", "GEMS", null, B, "100000")), at(f, "fill", mv("sale", "GEMS", B, A, "500"), mv("fee", "GEMS", B, T, "8"))],
    (st) => [["B owns the name", st.names.gemsale?.owner === B], ["fee 8", st.offers[o.id]?.fill?.fee === "8"]]);
}
{
  const ev = [open("DUST", A, H), mintOf("DUST", A, H + 1, "100"), ...gems(H + 2)];
  const o = PE(offer({ give: { ticker: "DUST", amount: "5" }, want: { ticker: "GEMS", amount: "0" } }), H + 4, A, epochOf(H) + 50);
  const f = tokenFill(o.id, B, H + 5);
  add("token-fill-zero", [...ev, o, f], H + 6,
    [at(ev[1], "mint", mv("mint", "DUST", null, A, "100")), at(ev[3], "mint", mv("mint", "GEMS", null, B, "100000")), at(f, "fill", mv("fill", "DUST", A, B, "5"))],
    (st) => [["filled for 0, fee 0", st.offers[o.id]?.status === "filled" && st.offers[o.id]?.fill?.paid === "0" && st.offers[o.id]?.fill?.fee === "0"]]);
}
{
  const ev = [...register("csdsale", A, H)];
  const o = PE(offer({ give: { name: "csdsale" }, want: { value: "100000000" }, taker: B }), H + 20, A, epochOf(H + 20) + 2);
  ev.push(o);
  const f = csdFill(ev, o.id, B, H + 21, "100000000");
  add("csd-name-fill", [...ev, f], H + 22, [],
    (st) => [["B owns the name", st.names.csdsale?.owner === B], ["filled", st.offers[o.id]?.status === "filled"]]);
}
{
  const ev = [open("DUST", A, H), mintOf("DUST", A, H + 1, "100"), open("GEMS", B, H + 2), mintOf("GEMS", B, H + 3, "100")];
  const o1 = PE(offer({ give: { ticker: "DUST", amount: "10" }, want: { ticker: "GEMS", amount: "99" } }), H + 4, A, epochOf(H) + 50);
  const o2 = PE(offer({ give: { ticker: "DUST", amount: "10" }, want: { ticker: "GEMS", amount: "50" } }), H + 4, A, epochOf(H) + 50, 1);
  const o3 = PE(offer({ give: { ticker: "DUST", amount: "10" }, want: { value: "300000000" }, taker: B }), H + 4, A, epochOf(H) + 50, 2);
  const f1 = tokenFill(o1.id, B, H + 5), f2 = AE(o2.id, B, H + 5, {}, SCORE_FILL, 0);
  const f3 = AE(o3.id, B, H + 5, { [A]: "299999999", [T]: "4500000" });
  add("refused-fills", [...ev, o1, o2, o3, f1, f2, f3], H + 6,
    [at(ev[1], "mint", mv("mint", "DUST", null, A, "100")), at(ev[3], "mint", mv("mint", "GEMS", null, B, "100"))],
    (st) => [["99 plus its fee is above 100", refusedAs(st, f1, "TOKEN_BALANCE_LOW")], ["no marker", refusedAs(st, f2, "FILL_NO_TOKEN_MARKER")],
      ["short of the price", refusedAs(st, f3, "FILL_UNDERPAID")], ["all three open", [o1, o2, o3].every((o) => st.offers[o.id]?.status === "open")]]);
}

// last: a case inserted before another renumbers the ids of every case after it
{
  const ev = [...register("gempay", A, H), ...gems(H + 2)];
  const o = PE(offer({ give: { name: "gempay" }, want: { ticker: "GEMS", amount: "500", payto: C } }), H + 20, A, epochOf(H + 20) + 2);
  const f = tokenFill(o.id, B, H + 21);
  add("token-fill-name-payto", [...ev, o, f], H + 22,
    [at(ev[4], "mint", mv("mint", "GEMS", null, B, "100000")), at(f, "fill", mv("sale", "GEMS", B, C, "500"), mv("fee", "GEMS", B, T, "8"))],
    (st) => [["B owns the name", st.names.gempay?.owner === B], ["C holds the 500", bal(st, "GEMS", C)?.available === "500"], ["A holds no GEMS", bal(st, "GEMS", A) === undefined]]);
}

const path = new URL("../packages/cairnx/test/vectors/moves.json", import.meta.url);
writeFileSync(path, `{"format":1,"cases":[\n${built.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`);
console.log(`wrote ${built.length} token-move cases (${built.reduce((n, c) => n + c.moves.reduce((k, e) => k + e.moves.length, 0), 0)} moves) -> moves.json`);
