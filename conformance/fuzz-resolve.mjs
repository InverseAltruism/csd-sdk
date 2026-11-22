// DIFFERENTIAL FUZZER (non-self-fulfilling): generate thousands of random + adversarial CairnX event
// sequences and assert the shipping JS resolver and the INDEPENDENT Python port (cairnx_ref.py) produce
// byte-identical canonicalState on EVERY one. Neither side is told the expected answer; a single
// divergence = a latent cross-language consensus fork. Seeded for reproducibility (prints the seed).
//   node conformance/fuzz-resolve.mjs [N] [seed]
//   node conformance/fuzz-resolve.mjs N seed --emit <file>   writes the N generated sequences as JSON and exits before the
//                                                            differential (scripts/seal-differential.mjs replays them)
//   --expiry   sequences built so that offers, bids, reservations and recapture reservations end inside them, at heights
//              with no event, and later events read what each released; a floor per kind of expiry fails a thin run.
//   --malformed  sequences whose offers, bids, reservations, recapture reservations and tips carry heights, expiries
//              or tips no chain produces (numbers that are not safe integers, numeric and other strings, null,
//              undefined, booleans, arrays, objects, BigInts), on both sides of V21 and of an epoch edge, with a floor
//              per kind and per type; the reference gets the all-integer ones.
// Every run also checks that events which write nothing change nothing (CONVENTION section 5) on the sequences whose
// heights a chain can produce: each is resolved again with an Attest on an unknown proposal at many heights, by JS
// (whole result) and by the reference (canonical state).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { canonicalState, resolve } from "../packages/cairnx/dist/index.js";
import * as R from "../packages/cairnx/dist/index.js";
import { MALFORMED_TYPES, denseTips, dueHeights, expiryKinds, inertEvents, malformedKinds, stringifyNumbers } from "./sweep-streams.mjs";
let gV23Clears = 0; // count of owned-name V23 nset-clears the fuzz exercised (declared top-level to avoid TDZ)
// REBIND B0a: v2.8 fclaim GENERATION-SIDE counters. These record what the generator INTENDED to emit; they
// are NOT evidence that the resolver reached the branch. Denied fclaims are not canonically observable
// (canonicalState omits the fclaims map, so a deny shows up only as the offer staying unheld), which is why
// intent is all a counter can capture here.
// They are printed under a `gen:` prefix and deliberately NOT used as behavioural assertions: a
// generation-side counter that is asserted is a test that cannot fail, which is the exact defect class this
// batch exists to remove. Behavioural coverage of the deny ladder and of the legacy-claim rejection in `applyLegacyClaim`
// (packages/cairnx/src/resolve/attest.ts) is carried by the
// deterministic self-check at the bottom (which drives real sequences through resolve) and by the
// state-derived cov.* counters. Caught at the B0a gate by Opus-B (B0a-R1/R2) after the first cut asserted
// these; the PoC changed one token so the resolver never reached :799 while the counter still read 27.
let gFclaimGrants = 0, gFclaimDenies = 0, gV28LegacyEmitted = 0;

const ARGS = process.argv.slice(2);
const EMIT_AT = ARGS.indexOf("--emit");
const EMIT = EMIT_AT >= 0 ? ARGS.splice(EMIT_AT, 2)[1] : undefined;
if (EMIT_AT >= 0 && !EMIT) { console.error("--emit needs a file path"); process.exit(2); }
const EXPIRY_AT = ARGS.indexOf("--expiry");
const EXPIRY = EXPIRY_AT >= 0;
if (EXPIRY) ARGS.splice(EXPIRY_AT, 1);
const MALFORMED_AT = ARGS.indexOf("--malformed");
const MALFORMED = MALFORMED_AT >= 0;
if (MALFORMED) ARGS.splice(MALFORMED_AT, 1);
const N = Number(ARGS[0] || 3000);
let SEED = Number(ARGS[1] || 0xC417 ^ (N * 2654435761 >>> 0)) >>> 0;
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
// token (deploy) names CAN be unicode ≤32: exercise canonical-JSON emit + UTF-16 length
const TOKNAMES = [undefined, "Gold", "金", "𝕏coin", "á", "💎", "￿x", "x".repeat(32), "x".repeat(33), "lone\uD800"];
const AMOUNTS = ["1", "100", "999999999", "79228162514264337593543950335" /*2^96-1*/, "79228162514264337593543950336" /*2^96*/, "0"];
const BIGEXP = [10, 1500, 9007199254740991, 9007199254740992, 1e21];

const validOr = (fn) => { try { return fn(); } catch { return null; } };
const amt = () => pick(AMOUNTS);
const tick = () => chance(0.85) ? pick(TICKERS) : ("T" + ri(0, 99));
// v1.9 nprofile `p` maps: valid pkeys (lowercase/dotted/integer-index ≤32ch) + sometimes empty (= clear),
// values incl. astral/emoji and boundary 256-byte: exercises the V19 gate/apply/LWW/clear/materialize branches.
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

// A COHERENT flow that actually SUCCEEDS: so the V16 accept path (rebate math + state mutation) is
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
  if (h >= R.V23_HEIGHT) gV23Clears++;   // count ONLY genuine above-gate clears (>=V23 -> addr undefined). When h0 is low the clear can land a few blocks BELOW the gate, where it's a literal-0x0 store (old behavior): not a clear, so don't count it (audit: the old unconditional ++ overcounted ~4.5%).
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
// a live hold must be rejected), the post-holdEnd lapse, and the legacy SCORE_CLAIM that `applyLegacyClaim`
// (packages/cairnx/src/resolve/attest.ts) rejects outright from V28. Heights are forced around the gate.
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
// (owner-gated; sometimes a non-owner that must no-op), then LWW-replace or transfer-clear: exercising the
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

// v2.6 SEALED RECAPTURE: a name registered and paid below V25 lapses past its term and grace; a recapturer
// commits, reveals payment-free (a reservation in the internal recaptures map, the lapsed record untouched) and
// pays the decaying premium at a winner-only nfinalize. lapseFlow's far-future reclaim has no salt, so at >= V26
// it is rejected before this path (recaptureFinalized read 0 over 20,000 sequences without this flow). Sometimes a second recapturer contests, a reveal or the
// finalize misses its window, or the premium is one unit short, so the accept path and its rejects both run.
const RC_D = "0x" + "d7".repeat(20), RC_E = "0x" + "e7".repeat(20), RC_F = "0x" + "f7".repeat(20);
const leaseEnd = (regH) => R.epochOf(regH) + R.NAME_TERM_EPOCHS;                  // paidThrough of a pre-V25 registration
const recapturePremium = (nm, regH, h) => R.expiredClaimFee(nm, R.epochOf(h) - (leaseEnd(regH) + R.NAME_GRACE_EPOCHS), h);
function recaptureFlow() {
  const NM = "rc" + ri(100, 9999);
  const mkSalt = (p) => p + Array.from({ length: ri(14, 28) }, () => "0123456789abcdef"[ri(0, 15)]).join("");
  const sE = mkSalt("e7"), sF = mkSalt("f7");
  const ev = [];
  const push = (who, rec, h, paid) => { if (rec) ev.push({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: ri(0, 3), expiresEpoch: 9_000_000_000_000_000, paidTo: paid || {} }); };
  const regH = ri(R.V15_HEIGHT + 10, R.V25_HEIGHT - 10);
  push(RC_D, validOr(() => R.nameClaim({ name: NM })), regH, { [TREAS]: R.nameRegFee(NM, regH).toString() });
  // first height of the first lapsed epoch, plus a point inside the premium's decay window
  const cEh = (leaseEnd(regH) + R.NAME_GRACE_EPOCHS + 1) * R.EPOCH_LEN + ri(0, R.NAME_PREMIUM_DECAY_EPOCHS * R.EPOCH_LEN);
  push(RC_E, validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sE, RC_E) })), cEh, {});
  const contested = chance(0.4);
  const cFh = contested ? (chance(0.5) ? cEh - ri(1, 3) : cEh + ri(0, 2)) : null;   // F earlier => F wins the reservation
  if (contested) push(RC_F, validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sF, RC_F) })), cFh, {});
  push(RC_E, validOr(() => R.nameClaim({ name: NM, salt: sE })), cEh + ri(1, chance(0.85) ? R.REG_COMMIT_MAX_BLOCKS : R.REG_COMMIT_MAX_BLOCKS + 4), {});
  if (contested) push(RC_F, validOr(() => R.nameClaim({ name: NM, salt: sF })), cFh + ri(1, R.REG_COMMIT_MAX_BLOCKS), {});
  const fin = (who, s, ch) => {                                     // 0-2 in-window, 3 too early, 4 expired
    const mode = ri(0, 4);
    const hf = mode === 3 ? ch + ri(0, R.REG_COMMIT_MAX_BLOCKS)
             : mode === 4 ? ch + R.REG_COMMIT_MAX_BLOCKS + R.REG_FINALIZE_GRACE_BLOCKS + ri(1, 4)
             : ch + R.REG_COMMIT_MAX_BLOCKS + ri(1, R.REG_FINALIZE_GRACE_BLOCKS);
    const need = recapturePremium(NM, regH, hf);
    const fee = chance(0.2) ? need - 1n : need;                     // sometimes one unit short -> reject
    push(who, validOr(() => R.nameFinalize({ name: NM, salt: s })), hf, { [TREAS]: fee.toString() });
  };
  if (chance(0.9)) fin(RC_E, sE, cEh);
  if (contested && chance(0.6)) fin(RC_F, sF, cFh);
  return ev;
}

// --expiry. A seller's offers (CSD- or token-priced, open or taker-bound, some answering a bid), bids, cancels, bulk
// cancels, transfers, fill attempts and fclaims, with expiries a few epochs out and gaps that cross epoch boundaries, so
// that items end at heights holding no event and later events read what they released; reservations left to lapse
// and re-revealed by a rival; a name offer that ends before a transfer. A fifth of the sequences start below V21 with
// offers and bids past the v2.1 cap that cross it; a sixth are recapture reservations that lapse before a rival's.
function expirySeq() {
  if (chance(1 / 6)) return recaptureExpirySeq();
  const L = R.EPOCH_LEN, ev = [], at = new Map();
  const posAt = (hh) => { const p = at.get(hh) ?? 0; at.set(hh, p + 1); return p; };
  const S = "0x" + "e1".repeat(20), B = "0x" + "e3".repeat(20), C = "0x" + "e4".repeat(20), X = "0x" + "e5".repeat(20);
  const P = (rec, who, hh, ee, pt) => { if (!rec) return null; const e = { kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: hh, pos: posAt(hh), expiresEpoch: ee, paidTo: pt || {} }; ev.push(e); return e; };
  const A = (pid, who, hh, score, pt) => ev.push({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence: 0, height: hh, pos: posAt(hh), paidTo: pt || {} });
  const FAR = 9_000_000_000_000_000;
  const crossV21 = chance(0.2);
  let h = crossV21 ? ri(R.V17_HEIGHT + 10, R.V21_HEIGHT - 400) : ri(R.V29_HEIGHT, R.V29_HEIGHT + 30_000);
  const T1 = "E" + ri(100, 999), T2 = "W" + ri(100, 999);
  P(validOr(() => R.deploy({ ticker: T1, decimals: 0, supply: "1000", mint: "issuer" })), S, h, FAR, { [TREAS]: String(R.DEPLOY_FEE) });
  P(validOr(() => R.mint({ ticker: T1, amount: "1000" })), S, h + 1, FAR);
  P(validOr(() => R.deploy({ ticker: T2, decimals: 0, supply: "1000", mint: "issuer" })), B, h, FAR, { [TREAS]: String(R.DEPLOY_FEE) });
  P(validOr(() => R.mint({ ticker: T2, amount: "1000" })), B, h + 1, FAR);
  h += 2;
  const expiry = (hh) => (crossV21 && hh < R.V21_HEIGHT && chance(0.6) ? R.epochOf(hh) + ri(R.MAX_OFFER_EPOCHS + 1, R.MAX_OFFER_EPOCHS + 400) : R.epochOf(hh) + ri(0, 3));
  const offers = [], bids = [];
  const pay = (o, hh) => Object.fromEntries(R.requiredFillOutputs({ id: o.id, seller: S, give: o.give, want: { value: "1000", payto: S }, status: "open", expiresEpoch: o.expiresEpoch,
    height: o.height, feeBps: R.FEE_BPS_V16, ...(o.taker ? { taker: o.taker } : {}), ...(o.bid ? { bid: o.bid } : {}) }, "1000").map((x) => [x.to, String(x.value)]));
  const len = ri(6, 18);
  for (let i = 0; i < len; i++) {
    h += chance(0.3) ? ri(0, 2) : ri(1, 45);
    const r = rng();
    if (r < 0.26) {
      const give = { ticker: T1, amount: String(ri(1, 60)) }, csd = chance(0.7), taker = chance(0.5) ? B : undefined;
      const bid = bids.length && chance(0.35) ? pick(bids) : undefined;
      const rec = validOr(() => R.offer({ give, want: csd ? { value: "1000" } : { ticker: T2, amount: "1" }, ...(bid ? { bid: bid.id, taker: B } : taker ? { taker } : {}) }));
      const ee = bid && chance(0.5) ? bid.expiresEpoch + ri(1, 3) : expiry(h);
      const e = P(rec, S, h, ee);
      if (e && csd) offers.push({ id: e.id, give, expiresEpoch: ee, height: h, taker: bid ? B : taker, bid: bid?.id });
    } else if (r < 0.40) {
      const e = P(validOr(() => R.bid({ want: { ticker: T1, amount: "1" }, give: { value: "1000" } })), B, h, expiry(h));
      if (e) bids.push(e);
    } else if (r < 0.52) {
      P(validOr(() => R.transfer({ ticker: T1, to: X, amount: String(ri(1, 400)) })), S, h, FAR);
    } else if (r < 0.60 && offers.length) {
      A(pick(offers).id, S, h, R.SCORE_CANCEL);
    } else if (r < 0.65) {
      P(validOr(() => R.offerCancelAll(chance(0.5) ? { ticker: T1 } : {})), S, h, FAR);
    } else if (r < 0.75 && offers.length) {
      const o = pick(offers);
      A(o.id, o.taker ?? C, h, R.SCORE_FILL, pay(o, h));
    } else if (r < 0.82 && offers.length && h >= R.V28_HEIGHT) {
      const o = pick(offers);
      P(validOr(() => R.fclaim({ offer: o.id })), C, h, R.epochOf(h) + ri(0, R.FCLAIM_MAX_EPOCH_AHEAD));
    } else if (r < 0.94 && h >= R.V25_HEIGHT) {
      // a reservation left to lapse, finalized one time in four; a rival reveals the name after the deadline or before it
      const nm = "ex" + ri(1000, 99999), salt = "e4e4e4e4e4e4e4e4e4", rs = "e5e5e5e5e5e5e5e5e5";
      P(validOr(() => R.nameCommitRecord({ commit: R.nameCommit(nm, salt, C) })), C, h, FAR);
      const rv = h + ri(1, R.REG_COMMIT_MAX_BLOCKS);
      P(validOr(() => R.nameClaim({ name: nm, salt })), C, rv, FAR);
      const end = h + R.REG_COMMIT_MAX_BLOCKS + R.REG_FINALIZE_GRACE_BLOCKS;
      if (chance(0.25)) { const hf = h + R.REG_COMMIT_MAX_BLOCKS + ri(1, R.REG_FINALIZE_GRACE_BLOCKS); P(validOr(() => R.nameFinalize({ name: nm, salt })), C, hf, FAR, { [TREAS]: R.nameRegFee(nm, hf).toString() }); }
      const ch = chance(0.75) ? end + ri(-6, 40) : rv + ri(0, 10);
      P(validOr(() => R.nameCommitRecord({ commit: R.nameCommit(nm, rs, X) })), X, ch, FAR);
      P(validOr(() => R.nameClaim({ name: nm, salt: rs })), X, ch + ri(1, R.REG_COMMIT_MAX_BLOCKS), FAR);
    } else if (h >= R.V27_HEIGHT) {
      // a name registered by S and offered with a short expiry; a transfer just before and just after the offer ends
      const nm = "eo" + ri(1000, 99999), salt = "e1e1e1e1e1e1e1e1e1";
      P(validOr(() => R.nameCommitRecord({ commit: R.nameCommit(nm, salt, S) })), S, h, FAR);
      P(validOr(() => R.nameClaim({ name: nm, salt })), S, h + 1, FAR);
      const hf = h + R.REG_COMMIT_MAX_BLOCKS + 1;
      P(validOr(() => R.nameFinalize({ name: nm, salt })), S, hf, FAR, { [TREAS]: R.nameRegFee(nm, hf).toString() });
      const ho = hf + ri(0, 3), ee = R.epochOf(ho) + ri(0, 2), end = (ee + 1) * L;
      P(validOr(() => R.offer({ give: { name: nm }, want: { value: "1000" }, taker: B })), S, ho, ee);
      P(validOr(() => R.nameXfer({ name: nm, to: X })), S, end + ri(-1, 0), FAR);
      if (chance(0.5)) P(validOr(() => R.nameXfer({ name: nm, to: C })), S, end + ri(1, 30), FAR);
    }
  }
  if (crossV21) {
    // later events at V21 and past the latest capped expiry, so the cap is read by an event and not only by the tip
    const capped = dueHeights(R, ev).filter((x) => x >= R.V21_HEIGHT);
    for (const hh of [R.V21_HEIGHT + ri(0, 40), Math.max(R.V21_HEIGHT, ...capped) + ri(0, 40)]) if (hh > h) { h = hh; P(validOr(() => R.transfer({ ticker: T1, to: X, amount: "1" })), S, h, FAR); }
  }
  const last = Math.max(...ev.map((e) => e.height));
  return { events: ev, tipHeight: last + ri(0, 3 * L) };
}

// --expiry: a name registered below V25 lapses; E reserves it for recapture and lets the reservation end; F reveals it
// after E's deadline (or before it, refused); sometimes E's finalize comes too late, and E's fresh registration of
// another name ends at the same height.
function recaptureExpirySeq() {
  const NM = "rx" + ri(100, 9999), FN = "fx" + ri(100, 9999), sE = "e7e7e7e7e7e7e7e7e7", sF = "f7f7f7f7f7f7f7f7f7";
  const ev = [], at = new Map();
  const push = (who, rec, h, paid) => { if (rec) { const p = at.get(h) ?? 0; at.set(h, p + 1); ev.push({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: p, expiresEpoch: 9_000_000_000_000_000, paidTo: paid || {} }); } };
  const regH = ri(R.V15_HEIGHT + 10, R.V25_HEIGHT - 10);
  push(RC_D, validOr(() => R.nameClaim({ name: NM })), regH, { [TREAS]: R.nameRegFee(NM, regH).toString() });
  const cEh = (leaseEnd(regH) + R.NAME_GRACE_EPOCHS + 1) * R.EPOCH_LEN + ri(0, 600);
  push(RC_E, validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sE, RC_E) })), cEh);
  push(RC_E, validOr(() => R.nameClaim({ name: NM, salt: sE })), cEh + ri(1, R.REG_COMMIT_MAX_BLOCKS));
  if (chance(0.5)) {
    push(RC_E, validOr(() => R.nameCommitRecord({ commit: R.nameCommit(FN, sE, RC_E) })), cEh);
    push(RC_E, validOr(() => R.nameClaim({ name: FN, salt: sE })), cEh + ri(1, R.REG_COMMIT_MAX_BLOCKS));
  }
  const end = cEh + R.REG_COMMIT_MAX_BLOCKS + R.REG_FINALIZE_GRACE_BLOCKS;
  const cFh = chance(0.75) ? end + ri(-6, 40) : cEh + ri(1, 20);
  push(RC_F, validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sF, RC_F) })), cFh);
  push(RC_F, validOr(() => R.nameClaim({ name: NM, salt: sF })), cFh + ri(1, R.REG_COMMIT_MAX_BLOCKS));
  if (chance(0.3)) { const hf = end + ri(0, 3); push(RC_E, validOr(() => R.nameFinalize({ name: NM, salt: sE })), hf, { [TREAS]: recapturePremium(NM, regH, hf).toString() }); }
  const last = Math.max(...ev.map((e) => e.height));
  return { events: ev, tipHeight: last + ri(0, 90) };
}

// --malformed. A seller's offers and bids, sealed reservations and recapture reservations, each carrying now and then a
// height or an expiry from the malformed lists, around a base height on either side of V21 and next to an epoch edge;
// NaN-height offers get expiries due below V21 (the class whose expiry rises across V21), and some sequences hold
// them across V21 with no event between their raw due height and V21; transfers and tips around
// V21 and the epoch edges read what the sweeps released. Recapture reservations need a lapsed lease, so theirs lie far
// above V21. Heights and expiries kept valid elsewhere so that the malformed field is the one the replay meets; a
// sequence's tip is an integer read from its valid heights.
const BAD_H = [Number.NaN, Infinity, -Infinity, -5, 0.5, 2 ** 53, 2 ** 53 + 2, 1e17];
const BAD_E = [Number.NaN, Infinity, -Infinity, -3, 0.5, 2 ** 53, 2 ** 53 + 2, 1e21];
// Values of other types than number, for heights, expiries and tips: what resolve() takes from a caller that did not
// parse its feed (a numeric string, another string, null, undefined, a boolean, an array, an object, a BigInt).
const BAD_T = [(h) => String(h), () => "x9", () => "", () => null, () => undefined, () => true, () => false, (h) => [h], () => ({}), (h) => BigInt(Math.floor(h))];
function malformedSeq() {
  const L = R.EPOCH_LEN, ev = [], at = new Map(), FAR = 9_000_000_000;
  const posAt = (hh) => { const k = String(hh); const p = at.get(k) ?? 0; at.set(k, p + 1); return p; };
  const S = "0x" + "c1".repeat(20), B = "0x" + "c3".repeat(20), C = "0x" + "c4".repeat(20), X = "0x" + "c5".repeat(20);
  const P = (rec, who, hh, ee, pt) => { if (!rec) return null; const e = { kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: hh, pos: posAt(hh), expiresEpoch: ee, paidTo: pt || {} }; ev.push(e); return e; };
  // two sequences in five carry only integers, so that the reference (given only those) replays them too; one in ten
  // keeps every height and expiry valid and puts only the tip outside the domain
  const ints = chance(0.4), tipOnly = !ints && chance(0.1), okInt = (v) => !ints || (Number.isInteger(v) && Math.abs(v) < 1e21);
  const badH = (h) => { if (tipOnly) return h; if (!ints && chance(0.35)) return pick(BAD_T)(h); const v = chance(0.25) && !ints ? Number.NaN : pick(BAD_H.filter(okInt)); return v === 0.5 ? h + 0.5 : v; };
  const badE = (e) => { if (tipOnly) return e; if (!ints && chance(0.2)) return pick(BAD_T)(e); const v = pick(BAD_E.filter(okInt)); return v === 0.5 ? e + 0.5 : v; };
  // the tip, now and then outside the domain: another type, or a number that is not a safe integer
  const tipOf = (t) => (ints || (!tipOnly && !chance(0.3)) ? t : chance(0.6) ? pick(BAD_T)(t) : pick([t + 0.5, Number.NaN, Infinity, 2 ** 53 + 2]));
  if (!tipOnly && chance(0.12)) {
    // sealed reservations whose commit heights are numeric strings: a deadline is then a string ("90000" + 8 + 20 is
    // "90000820"), which a sweep compares as text at a string height and as a number at a number one; up to three for
    // one owner and, half the time, a fourth name committed and revealed far above at string or number heights, which
    // the reservation cap counts against them; the tip a string or a number, far above or near
    const h = ri(R.V29_HEIGHT, R.V29_HEIGHT + 20_000), salt = "c6c6c6c6c6c6c6c6c6";
    const reserve = (nm, hc, hr) => { P(validOr(() => R.nameCommitRecord({ commit: R.nameCommit(nm, salt, C) })), C, hc, FAR); P(validOr(() => R.nameClaim({ name: nm, salt })), C, hr, FAR); };
    for (let j = ri(1, 3); j > 0; j--) reserve("em" + ri(1000, 99999), String(h + 10 * j), h + 10 * j + ri(1, R.REG_COMMIT_MAX_BLOCKS));
    const far = h * ri(11_000, 20_000);   // above each deadline read as a number ("h" + 8 + 20 + 1 is about 10,000 h)
    if (chance(0.5)) { const H = far + ri(0, 1000); reserve("em" + ri(1000, 99999), String(H), chance(0.5) ? String(H + 1) : H + 1); }
    const t = chance(0.5) ? far + ri(0, 2000) : h + ri(40, 160);
    return { events: ev, tipHeight: chance(0.5) ? String(t) : t };
  }
  if (!tipOnly && chance(0.15)) {
    // offers with a NaN height whose raw expiry falls due below V21, and (half the time) no event from that height up
    // to V21: 0.2.8 leaves such an offer open from V21 on (its cap is NaN), where a sweep that ran a batch at its raw
    // due height would have expired it; with an event between, it expires below V21 either way
    const T = "N" + ri(100, 999), base = R.V21_HEIGHT - ri(200, 6000);
    P(validOr(() => R.deploy({ ticker: T, decimals: 0, supply: "1000", mint: "issuer" })), S, base, FAR, { [TREAS]: String(R.DEPLOY_FEE) });
    P(validOr(() => R.mint({ ticker: T, amount: "1000" })), S, base + 1, FAR);
    let due = R.V21_HEIGHT;
    for (let j = ri(1, 3); j > 0; j--) {
      const E = ri(R.epochOf(base + 1), R.epochOf(R.V21_HEIGHT) - 2);
      due = Math.min(due, (E + 1) * L);
      P(validOr(() => R.offer({ give: { ticker: T, amount: String(ri(1, 400)) }, want: { value: "1000" } })), S, Number.NaN, E);
    }
    if (chance(0.5)) P(validOr(() => R.transfer({ ticker: T, to: X, amount: String(ri(1, 400)) })), S, ri(due, R.V21_HEIGHT - 1), FAR);
    for (let j = ri(1, 3); j > 0; j--) P(validOr(() => R.transfer({ ticker: T, to: X, amount: String(ri(1, 1000)) })), S, R.V21_HEIGHT + ri(0, 60), FAR);
    return { events: ev, tipHeight: tipOf(Math.max(...ev.map((e) => e.height).filter(Number.isSafeInteger)) + ri(0, 90)) };
  }
  if (chance(0.15)) {
    // a lapsed name, reserved for recapture with a malformed commit, reveal or finalize height
    const NM = "rm" + ri(1000, 99999), sE = "c7c7c7c7c7c7c7c7c7", sF = "f8f8f8f8f8f8f8f8f8";
    const regH = ri(R.V15_HEIGHT + 10, R.V25_HEIGHT - 10);
    P(validOr(() => R.nameClaim({ name: NM })), RC_D, regH, FAR, { [TREAS]: R.nameRegFee(NM, regH).toString() });
    const cEh = (leaseEnd(regH) + R.NAME_GRACE_EPOCHS + 1) * L + ri(0, 600);
    const which = ri(0, 2);
    P(validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sE, RC_E) })), RC_E, which === 0 ? badH(cEh) : cEh, FAR);
    P(validOr(() => R.nameClaim({ name: NM, salt: sE })), RC_E, which === 1 ? badH(cEh + 1) : cEh + ri(1, R.REG_COMMIT_MAX_BLOCKS), FAR);
    const end = cEh + R.REG_COMMIT_MAX_BLOCKS + R.REG_FINALIZE_GRACE_BLOCKS;
    if (which === 2 || chance(0.3)) { const hf = which === 2 ? badH(end - 2) : end - ri(0, 10); P(validOr(() => R.nameFinalize({ name: NM, salt: sE })), RC_E, hf, FAR, { [TREAS]: recapturePremium(NM, regH, Number.isFinite(hf) ? hf : end).toString() }); }
    const cFh = end + ri(-4, 40);
    P(validOr(() => R.nameCommitRecord({ commit: R.nameCommit(NM, sF, RC_F) })), RC_F, cFh, FAR);
    P(validOr(() => R.nameClaim({ name: NM, salt: sF })), RC_F, cFh + ri(1, R.REG_COMMIT_MAX_BLOCKS), FAR);
    return { events: ev, tipHeight: tipOf(Math.max(...ev.map((e) => e.height).filter((x) => Number.isSafeInteger(x) && x < 1e9)) + ri(0, 90)) };
  }
  const below = chance(0.5);
  let h = below ? R.V21_HEIGHT - ri(40, 900) : (chance(0.5) ? R.V21_HEIGHT + ri(0, 900) : R.V29_HEIGHT + ri(0, 20_000));
  h = Math.floor(h / L) * L + pick([-2, -1, 0, 1, 28]);   // next to an epoch edge
  const T1 = "M" + ri(100, 999);
  P(validOr(() => R.deploy({ ticker: T1, decimals: 0, supply: "1000", mint: "issuer" })), S, h - 4, FAR, { [TREAS]: String(R.DEPLOY_FEE) });
  P(validOr(() => R.mint({ ticker: T1, amount: "1000" })), S, h - 3, FAR);
  const len = ri(4, 12);
  for (let i = 0; i < len; i++) {
    h += chance(0.3) ? ri(0, 2) : ri(1, 40);
    const r = rng(), mh = chance(0.5), me = !mh || chance(0.3);
    if (r < 0.35) {
      const hh = mh ? badH(h) : h;
      // a NaN-height offer due below V21, so that the stream crosses V21 with it held
      const ee = Number.isNaN(hh) ? R.epochOf(R.V21_HEIGHT) - ri(1, 30) : me ? badE(R.epochOf(h) + ri(0, 2)) : R.epochOf(h) + ri(0, 2);
      P(validOr(() => R.offer({ give: { ticker: T1, amount: String(ri(1, 50)) }, want: { value: "1000" }, ...(chance(0.5) ? { taker: B } : {}) })), S, hh, ee);
    } else if (r < 0.5) {
      P(validOr(() => R.bid({ want: { ticker: T1, amount: "1" }, give: { value: "1000" } })), B, mh ? badH(h) : h, me ? badE(R.epochOf(h) + ri(0, 2)) : R.epochOf(h) + ri(0, 2));
    } else if (r < 0.7 && h >= R.V25_HEIGHT) {
      const nm = "em" + ri(1000, 99999), salt = "c4c4c4c4c4c4c4c4c4", which = ri(0, 2);
      P(validOr(() => R.nameCommitRecord({ commit: R.nameCommit(nm, salt, C) })), C, which === 0 ? badH(h) : h, FAR);
      P(validOr(() => R.nameClaim({ name: nm, salt })), C, which === 1 ? badH(h + 1) : h + ri(1, R.REG_COMMIT_MAX_BLOCKS), FAR);
      const hf = h + R.REG_COMMIT_MAX_BLOCKS + ri(1, R.REG_FINALIZE_GRACE_BLOCKS);
      if (which === 2 || chance(0.3)) P(validOr(() => R.nameFinalize({ name: nm, salt })), C, which === 2 ? badH(hf) : hf, FAR, { [TREAS]: R.nameRegFee(nm, hf).toString() });
    } else {
      P(validOr(() => R.transfer({ ticker: T1, to: X, amount: String(ri(1, 400)) })), S, h, FAR);
    }
  }
  // transfers on both sides of V21 and of the next epoch edge read what the sweeps released
  const edge = (R.epochOf(h) + 1) * L;
  for (const hh of [edge - 1, edge, R.V21_HEIGHT - 1, R.V21_HEIGHT + ri(0, 3)]) if (hh > h - 40) P(validOr(() => R.transfer({ ticker: T1, to: X, amount: String(ri(1, 400)) })), S, hh, FAR);
  const last = Math.max(...ev.map((e) => e.height).filter((x) => Number.isSafeInteger(x) && x < 1e9));
  return { events: ev, tipHeight: tipOf(last + ri(0, 3 * L)) };
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
  if (chance(0.12)) { const e = recaptureFlow(); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
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
      const score = pick([0, 100, 100, 50, 50, ri(0, 200)]); // 50 = SCORE_CLAIM (v1.7): exercise the claim branch
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
  // MUST stay byte-identical: this is the regression guard for QA finding #1 (paidTo input-contract).
  const adversarial = ["0x10", "0b101", "1_000", "", " 5 ", "+5", "007", "0xff", "1.0", "-3", "1e3", "0xdeadbeef"];
  for (let i = 0; i < k; i++) m[addr()] = chance(0.25) ? pick(adversarial) : pick(vals);
  if (chance(0.5)) m[TREAS] = chance(0.25) ? pick(adversarial) : pick(["1500000", "1000000", "100000000", "0", "25500000"]);
  return m;
}

// generate, run JS, batch to Python, diff
const seqs = Array.from({ length: N }, MALFORMED ? malformedSeq : EXPIRY ? expirySeq : genSeq);
if (EMIT) {
  writeFileSync(EMIT, stringifyNumbers(seqs.map((s) => ({ events: s.events, tipHeight: s.tipHeight }))));
  console.log(`emitted ${N} sequences to ${EMIT}`);
  process.exit(0);
}
const runs = seqs.map((s) => { try { return { st: resolve(s.events, s.tipHeight) }; } catch (e) { return { err: "JS_THROW:" + (e?.message || e) }; } });
const js = runs.map((r) => r.err ?? canonicalState(r.st));
// --malformed: the reference gets the sequences whose numbers are all integers JSON writes as such. Its arithmetic
// on NaN and the infinities is Python's, not JavaScript's (a NaN key in its sort, min(E, NaN) = E, inf // 30 = NaN),
// and it refuses to write a state that holds a float; neither reaches a chain input. The events that write nothing go
// where the property is claimed (CONVENTION section 5): every event height and the tip a safe integer.
const intOnly = (s) => [s.tipHeight, ...s.events.flatMap((e) => [e.height, e.pos, ...(e.kind === "propose" ? [e.expiresEpoch] : [])])]
  .every((x) => Number.isInteger(x) && Math.abs(x) < 1e21);
const toRef = seqs.map((s) => !MALFORMED || intOnly(s));
const withTwin = seqs.map((s, i) => !MALFORMED || (runs[i].st !== undefined && Number.isSafeInteger(s.tipHeight) && s.events.every((e) => Number.isSafeInteger(e.height))));
// each sequence's twin: an event that writes nothing at each height of a dense walk (at most 300, the expiry heights kept)
const inertAt = (s) => {
  const due = dueHeights(R, s.events).filter((x) => x <= s.tipHeight);
  const tips = denseTips(s.events.filter((e) => Number.isSafeInteger(e.height)), s.tipHeight, R.EPOCH_LEN, [...due, ...Object.values(R.GATE_HEIGHTS)], 300);
  const keep = new Set(due.flatMap((x) => [x - 1, x]));
  return tips.length <= 300 ? tips : tips.filter((x, i) => keep.has(x) || i % Math.ceil(tips.length / 300) === 0);
};
const twins = seqs.map((s, i) => (withTwin[i] ? { events: [...inertEvents(inertAt(s)), ...s.events], tipHeight: s.tipHeight } : null));
let inertJs = 0, inertPy = 0, inertN = 0;
seqs.forEach((s, i) => {
  if (!twins[i]) return;
  inertN += twins[i].events.length - s.events.length;
  let b;
  const a = runs[i].err ?? JSON.stringify(runs[i].st);
  try { b = JSON.stringify(resolve(twins[i].events, s.tipHeight)); } catch (e) { b = "JS_THROW:" + (e?.message || e); }
  if (a !== b && ++inertJs <= 5) console.error(`✗ seq #${i} JS: events that write nothing changed the result`);
});
const refIdx = seqs.map((_, i) => i).filter((i) => toRef[i]), twinIdx = refIdx.filter((i) => twins[i]);
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname],
  { input: JSON.stringify({ resolve: [...refIdx.map((i) => seqs[i]), ...twinIdx.map((i) => twins[i])].map((s) => ({ events: s.events, tipHeight: s.tipHeight })) }), encoding: "utf8", maxBuffer: 2048 * 1024 * 1024 });
if (py.status !== 0) { console.error("python ref crashed:\n", py.stderr.slice(0, 4000)); process.exit(1); }
const pall = JSON.parse(py.stdout).resolve;
const pj = new Array(N);
refIdx.forEach((i, k) => { pj[i] = pall[k]; });
twinIdx.forEach((i, k) => { if (pall[refIdx.length + k] !== pj[i] && ++inertPy <= 5) console.error(`✗ seq #${i} reference: events that write nothing changed the canonical state`); });

let diverged = 0, jsThrows = 0, notToRef = 0;
const cov = { filledV16Rebate: 0, filledAny: 0, numericNameInState: 0, bigAmountInState: 0, viaFill: 0, expired: 0, feeBps150: 0, v17Claimed: 0, v17OpenFilled: 0, nprofileSet: 0, pendingReg: 0, fclaimHeld: 0, fclaimFilled: 0, aboveV28: 0, recaptureFinalized: 0 };
for (let i = 0; i < N; i++) {
  // A throw fails the run: every replayer would stop at that sequence's block, whatever Python answers. In --malformed a
  // throw is an answer to an input no chain produces (a BigInt in arithmetic); the seal's step (d3) requires 0.2.8's.
  if (js[i].startsWith("JS_THROW:")) { if (++jsThrows <= 5 && !MALFORMED) console.error(`✗ seq #${i} JS resolve() threw: ${js[i].slice(9, 200)}`); continue; }
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
    // a recapturer owns a name only through a v2.6 recapture nfinalize: no flow registers or transfers one to them
    if (st.names && Object.values(st.names).some((n) => n && (n.owner === RC_E || n.owner === RC_F) && !n.pending && !n.expired)) cov.recaptureFinalized++;
  } catch { /* JS state always parses */ }
  if (!toRef[i]) { notToRef++; continue; }
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
console.log(`\nDIFFERENTIAL FUZZ: ${N} sequences · ${N - diverged - jsThrows - notToRef} byte-identical · ${diverged} DIVERGED · ${jsThrows} js-threw${MALFORMED ? ` · ${notToRef} not given to the reference (a value that is not an integer)` : ""}`);
// cov.* are STATE-DERIVED (read back out of canonical state, so they are evidence the resolver reached the
// branch). gen.* are GENERATION-SIDE intent only and are never asserted; see the note at the top.
console.log(`coverage hit: ${JSON.stringify({ ...cov, v23Clears: gV23Clears })}`);
console.log(`gen (intent only, not evidence): ${JSON.stringify({ fclaimGrants: gFclaimGrants, fclaimDenies: gFclaimDenies, v28LegacyEmitted: gV28LegacyEmitted })}`);
console.log(`max generated height: ${seqs.reduce((m, s) => Math.max(m, ...[s.tipHeight, ...s.events.map((e) => e.height)].filter(Number.isSafeInteger)), 0)} (V28 = ${R.V28_HEIGHT})`);
console.log(`events that write nothing: ${inertN} added over ${twins.filter(Boolean).length} twins (${twinIdx.length} to the reference); results changed: JS ${inertJs}, reference ${inertPy}`);
if (inertJs || inertPy) process.exit(1);
if (MALFORMED) {
  // the floors: sequences in which the replay met a malformed field on each kind, a tip outside the domain (and one
  // with every height inside it), each side
  // of V21, an offer with a NaN height open past V21 though its raw expiry fell due below it, a reservation with a
  // string deadline; and sequences carrying each type on a height, an expiry or the tip
  const reach = { offer: 0, bid: 0, reservation: 0, recapture: 0, tip: 0, tipOnly: 0, crossV21: 0, aboveV21: 0, nanOffer: 0, textDeadline: 0 };
  const types = Object.fromEntries(MALFORMED_TYPES.map((t) => [t, 0]));
  seqs.forEach((s, i) => {
    const k = malformedKinds(R, s.events, s.tipHeight, runs[i].st ?? null);
    for (const x of Object.keys(reach)) if (k[x]) reach[x]++;
    for (const t of k.types) types[t]++;
  });
  const floor = Math.max(1, Math.floor(N / 50));
  console.log(`malformed reach (sequences, floor ${floor} each): ${JSON.stringify(reach)}`);
  console.log(`malformed types (sequences, floor ${floor} each): ${JSON.stringify(types)}; ${jsThrows} sequence(s) resolve() refused by throwing`);
  const thin = [...Object.entries(reach), ...Object.entries(types)].filter(([, n]) => n < floor);
  if (thin.length) { console.error(`✗ malformed reach below the floor: ${thin.map(([k, n]) => `${k} ${n}`).join(", ")}`); process.exit(1); }
  process.exit(diverged ? 1 : 0);
}
if (EXPIRY) {
  // the floors: sequences in which each kind of expiry happens with a later event at or above its height
  const reach = { offer: 0, bid: 0, reservation: 0, recapture: 0, v21: 0 };
  seqs.forEach((s, i) => { if (js[i].startsWith("JS_THROW:")) return; const k = expiryKinds(R, s.events, resolve(s.events, s.tipHeight)); for (const x of Object.keys(reach)) if (k[x]) reach[x]++; });
  const floor = Math.max(1, Math.floor(N / 50));
  console.log(`expiry reach (sequences, floor ${floor} each): ${JSON.stringify(reach)}`);
  const thin = Object.entries(reach).filter(([, n]) => n < floor);
  if (thin.length) { console.error(`✗ expiry reach below the floor: ${thin.map(([k, n]) => `${k} ${n}`).join(", ")}`); process.exit(1); }
  process.exit(diverged || jsThrows ? 1 : 0);
}
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
  if (!n || n.owner !== D || n.addr != null) { console.error(`✗ v23 clear self-check FAILED: owned name not cleared (owner=${n && n.owner}, addr=${n && n.addr}); the clear branch is not really exercised`); process.exit(1); }
  if (gV23Clears <= 0) { console.error("✗ v23Clears coverage is 0: the differential fuzz never exercised the V23 clear branch"); process.exit(1); }
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
    console.error(`✗ v25 finalize self-check FAILED: reserve→finalize did not yield a clean owned name (owner=${n && n.owner}, pending=${n && n.pending}, viaFill=${n && n.viaFill}, feesPaid=${st.feesPaid})`); process.exit(1);
  }
  if (!cov.pendingReg) { console.error("✗ pendingReg coverage is 0: the fuzz never materialized a V25 reservation"); process.exit(1); }
  console.log(`✓ v25 finalize self-check: commit→payment-free reveal→nfinalize yields a normal owned name (fee once, not viaFill); fuzz materialized ${cov.pendingReg} pending reservation(s)`);
}
// V28 self-check (REBIND B0a). The headline defect this batch closes: before it, NOT ONE attest in 20,000
// generated sequences ever reached V28, so every v2.8 branch, grant, the fclaim fill routing, Correction 1,
// and the legacy-SCORE_CLAIM rejection in `applyLegacyClaim` (packages/cairnx/src/resolve/attest.ts), was unfuzzed, while V28 is the gate this
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
  // `applyLegacyClaim` (packages/cairnx/src/resolve/attest.ts) rejects every legacy SCORE_CLAIM from V28. Asserting only "claimedBy is undefined above
  // the gate" would also pass if the attest were simply malformed or aimed at nothing, so pair it with a
  // BELOW-gate control built the same way: the identical claim must be GRANTED there. The pair is what makes
  // the gate the cause. (Opus-B, B0a-R2: an assertion that passes on absence is not an assertion.)
  const legOnly = resolve([dep, mnt, off, legacy], base + 5).offers[off.id];
  if (legOnly.claimedBy !== undefined) { console.error("✗ v28 self-check FAILED, a legacy SCORE_CLAIM at >=V28 was honoured; src/resolve/attest.ts applyAttest should reject it"); process.exit(1); }
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
    if (across.claimedBy !== undefined) { console.error(`✗ v28 self-check FAILED, a legacy claim ABOVE the gate was honoured against a BELOW-gate offer (claimedBy=${across.claimedBy}); src/resolve/attest.ts applyAttest must key on the CLAIM's height, not the offer's`); process.exit(1); }
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
  console.log(`✓ v28 fclaim self-check: grant + fclaim-routed fill deliver, a legacy SCORE_CLAIM at >=V28 is rejected (src/resolve/attest.ts applyAttest), and Correction 1 blocks an offer-txid fill during the hold; fuzz resolved ${cov.aboveV28} sequence(s) at/above the gate, granted ${cov.fclaimHeld} hold(s) and routed ${cov.fclaimFilled} fill(s) through an fclaim txid`);
}
// V26 self-check: commit -> payment-free reveal -> nfinalize on a LAPSED name hands it to the recapturer as a
// normal fresh lease, and the premium is paid exactly once. The control (the same sequence without the finalize)
// leaves the lapsed record untouched, so the finalize is what moved the name. Deterministic, seed-independent.
{
  const NM = "rcchk", salt = "e7e7e7e7e7e7e7e7e7e7", regH = R.V25_HEIGHT - 100;
  const cH = (leaseEnd(regH) + R.NAME_GRACE_EPOCHS + 1) * R.EPOCH_LEN, hf = cH + R.REG_COMMIT_MAX_BLOCKS + 2;
  const mk = (who, rec, h, paid) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: 1, expiresEpoch: 9_000_000_000_000_000, paidTo: paid || {} });
  const regFee = R.nameRegFee(NM, regH), premium = recapturePremium(NM, regH, hf);
  const seq = [
    mk(RC_D, R.nameClaim({ name: NM }), regH, { [TREAS]: regFee.toString() }),
    mk(RC_E, R.nameCommitRecord({ commit: R.nameCommit(NM, salt, RC_E) }), cH),
    mk(RC_E, R.nameClaim({ name: NM, salt }), cH + 1),
    mk(RC_E, R.nameFinalize({ name: NM, salt }), hf, { [TREAS]: premium.toString() }),
  ];
  const st = resolve(seq, hf + 3), n = st.names[NM];
  if (!n || n.owner !== RC_E || n.pending || n.viaFill || n.expired || BigInt(st.feesPaid) !== regFee + premium || premium <= regFee) {
    console.error(`✗ v26 recapture self-check FAILED, the finalize did not hand over the lapsed name (owner=${n && n.owner}, expired=${n && n.expired}, feesPaid=${st.feesPaid}, premium=${premium})`); process.exit(1);
  }
  const ctl = resolve(seq.slice(0, 3), cH + 3).names[NM];
  if (!ctl || ctl.owner !== RC_D || !ctl.expired) { console.error(`✗ v26 recapture self-check FAILED, the reservation alone changed the lapsed record (owner=${ctl && ctl.owner})`); process.exit(1); }
  if (!cov.recaptureFinalized) { console.error("✗ recaptureFinalized coverage is 0, the fuzz never reached the v2.6 sealed-recapture accept path"); process.exit(1); }
  console.log(`✓ v26 recapture self-check: commit→payment-free reveal→nfinalize hands a lapsed name to the recapturer (premium once, not viaFill); fuzz finalized ${cov.recaptureFinalized} recapture(s)`);
}
process.exit(diverged || jsThrows ? 1 : 0);
