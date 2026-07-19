// DIFFERENTIAL FUZZER (non-self-fulfilling) — generate thousands of random + adversarial CairnX event
// sequences and assert the shipping JS resolver and the INDEPENDENT Python port (cairnx_ref.py) produce
// byte-identical canonicalState on EVERY one. Neither side is told the expected answer; a single
// divergence = a latent cross-language consensus fork. Seeded for reproducibility (prints the seed).
//   node conformance/fuzz-resolve.mjs [N] [seed]
import { spawnSync } from "node:child_process";
import { canonicalState, resolve } from "../packages/cairnx/dist/index.js";
import * as R from "../packages/cairnx/dist/index.js";
let gV23Clears = 0; // count of owned-name V23 nset-clears the fuzz exercised (declared top-level to avoid TDZ)
// REBIND B0a: v2.8 fclaim GENERATION-SIDE counters. These record what the generator INTENDED to emit; they
// are NOT evidence that the resolver reached the branch. Denied fclaims are not canonically observable
// (canonicalState omits the fclaims map, so a deny shows up only as the offer staying unheld), which is why
// intent is all a counter can capture here.
// They are printed under a `gen:` prefix and deliberately NOT used as behavioural assertions: a
// generation-side counter that is asserted is a test that cannot fail, which is the exact defect class this
// batch exists to remove. Behavioural coverage of the deny ladder and of resolve.ts:799 is carried by the
// deterministic self-check at the bottom (which drives real sequences through resolve) and by the
// state-derived cov.* counters. Caught at the B0a gate by Opus-B (B0a-R1/R2) after the first cut asserted
// these; the PoC changed one token so the resolver never reached :799 while the counter still read 27.
let gFclaimGrants = 0, gFclaimDenies = 0, gV28LegacyEmitted = 0;

const N = Number(process.argv[2] || 3000);
let SEED = Number(process.argv[3] || 0xC417 ^ (N * 2654435761 >>> 0)) >>> 0;
const rng = () => { SEED = (SEED * 1664525 + 1013904223) >>> 0; return SEED / 0x100000000; };
const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (a) => a[ri(0, a.length - 1)];
const chance = (p) => rng() < p;

const TREAS = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
const ADDRS = [TREAS, ...Array.from({ length: 7 }, (_, i) => "0x" + String.fromCharCode(97 + i).repeat(2).repeat(20).slice(0, 40))];
const addr = () => "0x" + (ADDRS[ri(0, ADDRS.length - 1)].slice(2)); // includes treasury sometimes
const TICKERS = ["GOLD", "PAY", "TKN", "ZZZ9", "A1B", "WCSD"];
// names: numeric (integer-key ordering), boundary indices, non-canonical-decimal, strings, invalid
const NAMES = ["1", "2", "10", "42", "0", "007", "4294967294", "4294967295", "0x", "alice", "zzz", "a-b", "BAD!", "", "x".repeat(33)];
// token (deploy) names CAN be unicode ≤32 — exercise canonical-JSON emit + UTF-16 length
const TOKNAMES = [undefined, "Gold", "金", "𝕏coin", "á", "💎", "￿x", "x".repeat(32), "x".repeat(33), "lone\uD800"];
const AMOUNTS = ["1", "100", "999999999", "79228162514264337593543950335" /*2^96-1*/, "79228162514264337593543950336" /*2^96*/, "0"];
const BIGEXP = [10, 1500, 9007199254740991, 9007199254740992, 1e21];

const validOr = (fn) => { try { return fn(); } catch { return null; } };
const amt = () => pick(AMOUNTS);
const tick = () => chance(0.85) ? pick(TICKERS) : ("T" + ri(0, 99));
// v1.9 nprofile `p` maps: valid pkeys (lowercase/dotted/integer-index ≤32ch) + sometimes empty (= clear),
// values incl. astral/emoji and boundary 256-byte — exercises the V19 gate/apply/LWW/clear/materialize branches.
const PKEYS = ["display", "avatar", "bio", "url", "com.twitter", "a.b.c", "x", "k0", "k1", "2", "10", "z".repeat(32)];
const pmap = () => { const n = ri(0, 6); const m = {}; for (let i = 0; i < n; i++) m[pick(PKEYS)] = chance(0.15) ? "\u{1F600}" : (chance(0.1) ? "x".repeat(256) : "v" + ri(0, 9999)); return m; };

// build a (mostly) valid record via the shipping helpers; returns {uri, payloadHash} or null
function buildRec() {
  const t = pick(["deploy", "mint", "transfer", "offer", "bid", "ocancel", "ncommit", "name", "nfinalize", "nxfer", "nset", "nrenew", "nprofile", "tmeta"]);
  return validOr(() => {
    switch (t) {
      case "deploy": { const mint = pick(["issuer", "open"]); const r = { ticker: tick(), decimals: ri(0, 8), supply: amt(), mint }; const nm = pick(TOKNAMES); if (nm !== undefined) r.name = nm; if (mint === "open") r.mintLimit = amt(); return R.deploy(r); }
      case "mint": return R.mint(chance(0.7) ? { ticker: tick(), amount: amt() } : { ticker: tick() });
      case "transfer": return R.transfer({ ticker: tick(), to: addr(), amount: amt(), ...(chance(0.3) ? { ts: pick(BIGEXP) } : {}) });
      case "offer": {
        const give = chance(0.5) ? { ticker: tick(), amount: amt() } : { name: pick(NAMES) };
        const want = chance(0.6) ? { value: amt() } : { ticker: tick(), amount: amt() };
        if (chance(0.4)) want.payto = addr();
        const r = { give, want };
        if (chance(0.4)) r.taker = addr();
        if (chance(0.3)) r.bid = "0x" + "bb".repeat(32);
        if (chance(0.3) && "value" in want && !("ticker" in want)) r.min = amt();
        return R.offer(r);
      }
      case "bid": return R.bid({ want: chance(0.5) ? { ticker: tick(), amount: amt() } : { name: pick(NAMES) }, give: { value: amt() } });
      case "ocancel": return R.offerCancelAll(chance(0.4) ? {} : chance(0.5) ? { ticker: tick() } : { name: pick(NAMES) });
      case "ncommit": return R.nameCommitRecord({ commit: "0x" + Array.from({ length: 64 }, () => "0123456789abcdef"[ri(0, 15)]).join("") });
      case "name": return R.nameClaim(chance(0.5) ? { name: pick(NAMES) } : { name: pick(NAMES), salt: Array.from({ length: ri(16, 64) }, () => "0123456789abcdef"[ri(0, 15)]).join("") });
      case "nfinalize": return R.nameFinalize({ name: pick(NAMES), salt: Array.from({ length: ri(16, 64) }, () => "0123456789abcdef"[ri(0, 15)]).join("") });
      case "nxfer": return R.nameXfer({ name: pick(NAMES), to: addr() });
      case "nset": return R.nameSet({ name: pick(NAMES), addr: chance(0.12) ? R.ZERO_ADDR : addr() }); // V23: sometimes the clear sentinel (mostly non-owner -> rejected; owned clears come from v23ClearFlow)
      case "nrenew": return R.nameRenew({ name: pick(NAMES) });
      case "nprofile": return R.nameProfile({ name: pick(NAMES), p: pmap() });
      case "tmeta": return R.tokenMeta({ ticker: tick(), hash: "0x" + "ab".repeat(32) });
    }
  });
}

let idc = 1;
const nid = () => "0x" + (idc++).toString(16).padStart(64, "0");

// A COHERENT flow that actually SUCCEEDS — so the V16 accept path (rebate math + state mutation) is
// exercised, not just parse/reject. deploy→mint→[bid]→offer→fill, with paidTo computed correctly
// (incl. the rebate for a bid-answered v1.6 offer) OR deliberately underpaid.
function coherentFlow(h0) {
  const ev = [];
  const D = "0x" + "dd".repeat(20), B = "0x" + "be".repeat(20);
  const T = "C" + ri(100, 999), val = pick(["100000000", "250000000", "1", "999999999"]);
  const give = pick(["10", "1000000"]);
  let h = h0; const P = (b, who, pt, exp) => ({ kind: "propose", id: nid(), proposer: who, uri: b.uri, payloadHash: b.payloadHash, height: h, pos: ri(0, 3), expiresEpoch: exp ?? 9_000_000_000_000_000, paidTo: pt });
  const dep = validOr(() => R.deploy({ ticker: T, decimals: 0, supply: "1000000", mint: "issuer" })); if (!dep) return [];
  ev.push(P(dep, D, { [TREAS]: "100000000" })); h += ri(1, 5);
  ev.push(P(validOr(() => R.mint({ ticker: T, amount: "1000000" })), D, {})); h += ri(1, 5);
  const answersBid = chance(0.6);
  const bidId = "0x" + "f1".repeat(32);
  if (answersBid) { ev.push({ ...P(validOr(() => R.bid({ want: { ticker: T, amount: give }, give: { value: val } }), {}), B, {}), id: bidId }); h += ri(1, 5); }
  const distinctPayto = chance(0.5);
  const payto = distinctPayto ? "0x" + "ee".repeat(20) : D;
  const offRec = { give: { ticker: T, amount: give }, want: distinctPayto ? { value: val, payto } : { value: val }, taker: B, ...(answersBid ? { bid: bidId } : {}) };
  const off = validOr(() => R.offer(offRec)); if (!off) return ev;
  const offEv = P(off, D, {}); const offerId = offEv.id; const offH = h; ev.push(offEv); h += ri(1, 6);
  // correct paidTo for the fill: price→payto, fee→treasury, rebate→seller (if v1.6 bid-answered)
  const feeBps = offH >= R.V16_HEIGHT ? 150 : 100;
  const want = BigInt(val), fee = R.tradeFee(want, feeBps);
  const rebate = (offH >= R.V16_HEIGHT && answersBid) ? R.makerRebate(want) : 0n;
  const acc = new Map(); const ad = (a, v) => { if (v > 0n) acc.set(a, (acc.get(a) ?? 0n) + v); };
  ad(payto, want); ad(TREAS, fee); if (rebate > 0n) ad(D, rebate);
  const underpay = chance(0.3); // sometimes drop the rebate (or short the fee) → resolver must REJECT
  const pt = {}; for (const [a, v] of acc) pt[a] = (underpay && (a === D && rebate > 0n) ? v - 1n : v).toString();
  ev.push({ kind: "attest", txid: nid(), proposalId: offerId, attester: B, score: 100, confidence: 0, height: h, pos: ri(0, 3), paidTo: pt });
  return ev;
}

// NAME sold via fill → viaFill displacement-immunity (Path C name-give). Spacing respects the v1.3
// young-name gate (offer height > claim height + COMMIT_MAX_BLOCKS) and the v1.5 lease-window gate.
function nameFlow(h0) {
  const ev = []; const D = "0x" + "da".repeat(20), B = "0x" + "bf".repeat(20);
  const NM = "nm" + ri(100, 9999); const val = pick(["100000000", "1", "250000000"]);
  const regfee = NM.length <= 5 ? "100000000" : "50000000";
  let h = h0;
  ev.push({ kind: "propose", id: nid(), proposer: D, uri: R.nameClaim({ name: NM }).uri, payloadHash: R.nameClaim({ name: NM }).payloadHash, height: h, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: { [TREAS]: regfee } });
  h += 250; // out-age the commit window (v1.3 young-name gate)
  const answersBid = chance(0.5); const bidId = "0x" + "f2".repeat(32);
  if (answersBid) { ev.push({ kind: "propose", id: bidId, proposer: B, uri: R.bid({ want: { name: NM }, give: { value: val } }).uri, payloadHash: R.bid({ want: { name: NM }, give: { value: val } }).payloadHash, height: h, pos: 0, expiresEpoch: 8_000_000_000_000_000, paidTo: {} }); h += 5; }
  const off = validOr(() => R.offer({ give: { name: NM }, want: { value: val }, taker: B, ...(answersBid ? { bid: bidId } : {}) })); if (!off) return ev;
  const offH = h; const offerId = nid();
  ev.push({ kind: "propose", id: offerId, proposer: D, uri: off.uri, payloadHash: off.payloadHash, height: offH, pos: 1, expiresEpoch: Math.floor(offH / 30) + 50, paidTo: {} });
  h += ri(1, 5);
  const feeBps = offH >= R.V16_HEIGHT ? 150 : 100; const want = BigInt(val);
  const rebate = (offH >= R.V16_HEIGHT && answersBid) ? R.makerRebate(want) : 0n;
  const acc = new Map(); const ad = (a, v) => { if (v > 0n) acc.set(a, (acc.get(a) ?? 0n) + v); };
  ad(D, want); ad(TREAS, R.tradeFee(want, feeBps)); if (rebate > 0n) ad(D, rebate);
  const pt = {}; for (const [a, v] of acc) pt[a] = v.toString();
  ev.push({ kind: "attest", txid: nid(), proposalId: offerId, attester: B, score: 100, confidence: 0, height: h, pos: 1, paidTo: pt });
  return ev;
}
// V23 nset-clear coverage: register a name (owner D), point it at self, then CLEAR it (nset->ZERO) at a
// post-V23 height; sometimes a 2nd self-pointing name so the primary recompute is exercised. Drives the new
// owner-gated clear branch with the proposer actually owning the name (the generic-path nsets are non-owner).
function v23ClearFlow(h0) {
  const ev = []; const D = "0x" + "da".repeat(20), B = "0x" + "bf".repeat(20);
  let h = Math.max(R.V23_HEIGHT - 30, h0);
  // pay the REAL registration fee (nameRegFee scales by length/height); a flat under-fee would be rejected
  // "fee unpaid" at >=V18, leaving the name unowned so the clear would no-op (the bug the audit caught).
  const reg = (n, hh) => ev.push({ kind: "propose", id: nid(), proposer: D, uri: R.nameClaim({ name: n }).uri, payloadHash: R.nameClaim({ name: n }).payloadHash, height: hh, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: { [TREAS]: R.nameRegFee(n, hh).toString() } });
  const set = (n, a, hh) => ev.push({ kind: "propose", id: nid(), proposer: D, uri: R.nameSet({ name: n, addr: a }).uri, payloadHash: R.nameSet({ name: n, addr: a }).payloadHash, height: hh, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: {} });
  // Register+own the name BELOW V25: at >=V25 a `name` reveal is a payment-free RESERVATION, not an owned name,
  // so its clear would no-op. V25 < V23, so a below-V25 registration is also below the V23 clear window and the
  // owned name persists (no lapse for ~1yr) all the way to the clear. Keeps the clear coverage genuine.
  const regH = Math.min(R.V25_HEIGHT, R.V23_HEIGHT) - 200;
  const NM = "z" + ri(100, 9999); reg(NM, regH); set(NM, D, regH + 2);
  if (chance(0.5)) { const NM2 = "y" + ri(100, 9999); reg(NM2, regH + 3); set(NM2, D, regH + 4); }  // 2nd self-pointing name -> primary recompute on clear
  if (h >= R.V23_HEIGHT) gV23Clears++;   // count ONLY genuine above-gate clears (>=V23 -> addr undefined). When h0 is low the clear can land a few blocks BELOW the gate, where it's a literal-0x0 store (old behavior) — not a clear, so don't count it (audit: the old unconditional ++ overcounted ~4.5%).
  set(NM, R.ZERO_ADDR, h);   // the CLEAR (height >= V23 -> n.addr = undefined; owner-gated; the name is owned+paid so it APPLIES)
  if (chance(0.4)) { h += 2; set(NM, B, h); }   // sometimes re-point after clear (clear-then-reset)
  return ev;
}
// A LEASE that LAPSES: claim a name, then a far-future tip pushes it past term+grace → expired:true,
// and sometimes a premium re-claim by another party (decaying-premium fee).
function lapseFlow(h0) {
  const ev = []; const D = "0x" + "1a".repeat(20), E = "0x" + "2b".repeat(20);
  const NM = "lz" + ri(100, 9999);
  ev.push({ kind: "propose", id: nid(), proposer: D, uri: R.nameClaim({ name: NM }).uri, payloadHash: R.nameClaim({ name: NM }).payloadHash, height: h0, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: { [TREAS]: NM.length <= 5 ? "100000000" : "50000000" } });
  // far-future re-claim attempt (decaying premium); sometimes underpay → rejected (still expired in state)
  if (chance(0.6)) {
    const farH = h0 + ri(300000, 400000);
    const reclaim = R.nameClaim({ name: NM });
    ev.push({ kind: "propose", id: nid(), proposer: E, uri: reclaim.uri, payloadHash: reclaim.payloadHash, height: farH, pos: 1, expiresEpoch: Math.floor(farH / 30) + 9999, paidTo: { [TREAS]: pick(["1", "200000000", "10000000000"]) } });
  }
  return ev;
}

// v1.7 OPEN offer (no taker) → claim → fill. Exercises the claim branch (grant/compete/cap), the
// V13↔V17 inversion (open offer allowed ≥V17), and the fill gate (only the live claimer may fill;
// wrong-claimer + lapsed-claim + no-claim fills must be rejected). h0 ≥ V17_HEIGHT.
function openFlow(h0) {
  const ev = []; const D = "0x" + "d0".repeat(20), B = "0x" + "b0".repeat(20), C = "0x" + "c0".repeat(20);
  const T = "O" + ri(100, 999), val = pick(["100000000", "1", "250000000"]);
  let h = h0;
  const dep = validOr(() => R.deploy({ ticker: T, decimals: 0, supply: "1000000", mint: "issuer" })); if (!dep) return [];
  const P = (b, who, pt) => ({ kind: "propose", id: nid(), proposer: who, uri: b.uri, payloadHash: b.payloadHash, height: h, pos: ri(0, 3), expiresEpoch: 9_000_000_000_000_000, paidTo: pt });
  ev.push(P(dep, D, { [TREAS]: "100000000" })); h += ri(1, 3);
  ev.push(P(validOr(() => R.mint({ ticker: T, amount: "1000000" })), D, {})); h += ri(1, 3);
  const off = validOr(() => R.offer({ give: { ticker: T, amount: "10" }, want: { value: val } })); if (!off) return ev; // OPEN: no taker (allowed ≥V17)
  const offerId = nid(); ev.push({ kind: "propose", id: offerId, proposer: D, uri: off.uri, payloadHash: off.payloadHash, height: h, pos: 1, expiresEpoch: Math.floor(h / 30) + 99999, paidTo: {} }); h += ri(1, 4);
  const claimer = pick([B, C]);
  ev.push({ kind: "attest", txid: nid(), proposalId: offerId, attester: claimer, score: 50, confidence: 0, height: h, pos: ri(0, 3), paidTo: {} });
  if (chance(0.35)) ev.push({ kind: "attest", txid: nid(), proposalId: offerId, attester: pick([B, C]), score: 50, confidence: 0, height: h, pos: ri(0, 3), paidTo: {} }); // competing claim
  h += ri(1, 4);
  const filler = pick([claimer, B, C]);                                  // sometimes the wrong addr
  const fillH = chance(0.3) ? h + 20 : h;                                // sometimes after the claim lapses
  const feeBps = h0 >= R.V16_HEIGHT ? 150 : 100; const want = BigInt(val);
  const reb = h0 >= R.V17_HEIGHT ? R.makerRebate(want) : 0n;  // v1.7 open-ask earns the rebate → filler must pay want+rebate to D
  ev.push({ kind: "attest", txid: nid(), proposalId: offerId, attester: filler, score: 100, confidence: 0, height: fillH, pos: 1, paidTo: { [D]: (want + reb).toString(), [TREAS]: R.tradeFee(want, feeBps).toString() } });
  return ev;
}

// v2.8 FCLAIM (§31): the V28 hold lane. buildRec never emitted an `fclaim` and the generic height band
// topped out below V28, so before REBIND B0a this differential had ZERO coverage of the entire v2.8
// grant/deny/fill-routing surface, measured over 20,000 generated sequences, heights DID exceed V28 (via
// lapseFlow's far-future re-claims) but every one of those events was a `propose`, so not one attest ever
// reached the gate. That made the fork guard on every later consensus change vacuous for V28.
// This flow drives: grant, the fill routed through the fclaim txid, Correction 1 (an offer-txid fill during
// a live hold must be rejected), the post-holdEnd lapse, and the legacy SCORE_CLAIM that resolve.ts:799
// rejects outright from V28. Heights are forced around the gate.
function fclaimFlow(h0) {
  const ev = [];
  const D = "0x" + "f0".repeat(20), B = "0x" + "fb".repeat(20), C = "0x" + "fc".repeat(20);
  const T2 = "F" + ri(100, 999), val = pick(["100000000", "1", "500000000", "250000000"]);
  const P = (b, who, pt, hh, ee) => ({ kind: "propose", id: nid(), proposer: who, uri: b.uri, payloadHash: b.payloadHash, height: hh, pos: ri(0, 3), expiresEpoch: ee ?? 9_000_000_000_000_000, paidTo: pt });
  const dep = validOr(() => R.deploy({ ticker: T2, decimals: 0, supply: "1000000", mint: "issuer" })); if (!dep) return [];
  const base = Math.max(h0, R.V28_HEIGHT + 1);
  ev.push(P(dep, D, { [TREAS]: String(R.DEPLOY_FEE) }, base - 3));
  ev.push(P(validOr(() => R.mint({ ticker: T2, amount: "1000000" })), D, {}, base - 2));
  const off = validOr(() => R.offer({ give: { ticker: T2, amount: "10" }, want: { value: val } })); if (!off) return ev;  // OPEN: no taker, CSD-priced (fclaim requires both)
  const offEv = P(off, D, {}, base - 1, Math.floor((base - 1) / R.EPOCH_LEN) + 99999);
  const offerId = offEv.id; ev.push(offEv);
  // A legacy SCORE_CLAIM at >=V28 is REJECTED outright (v2.8: claims are fclaim proposals now). Emitting it
  // before the grant proves the rejection does not consume the offer or block the fclaim that follows.
  const legacy = chance(0.35);
  if (legacy) { ev.push({ kind: "attest", txid: nid(), proposalId: offerId, attester: C, score: 50, confidence: 0, height: base, pos: 0, paidTo: {} }); gV28LegacyEmitted++; }
  const gh = base + ri(0, 3);
  const E = Math.floor(gh / R.EPOCH_LEN) + ri(0, R.FCLAIM_MAX_EPOCH_AHEAD + 1);   // sometimes one epoch too far -> anti-squat deny
  const grantOk = E <= Math.floor(gh / R.EPOCH_LEN) + R.FCLAIM_MAX_EPOCH_AHEAD;
  const g = P(validOr(() => R.fclaim({ offer: offerId })), B, {}, gh, E); if (!g.uri) return ev;
  ev.push(g);
  if (grantOk) gFclaimGrants++; else gFclaimDenies++;
  const holdEnd = (E + 1) * R.EPOCH_LEN - 1;
  const want = BigInt(val), fee = R.tradeFee(want, R.FEE_BPS_V16), reb = R.makerRebate(want);  // open lane >=V17 earns the maker rebate
  const pt = { [D]: (want + reb).toString(), [TREAS]: fee.toString() };
  if (chance(0.30)) {
    // Correction 1: a fill attesting the OFFER txid while the hold is live must be rejected
    ev.push({ kind: "attest", txid: nid(), proposalId: offerId, attester: B, score: 100, confidence: 0, height: gh + 1, pos: 1, paidTo: pt });
  }
  const late = chance(0.25);                                   // sometimes past holdEnd -> the fill lapses
  const fh = late ? holdEnd + ri(1, 30) : gh + ri(1, Math.max(1, Math.min(40, holdEnd - gh)));
  const filler = chance(0.85) ? B : C;                          // sometimes the wrong address
  const underpay = chance(0.25);                                // sometimes drop the rebate -> resolver must REJECT
  const ptf = underpay ? { [D]: want.toString(), [TREAS]: fee.toString() } : pt;
  ev.push({ kind: "attest", txid: nid(), proposalId: g.id, attester: filler, score: 100, confidence: 0, height: fh, pos: ri(0, 2), paidTo: ptf });
  return ev;
}

// v1.9 nprofile materialization (H1): register a name by its owner ABOVE the V19 gate, set a profile
// (owner-gated; sometimes a non-owner that must no-op), then LWW-replace or transfer-clear — exercising the
// apply / last-write-wins / clear-on-transfer / tip-materialization branches the random fuzzer rarely hits.
function nprofileFlow(h0) {
  const ev = []; const O = "0x" + "ce".repeat(20), B = "0x" + "bd".repeat(20);
  const NM = "np" + ri(100, 9999);
  let h = Math.max(h0, R.V11_HEIGHT + 10);
  ev.push({ kind: "propose", id: nid(), proposer: O, uri: R.nameClaim({ name: NM }).uri, payloadHash: R.nameClaim({ name: NM }).payloadHash, height: h, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: { [TREAS]: NM.length <= 5 ? "100000000" : "50000000" } });
  h = Math.max(h + ri(1, 300), R.V19_HEIGHT + ri(1, 400)); // above the v1.9 gate so the profile materializes
  const p1 = validOr(() => R.nameProfile({ name: NM, p: pmap() }));
  if (p1) ev.push({ kind: "propose", id: nid(), proposer: chance(0.85) ? O : B, uri: p1.uri, payloadHash: p1.payloadHash, height: h, pos: 0, expiresEpoch: 9_000_000_000_000_000, paidTo: {} });
  if (chance(0.4)) { h += ri(1, 50); const p2 = validOr(() => R.nameProfile({ name: NM, p: pmap() })); if (p2) ev.push({ kind: "propose", id: nid(), proposer: O, uri: p2.uri, payloadHash: p2.payloadHash, height: h, pos: 0, expiresEpoch: 9_000_000_000_000_000, paidTo: {} }); }
  else if (chance(0.4)) { h += ri(1, 50); const xf = R.nameXfer({ name: NM, to: B }); ev.push({ kind: "propose", id: nid(), proposer: O, uri: xf.uri, payloadHash: xf.payloadHash, height: h, pos: 0, expiresEpoch: 9_000_000_000_000_000, paidTo: {} }); }
  return ev;
}

// v2.5/v2.6 SEALED-RESERVATION registration under the differential: commit -> PAYMENT-FREE reveal (a `pending`
// reservation) -> winner-only `nfinalize` (pays the reg fee, valid only AFTER the freeze). buildRec never emits
// nfinalize coherently, so without a dedicated flow the fork-guard has ZERO coverage of the new finalize state
// transition. Random height/pos/fee/salt/order + a contested (earliest-commit-wins) race exercise the ACCEPT and
// every REJECT branch (early / expired / underpaid / displaced / salt-mismatch); resolve() decides accept/reject,
// the differential asserts JS==Python. Heights are forced >= V25 so it is always the sealed path.
function regFlow(h0) {
  const A = "0x" + "a7".repeat(20), B = "0x" + "b7".repeat(20);
  const NM = "rg" + ri(100, 9999);
  const mkSalt = (p) => p + Array.from({ length: ri(14, 28) }, () => "0123456789abcdef"[ri(0, 15)]).join("");
  const sA = mkSalt("a7"), sB = mkSalt("b7");
  const ev = [];
  const push = (who, rec, h, paid) => { if (rec) ev.push({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: ri(0, 3), expiresEpoch: 9_000_000_000_000_000, paidTo: paid || {} }); };
  const cAh = Math.max(h0, R.V25_HEIGHT + 5);
  push(A, validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sA, A) })), cAh, {});
  const contested = chance(0.5);
  const cBh = contested ? (chance(0.5) ? cAh - ri(1, 3) : cAh + ri(0, 2)) : null;   // B earlier => B wins the race
  if (contested) push(B, validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sB, B) })), cBh, {});
  push(A, validOr(() => R.nameClaim({ name: NM, salt: sA })), cAh + ri(1, chance(0.85) ? R.REG_COMMIT_MAX_BLOCKS : R.REG_COMMIT_MAX_BLOCKS + 4), {}); // mostly in-window, sometimes past it -> reject
  if (contested) push(B, validOr(() => R.nameClaim({ name: NM, salt: sB })), cBh + ri(1, R.REG_COMMIT_MAX_BLOCKS), {});
  const fin = (who, s, ch) => {                                     // winner-only; random timing/fee hits accept + reject
    const mode = ri(0, 4);                                         // 0-2 in-window, 3 too-early, 4 expired
    const hf = mode === 3 ? ch + ri(0, R.REG_COMMIT_MAX_BLOCKS)
             : mode === 4 ? ch + R.REG_COMMIT_MAX_BLOCKS + R.REG_FINALIZE_GRACE_BLOCKS + ri(1, 4)
             : ch + R.REG_COMMIT_MAX_BLOCKS + ri(1, R.REG_FINALIZE_GRACE_BLOCKS);
    const need = R.nameRegFee(NM, hf);
    const fee = chance(0.2) && need > 0n ? need - 1n : need;       // sometimes underpay -> reject
    push(who, validOr(() => R.nameFinalize({ name: NM, salt: s })), hf, { [TREAS]: fee.toString() });
  };
  if (chance(0.9)) fin(A, sA, cAh);
  if (contested && chance(0.6)) fin(B, sB, cBh);
  return ev;
}

function genSeq() {
  if (chance(0.20)) { const e = coherentFlow(ri(29900, 40040)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.14)) { const e = nameFlow(ri(29900, 40040)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.12)) { const e = v23ClearFlow(ri(R.V23_HEIGHT - 100, R.V23_HEIGHT + 2000)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.14)) { const e = nprofileFlow(ri(R.V19_HEIGHT - 200, R.V19_HEIGHT + 3000)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.10)) { const e = lapseFlow(ri(32100, 33000)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 60000) }; }
  if (chance(0.18)) { const e = openFlow(ri(R.V17_HEIGHT, R.V17_HEIGHT + 5000)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.13)) { const e = regFlow(ri(R.V25_HEIGHT - 20, R.V25_HEIGHT + 3000)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.16)) { const e = fclaimFlow(ri(R.V28_HEIGHT - 40, R.V28_HEIGHT + 2500)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 120) }; }
  const events = [];
  const len = ri(1, 16);
  // REBIND B0a: the band used to be ri(29810, V23+1000), an arithmetic maximum of 59,400 once the
  // per-step h += ri(1,400) is added, i.e. strictly below V28 = 60,000. Rather than move the whole band
  // (which would thin out coverage of every gate below it), a quarter of sequences now seed at the V28
  // boundary so the random path exercises the gate too, not only the dedicated flow.
  let h = chance(0.25) ? ri(R.V28_HEIGHT - 200, R.V28_HEIGHT + 2500) : ri(29810, R.V23_HEIGHT + 1000);
  const offerIds = [];
  for (let i = 0; i < len; i++) {
    if (chance(0.25)) h += ri(0, 3); // sometimes same block (tests pos ordering / same-block fill+cancel)
    else h += ri(1, 400);
    const pos = ri(0, 6);
    const ee = pick(BIGEXP);
    // REBIND B0a: an fclaim propose referencing a real-ish id, so the random path reaches the §31 handler
    // at all. MEASURED REACH, so nobody reads more into this than it delivers (Opus-A, B0a-1): over 1500
    // sequences this emits ~286 fclaims, ~75 at or above V28 (the rest exit at the `height < V28_HEIGHT`
    // inertness check, which is itself worth covering), and of those ~75 only a handful target a real offer
    // record and effectively none target a CSD-priced untaken one. So in practice this path exercises the
    // below-gate inertness check and the `unknown offer` leg, NOT the rest of the deny ladder and NOT the
    // grant path. The ladder is covered by v28-fclaim-crosslang.mjs scenario 13 and the grant/fill path by
    // fclaimFlow above. Kept because those two legs are real coverage and it costs nothing.
    if (offerIds.length && chance(0.10)) {
      const fc = validOr(() => R.fclaim({ offer: pick(offerIds) }));
      if (fc) {
        const id = nid();
        const eE = Math.floor(h / R.EPOCH_LEN) + ri(-1, R.FCLAIM_MAX_EPOCH_AHEAD + 2); // mixes valid / anti-squat / already-past
        events.push({ kind: "propose", id, proposer: addr(), uri: fc.uri, payloadHash: fc.payloadHash, height: h, pos, expiresEpoch: eE, paidTo: randPaidTo() });
        offerIds.push(id);
        continue;
      }
    }
    if (chance(0.62)) {
      // a propose (valid record); occasionally adversarial-mutate the uri/hash
      const built = buildRec();
      if (!built) { i--; continue; }
      let uri = built.uri, ph = built.payloadHash;
      if (chance(0.06)) uri = uri.replace("}", ',"zZ\u{1D7D8}":1}'); // non-canonical/decoy → both must no-op
      if (chance(0.04)) ph = "0x" + "00".repeat(32);                  // hash mismatch → both no-op
      const id = nid();
      events.push({ kind: "propose", id, proposer: addr(), uri, payloadHash: ph, height: h, pos, expiresEpoch: ee, paidTo: randPaidTo() });
      offerIds.push(id);
    } else {
      // an attest (fill/cancel/claim/garbage) referencing a real-ish or random proposal id
      const pidRef = offerIds.length && chance(0.8) ? pick(offerIds) : nid();
      const score = pick([0, 100, 100, 50, 50, ri(0, 200)]); // 50 = SCORE_CLAIM (v1.7) — exercise the claim branch
      const confidence = pick([0, 100, 1_000_000, ri(0, 2_000_000)]);
      events.push({ kind: "attest", txid: nid(), proposalId: pidRef, attester: addr(), score, confidence, height: h, pos, paidTo: randPaidTo() });
    }
  }
  return { events, tipHeight: h + ri(0, 50) };
}

function randPaidTo() {
  const m = {};
  const k = ri(0, 3);
  const vals = ["1", "1000000", "100000000", "125500000", "1500000", "500000000", "79228162514264337593543950335"];
  // adversarial NON-canonical forms: raw BigInt()/int() historically DIVERGED on these (one yields a value,
  // the other throws). The AMOUNT_RE gate (ptAmt / _pt) must make BOTH treat them as 0, so the differential
  // MUST stay byte-identical — this is the regression guard for QA finding #1 (paidTo input-contract).
  const adversarial = ["0x10", "0b101", "1_000", "", " 5 ", "+5", "007", "0xff", "1.0", "-3", "1e3", "0xdeadbeef"];
  for (let i = 0; i < k; i++) m[addr()] = chance(0.25) ? pick(adversarial) : pick(vals);
  if (chance(0.5)) m[TREAS] = chance(0.25) ? pick(adversarial) : pick(["1500000", "1000000", "100000000", "0", "25500000"]);
  return m;
}

// generate, run JS, batch to Python, diff
const seqs = Array.from({ length: N }, genSeq);
const js = seqs.map((s) => { try { return canonicalState(resolve(s.events, s.tipHeight)); } catch (e) { return "JS_THROW:" + (e?.message || e); } });
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname],
  { input: JSON.stringify({ resolve: seqs.map((s) => ({ events: s.events, tipHeight: s.tipHeight })) }), encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
if (py.status !== 0) { console.error("python ref crashed:\n", py.stderr.slice(0, 4000)); process.exit(1); }
const pj = JSON.parse(py.stdout).resolve;

let diverged = 0, jsThrows = 0;
const cov = { filledV16Rebate: 0, filledAny: 0, numericNameInState: 0, bigAmountInState: 0, viaFill: 0, expired: 0, feeBps150: 0, v17Claimed: 0, v17OpenFilled: 0, nprofileSet: 0, pendingReg: 0, fclaimHeld: 0, fclaimFilled: 0, aboveV28: 0 };
for (let i = 0; i < N; i++) {
  if (js[i].startsWith("JS_THROW:")) { jsThrows++; continue; } // a JS throw is fine IF Python also can't produce (both fail closed) — flag separately
  // coverage: confirm the fuzzer actually reaches the high-risk paths
  try {
    const st = JSON.parse(js[i]);
    if (js[i].includes('"feeBps":150')) cov.feeBps150++;
    if (js[i].includes('"status":"filled"')) cov.filledAny++;
    if (js[i].includes('"feeBps":150') && js[i].includes('"status":"filled"')) cov.filledV16Rebate++;
    if (js[i].includes("79228162514264337593543950335")) cov.bigAmountInState++;
    if (js[i].includes('"viaFill":true')) cov.viaFill++;
    if (js[i].includes('"claimedBy":')) cov.v17Claimed++;                                              // v1.7 claim granted
    if (st.offers && Object.values(st.offers).some((o) => o.claimedBy && o.status === "filled" && !o.taker)) cov.v17OpenFilled++; // open offer claimed + filled
    if (js[i].includes('"expired":true')) cov.expired++;
    if (st.names && Object.keys(st.names).some((k) => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295)) cov.numericNameInState++;
    if (st.names && Object.values(st.names).some((n) => n && n.profile !== undefined)) cov.nprofileSet++; // v1.9 nprofile materialized (H1)
    if (st.names && Object.values(st.names).some((n) => n && n.pending === true)) cov.pendingReg++;        // v2.5 sealed reservation materialized (>=V25)
    // v2.8: claimTxid is set ONLY by an fclaim grant (a legacy SCORE_CLAIM sets claimedBy/claimUntilHeight
    // but never claimTxid), so its presence in canonical state is an unambiguous grant signal.
    if (js[i].includes('"claimTxid":')) cov.fclaimHeld++;
    if (st.offers && Object.values(st.offers).some((o) => o.claimTxid && o.status === "filled")) cov.fclaimFilled++;
    if (Number(st.tipHeight) >= R.V28_HEIGHT) cov.aboveV28++;
  } catch { /* JS state always parses */ }
  if (js[i] !== pj[i]) {
    diverged++;
    if (diverged <= 5) {
      let k = 0; const a = js[i], b = pj[i] ?? "<py-missing>"; while (k < a.length && k < b.length && a[k] === b[k]) k++;
      console.error(`✗ seq #${i} DIVERGED at offset ${k}`);
      console.error(`   JS : …${a.slice(Math.max(0, k - 50), k + 70)}`);
      console.error(`   PY : …${b.slice(Math.max(0, k - 50), k + 70)}`);
      console.error(`   events: ${JSON.stringify(seqs[i].events).slice(0, 600)}`);
    }
  }
}
console.log(`\nDIFFERENTIAL FUZZ: ${N} sequences · ${N - diverged - jsThrows} byte-identical · ${diverged} DIVERGED · ${jsThrows} js-threw`);
// cov.* are STATE-DERIVED (read back out of canonical state, so they are evidence the resolver reached the
// branch). gen.* are GENERATION-SIDE intent only and are never asserted; see the note at the top.
console.log(`coverage hit: ${JSON.stringify({ ...cov, v23Clears: gV23Clears })}`);
console.log(`gen (intent only, not evidence): ${JSON.stringify({ fclaimGrants: gFclaimGrants, fclaimDenies: gFclaimDenies, v28LegacyEmitted: gV28LegacyEmitted })}`);
console.log(`max generated height: ${seqs.reduce((m, s) => Math.max(m, s.tipHeight, ...s.events.map((e) => e.height)), 0)} (V28 = ${R.V28_HEIGHT})`);
// HONEST-COUNTER guard: prove v23ClearFlow actually REACHES the clear branch (a paid+owned name cleared at
// >=V23 -> addr undefined), so the gV23Clears counter cannot silently lie again (audit caught a flat under-fee
// that left the name unowned, no-op'ing every clear). Deterministic, independent of the random seed.
{
  const D = "0x" + "da".repeat(20), NM = "selfchk";
  const regH = Math.min(R.V25_HEIGHT, R.V23_HEIGHT) - 100;   // PAID+OWNED below V25 (a V25 reveal is a reservation, not owned); < V23 so it persists to the clear
  const H = R.V23_HEIGHT + 50;                                // the CLEAR happens here (>= V23)
  const mk = (rec, hh, paid) => ({ kind: "propose", id: nid(), proposer: D, uri: rec.uri, payloadHash: rec.payloadHash, height: hh, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: paid || {} });
  const seq = [
    mk(R.nameClaim({ name: NM }), regH, { [TREAS]: R.nameRegFee(NM, regH).toString() }),   // PAID registration below V25 -> owned
    mk(R.nameSet({ name: NM, addr: D }), regH + 1),                                          // point at self
    mk(R.nameSet({ name: NM, addr: R.ZERO_ADDR }), H),                                       // CLEAR at >=V23
  ];
  const n = resolve(seq, H + 5).names[NM];
  if (!n || n.owner !== D || n.addr != null) { console.error(`✗ v23 clear self-check FAILED — owned name not cleared (owner=${n && n.owner}, addr=${n && n.addr}); the clear branch is not really exercised`); process.exit(1); }
  if (gV23Clears <= 0) { console.error("✗ v23Clears coverage is 0 — the differential fuzz never exercised the V23 clear branch"); process.exit(1); }
  console.log(`✓ v23 clear self-check: a paid+owned name was genuinely cleared (addr->undefined); fuzz exercised the branch ${gV23Clears}x`);
}
// V25 self-check: prove a commit -> PAYMENT-FREE reveal -> nfinalize genuinely FINALIZES to a NORMAL owned name
// (accept path reachable, fee paid exactly once, NOT viaFill), so regFlow coverage cannot silently be all-rejects.
{
  const A = "0x" + "a7".repeat(20), NM = "regchk", salt = "a7a7a7a7a7a7a7a7a7a7";
  const V = R.V25_HEIGHT, hf = V + R.REG_COMMIT_MAX_BLOCKS + 2;
  const mk = (rec, h, paid) => ({ kind: "propose", id: nid(), proposer: A, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: paid || {} });
  const seq = [
    mk(R.nameCommitRecord({ commit: R.nameCommit(NM, salt, A) }), V, {}),
    mk(R.nameClaim({ name: NM, salt }), V + 1, {}),                                       // payment-free reveal (pending)
    mk(R.nameFinalize({ name: NM, salt }), hf, { [TREAS]: R.nameRegFee(NM, hf).toString() }),
  ];
  const st = resolve(seq, hf + 3), n = st.names[NM];
  if (!n || n.owner !== A.toLowerCase() || n.pending || n.viaFill || Number(st.feesPaid) !== Number(R.nameRegFee(NM, hf))) {
    console.error(`✗ v25 finalize self-check FAILED — reserve→finalize did not yield a clean owned name (owner=${n && n.owner}, pending=${n && n.pending}, viaFill=${n && n.viaFill}, feesPaid=${st.feesPaid})`); process.exit(1);
  }
  if (!cov.pendingReg) { console.error("✗ pendingReg coverage is 0 — the fuzz never materialized a V25 reservation"); process.exit(1); }
  console.log(`✓ v25 finalize self-check: commit→payment-free reveal→nfinalize yields a normal owned name (fee once, not viaFill); fuzz materialized ${cov.pendingReg} pending reservation(s)`);
}
// V28 self-check (REBIND B0a). The headline defect this batch closes: before it, NOT ONE attest in 20,000
// generated sequences ever reached V28, so every v2.8 branch, grant, the fclaim fill routing, Correction 1,
// and the legacy-SCORE_CLAIM rejection at resolve.ts:799, was unfuzzed, while V28 is the gate this
// differential exists to guard. Deterministic, seed-independent, and it asserts the branches are REACHED,
// not merely that the counters moved.
{
  const D = "0x" + "f0".repeat(20), B = "0x" + "fb".repeat(20), NMT = "FCHK";
  // Derive the hold epoch from the live cap rather than hardcoding +1, so a future gate that lowers
  // FCLAIM_MAX_EPOCH_AHEAD cannot make this self-check fail while blaming resolve (Opus-A, B0a-3).
  const base = R.V28_HEIGHT + 5, EE = Math.floor(base / R.EPOCH_LEN) + Math.min(1, R.FCLAIM_MAX_EPOCH_AHEAD), holdEnd = (EE + 1) * R.EPOCH_LEN - 1;
  const P = (rec, who, hh, pt, ee) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: hh, pos: 0, expiresEpoch: ee ?? 9_000_000_000_000_000, paidTo: pt || {} });
  const dep = P(R.deploy({ ticker: NMT, decimals: 0, supply: "1000000", mint: "issuer" }), D, base - 4, { [TREAS]: String(R.DEPLOY_FEE) });
  const mnt = P(R.mint({ ticker: NMT, amount: "1000000" }), D, base - 3);
  const off = P(R.offer({ give: { ticker: NMT, amount: "10" }, want: { value: "100000000" } }), D, base - 2, {}, Math.floor(base / R.EPOCH_LEN) + 99999);
  const g = P(R.fclaim({ offer: off.id }), B, base, {}, EE);
  const want = 100000000n, pt = { [D]: (want + R.makerRebate(want)).toString(), [TREAS]: R.tradeFee(want, R.FEE_BPS_V16).toString() };
  const legacy = { kind: "attest", txid: nid(), proposalId: off.id, attester: B, score: 50, confidence: 0, height: base - 1, pos: 0, paidTo: {} };
  const fill = { kind: "attest", txid: nid(), proposalId: g.id, attester: B, score: 100, confidence: 0, height: holdEnd - 1, pos: 0, paidTo: pt };
  const held = resolve([dep, mnt, off, legacy, g], base + 5).offers[off.id];
  if (held.claimTxid !== g.id || held.claimedBy !== B.toLowerCase()) { console.error(`✗ v28 self-check FAILED, fclaim did not grant the hold (claimTxid=${held.claimTxid})`); process.exit(1); }
  // resolve.ts:799 rejects every legacy SCORE_CLAIM from V28. Asserting only "claimedBy is undefined above
  // the gate" would also pass if the attest were simply malformed or aimed at nothing, so pair it with a
  // BELOW-gate control built the same way: the identical claim must be GRANTED there. The pair is what makes
  // the gate the cause. (Opus-B, B0a-R2: an assertion that passes on absence is not an assertion.)
  const legOnly = resolve([dep, mnt, off, legacy], base + 5).offers[off.id];
  if (legOnly.claimedBy !== undefined) { console.error("✗ v28 self-check FAILED, a legacy SCORE_CLAIM at >=V28 was honoured; resolve.ts:799 should reject it"); process.exit(1); }
  {
    const lb = R.V28_HEIGHT - 60;   // comfortably below the gate, well above V17 where the claim lane opened
    const depL = P(R.deploy({ ticker: "FCHL", decimals: 0, supply: "1000000", mint: "issuer" }), D, lb - 4, { [TREAS]: String(R.DEPLOY_FEE) });
    const mntL = P(R.mint({ ticker: "FCHL", amount: "1000000" }), D, lb - 3);
    const offL = P(R.offer({ give: { ticker: "FCHL", amount: "10" }, want: { value: "100000000" } }), D, lb - 2, {}, Math.floor(lb / R.EPOCH_LEN) + 99999);
    const legL = { kind: "attest", txid: nid(), proposalId: offL.id, attester: B, score: 50, confidence: 0, height: lb, pos: 0, paidTo: {} };
    const belowGate = resolve([depL, mntL, offL, legL], lb + 5).offers[offL.id];
    if (belowGate.claimedBy !== B.toLowerCase()) { console.error(`✗ v28 self-check FAILED, the below-gate control did not grant a legacy claim (claimedBy=${belowGate.claimedBy}); the above-gate rejection proves nothing without it`); process.exit(1); }
    // Third leg: the SAME below-gate offer, claimed from ABOVE the gate. The two legs above move the offer
    // and the claim together, so they establish "height matters" but cannot attribute the gate to the
    // CLAIM's own height. Without this, a resolver keyed on `o.height` instead of `ev.height` passes both
    // and silently honours every legacy claim against a pre-gate offer, defeating the v2.8 sunset. That is
    // the grant-height keying class this ecosystem already had to correct once (SEAM-V28).
    // Found at the B0a re-gate by Opus-B (M4).
    const legAcross = { kind: "attest", txid: nid(), proposalId: offL.id, attester: B, score: 50, confidence: 0, height: R.V28_HEIGHT + 40, pos: 0, paidTo: {} };
    const across = resolve([depL, mntL, offL, legAcross], R.V28_HEIGHT + 60).offers[offL.id];
    if (across.claimedBy !== undefined) { console.error(`✗ v28 self-check FAILED, a legacy claim ABOVE the gate was honoured against a BELOW-gate offer (claimedBy=${across.claimedBy}); resolve.ts:799 must key on the CLAIM's height, not the offer's`); process.exit(1); }
    // Exact-boundary pin: nothing else in the suite probes height === V28_HEIGHT itself, so a `>` for `>=`
    // slip is invisible. The gate is inclusive, so a claim AT the gate must already be rejected (Opus-B, M3).
    const legAt = { kind: "attest", txid: nid(), proposalId: offL.id, attester: B, score: 50, confidence: 0, height: R.V28_HEIGHT, pos: 0, paidTo: {} };
    const atGate = resolve([depL, mntL, offL, legAt], R.V28_HEIGHT + 20).offers[offL.id];
    if (atGate.claimedBy !== undefined) { console.error(`✗ v28 self-check FAILED, a legacy claim AT exactly V28_HEIGHT was honoured (claimedBy=${atGate.claimedBy}); the gate is inclusive (>=), not exclusive`); process.exit(1); }
  }
  const done = resolve([dep, mnt, off, legacy, g, fill], holdEnd + 5).offers[off.id];
  if (done.status !== "filled" || done.claimTxid !== g.id) { console.error(`✗ v28 self-check FAILED, the fclaim-routed fill did not deliver (status=${done.status})`); process.exit(1); }
  const c1 = resolve([dep, mnt, off, g, { ...fill, proposalId: off.id, height: base + 1 }], holdEnd + 5).offers[off.id];
  if (c1.status !== "open") { console.error(`✗ v28 self-check FAILED, Correction 1: an offer-txid fill during a live hold was accepted (status=${c1.status})`); process.exit(1); }
  // Only STATE-DERIVED counters are asserted. Each is read back out of canonical state, so it cannot be
  // satisfied by the generator merely intending to emit something.
  if (!cov.aboveV28) { console.error("✗ aboveV28 coverage is 0, no sequence resolved at or above the V28 gate"); process.exit(1); }
  if (!cov.fclaimHeld) { console.error("✗ fclaimHeld coverage is 0, the fuzz never granted a v2.8 hold"); process.exit(1); }
  if (!cov.fclaimFilled) { console.error("✗ fclaimFilled coverage is 0, the fuzz never routed a fill through an fclaim txid"); process.exit(1); }
  console.log(`✓ v28 fclaim self-check: grant + fclaim-routed fill deliver, a legacy SCORE_CLAIM at >=V28 is rejected (resolve.ts:799), and Correction 1 blocks an offer-txid fill during the hold; fuzz resolved ${cov.aboveV28} sequence(s) at/above the gate, granted ${cov.fclaimHeld} hold(s) and routed ${cov.fclaimFilled} fill(s) through an fclaim txid`);
}
process.exit(diverged ? 1 : 0);
