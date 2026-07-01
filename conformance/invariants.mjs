// LEDGER-SOUNDNESS INVARIANTS — a general, feature-agnostic correctness oracle for the CairnX resolver.
//
// money-safety.mjs targets ONE failure mode (a fee anchored then rejected) and the fixtures encode KNOWN
// incidents. This file is the general tool: properties that must hold for EVERY resolved state regardless
// of which feature produced it or what changes in the future. A change that breaks ledger soundness (a
// balance goes negative, tokens are minted from nothing, a mint exceeds its cap, an offer lock leaks, a
// name is bricked, the fee tally is inflated) violates one of these WITHOUT anyone having to anticipate the
// specific bug. That is what makes it useful for future work, not just the register-fee-burn we already know.
//
// It checks INVARIANTS over states, so a CLEAN run means "the resolver stayed sound across everything the
// fuel explored". The value is twofold: today it is a proof-of-soundness over a broad random space; going
// forward it goes non-zero the moment a change breaks an invariant.
//
// Fuel:
//   node conformance/invariants.mjs [N] [seed]   # broad random corpus (default 5000), report violations + coverage
//   node conformance/invariants.mjs --selftest    # feed HAND-BROKEN states to each invariant, assert it fires
//   cat seqs.json | node conformance/invariants.mjs --stdin   # check invariants over your own sequences
//        (pipe the real on-chain event stream here, or the fuzz corpus, for coverage far beyond the built-in fuel)
//
// Report-only. Wraps the compiled resolver; changes nothing. Exit 1 ONLY on --selftest if an invariant fails
// to fire (the checker is broken) — a real-corpus violation is a finding printed for triage, not a build break.

import { resolve, TREASURY_ADDR, V15_HEIGHT, V17_HEIGHT, V25_HEIGHT, V26_HEIGHT, DEPLOY_FEE, nameRegFee, nameClaim, nameCommit, nameCommitRecord, nameXfer, nameSet, nameRenew, nameFinalize, deploy, mint, transfer, offer, bid, offerCancelAll, tradeFee, FEE_BPS_V16 } from "../packages/cairnx/dist/index.js";
import { pathToFileURL } from "node:url";

const T = TREASURY_ADDR;
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const NUM_RE = /^(0|[1-9][0-9]*)$/;
const bi = (s) => (typeof s === "string" && (NUM_RE.test(s) || /^-[1-9][0-9]*$/.test(s)) ? BigInt(s) : null); // accepts negatives so INV1 can SEE them

// ── the invariants (each: state -> string[] of violations). Pure, feature-agnostic. ─────────────────────

// INV1 no balance is ever negative
export function invNoNegativeBalance(st) {
  const v = [];
  for (const [t, holders] of Object.entries(st.balances || {}))
    for (const [a, b] of Object.entries(holders)) {
      const av = bi(b.available), lk = bi(b.locked);
      if (av === null || av < 0n) v.push(`INV1 negative available: ${t}/${a}=${b.available}`);
      if (lk === null || lk < 0n) v.push(`INV1 negative locked: ${t}/${a}=${b.locked}`);
    }
  return v;
}

// INV2 token conservation: every minted unit is held somewhere; transfers/locks/fills never create or destroy
export function invTokenConservation(st) {
  const v = [];
  for (const [t, tok] of Object.entries(st.tokens || {})) {
    let held = 0n;
    for (const b of Object.values((st.balances || {})[t] || {})) held += (bi(b.available) || 0n) + (bi(b.locked) || 0n);
    const minted = bi(tok.minted);
    if (minted === null || held !== minted) v.push(`INV2 conservation: ${t} held=${held} minted=${tok.minted}`);
  }
  return v;
}

// INV3 a token can never mint beyond its declared supply cap
export function invMintWithinCap(st) {
  const v = [];
  for (const [t, tok] of Object.entries(st.tokens || {})) {
    const m = bi(tok.minted), s = bi(tok.supply);
    if (m === null || s === null || m > s) v.push(`INV3 over-cap: ${t} minted=${tok.minted} supply=${tok.supply}`);
  }
  return v;
}

// INV4 locks exactly back open offers: for each (token, seller), locked balance == sum of that seller's OPEN
// token-give offers of that token. Catches a leaked lock (offer closed but tokens still locked) or a phantom
// lock (locked without an open offer) or an under-lock (open offer without the tokens reserved).
export function invLockIntegrity(st) {
  const v = [];
  const exp = new Map();
  for (const o of Object.values(st.offers || {})) {
    if (o.status !== "open") continue;
    const g = o.give;
    if (g && g.ticker !== undefined && g.amount !== undefined) { const k = `${g.ticker}|${o.seller}`; exp.set(k, (exp.get(k) || 0n) + (bi(g.amount) || 0n)); }
  }
  const act = new Map();
  for (const [t, holders] of Object.entries(st.balances || {}))
    for (const [a, b] of Object.entries(holders)) { const lk = bi(b.locked) || 0n; if (lk > 0n) act.set(`${t}|${a}`, lk); }
  for (const k of new Set([...exp.keys(), ...act.keys()])) { const e = exp.get(k) || 0n, a = act.get(k) || 0n; if (e !== a) v.push(`INV4 lock mismatch: ${k} locked=${a} openOffers=${e}`); }
  return v;
}

// INV5 names are always well-formed: valid owner, effectiveHeight <= height (back-dating only goes earlier),
// a pending reservation is still finalizable (finalizeBy > tip) and holds no addr, a set addr is well-formed.
// A "bricked" name (dead/undefined owner, or a stale pending that should have been swept) trips this.
export function invNameWellFormed(st) {
  const v = [];
  for (const [nm, n] of Object.entries(st.names || {})) {
    if (!ADDR_RE.test(n.owner || "")) v.push(`INV5 bad owner: ${nm}=${n.owner}`);
    if (typeof n.effectiveHeight === "number" && typeof n.height === "number" && n.effectiveHeight > n.height) v.push(`INV5 effHeight>height: ${nm} ${n.effectiveHeight}>${n.height}`);
    if (n.pending) {
      if (!(typeof n.finalizeBy === "number" && n.finalizeBy > st.tipHeight)) v.push(`INV5 stale pending: ${nm} finalizeBy=${n.finalizeBy} tip=${st.tipHeight}`);
      if (n.addr !== undefined) v.push(`INV5 pending name carries an addr: ${nm}`);
    }
    if (n.addr !== undefined && !ADDR_RE.test(n.addr)) v.push(`INV5 bad addr: ${nm}=${n.addr}`);
  }
  return v;
}

// INV6 name-lock symmetry: a name is locked IFF exactly it backs an open offer that gives it, and any open
// name-give offer references a name that exists. Catches a name stuck locked after its offer closed, or a
// live offer whose name is not actually reserved (a double-spend/theft window).
export function invNameLockSymmetry(st) {
  const v = [];
  const openGiven = new Set();
  for (const o of Object.values(st.offers || {})) if (o.status === "open" && o.give && o.give.name !== undefined) openGiven.add(o.give.name);
  for (const [nm, n] of Object.entries(st.names || {})) {
    if (n.locked && !openGiven.has(nm)) v.push(`INV6 name locked with no open offer: ${nm}`);
    if (!n.locked && openGiven.has(nm)) v.push(`INV6 open name-offer but name unlocked: ${nm}`);
  }
  for (const nm of openGiven) if (!(st.names || {})[nm]) v.push(`INV6 open offer gives a non-existent name: ${nm}`);
  return v;
}

// INV7 fee accounting: the resolver's own feesPaid tally must never exceed the treasury outputs actually
// anchored by the events it APPLIED. If it credits more fees than were paid, the accounting is unsound.
export function invFeeAccounting(st, events) {
  const byId = new Map(events.map((e) => [e.kind === "propose" ? e.id : e.txid, e]));
  let anchored = 0n;
  for (const l of st.events) {
    if (!l.ok) continue;
    const ev = byId.get(l.id); if (!ev) continue;
    const t = ev.paidTo && ev.paidTo[T];
    if (typeof t === "string" && NUM_RE.test(t)) anchored += BigInt(t);
  }
  const fp = bi(st.feesPaid) || 0n;
  return fp > anchored ? [`INV7 over-credited fees: feesPaid=${fp} > appliedTreasuryOutputs=${anchored}`] : [];
}

const STATE_INVARIANTS = [invNoNegativeBalance, invTokenConservation, invMintWithinCap, invLockIntegrity, invNameWellFormed, invNameLockSymmetry];

export function checkInvariants(events, tipHeight) {
  const st = resolve(events, tipHeight);
  const out = [];
  for (const inv of STATE_INVARIANTS) out.push(...inv(st));
  out.push(...invFeeAccounting(st, events));
  return { violations: out, st };
}

// ── broad random fuel: coherent flows that REACH rich states (open locks, fills, pending, lapsed) + noise ──
let SEED = 0; const rng = () => { SEED = (SEED * 1664525 + 1013904223) >>> 0; return SEED / 0x100000000; };
const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (a) => a[ri(0, a.length - 1)];
const chance = (p) => rng() < p;
let GID = 1; const nid = () => "0x" + (GID++).toString(16).padStart(64, "0");
const hexSalt = (n = 32) => Array.from({ length: n }, () => "0123456789abcdef"[ri(0, 15)]).join("");
const AC = ["0x" + "a1".repeat(20), "0x" + "b2".repeat(20), "0x" + "c3".repeat(20)];
const vo = (fn) => { try { return fn(); } catch { return null; } };
const P = (ev, who, rec, h, paid = {}) => { if (rec) ev.push({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: ri(0, 3), expiresEpoch: 9e15, paidTo: paid }); return ev[ev.length - 1]; };
const AT = (ev, who, pid, h, paid = {}, score = 100) => { ev.push({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence: 0, height: h, pos: ri(0, 3), paidTo: paid }); return ev[ev.length - 1]; };

function genScenario() {
  const ev = [];
  const [A, B, C] = [pick(AC), pick(AC), pick(AC)];
  const flow = pick(["token", "token", "name", "name", "sealed", "lapse", "noise"]);
  let tip;
  if (flow === "token") {
    const tk = "T" + ri(10, 999); let h = ri(30000, V26_HEIGHT + 2000);
    P(ev, A, vo(() => deploy({ ticker: tk, decimals: 0, supply: "1000000", mint: pick(["issuer", "open"]) })), h, { [T]: DEPLOY_FEE.toString() }); h += ri(1, 3);
    P(ev, A, vo(() => mint({ ticker: tk, amount: pick(["100", "1000", "50"]) })), h); h += ri(1, 3);
    if (chance(0.75)) {
      const val = pick(["100000000", "1", "250000000"]);
      const takerBound = chance(0.5);
      const off = P(ev, A, vo(() => offer({ give: { ticker: tk, amount: "10" }, want: { value: val }, ...(takerBound ? { taker: B } : {}) })), h, {}); h += ri(1, 4);
      const mode = pick(["open", "open", "fill", "cancel"]);   // 'open' leaves the lock live (exercises INV4/INV6)
      if (mode === "fill" && off) { const fee = tradeFee(BigInt(val), h >= 33600 ? FEE_BPS_V16 : 100).toString(); const reb = (!takerBound && h >= V17_HEIGHT) ? tradeFee(BigInt(val), 50) : 0n; AT(ev, takerBound ? B : C, off.id, h, { [A]: (BigInt(val) + reb).toString(), [T]: fee }); }
      else if (mode === "cancel") P(ev, A, vo(() => offerCancelAll({ ticker: tk })), h, {});
    }
    tip = h + ri(0, 40);
  } else if (flow === "name") {
    const nm = "n" + ri(100, 9999); let h = ri(30000, V25_HEIGHT - 400);
    P(ev, A, vo(() => nameClaim({ name: nm })), h, { [T]: nameRegFee(nm, h).toString() }); h += ri(1, 6);
    const act = pick(["set", "xfer", "renew", "list", "list", "none"]);
    if (act === "set") P(ev, A, vo(() => nameSet({ name: nm, addr: A })), h);
    else if (act === "xfer") P(ev, A, vo(() => nameXfer({ name: nm, to: B })), h);
    else if (act === "renew") P(ev, A, vo(() => nameRenew({ name: nm })), h, { [T]: nameRegFee(nm, h).toString() });
    else if (act === "list") P(ev, A, vo(() => offer({ give: { name: nm }, want: { value: "100000000" } })), h, {}); // OPEN → name locked (INV6)
    tip = h + ri(0, 40);
  } else if (flow === "sealed") {
    const nm = "s" + ri(100, 9999); const salt = hexSalt(32); let h = Math.max(V25_HEIGHT + 5, ri(V25_HEIGHT, V26_HEIGHT + 2000));
    P(ev, A, vo(() => nameCommitRecord({ commit: nameCommit(nm, salt, A) })), h); h += ri(1, 4);
    P(ev, A, vo(() => nameClaim({ name: nm, salt })), h); const commitH = h - ri(1, 4);        // payment-free reveal → pending
    if (chance(0.6)) { const fh = h + 8 + ri(1, 20); P(ev, A, vo(() => nameFinalize({ name: nm, salt })), fh, { [T]: nameRegFee(nm, fh).toString() }); h = fh; }
    tip = h + ri(0, 10);   // sometimes leaves the name PENDING at tip (exercises INV5 pending shape)
  } else if (flow === "lapse") {
    const nm = "l" + ri(100, 9999); const h = ri(30000, 33000);
    P(ev, A, vo(() => nameClaim({ name: nm })), h, { [T]: nameRegFee(nm, h).toString() });
    tip = h + ri(300000, 400000);   // far future → lease lapsed (INV5 expired shape)
  } else {
    const n = ri(1, 8); let h = ri(29900, V26_HEIGHT + 1000);
    for (let i = 0; i < n; i++) { const b = vo(() => buildNoise()); if (b) P(ev, pick(AC), b, h, chance(0.5) ? { [T]: pick(["1", "100000000", "300000000"]) } : {}); h += ri(0, 300); }
    tip = h + ri(0, 40);
  }
  return { events: ev, tipHeight: tip };
}
function buildNoise() {
  const t = pick(["deploy", "mint", "transfer", "offer", "bid", "name", "nxfer", "nset", "nrenew"]);
  switch (t) {
    case "deploy": return deploy({ ticker: "Z" + ri(1, 99), decimals: ri(0, 8), supply: pick(["1", "1000000", "999999999"]), mint: pick(["issuer", "open"]) });
    case "mint": return mint({ ticker: "Z" + ri(1, 99), amount: pick(["1", "100"]) });
    case "transfer": return transfer({ ticker: "Z" + ri(1, 99), to: pick(AC), amount: pick(["1", "100"]) });
    case "offer": return offer({ give: chance(0.5) ? { ticker: "Z" + ri(1, 99), amount: "5" } : { name: "n" + ri(1, 99) }, want: { value: "1" } });
    case "bid": return bid({ want: { name: "n" + ri(1, 99) }, give: { value: "1" } });
    case "name": return nameClaim(chance(0.5) ? { name: "n" + ri(1, 99) } : { name: "n" + ri(1, 99), salt: hexSalt(20) });
    case "nxfer": return nameXfer({ name: "n" + ri(1, 99), to: pick(AC) });
    case "nset": return nameSet({ name: "n" + ri(1, 99), addr: pick(AC) });
    case "nrenew": return nameRenew({ name: "n" + ri(1, 99) });
  }
}

// ── self-test: feed HAND-BROKEN states to each invariant and assert it fires (proves the checkers work) ──
function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, fired) => { console.log(`${fired ? "✓" : "✗"} ${name}`); fired ? pass++ : fail++; };
  const A = "0x" + "a1".repeat(20);
  ok("INV1 fires on negative balance", invNoNegativeBalance({ balances: { TK: { [A]: { available: "-5", locked: "0" } } } }).length > 0);
  ok("INV2 fires on held != minted", invTokenConservation({ tokens: { TK: { minted: "100", supply: "1000" } }, balances: { TK: { [A]: { available: "50", locked: "0" } } } }).length > 0);
  ok("INV3 fires on minted > supply", invMintWithinCap({ tokens: { TK: { minted: "2000", supply: "1000" } } }).length > 0);
  ok("INV4 fires on a leaked/orphan lock", invLockIntegrity({ offers: {}, balances: { TK: { [A]: { available: "0", locked: "10" } } } }).length > 0);
  ok("INV4 fires on an under-locked open offer", invLockIntegrity({ offers: { o: { status: "open", seller: A, give: { ticker: "TK", amount: "10" } } }, balances: {} }).length > 0);
  ok("INV5 fires on a bricked name (bad owner)", invNameWellFormed({ tipHeight: 50000, names: { bad: { owner: "not-hex", height: 1, effectiveHeight: 1, locked: false } } }).length > 0);
  ok("INV5 fires on effHeight > height", invNameWellFormed({ tipHeight: 50000, names: { n: { owner: A, height: 1, effectiveHeight: 2, locked: false } } }).length > 0);
  ok("INV5 fires on a stale pending reservation", invNameWellFormed({ tipHeight: 99999, names: { n: { owner: A, height: 1, effectiveHeight: 1, locked: false, pending: true, finalizeBy: 10 } } }).length > 0);
  ok("INV6 fires on a name locked with no offer", invNameLockSymmetry({ offers: {}, names: { n: { owner: A, locked: true } } }).length > 0);
  ok("INV6 fires on an open name-offer but unlocked name", invNameLockSymmetry({ offers: { o: { status: "open", give: { name: "n" } } }, names: { n: { owner: A, locked: false } } }).length > 0);
  ok("INV7 fires on over-credited fees", invFeeAccounting({ feesPaid: "999", events: [{ ok: true, id: "0x1" }] }, [{ kind: "propose", id: "0x1", paidTo: {} }]).length > 0);
  // and a KNOWN-SOUND state must produce zero violations from every checker (no false positives)
  const A2 = "0x" + "a1".repeat(20);
  const sound = { tipHeight: 40040, tokens: { TK: { minted: "1000", supply: "1000000" } }, balances: { TK: { [A2]: { available: "990", locked: "10" } } }, names: { alice: { owner: A2, height: 40003, effectiveHeight: 40003, locked: true } }, offers: { o: { status: "open", seller: A2, give: { ticker: "TK", amount: "10" } }, o2: { status: "open", give: { name: "alice" } } }, feesPaid: "0", events: [] };
  const soundViol = STATE_INVARIANTS.flatMap((f) => f(sound)).concat(invFeeAccounting(sound, []));
  ok("all invariants silent on a hand-built SOUND state", soundViol.length === 0);
  if (soundViol.length) console.log("   unexpected:", soundViol);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function runCorpus(N, seed) {
  SEED = seed >>> 0;
  const cov = { tokens: 0, openLock: 0, filled: 0, pendingName: 0, lapsedName: 0, nameLocked: 0 };
  const hits = new Map(); let scenariosWithViol = 0;
  const scen = [];
  for (let i = 0; i < N; i++) scen.push(genScenario());
  for (const s of scen) {
    const { violations, st } = checkInvariants(s.events, s.tipHeight);
    if (Object.keys(st.tokens || {}).length) cov.tokens++;
    for (const o of Object.values(st.offers || {})) { if (o.status === "open" && o.give?.ticker) cov.openLock++; if (o.status === "filled") cov.filled++; }
    for (const n of Object.values(st.names || {})) { if (n.pending) cov.pendingName++; if (n.expired) cov.lapsedName++; if (n.locked) cov.nameLocked++; }
    if (violations.length) { scenariosWithViol++; for (const vln of violations) { const key = vln.split(":")[0]; hits.set(key, (hits.get(key) || 0) + 1); if ((hits.get("__samples_" + key) || []).length === undefined) hits.set("__samples_" + key, []); const sm = hits.get("__samples_" + key); if (sm.length < 3) sm.push({ vln, seed: SEED }); } }
  }
  console.log(`LEDGER-SOUNDNESS INVARIANTS — ${N} random scenarios (seed ${seed >>> 0})  [report-only]\n`);
  console.log(`coverage reached: ${JSON.stringify(cov)}\n`);
  if (scenariosWithViol === 0) { console.log("✓ 0 invariant violations — the resolver stayed ledger-sound across every scenario the fuel reached."); process.exit(0); }
  for (const [k, n] of hits) { if (k.startsWith("__samples_")) continue; console.log(`✗ ${k}: ${n} violation(s)`); for (const sm of hits.get("__samples_" + k) || []) console.log(`    ${sm.vln}`); }
  console.log(`\n${scenariosWithViol}/${N} scenarios violated an invariant. Reproduce with the printed seed. (A real violation is a resolver soundness bug or a too-strict invariant — investigate before trusting.)`);
  process.exit(0);
}

function runStdin() {
  const chunks = []; process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(chunks.join("")); } catch { console.error('--stdin: expected JSON {"sequences":[{"events":[...],"tipHeight":N}]} on stdin'); process.exit(1); }
    const sequences = parsed.sequences || [];
    let bad = 0;
    for (let i = 0; i < sequences.length; i++) { const s = sequences[i]; const { violations } = checkInvariants(s.events, s.tipHeight); if (violations.length) { bad++; console.log(`✗ ${s.label || "seq#" + i}:`); for (const v of violations) console.log(`    ${v}`); } }
    console.log(`\n${sequences.length} sequences · ${bad} with an invariant violation`);
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) selftest();
  else if (argv.includes("--stdin")) runStdin();
  else { const N = Number(argv[0] || 5000); const seed = (Number(argv[1]) >>> 0) || ((0x50D1 ^ (N * 2654435761 >>> 0)) >>> 0); runCorpus(N, seed); }
}
