// growth-streams.mjs - synthetic event streams that load the replay's expiry and per-address work (Plan 91 G1).
//
// Each builder takes the cairnx-core module (src in the tests, dist in scripts/seal-differential.mjs) and a size, and
// returns a stream { key, label, events, tipHeight, tips, expect } or an array of them. `tips` are further tips to
// resolve the whole stream at (some below its last event). `expect(resolveAt)` lists what the stream was built to show
// and the state does not: resolveAt(h) resolves the events at or below h with tip h, resolveAt() the whole stream at
// its tip. Codes are read from the applied log (CONVENTION section 40), so a refusal and an admission of each cap are
// both checked, never assumed.
//
// Heights are chosen against the gate constants of cairnx-core 0.2.4 to 0.2.7; every stream is deterministic.

/** The sizes the seal runs (the plan's four streams are S1 to S4). */
export const FULL_SIZES = Object.freeze({ S1: 16_000, S2: 20_000, S3: 20_000, S4: 20_000, S5: 20_000, S6: 20_000, S7: 20_000 });

const FAR = 9_000_000_000;
const SALT = "00112233445566778899aabbccddeeff";
const ad = (i) => "0x" + (0x10000 + i).toString(16).padStart(40, "0");
const nm = (i) => "g" + i.toString(36).padStart(9, "0");                    // 10 characters: the long-name fee
const idGen = (tag) => { let k = 0; return () => "0x" + tag + (++k).toString(16).padStart(62, "0"); };

function kit(R, tag) {
  const nid = idGen(tag);
  const T = R.TREASURY_ADDR;
  const P = (b, h, pos, who, exp, paidTo = {}, id = nid()) =>
    ({ kind: "propose", id, proposer: who, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: exp, height: h, pos, paidTo });
  const A = (pid, who, h, pos, score, paidTo = {}) =>
    ({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence: 0, height: h, pos, paidTo });
  const fee = (v) => ({ [T]: String(v) });
  // a token with `supply` units minted to `who`
  const token = (ticker, supply, who, h) => [
    P(R.deploy({ ticker, decimals: 0, supply: String(supply), mint: "issuer" }), h, 0, who, FAR, fee(R.DEPLOY_FEE)),
    P(R.mint({ ticker, amount: String(supply) }), h + 1, 0, who, FAR),
  ];
  // the outputs that pay a whole fill of an open CSD offer of one unit for `value` (requiredFillOutputs reads these fields)
  const payFor = (id, seller, ticker, value, height) => Object.fromEntries(R.requiredFillOutputs(
    { id, seller, give: { ticker, amount: "1" }, want: { value, payto: seller }, status: "open", expiresEpoch: FAR, height, feeBps: R.FEE_BPS_V16 },
    value,
  ).map((x) => [x.to, String(x.value)]));
  // a sealed registration at V25+: commit at h, reveal at h + 1, finalize at h + 9 (after the eight-block freeze)
  const register = (name, who, h, pos) => [
    P(R.nameCommitRecord({ commit: R.nameCommit(name, SALT, who) }), h, pos, who, FAR),
    P(R.nameClaim({ name, salt: SALT }), h + 1, pos, who, FAR),
    P(R.nameFinalize({ name, salt: SALT }), h + 9, pos, who, FAR, fee(R.nameRegFee(name, h + 9))),
  ];
  const reveal = (name, who, hCommit, hReveal, pos) => [
    P(R.nameCommitRecord({ commit: R.nameCommit(name, SALT, who) }), hCommit, pos, who, FAR),
    P(R.nameClaim({ name, salt: SALT }), hReveal, pos, who, FAR),
  ];
  return { nid, P, A, fee, token, payFor, register, reveal };
}

// expectation helpers over a resolved state
const codeCount = (st, code, from = -Infinity, to = Infinity) => st.events.filter((e) => e.code === code && e.height >= from && e.height < to).length;
const codeOf = (st, id) => st.events.find((e) => e.id === id)?.code;
const need = (bad, cond, what) => { if (!cond) bad.push(what); };

// S1: n full registrations, an owner's in turn ten blocks apart, so the cap never binds except for one probe address
// that reveals a fourth name in one window (refused) and another after finalizing one (admitted).
export function registrations(R, n) {
  const k = kit(R, "a1");
  const ev = [];
  const owners = Math.max(4, Math.ceil(n / 3));
  let h = 61_000;
  for (let i = 0; i < n; i += 20) {
    for (let j = 0; j < 20 && i + j < n; j++) ev.push(...k.register(nm(i + j), ad(100 + ((i + j) % owners)), h, j));
    h += 10;
  }
  const X = ad(1);
  h += 20;
  const probe = [];
  for (let j = 0; j < 4; j++) { const r = k.reveal(`probe${j}names`, X, h, h + 1, j); probe.push(r[1].id); ev.push(...r); }
  ev.push(k.P(R.nameFinalize({ name: "probe0names", salt: SALT }), h + 9, 0, X, FAR, k.fee(R.nameRegFee("probe0names", h + 9))));
  const after = k.reveal("probe9names", X, h + 10, h + 11, 0);
  ev.push(...after);
  return {
    key: "S1", label: `${n} registrations`, events: ev, tipHeight: h + 60, tips: [],
    expect(resolveAt) {
      const st = resolveAt(), bad = [];
      need(bad, codeCount(st, "NAME_RESERVED") >= n && codeCount(st, "NAME_FINALIZED") >= n, "every registration reserved and finalized");
      need(bad, codeOf(st, probe[3]) === "CAP_PENDING_RESERVATIONS", "the fourth concurrent reservation is refused by the cap");
      need(bad, codeOf(st, after[1].id) === "NAME_RESERVED", "a reservation after one finalized is admitted");
      return bad;
    },
  };
}

// S2: n open bids, ten a block; the even ones never expire, the odd ones expire during the stream; every 50th is
// cancelled by its bidder.
export function bids(R, n) {
  const k = kit(R, "a2");
  const ev = [];
  const b = R.bid({ want: { ticker: "AAA", amount: "1" }, give: { value: "1000" } });
  let h = 61_000, pos = 0;
  const ids = [];
  for (let i = 0; i < n; i++) {
    if (pos === 10) { h++; pos = 0; }
    const e = k.P(b, h, pos++, ad(100 + (i % 50)), i % 2 ? R.epochOf(h) + (i % 7) : FAR);
    ids.push(e.id); ev.push(e);
    if (i % 50 === 0) ev.push(k.A(e.id, e.proposer, h + 1, 0, R.SCORE_CANCEL));
  }
  return {
    key: "S2", label: `${n} open bids`, events: ev, tipHeight: h + 10, tips: [],
    expect(resolveAt) {
      const st = resolveAt(), bad = [], s = (x) => Object.values(st.bids).filter((v) => v.status === x).length;
      need(bad, codeCount(st, "BID_CREATED") === n, "every bid created");
      need(bad, s("open") > 0 && s("expired") > 0 && s("cancelled") > 0, "bids open, expired and cancelled at the tip");
      return bad;
    },
  };
}

// S3: open CSD offers held by claims, in three eras: legacy SCORE_CLAIM holds in [V20, V28), fclaim holds in
// [V28, V29), fclaim holds at V29+. In each era claimers take three offers a round and every tenth tries a fourth
// (refused); one claimer fills its three holds and then claims a fourth (refused below V29, where a filled offer's hold
// still counts; admitted at V29+); a probe address re-claims an offer it held, inside the cooldown (refused) and
// after it (admitted).
export function holds(R, n) {
  const k = kit(R, "a3");
  const ev = [];
  const probes = {};
  const VALUE = "100000000";
  const era = (name, ticker, seller, h0, count, legacy) => {
    ev.push(...k.token(ticker, count + 10, seller, h0));
    const offer = R.offer({ give: { ticker, amount: "1" }, want: { value: VALUE, payto: seller } });
    const ids = [];
    let h = h0 + 2, pos = 0;
    for (let i = 0; i < count + 2; i++) {
      if (pos === 20) { h++; pos = 0; }
      const e = k.P(offer, h, pos++, seller, FAR); ids.push(e.id); ev.push(e);
    }
    const probeOffer = ids.pop(), fillerFourth = ids.pop();
    const claimers = Math.max(5, Math.floor(count / 20));
    const until = (g) => (legacy ? g + R.claimWindowAt(g) + 5 : (R.epochOf(g) + R.FCLAIM_MAX_EPOCH_AHEAD + 1) * R.EPOCH_LEN);
    const claim = (off, who, g, p) => legacy
      ? k.A(off, who, g, p, R.SCORE_CLAIM)
      : k.P(R.fclaim({ offer: off }), g, p, who, R.epochOf(g) + R.FCLAIM_MAX_EPOCH_AHEAD);
    h += 2;
    let next = 0, round = 0;
    while (next < ids.length) {
      let p = 0;
      const mine = [];
      for (let c = 0; c < claimers && next < ids.length; c++) {
        const who = ad(1000 + c);
        for (let j = 0; j < 3 && next < ids.length; j++) { const off = ids[next++]; const g = claim(off, who, h, p++); ev.push(g); if (c === 1) mine.push({ g, off }); }
        if (c % 10 === 0 && next < ids.length) ev.push(claim(ids[next], who, h, p++));            // a fourth: refused
      }
      if (round === 0 && mine.length === 3) {
        for (const { g, off } of mine) ev.push(k.A(legacy ? off : g.id, ad(1001), h + 1, p++, R.SCORE_FILL, k.payFor(off, seller, ticker, VALUE, h0 + 2)));
        const fourth = claim(fillerFourth, ad(1001), h + 2, 0);
        ev.push(fourth);
        probes[`${name}: a fourth claim after three filled holds`] = [fourth, h >= R.V29_HEIGHT ? "CLAIM_GRANTED" : "CAP_LIVE_HOLDS"];
      }
      h = until(h) + 1; round++;
    }
    const pr = ad(999), g0 = claim(probeOffer, pr, h, 0), end = until(h);
    const inCooldown = claim(probeOffer, pr, end + 1, 0), after = claim(probeOffer, pr, end + R.CLAIM_COOLDOWN_BLOCKS + 1, 0);
    ev.push(g0, inCooldown, after);
    probes[`${name}: a re-claim inside the cooldown`] = [inCooldown, "CLAIM_COOLDOWN"];
    probes[`${name}: a re-claim after the hold and the cooldown`] = [after, "CLAIM_GRANTED"];
    return end + R.CLAIM_COOLDOWN_BLOCKS + 1;
  };
  const q = Math.max(20, Math.floor(n / 4));
  const lastL = era("legacy", "LGC", ad(1), 50_000, q, true);
  const lastF = era("fclaim", "FCL", ad(2), 61_000, n - 2 * q, false);
  const lastV = era("v29", "VCL", ad(3), R.V29_HEIGHT, q, false);
  if (!(lastL < R.V28_HEIGHT && lastF < R.V29_HEIGHT)) throw new Error("growth-streams S3: an era overran its gate");
  const eid = (e) => e.id ?? e.txid;
  return {
    key: "S3", label: `${n} open offers with holds`, events: ev, tipHeight: lastV + 5, tips: [],
    expect(resolveAt) {
      const st = resolveAt(), bad = [];
      for (const [what, [e, code]] of Object.entries(probes)) need(bad, codeOf(st, eid(e)) === code, `${what}: ${code}`);
      for (const [lo, hi, what] of [[50_000, R.V28_HEIGHT, "legacy"], [R.V28_HEIGHT, R.V29_HEIGHT, "fclaim"], [R.V29_HEIGHT, Infinity, "v29"]])
        need(bad, codeCount(st, "CAP_LIVE_HOLDS", lo, hi) > 0 && codeCount(st, "CLAIM_GRANTED", lo, hi) > 0, `${what} era: the cap refuses and admits`);
      need(bad, codeCount(st, "FILL_APPLIED") >= 9, "the held fills deliver");
      return bad;
    },
  };
}

// S4: n reservations alive at once: every commit within ten blocks, each reveal one block after its commit, three per
// owner and every hundredth owner trying a fourth (refused); the tip is past every finalizeBy.
export function reservations(R, n) {
  const k = kit(R, "a4");
  const ev = [];
  const per = Math.ceil(n / 10), h0 = 61_000, owners = Math.ceil(n / 3);
  for (let i = 0; i < n; i++) ev.push(...k.reveal(nm(i), ad(100 + Math.floor(i / 3)), h0 + Math.floor(i / per), h0 + Math.floor(i / per) + 1, i % per));
  const over = [];
  for (let o = 0; o < owners; o += 100) { const r = k.reveal("over" + o.toString(36).padStart(6, "0"), ad(100 + o), h0 + 10, h0 + 11, per + o); over.push(r[1].id); ev.push(...r); }
  return {
    key: "S4", label: `${n} reservations alive at once`, events: ev, tipHeight: h0 + 50, tips: [],
    expect(resolveAt) {
      const st = resolveAt(), bad = [];
      need(bad, codeCount(st, "NAME_RESERVED") === n, "every first-three reservation admitted");
      need(bad, over.every((id) => codeOf(st, id) === "CAP_PENDING_RESERVATIONS"), "every fourth refused by the cap");
      need(bad, Object.values(st.names).every((x) => !x.pending), "every reservation swept at the tip");
      return bad;
    },
  };
}

// S5: n recapture reservations alive at once. n names are registered and finalized, and once their leases have lapsed
// each is recaptured (commit, reveal), three per owner, every hundredth owner trying a fourth on a spare name (refused).
// Five recaptures are displaced by an earlier commit and five are finalized at the decaying premium.
export function recaptures(R, n) {
  const k = kit(R, "a5");
  const ev = [];
  const extra = Math.ceil(n / 300) + 1, owners = Math.ceil(n / 3);
  const finAt = new Map();
  let h = 61_000;
  for (let i = 0; i < n + extra; i += 50) {
    for (let j = 0; j < 50 && i + j < n + extra; j++) { ev.push(...k.register(nm(i + j), ad(100 + ((i + j) % owners)), h, j)); finAt.set(nm(i + j), h + 9); }
    h += 10;
  }
  const lapseH = (R.epochOf(h) + R.NAME_TERM_EPOCHS + R.NAME_GRACE_EPOCHS + 2) * R.EPOCH_LEN;
  const per = Math.ceil(n / 10);
  const commitAt = (i) => lapseH + 2 + Math.floor(i / per);
  const rec = [];
  for (let i = 0; i < n; i++) { const r = k.reveal(nm(i), ad(50_000 + Math.floor(i / 3)), commitAt(i), commitAt(i) + 1, i % per); rec.push(r); ev.push(...r); }
  const over = [];
  for (let o = 0, x = 0; o < owners && x < extra; o += 100, x++) { const r = k.reveal(nm(n + x), ad(50_000 + o), commitAt(n - 1) + 1, commitAt(n - 1) + 2, per + o); over.push(r[1].id); ev.push(...r); }
  const displaced = [], finalized = [];
  for (let i = 0; i < 5; i++) {
    const d = 3 + i;                                       // owners 1 and 2, whom no cap probe uses
    const r = k.reveal(nm(d), ad(90_000 + i), commitAt(d) - 1, commitAt(d) + 2, per + owners + i);   // an earlier commit
    displaced.push(r[1].id); ev.push(...r);
    const j = n - 1 - i, name = nm(j), who = ad(50_000 + Math.floor(j / 3)), hf = commitAt(j) + 10;
    const ep = R.epochOf(hf), paidThrough = R.epochOf(finAt.get(name)) + R.NAME_TERM_EPOCHS;
    const f = k.P(R.nameFinalize({ name, salt: SALT }), hf, per + owners + 10 + i, who, FAR,
      k.fee(R.expiredClaimFee(name, ep - (paidThrough + R.NAME_GRACE_EPOCHS), hf)));
    finalized.push(f.id); ev.push(f);
  }
  return {
    key: "S5", label: `${n} recaptures alive at once`, events: ev, tipHeight: commitAt(n - 1) + 60, tips: [],
    expect(resolveAt) {
      const st = resolveAt(), bad = [];
      need(bad, codeCount(st, "NAME_RECAPTURE_RESERVED") >= n - 5, "the recaptures admitted");
      need(bad, over.every((id) => codeOf(st, id) === "CAP_PENDING_RECAPTURES"), "every fourth refused by the recapture cap");
      need(bad, displaced.every((id) => codeOf(st, id) === "NAME_RECAPTURE_RESERVED_DISPLACED"), "the earlier commits displace");
      need(bad, finalized.every((id) => codeOf(st, id) === "NAME_RECAPTURE_FINALIZED"), "the recapture finalizes land");
      need(bad, Object.keys(st.recaptures).length === 0, "every recapture swept or finalized at the tip");
      return bad;
    },
  };
}

// S6: m bulk cancels over n open offers. Seller A holds n GRW offers, 50 GRX offers, two name offers, taker-bound TKB
// offers anchored below V28 (cancellable) and at V28+ (firm quotes); seller C holds ten offers. Most cancels name the
// ticker ZZZ and match nothing; one names GRX, one the first name, one TKB; then A cancels everything and C too.
export function ocancels(R, n, m) {
  const k = kit(R, "a6");
  const ev = [];
  const A = ad(1), B = ad(2), C = ad(3);
  ev.push(...k.token("TKB", 20, A, 59_000));
  const tkb = (h, pos) => k.P(R.offer({ give: { ticker: "TKB", amount: "1" }, want: { value: "1000", payto: A }, taker: B }), h, pos, A, FAR);
  const tkOld = [0, 1, 2, 3, 4].map((i) => tkb(59_010, i));
  ev.push(...tkOld);
  const names = ["oca1names", "oca2names"];
  names.forEach((x, i) => ev.push(...k.register(x, A, 60_900, i)));
  ev.push(...k.token("GRW", n, A, 61_000), ...k.token("GRX", 50, A, 61_000).map((e) => ({ ...e, pos: e.pos + 1 })), ...k.token("CCC", 10, C, 61_000).map((e) => ({ ...e, pos: e.pos + 2 })));
  const tkNew = [0, 1, 2, 3, 4].map((i) => tkb(61_002, i));
  const nameOffers = names.map((x, i) => k.P(R.offer({ give: { name: x }, want: { value: "1000" } }), 61_002, 10 + i, A, R.epochOf(61_002) + 500));
  ev.push(...tkNew, ...nameOffers);
  const grw = R.offer({ give: { ticker: "GRW", amount: "1" }, want: { value: "1000" } });
  const grx = R.offer({ give: { ticker: "GRX", amount: "1" }, want: { value: "1000" } });
  const ccc = R.offer({ give: { ticker: "CCC", amount: "1" }, want: { value: "1000" } });
  let h = 61_003, pos = 0;
  const put = (b, who) => { if (pos === 20) { h++; pos = 0; } const e = k.P(b, h, pos++, who, FAR); ev.push(e); return e.id; };
  const grwIds = [], grxIds = [], cccIds = [];
  for (let i = 0; i < n; i++) grwIds.push(put(grw, A));
  for (let i = 0; i < 50; i++) grxIds.push(put(grx, A));
  for (let i = 0; i < 10; i++) cccIds.push(put(ccc, C));
  h++; pos = 0;
  const zzz = R.offerCancelAll({ ticker: "ZZZ" });
  const mid = Math.floor(m / 2);
  let hMid = 0;
  for (let i = 0; i < m; i++) {
    if (pos === 20) { h++; pos = 0; }
    const rec = i === 0 ? R.offerCancelAll({ ticker: "GRX" }) : i === mid ? R.offerCancelAll({ name: names[0] }) : i === mid + 1 ? R.offerCancelAll({ ticker: "TKB" }) : zzz;
    ev.push(k.P(rec, h, pos++, A, FAR));
    if (i === mid + 1) hMid = h;
  }
  ev.push(k.P(R.offerCancelAll({}), h + 1, 0, A, FAR), k.P(R.offerCancelAll({}), h + 1, 1, C, FAR));
  const status = (st, ids) => [...new Set(ids.map((id) => st.offers[id]?.status))].join(",");
  return {
    key: "S6", label: `${m} bulk cancels over ${n} offers`, events: ev, tipHeight: h + 5, tips: [],
    expect(resolveAt) {
      const bad = [], mid = resolveAt(hMid), end = resolveAt();
      need(bad, status(mid, grxIds) === "cancelled", "the GRX cancel closes every GRX offer");
      need(bad, status(mid, [nameOffers[0].id]) === "cancelled" && status(mid, [nameOffers[1].id]) === "open", "the name cancel closes that name's offer only");
      need(bad, status(mid, tkOld.map((e) => e.id)) === "cancelled", "the TKB cancel closes the pre-V28 taker-bound offers");
      need(bad, status(mid, grwIds) === "open", "the ZZZ cancels close nothing");
      need(bad, status(end, grwIds) === "cancelled" && status(end, cccIds) === "cancelled", "the unfiltered cancels close the rest");
      need(bad, status(end, tkNew.map((e) => e.id)) === "open", "a taker-bound offer anchored at V28+ is never cancelled");
      return bad;
    },
  };
}

// S7: m reservation displacements over n open offers (each displacement voids the name's open offers, of which there
// are none), and five pre-V13 displacements of a squatter whose open name offer the void must cancel.
export function displacements(R, n, m) {
  const k = kit(R, "a7");
  const ev = [];
  const squatOffers = [], squatReveals = [];
  for (let j = 0; j < 5; j++) {
    const h = 30_500 + 20 * j, name = `squat${j}name`, S = ad(10 + j), D = ad(20 + j);
    ev.push(k.P(R.nameCommitRecord({ commit: R.nameCommit(name, SALT, D) }), h, 0, D, FAR));
    ev.push(k.P(R.nameClaim({ name }), h + 2, 0, S, FAR, k.fee(R.nameRegFee(name, h + 2))));
    const o = k.P(R.offer({ give: { name }, want: { value: "1000000" } }), h + 3, 0, S, R.epochOf(h) + 50);
    const r = k.P(R.nameClaim({ name, salt: SALT }), h + 5, 0, D, FAR, k.fee(R.nameRegFee(name, h + 5)));
    squatOffers.push(o.id); squatReveals.push(r.id); ev.push(o, r);
  }
  ev.push(...k.token("GRW", n, ad(1), 61_000));
  const offer = R.offer({ give: { ticker: "GRW", amount: "1" }, want: { value: "1000" } });
  let h = 61_002, pos = 0;
  for (let i = 0; i < n; i++) { if (pos === 20) { h++; pos = 0; } ev.push(k.P(offer, h, pos++, ad(1), FAR)); }
  h += 2;
  for (let i = 0; i < m; i += 50) {
    for (let j = 0; j < 50 && i + j < m; j++) {
      const name = nm(i + j), late = ad(100 + ((i + j) % 3000)), early = ad(5000 + ((i + j) % 3000));
      ev.push(k.P(R.nameCommitRecord({ commit: R.nameCommit(name, SALT, early) }), h, 2 * j, early, FAR));
      ev.push(...k.reveal(name, late, h + 1, h + 2, 2 * j));
      ev.push(k.P(R.nameClaim({ name, salt: SALT }), h + 3, 2 * j, early, FAR));
    }
    h += 40;
  }
  return {
    key: "S7", label: `${m} displacements over ${n} offers`, events: ev, tipHeight: h + 5, tips: [],
    expect(resolveAt) {
      const st = resolveAt(), bad = [];
      need(bad, codeCount(st, "NAME_RESERVED_DISPLACED") === m, "every V25+ displacement lands");
      need(bad, squatReveals.every((id) => codeOf(st, id) === "NAME_REGISTERED_DISPLACED"), "the pre-V13 reveals displace the squatters");
      need(bad, squatOffers.every((id) => st.offers[id]?.status === "cancelled"), "the squatters' open name offers are voided");
      return bad;
    },
  };
}

// S8: the V21 crossing. Offers and bids anchored below V21 with expiries past their capped epoch (some expire at the
// first sweep at V21), offers anchored in [V21, V22) and at V22+, events on both sides of V21.
export function v21(R) {
  const k = kit(R, "a8");
  const ev = [], s = ad(0), h0 = R.V21_HEIGHT - 6_000;
  ev.push(...k.token("VXX", 1000, s, h0));
  const off = R.offer({ give: { ticker: "VXX", amount: "1" }, want: { value: "1000" } });
  const bd = R.bid({ want: { ticker: "VXX", amount: "1" }, give: { value: "1000" } });
  const e0 = R.epochOf(h0 + 2);
  for (const d of [1, 100, 167, 168, 169, 200, 400, 10_000]) { ev.push(k.P(off, h0 + 2, d % 50, s, e0 + d)); ev.push(k.P(bd, h0 + 2, 50 + (d % 50), s, e0 + d)); }
  for (const dh of [-31, -1, 0, 1, 29, 30, 300]) ev.push(k.P(R.transfer({ ticker: "VXX", to: ad(1), amount: "1" }), R.V21_HEIGHT + dh, 0, s, FAR));
  const e1 = R.epochOf(R.V21_HEIGHT + 400);
  for (const d of [1, 168]) ev.push(k.P(off, R.V21_HEIGHT + 400, d, s, e1 + d));
  const e2 = R.epochOf(R.V22_HEIGHT + 10);
  for (const d of [1, 400]) ev.push(k.P(off, R.V22_HEIGHT + 10, d, s, e2 + d));
  const heights = [...new Set(ev.map((e) => e.height))];
  return {
    key: "S8", label: "the V21 crossing", events: ev, tipHeight: R.V22_HEIGHT + 30 * 500, tips: [R.V21_HEIGHT - 2, R.V21_HEIGHT, ...heights],
    expect(resolveAt) {
      const bad = [], a = resolveAt(R.V21_HEIGHT - 2), b = resolveAt(R.V21_HEIGHT);
      const flips = (x) => Object.keys(a[x]).filter((id) => a[x][id].status === "open" && b[x][id]?.status === "expired").length;
      need(bad, flips("offers") > 0 && flips("bids") > 0, "offers and bids open below V21 expire at the first sweep at V21");
      return bad;
    },
  };
}

// S9: edges where an index could part from the walk. (a) Below V29 a duplicated offer id applied after a same-block
// ocancel: the flush closes the replaced object, so the open copy leaves openOffers and never expires (cairnx-core
// 0.2.4's behaviour, kept). (b) NaN heights among offers, holds and reservations: the sort's comparator is inconsistent
// there, so heights reach the loop out of order. (c) A NaN-height fclaim at the cap rung, at every input position.
export function edges(R) {
  const out = [];
  {
    const k = kit(R, "a9");
    const ev = [], s = ad(0), t = ad(1), h0 = 61_000;
    ev.push(...k.token("EDG", 500, s, h0), k.P(R.transfer({ ticker: "EDG", to: t, amount: "100" }), h0 + 1, 1, s, FAR));
    const off = R.offer({ give: { ticker: "EDG", amount: "1" }, want: { value: "1000" } });
    const e = R.epochOf(h0 + 2), dupId = k.nid(), dup2 = k.nid(), dupB = k.nid();
    ev.push(k.P(off, h0 + 2, 0, s, e + 3, {}, dupId), k.P(R.offerCancelAll({}), h0 + 2, 1, s, FAR), k.P(off, h0 + 2, 2, s, e + 3, {}, dupId));
    ev.push(k.P(off, h0 + 3, 0, s, e + 2, {}, dup2), k.P(off, h0 + 4, 0, t, e + 9, {}, dup2));
    ev.push(k.P(R.offerCancelAll({ ticker: "ZZZ" }), h0 + 5, 0, s, FAR), k.P(R.offerCancelAll({ ticker: "EDG" }), h0 + 6, 0, t, FAR));
    const bd = R.bid({ want: { ticker: "EDG", amount: "1" }, give: { value: "1000" } });
    ev.push(k.P(bd, h0 + 2, 3, s, e + 1, {}, dupB), k.P(bd, h0 + 40, 0, s, e + 5, {}, dupB));
    ev.push(k.P(R.transfer({ ticker: "EDG", to: t, amount: "1" }), h0 + 400, 0, s, FAR));
    out.push({
      key: "S9", label: "a duplicated offer id around a same-block ocancel", events: ev, tipHeight: h0 + 300, tips: [h0 + 2, h0 + 100, 70_000],
      expect(resolveAt) {
        const st = resolveAt(70_000), bad = [];
        need(bad, st.offers[dupId]?.status === "open", "the duplicate copy outside openOffers stays open past its expiry");
        return bad;
      },
    });
  }
  {
    const k = kit(R, "aa");
    const ev = [], s = ad(0), h0 = 61_000;
    ev.push(...k.token("NAN", 100, s, h0 - 10));
    const off = R.offer({ give: { ticker: "NAN", amount: "1" }, want: { value: "1000" } });
    const ids = [];
    for (let i = 0; i < 24; i++) { const e = k.P(off, h0 + (i % 6), i, s, R.epochOf(h0) + (i % 4)); ids.push(e.id); ev.push(e); }
    for (let c = 0; c < 4; c++) for (let j = 0; j < 3; j++) ev.push(k.P(R.fclaim({ offer: ids[3 * c + j] }), h0 + 6 + c, j, ad(10 + c), R.epochOf(h0 + 6) + 1));
    for (let i = 0; i < 12; i++) ev.push(...k.reveal(nm(i), ad(20 + Math.floor(i / 3)), h0 + 20 + (i % 3), h0 + 21 + (i % 3), i));
    for (let i = 0; i < 12; i++) ev.splice(3 + 5 * i, 0, k.P(off, i % 3 === 0 ? Number.NaN : h0 + 7 * i, 50 + i, s, R.epochOf(h0) + (i % 4)));
    out.push({ key: "S9", label: "NaN heights among offers, holds and reservations", events: ev, tipHeight: h0 + 400, tips: [h0 + 2, h0 + 30], expect: () => [] });
  }
  {
    const k = kit(R, "ab");
    const S = ad(5), A = ad(6), base = [...k.token("NHT", 100, S, 60_990)];
    const off = []; for (let i = 0; i < 5; i++) { const o = k.P(R.offer({ give: { ticker: "NHT", amount: "1" }, want: { value: "1000" } }), 61_000, i, S, FAR); off.push(o); base.push(o); }
    const E = R.epochOf(61_001) + 2;
    const seq = [...base, ...[0, 1, 2].map((i) => k.P(R.fclaim({ offer: off[i].id }), 61_001, i, A, E)), k.P(R.fclaim({ offer: off[4].id }), 61_010, 0, A, E)];
    const nan = k.P(R.fclaim({ offer: off[3].id }), Number.NaN, 3, A, E);
    for (let at = 0; at <= seq.length; at++)
      out.push({ key: "S9", label: `a NaN-height fclaim at input position ${at}`, events: [...seq.slice(0, at), nan, ...seq.slice(at)], tipHeight: 61_020, tips: [61_005], expect: () => [] });
  }
  return out;
}

/** Every stream at one size: S1 to S7 at `n` (S6 and S7 with n / 10 cancels or displacements), S8 and S9 as fixed. */
export function growthStreams(R, n) {
  const m = Math.max(10, Math.floor(n / 10));
  return [registrations(R, n), bids(R, n), holds(R, n), reservations(R, n), recaptures(R, n), ocancels(R, n, m), displacements(R, n, m), v21(R), ...edges(R)];
}

/** The streams the seal runs: S1 to S7 at FULL_SIZES, S8 and S9. */
export function fullGrowthStreams(R) {
  return [registrations(R, FULL_SIZES.S1), bids(R, FULL_SIZES.S2), holds(R, FULL_SIZES.S3), reservations(R, FULL_SIZES.S4),
    recaptures(R, FULL_SIZES.S5), ocancels(R, FULL_SIZES.S6, 2_000), displacements(R, FULL_SIZES.S7, 2_000), v21(R), ...edges(R)];
}

/** resolveAt for a stream, over `resolve`: resolveAt(h) replays the events at or below h with tip h. */
export function resolverAt(resolve, s) {
  return (h) => (h === undefined ? resolve(s.events, s.tipHeight) : resolve(s.events.filter((e) => e.height <= h), h));
}
