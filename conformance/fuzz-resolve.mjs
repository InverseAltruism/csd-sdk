// DIFFERENTIAL FUZZER (non-self-fulfilling) — generate thousands of random + adversarial CairnX event
// sequences and assert the shipping JS resolver and the INDEPENDENT Python port (cairnx_ref.py) produce
// byte-identical canonicalState on EVERY one. Neither side is told the expected answer; a single
// divergence = a latent cross-language consensus fork. Seeded for reproducibility (prints the seed).
//   node conformance/fuzz-resolve.mjs [N] [seed]
import { spawnSync } from "node:child_process";
import { canonicalState, resolve } from "../packages/cairnx/dist/index.js";
import * as R from "../packages/cairnx/dist/index.js";

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

// build a (mostly) valid record via the shipping helpers; returns {uri, payloadHash} or null
function buildRec() {
  const t = pick(["deploy", "mint", "transfer", "offer", "bid", "ocancel", "ncommit", "name", "nxfer", "nset", "nrenew", "tmeta"]);
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
      case "nxfer": return R.nameXfer({ name: pick(NAMES), to: addr() });
      case "nset": return R.nameSet({ name: pick(NAMES), addr: addr() });
      case "nrenew": return R.nameRenew({ name: pick(NAMES) });
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

function genSeq() {
  if (chance(0.20)) { const e = coherentFlow(ri(29900, 40040)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.14)) { const e = nameFlow(ri(29900, 40040)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  if (chance(0.10)) { const e = lapseFlow(ri(32100, 33000)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 60000) }; }
  if (chance(0.18)) { const e = openFlow(ri(R.V17_HEIGHT, R.V17_HEIGHT + 5000)); if (e.length) return { events: e, tipHeight: e[e.length - 1].height + ri(0, 40) }; }
  const events = [];
  const len = ri(1, 16);
  let h = ri(29810, 40050); // spans ACTIVATION-50 .. V16+50 (all gates + boundaries)
  const offerIds = [];
  for (let i = 0; i < len; i++) {
    if (chance(0.25)) h += ri(0, 3); // sometimes same block (tests pos ordering / same-block fill+cancel)
    else h += ri(1, 400);
    const pos = ri(0, 6);
    const ee = pick(BIGEXP);
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
  for (let i = 0; i < k; i++) m[addr()] = pick(["1", "1000000", "100000000", "125500000", "1500000", "500000000", "79228162514264337593543950335"]);
  if (chance(0.5)) m[TREAS] = pick(["1500000", "1000000", "100000000", "0", "25500000"]);
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
const cov = { filledV16Rebate: 0, filledAny: 0, numericNameInState: 0, bigAmountInState: 0, viaFill: 0, expired: 0, feeBps150: 0, v17Claimed: 0, v17OpenFilled: 0 };
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
console.log(`coverage hit: ${JSON.stringify(cov)}`);
process.exit(diverged ? 1 : 0);
