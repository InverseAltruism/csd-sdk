// sweep-streams.mjs - streams built around the expiry sweep: each puts expiries at a height that holds no event, or at
// one height together, and makes a later event read what they released (CONVENTION section 5, "Expiry in the state").
//
// Each builder takes the cairnx-core module (src in the tests, dist in scripts/seal-differential.mjs) and returns a stream
// { key, label, events, tipHeight, tips, expect } as growth-streams.mjs does (`tips` empty): expect(resolveAt) lists what the stream was
// built to show and the state does not, read from the codes of the applied log. Also the walk helpers the seal and the
// tests share: the tips of a dense walk, and the events that write nothing.

const FAR = 9_000_000_000;
const SALT = "00112233445566778899aabbccddeeff";
const ad = (i) => "0x" + (0x70000 + i).toString(16).padStart(40, "0");
const idGen = (tag) => { let k = 0; return () => "0x" + tag + (++k).toString(16).padStart(62, "0"); };

function kit(R, tag) {
  const nid = idGen(tag);
  const P = (b, h, pos, who, exp, paidTo = {}, id = nid()) =>
    ({ kind: "propose", id, proposer: who, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: exp, height: h, pos, paidTo });
  const A = (pid, who, h, pos, score, paidTo = {}) =>
    ({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence: 0, height: h, pos, paidTo });
  const fee = (v) => ({ [R.TREASURY_ADDR]: String(v) });
  const token = (ticker, supply, who, h, pos = 0) => [
    P(R.deploy({ ticker, decimals: 0, supply: String(supply), mint: "issuer" }), h, pos, who, FAR, fee(R.DEPLOY_FEE)),
    P(R.mint({ ticker, amount: String(supply) }), h + 1, pos, who, FAR),
  ];
  const commit = (name, who, h, pos) => P(R.nameCommitRecord({ commit: R.nameCommit(name, SALT, who) }), h, pos, who, FAR);
  const reveal = (name, who, h, pos) => P(R.nameClaim({ name, salt: SALT }), h, pos, who, FAR);
  const finalize = (name, who, h, pos, feeV) => P(R.nameFinalize({ name, salt: SALT }), h, pos, who, FAR, fee(feeV ?? R.nameRegFee(name, h)));
  return { P, A, token, commit, reveal, finalize };
}

const codeOf = (st, id) => st.events.find((e) => e.id === id)?.code ?? "(no entry)";
const expectCodes = (pairs) => (resolveAt) => {
  const st = resolveAt(), bad = [];
  for (const [what, id, code] of pairs) if (codeOf(st, id) !== code) bad.push(`${what}: ${code}, got ${codeOf(st, id)}`);
  return bad;
};

/** The constructed streams. Heights are at V29 or above, except where a name must lapse or V21 must be crossed, and X
 *  and X2 hold a height that is not a number. */
export function sweepStreams(R) {
  const out = [];
  const ep = (h) => R.epochOf(h), L = R.EPOCH_LEN;

  // A. Two offers of one seller and one ticker, a bid and an offer that answers it end with one epoch; the seller's
  // balance is refused one height before and spent at the first height of the next epoch; a later offer names the bid.
  {
    const k = kit(R, "b1"), ev = [], h0 = 90_000, S = ad(1), S2 = ad(2), BUY = ad(3), X = ad(4);
    const e0 = ep(h0 + 2), H = (e0 + 1) * L;
    ev.push(...k.token("TKA", 100, S, h0, 0), ...k.token("TKB", 10, S2, h0, 1));
    const O1 = k.P(R.offer({ give: { ticker: "TKA", amount: "60" }, want: { value: "1000" } }), h0 + 2, 0, S, e0);
    const O2 = k.P(R.offer({ give: { ticker: "TKA", amount: "40" }, want: { value: "1000" } }), h0 + 2, 1, S, e0);
    const B1 = k.P(R.bid({ want: { ticker: "TKB", amount: "1" }, give: { value: "1000" } }), h0 + 2, 2, BUY, e0);
    const O3 = k.P(R.offer({ give: { ticker: "TKB", amount: "1" }, want: { value: "1000" }, bid: B1.id, taker: BUY }), h0 + 3, 0, S2, e0);
    const O4 = k.P(R.offer({ give: { ticker: "TKB", amount: "4" }, want: { value: "4000" }, min: "1000", taker: BUY }), h0 + 3, 1, S2, e0 + 1);
    const low = k.P(R.transfer({ ticker: "TKA", to: X, amount: "1" }), H - 1, 0, S, FAR);
    const spend = k.P(R.transfer({ ticker: "TKA", to: X, amount: "100" }), H, 0, S, FAR);
    const late = k.P(R.offer({ give: { ticker: "TKB", amount: "1" }, want: { value: "1000" }, bid: B1.id, taker: BUY }), H, 1, S2, FAR);
    const late2 = k.P(R.offer({ give: { ticker: "TKB", amount: "1" }, want: { value: "1000" }, bid: B1.id, taker: BUY }), H + 40, 0, S2, FAR);
    ev.push(O1, O2, B1, O3, O4, low, spend, late, late2);
    // a partial fill of O4 by its taker, paid as the state at that height requires
    const st = R.resolve(ev.filter((e) => e.height <= h0 + 3), h0 + 3);
    const pay = Object.fromEntries(R.requiredFillOutputs(st.offers[O4.id], "1000").map((x) => [x.to, String(x.value)]));
    const fill = k.A(O4.id, BUY, h0 + 4, 0, R.SCORE_FILL, pay);
    ev.push(fill);
    out.push({ key: "A", label: "two offers and a bid end with one epoch, the balance is spent at the next height", events: ev, tipHeight: H + 100,
      expect: expectCodes([["the balance is still locked one height before", low.id, "TOKEN_BALANCE_LOW"], ["released at the first height of the next epoch", spend.id, "TOKEN_TRANSFERRED"],
        ["an offer may name the expired bid", late.id, "OFFER_CREATED"], ["the partial fill", fill.txid, "FILL_PARTIAL"]]) });
  }

  // A2. A bid ends two epochs before the offer that answers it, with no event between the two ends.
  {
    const k = kit(R, "b7"), ev = [], h0 = 91_000, S2 = ad(5), BUY = ad(6);
    const e0 = ep(h0 + 2);
    ev.push(...k.token("TKC", 10, S2, h0, 0));
    const B1 = k.P(R.bid({ want: { ticker: "TKC", amount: "1" }, give: { value: "1000" } }), h0 + 2, 0, BUY, e0);
    const O3 = k.P(R.offer({ give: { ticker: "TKC", amount: "1" }, want: { value: "1000" }, bid: B1.id, taker: BUY }), h0 + 3, 0, S2, e0 + 2);
    const after = k.P(R.transfer({ ticker: "TKC", to: BUY, amount: "10" }), (e0 + 5) * L, 0, S2, FAR);
    ev.push(B1, O3, after);
    out.push({ key: "A2", label: "a bid ends two epochs before the offer that answers it", events: ev, tipHeight: (e0 + 6) * L,
      expect(resolveAt) {
        const st = resolveAt(), bad = [];
        if (st.bids[B1.id]?.status !== "expired" || st.offers[O3.id]?.status !== "expired") bad.push("the bid and the offer that answers it both expired");
        if (codeOf(st, after.id) !== "TOKEN_TRANSFERRED") bad.push("the released give is spent after both ends");
        return bad;
      } });
  }

  // B1. Three reservations of one owner end at one height; a fourth reveal at that height is refused by the cap and
  // one a block later is admitted.
  {
    const k = kit(R, "b2"), ev = [], h = 90_100, X = ad(10);
    const n = (i) => "q" + i.toString(36).padStart(9, "0");
    for (let j = 0; j < 3; j++) ev.push(k.commit(n(j), X, h, j), k.reveal(n(j), X, h + 1, j));
    const r3 = k.reveal(n(3), X, h + 28, 0), r4 = k.reveal(n(4), X, h + 29, 0);
    const fin = k.finalize(n(0), X, h + 28, 5);
    ev.push(k.commit(n(3), X, h + 25, 0), r3, k.commit(n(4), X, h + 26, 0), r4, fin);
    out.push({ key: "B1", label: "the reservation cap at the height three reservations end", events: ev, tipHeight: h + 200,
      expect: expectCodes([["the fourth reveal at the last live height", r3.id, "CAP_PENDING_RESERVATIONS"], ["one a block later", r4.id, "NAME_RESERVED"],
        ["a finalize at the last live height", fin.id, "NAME_FINALIZED"]]) });
  }

  // B2. Three holds of one claimer on offers that end with the hold; the fourth claim is refused at the last height of
  // the epoch and granted at the first of the next; a cancel frozen by the hold; a fill after the end.
  {
    const k = kit(R, "b3"), ev = [], h = 90_200, S = ad(20), A = ad(21), B = ad(22);
    const e = ep(h + 2), H = (e + 1) * L;
    ev.push(...k.token("HLD", 10, S, h));
    const off = (exp, pos) => k.P(R.offer({ give: { ticker: "HLD", amount: "1" }, want: { value: "100000000" } }), h + 2, pos, S, exp);
    const O = [off(e, 0), off(e, 1), off(e, 2), off(FAR, 3), off(FAR, 4)];
    ev.push(...O);
    const fc = [0, 1, 2].map((i) => k.P(R.fclaim({ offer: O[i].id }), h + 3, i, A, e));
    ev.push(...fc);
    const capped = k.P(R.fclaim({ offer: O[3].id }), H - 1, 0, A, e + 1);
    const granted = k.P(R.fclaim({ offer: O[3].id }), H, 0, A, e + 1);
    const gone = k.P(R.fclaim({ offer: O[0].id }), H, 1, B, e + 1);
    const lateFill = k.A(fc[0].id, A, H, 2, R.SCORE_FILL);
    const frozen = k.A(O[1].id, S, H - 1, 10, R.SCORE_CANCEL);
    const plain = k.A(O[4].id, S, H - 1, 11, R.SCORE_CANCEL);
    ev.push(capped, granted, gone, lateFill, frozen, plain);
    out.push({ key: "B2", label: "the hold cap where three holds and their offers end together", events: ev, tipHeight: H + 100,
      expect: expectCodes([["the fourth claim at the epoch's last height", capped.id, "CAP_LIVE_HOLDS"], ["the same claim at the next", granted.id, "CLAIM_GRANTED"],
        ["a claim on an offer that ended", gone.id, "OFFER_NOT_OPEN"], ["a fill after the end", lateFill.txid, "OFFER_NOT_OPEN"],
        ["a cancel frozen by the hold", frozen.txid, "OFFER_CANCEL_HOLD_LIVE"], ["a cancel of an unheld offer", plain.txid, "OFFER_CANCELLED"]]) });
  }

  // N. A name offer ends; the owner's transfer is refused at the last height of the epoch and applies at the next.
  {
    const k = kit(R, "b4"), ev = [], h = 90_400, O = ad(30), T = ad(31), Z = ad(32), name = "splitname0";
    ev.push(k.commit(name, O, h, 0), k.reveal(name, O, h + 1, 0), k.finalize(name, O, h + 9, 0));
    const e = ep(h + 20), H = (e + 1) * L;
    const no = k.P(R.offer({ give: { name }, want: { value: "1000" }, taker: T }), h + 20, 0, O, e);
    const locked = k.P(R.nameXfer({ name, to: Z }), H - 1, 0, O, FAR);
    const moved = k.P(R.nameXfer({ name, to: Z }), H, 0, O, FAR);
    ev.push(no, locked, moved);
    out.push({ key: "N", label: "a name offer ends and the name moves at the next height", events: ev, tipHeight: H + 100,
      expect: expectCodes([["the name offer", no.id, "OFFER_CREATED"], ["still locked at the last height", locked.id, "NAME_LOCKED"], ["moved at the next", moved.id, "NAME_TRANSFERRED"]]) });
  }

  // D. A recapture reservation and a pending registration of one owner end at one height; rivals reveal at that height
  // (refused) and one block later (admitted); the first owner's finalize comes too late.
  {
    const k = kit(R, "b5"), ev = [], O = ad(40), X = ad(41), Y = ad(42), Z = ad(43), N1 = "lapsename0", M = "freshname0";
    ev.push(k.commit(N1, O, 61_000, 0), k.reveal(N1, O, 61_001, 0), k.finalize(N1, O, 61_009, 0));
    const lapseEp = ep(61_009) + R.NAME_TERM_EPOCHS + R.NAME_GRACE_EPOCHS + 3;
    const c = lapseEp * L + 2, F = c + R.REG_COMMIT_MAX_BLOCKS + R.REG_FINALIZE_GRACE_BLOCKS;
    const xr = k.reveal(N1, X, c + 1, 0), xm = k.reveal(M, X, c + 1, 1);
    ev.push(k.commit(N1, X, c, 0), k.commit(M, X, c, 1), xr, xm);
    ev.push(k.commit(N1, Y, c + 22, 0), k.commit(M, Y, c + 22, 1), k.commit(N1, Z, c + 22, 2));
    const zEarly = k.reveal(N1, Z, F, 0);
    const yr = k.reveal(N1, Y, F + 1, 0), ym = k.reveal(M, Y, F + 1, 1);
    const paidThrough = ep(61_009) + R.NAME_TERM_EPOCHS;
    const xfin = k.finalize(N1, X, F + 1, 2, R.expiredClaimFee(N1, ep(F + 1) - (paidThrough + R.NAME_GRACE_EPOCHS), F + 1));
    ev.push(zEarly, yr, ym, xfin);
    out.push({ key: "D", label: "a recapture reservation and a registration of one owner end at one height", events: ev, tipHeight: F + 200,
      expect: expectCodes([["the recapture reservation", xr.id, "NAME_RECAPTURE_RESERVED"], ["the registration", xm.id, "NAME_RESERVED"],
        ["a rival at the last live height", zEarly.id, "NAME_TAKEN_EARLIER"], ["a rival recapture a block later", yr.id, "NAME_RECAPTURE_RESERVED"],
        ["a rival registration a block later", ym.id, "NAME_RESERVED"], ["the first owner's late finalize", xfin.id, "NAME_NO_RESERVATION"]]) });
  }

  // G. Deferred cancels in the last block of an epoch: a bulk cancel, a cancel it supersedes, a cancel frozen by a hold;
  // the frozen offer then ends at the next height, where the seller spends what the cancels and the expiry released.
  {
    const k = kit(R, "b6"), ev = [], h = 90_600, S = ad(50), A = ad(51), X = ad(52);
    const e = ep(h + 2), H = (e + 1) * L;
    ev.push(...k.token("DFC", 4, S, h));
    const O = [0, 1, 2, 3].map((i) => k.P(R.offer({ give: { ticker: "DFC", amount: "1" }, want: { value: "100000000" } }), h + 2, i, S, e));
    ev.push(...O);
    const hold = k.P(R.fclaim({ offer: O[1].id }), h + 3, 0, A, e);
    const bulk = k.P(R.offerCancelAll({ ticker: "DFC" }), H - 1, 0, S, FAR);
    const c0 = k.A(O[0].id, S, H - 1, 10, R.SCORE_CANCEL), c1 = k.A(O[1].id, S, H - 1, 11, R.SCORE_CANCEL);
    const spend3 = k.P(R.transfer({ ticker: "DFC", to: X, amount: "3" }), H - 1, 1, S, FAR);
    const spend4 = k.P(R.transfer({ ticker: "DFC", to: X, amount: "4" }), H, 0, S, FAR);
    ev.push(hold, bulk, c0, c1, spend3, spend4);
    out.push({ key: "G", label: "deferred cancels in an epoch's last block, then an expiry", events: ev, tipHeight: H + 100,
      expect: expectCodes([["the bulk cancel", bulk.id, "OFFER_BULK_CANCELLED"], ["a cancel the bulk cancel superseded", c0.txid, "OFFER_CLOSED_BEFORE_CANCEL"],
        ["a cancel frozen by the hold", c1.txid, "OFFER_CANCEL_HOLD_LIVE"], ["a spend before the deferred effects", spend3.id, "TOKEN_BALANCE_LOW"],
        ["a spend after the cancels and the expiry", spend4.id, "TOKEN_TRANSFERRED"]]) });
  }
  // V. An offer and a bid anchored below V21 with expiries past the v2.1 cap end at V21 itself, a height that holds no
  // event: the seller's give is refused one height before V21 and spent a few heights after it.
  {
    const k = kit(R, "b8"), ev = [], h0 = R.V17_HEIGHT + 100, S = ad(60), T = ad(61), X = ad(62);
    ev.push(...k.token("VTK", 10, S, h0));
    const far = ep(h0 + 2) + R.MAX_OFFER_EPOCHS + 232;
    const O = k.P(R.offer({ give: { ticker: "VTK", amount: "10" }, want: { value: "1000" }, taker: T }), h0 + 2, 0, S, far);
    const B = k.P(R.bid({ want: { ticker: "VTK", amount: "1" }, give: { value: "1000" } }), h0 + 2, 1, T, far);
    const low = k.P(R.transfer({ ticker: "VTK", to: X, amount: "10" }), R.V21_HEIGHT - 1, 0, S, FAR);
    const spend = k.P(R.transfer({ ticker: "VTK", to: X, amount: "10" }), R.V21_HEIGHT + 5, 0, S, FAR);
    ev.push(O, B, low, spend);
    out.push({ key: "V", label: "an offer and a bid past the v2.1 cap end at V21, a height with no event", events: ev, tipHeight: R.V21_HEIGHT + 100,
      expect(resolveAt) {
        const st = resolveAt(), bad = [];
        if (R.offerExpiryHeightOf(far, h0 + 2) !== R.V21_HEIGHT) bad.push("the capped expiry falls at V21");
        if (st.offers[O.id]?.status !== "expired" || st.bids[B.id]?.status !== "expired") bad.push("the offer and the bid expired");
        if (codeOf(st, low.id) !== "TOKEN_BALANCE_LOW") bad.push("the give is still locked one height before V21");
        if (codeOf(st, spend.id) !== "TOKEN_TRANSFERRED") bad.push("released at V21 and spent after it");
        return bad;
      } });
  }
  // X. An offer whose event carries a height that is not a number (an input no chain produces; resolve() accepts it):
  // its cap is NaN, so it is due below V21 and never at or above it. With no event between its raw expiry and V21 it
  // stays open past V21 and the seller's transfer at V21 is refused, as in 0.2.8; X2 puts an event there, which
  // expires it, so a later transfer applies.
  for (const [key, between] of [["X", false], ["X2", true]]) {
    const k = kit(R, key === "X" ? "b9" : "ba"), ev = [], S = ad(70), X = ad(71);
    ev.push(...k.token("BUG", 10, S, R.ACTIVATION_HEIGHT));
    const O = k.P(R.offer({ give: { ticker: "BUG", amount: "10" }, want: { value: "1000" } }), Number.NaN, 0, S, 1000);
    const mid = k.P(R.transfer({ ticker: "BUG", to: X, amount: "4" }), 30_100, 0, S, FAR);
    const late = k.P(R.transfer({ ticker: "BUG", to: X, amount: "6" }), R.V21_HEIGHT, 0, S, FAR);
    ev.push(O, ...(between ? [mid] : []), late);
    out.push({ key, label: between ? "a NaN-height offer expires at an event below V21, so the give is spent" : "a NaN-height offer whose cap is NaN stays open past V21",
      events: ev, tipHeight: R.V21_HEIGHT + 100,
      expect(resolveAt) {
        const st = resolveAt(), bad = [];
        if (st.offers[O.id]?.status !== (between ? "expired" : "open")) bad.push(`the offer ${between ? "expired" : "open"} at the tip`);
        if (between && codeOf(st, mid.id) !== "TOKEN_TRANSFERRED") bad.push("the transfer below V21 applies");
        if (codeOf(st, late.id) !== (between ? "TOKEN_TRANSFERRED" : "TOKEN_BALANCE_LOW")) bad.push(`the transfer at V21 ${between ? "applies" : "is refused"}`);
        return bad;
      } });
  }
  return out.map((s) => ({ ...s, tips: [] }));
}

/** The events a walk replays at tip `t`: every event not above it (one whose height is not a number is in every prefix). */
export const upTo = (events, t) => events.filter((e) => !(e.height > t));

/** The tips of a dense walk over `events` up to `tip`: every height from two below the first event when the span is at
 *  most `span` blocks; otherwise every height from two below to three epochs above each event height, the two heights
 *  around each height in `extra`, and the tip. Ascending, at or above 0. */
export function denseTips(events, tip, EPOCH_LEN, extra = [], span = 2_000) {
  const hs = [...new Set(events.map((e) => e.height).filter(Number.isSafeInteger))].sort((a, b) => a - b);
  if (!hs.length) return [tip];
  const lo = Math.max(0, hs[0] - 2), s = new Set([tip]);
  if (Number.isSafeInteger(tip) && tip - lo <= span) for (let h = lo; h <= tip; h++) s.add(h);
  else {
    for (const h of hs) for (let d = -2; d <= 3 * EPOCH_LEN; d++) s.add(h + d);
    for (const x of extra) for (const d of [-1, 0, 1]) s.add(x + d);
  }
  return [...s].filter((h) => Number.isSafeInteger(h) && h >= lo && h <= tip).sort((a, b) => a - b);
}

/** One Attest per height on a proposal no event names, with a score no rule reads: each writes nothing (no handler
 *  matches it and the log gets no entry), so a replay with them added must equal the replay without them. */
export function inertEvents(heights, tag = "fe") {
  return heights.map((h, i) => ({ kind: "attest", txid: "0x" + tag + (i + 1).toString(16).padStart(62, "0"), proposalId: "0x" + "dd".repeat(32),
    attester: "0x" + "ab".repeat(20), score: 77, confidence: 0, height: h, pos: 4_000_000, paidTo: {} }));
}

/** The heights at which the offers and bids `events` propose would first be expired (offerExpiryHeightOf of each
 *  Propose's expiry and anchor), for a walk to stop beside. */
export function dueHeights(R, events) {
  return events.filter((e) => e.kind === "propose" && Number.isSafeInteger(e.expiresEpoch) && e.expiresEpoch < 1e12 && Number.isSafeInteger(e.height))
    .map((e) => R.offerExpiryHeightOf(e.expiresEpoch, e.height));
}

/** What expired in `state` (= resolve(events, tip)) with a later event of `events` at or above its expiry height: an
 *  offer; a bid; a reservation, seen as a second NAME_RESERVED of its name; a recapture reservation, seen as a second
 *  NAME_RECAPTURE_RESERVED of its name; an offer or bid that expired under the V21 cap before its raw expiry. */
export function expiryKinds(R, events, state) {
  const last = Math.max(-1, ...events.map((e) => e.height).filter(Number.isFinite));
  const at = (x) => R.offerExpiryHeightOf(x.expiresEpoch, x.height);
  const ended = (x) => x.status === "expired" && at(x) <= last;
  const capped = (x) => ended(x) && at(x) < (x.expiresEpoch + 1) * R.EPOCH_LEN;
  const proposes = new Map(events.filter((e) => e.kind === "propose").map((e) => [e.id, e]));
  const nameOf = (id) => { const e = proposes.get(id); return e ? R.parseRecord(e.uri, e.payloadHash)?.name : undefined; };
  const twice = (code) => {
    const n = new Map();
    for (const x of state.events) if (x.code === code) { const nm = nameOf(x.id); if (nm !== undefined) n.set(nm, (n.get(nm) ?? 0) + 1); }
    return [...n.values()].some((k) => k >= 2);
  };
  const offers = Object.values(state.offers), bids = Object.values(state.bids);
  return { offer: offers.some(ended), bid: bids.some(ended), reservation: twice("NAME_RESERVED"), recapture: twice("NAME_RECAPTURE_RESERVED"),
    v21: offers.some(capped) || bids.some(capped) };
}

/** JSON text that keeps the numbers JSON has no form for (NaN, +-Infinity) as `{"$num": "NaN"}`; parseNumbers reads it back. */
export const stringifyNumbers = (value) => JSON.stringify(value, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : v));
export const parseNumbers = (text) => JSON.parse(text, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$num === "string" ? Number(v.$num) : v));

// Whether an event carries a height or an expiry a chain does not produce (not a safe integer).
const malformed = (e) => !Number.isSafeInteger(e.height) || (e.kind === "propose" && !Number.isSafeInteger(e.expiresEpoch));

/** What the replay read of the malformed fields in `events`, from its log and state: an offer, bid, reservation or
 *  recapture reservation entry whose event (or, for a reveal or finalize, whose commit) is malformed; such an entry in
 *  a sequence that crosses V21 (an event below it, the tip at or above it) or lies wholly at or above it; an offer
 *  with a NaN height open at a tip at or above V21 though its raw expiry fell due below V21 (the class whose expiry
 *  rises across V21, where a batch at that due height would have expired it). Reservations and recapture reservations
 *  are told apart by the generator's name prefixes (`em`, `rm`). */
export function malformedKinds(R, events, state) {
  const byId = new Map(events.map((e) => [e.kind === "propose" ? e.id : e.txid, e]));
  const commits = new Map(events.filter((e) => e.kind === "propose").map((e) => [R.parseRecord(e.uri, e.payloadHash)?.commit, e]).filter(([c]) => c !== undefined));
  const out = { offer: false, bid: false, reservation: false, recapture: false, crossV21: false, aboveV21: false, nanOffer: false };
  for (const x of state.events) {
    const e = byId.get(x.id);
    if (!e) continue;
    const rec = e.kind === "propose" ? R.parseRecord(e.uri, e.payloadHash) : null;
    const viaCommit = rec?.salt !== undefined && rec?.name !== undefined && (() => { const c = commits.get(R.nameCommit(rec.name, rec.salt, e.proposer.toLowerCase())); return c !== undefined && malformed(c); })();
    if (!malformed(e) && !viaCommit) continue;
    if (x.kind === "offer") out.offer = true;
    else if (x.kind === "bid") out.bid = true;
    else if ((x.kind === "name" || x.kind === "nfinalize") && rec?.name?.startsWith("em")) out.reservation = true;
    else if ((x.kind === "name" || x.kind === "nfinalize") && rec?.name?.startsWith("rm")) out.recapture = true;
  }
  const any = out.offer || out.bid || out.reservation || out.recapture;
  const safe = events.map((e) => e.height).filter(Number.isSafeInteger);
  out.crossV21 = any && safe.some((h) => h < R.V21_HEIGHT) && state.tipHeight >= R.V21_HEIGHT;
  out.aboveV21 = any && safe.every((h) => h >= R.V21_HEIGHT);
  out.nanOffer = state.tipHeight >= R.V21_HEIGHT && Object.values(state.offers)
    .some((o) => Number.isNaN(o.height) && o.status === "open" && (o.expiresEpoch + 1) * R.EPOCH_LEN < R.V21_HEIGHT);
  return out;
}
