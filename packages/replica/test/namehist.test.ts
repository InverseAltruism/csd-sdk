// The SUFFICIENCY gate for the name verifier.
//
// nameHistory() returns the name-scoped txids a wallet must SPV-verify + replay. The verifier is only
// sound if replaying JUST those events reproduces the SAME name record as replaying the whole chain:
//     resolve(pick(full, nameHistory(full, name))).names[name]  ===  resolve(full, tip).names[name]
// for EVERY name, over arbitrary histories. This test proves it on directed lifecycles AND a seeded
// fuzz that interleaves every name-event category (commit-reveal, displacement, nset/nxfer/nrenew,
// sale-by-fill, cancel, bare ocancel, lapse/reclaim) with unrelated token noise across several names.
// A bug where nameHistory OMITS a relevant event surfaces here as a name-state divergence.
import assert from "node:assert/strict";
import { nameCommit } from "@inversealtruism/cairnx-core";
import { resolve } from "@inversealtruism/cairnx-core";
import { nameHistory } from "../src/namehist.js";
import {
  COMMIT_MAX_BLOCKS, CONF_TOKEN_FILL, EPOCH_LEN, NAME_GRACE_EPOCHS, NAME_TERM_EPOCHS, REG_COMMIT_MAX_BLOCKS, SCORE_CANCEL, SCORE_CLAIM, SCORE_FILL,
  TREASURY_ADDR, DEPLOY_FEE, V15_HEIGHT, V17_HEIGHT, V19_HEIGHT, V25_HEIGHT, epochOf, expiredClaimFee, makerRebate, nameRegFee, tradeFee,
  type CairnXRecord, type ChainEvent, type ProposeEvent,
} from "@inversealtruism/cairnx-core";
import { fixtures } from "../src/factories.js";
import { supersededHints } from "./namehist-oracle.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`); };

const EP = (h: number) => epochOf(h);
const feeTo = (addr: string, v: bigint): Record<string, string> => ({ [addr]: v.toString() });

// namehist deltas (explicit, scanner-shape parity with the live feed): proposer/attester lowercased,
// expiresEpoch = epoch + 4 (a live anchor's short expiry), attests carry confidence 100.
const { prop, att } = fixtures({ expiryEpochs: 4, lower: true, attConfidence: 100 });

// the subset of `full` that nameHistory says matters for `name` (selected by consensus txid)
function pick(full: ChainEvent[], name: string): ChainEvent[] {
  const ids = new Set(nameHistory(full, name).events.map((e) => e.txid));
  return full.filter((e) => ids.has((e.kind === "propose" ? e.id : e.txid).toLowerCase()));
}
// the property: scoped replay === full replay, for this name's record. Returns true on match.
function equiv(full: ChainEvent[], name: string, tip: number): boolean {
  const a = resolve(full, tip).names[name];
  const b = resolve(pick(full, name), tip).names[name];
  try { assert.deepEqual(b, a); return true; }
  catch { console.log(`    DIVERGE on "${name}":\n      full  =`, JSON.stringify(a), `\n      scoped=`, JSON.stringify(b)); return false; }
}

// the same property for what check mode serves (the pruned hints): when it says sufficient, replaying exactly its
// hints gives the full chain's record, and no served nset or nprofile is superseded in that replay (so the prune
// guard did not fall back to the whole selection over one)
let servedPruned = 0;   // check-mode calls that dropped at least one candidate
let servedSuperseded = 0;   // check-mode calls whose unpruned selection held a superseded nset or nprofile
let supersededLeft = 0;     // check-mode calls that served one
function equivServed(full: ChainEvent[], name: string, tip: number): boolean {
  const h = nameHistory(full, name, { tipHeight: tip });
  if (!h.scopedReplaySufficient) return false;
  const unpruned = nameHistory(full, name).events;
  if (h.events.length < unpruned.length) servedPruned++;
  if (supersededHints(full, tip, name, unpruned.map((e) => e.txid)).length) servedSuperseded++;
  const left = supersededHints(full, tip, name, h.events.map((e) => e.txid));
  if (left.length) { supersededLeft++; console.log(`    SERVED A SUPERSEDED RECORD on "${name}": ${left.join(", ")}`); return false; }
  const ids = new Set(h.events.map((e) => e.txid));
  const b = resolve(full.filter((e) => ids.has((e.kind === "propose" ? e.id : e.txid).toLowerCase())), tip).names[name];
  try { assert.deepEqual(b, resolve(full, tip).names[name]); return true; }
  catch { console.log(`    SERVED HINTS DIVERGE on "${name}"`); return false; }
}

const A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20), C = "0x" + "cc".repeat(20), D = "0x" + "dd".repeat(20);
const ADDRS = [A, B, C, D];
const VAL = 100_000_000n; // 1 CSD

// register `name` to `owner` at `h` via commit-reveal (back-dated). Returns the events.
function regCommitReveal(name: string, owner: string, hCommit: number, hReveal: number): ChainEvent[] {
  const salt = "ab".repeat(8);
  const commit = nameCommit(name, salt, owner);
  return [
    prop({ v: 1, t: "ncommit", commit } as CairnXRecord, { proposer: owner, height: hCommit }),
    prop({ v: 1, t: "name", name, salt } as CairnXRecord, { proposer: owner, height: hReveal, paidTo: feeTo(TREASURY_ADDR, nameRegFee(name, hReveal)) }),
  ];
}
// register `name` directly (no commit) at `h`
const regDirect = (name: string, owner: string, h: number): ChainEvent =>
  prop({ v: 1, t: "name", name } as CairnXRecord, { proposer: owner, height: h, paidTo: feeTo(TREASURY_ADDR, nameRegFee(name, h)) });

// seller lists `name` for VAL CSD (taker-bound to buyer) and buyer fills → name moves to buyer (viaFill)
function sellName(name: string, seller: string, buyer: string, hOffer: number, hFill: number): ChainEvent[] {
  const offer = prop({ v: 1, t: "offer", give: { name }, want: { value: VAL.toString() }, taker: buyer } as CairnXRecord, { proposer: seller, height: hOffer, expiresEpoch: EP(hFill) + 50 });
  const fee = tradeFee(VAL, 150); // v1.6 offers store feeBps=150
  const fill = att({ proposalId: offer.id, attester: buyer, score: SCORE_FILL, height: hFill, paidTo: { [seller.toLowerCase()]: VAL.toString(), [TREASURY_ADDR]: fee.toString() } });
  return [offer, fill];
}

// ── directed scenarios ──────────────────────────────────────────────────────
console.log("directed name lifecycles (scoped replay must equal full replay):");
{
  // 1. commit-reveal register → nset → equiv
  const tip = V15_HEIGHT + 1000;
  const ev = [
    ...regCommitReveal("alice", A, V15_HEIGHT + 10, V15_HEIGHT + 40),
    prop({ v: 1, t: "nset", name: "alice", addr: B } as CairnXRecord, { proposer: A, height: V15_HEIGHT + 60 }),
  ];
  const h = nameHistory(ev, "alice");
  ok("history picks the ncommit, the reveal, and the nset (3 events)", h.events.length === 3 && h.events.map((e) => e.kind).sort().join(",") === "name,ncommit,nset");
  ok("alice: scoped == full after register+nset", equiv(ev, "alice", tip));
}
{
  // 2. register → transfer (nxfer) → new owner sets addr → equiv; the OLD owner can't change it
  const tip = V15_HEIGHT + 1000;
  const ev = [
    regDirect("bob", A, V15_HEIGHT + 10),
    prop({ v: 1, t: "nxfer", name: "bob", to: C } as CairnXRecord, { proposer: A, height: V15_HEIGHT + 30 }),
    prop({ v: 1, t: "nset", name: "bob", addr: C } as CairnXRecord, { proposer: C, height: V15_HEIGHT + 50 }),
    prop({ v: 1, t: "nset", name: "bob", addr: D } as CairnXRecord, { proposer: A, height: V15_HEIGHT + 55 }), // rejected: A no longer owns
  ];
  const r = resolve(ev, tip).names["bob"]!;
  ok("bob owned by C with addr=C after transfer (old owner's nset rejected)", r.owner === C.toLowerCase() && r.addr === C.toLowerCase());
  ok("bob: scoped == full after transfer+nset", equiv(ev, "bob", tip));
}
{
  // 3. sale by fill: A registers, sells to B → viaFill ownership; verify equiv (offer+fill must be in scope)
  const reg = V15_HEIGHT + 10, off = reg + COMMIT_MAX_BLOCKS + 20, fil = off + 5, tip = fil + 500;
  const ev = [regDirect("carol", A, reg), ...sellName("carol", A, B, off, fil)];
  const r = resolve(ev, tip).names["carol"]!;
  ok("carol sold to B (viaFill ownership)", r.owner === B.toLowerCase() && r.viaFill === true);
  ok("carol: scoped == full across a name SALE (offer+fill in scope)", equiv(ev, "carol", tip));
}
{
  // 4. displacement: a back-dated reveal from an EARLIER commit takes the name from a direct claimer
  const tip = V15_HEIGHT + 1000;
  const ev = [
    ...regCommitReveal("dave", B, V15_HEIGHT + 5, V15_HEIGHT + 100),  // commit early, reveal later (back-dates to +5)
    regDirect("dave", A, V15_HEIGHT + 20),                            // A claims at +20, looks first...
  ];
  const r = resolve(ev, tip).names["dave"]!;
  ok("dave displaced to B via earlier back-dated commit", r.owner === B.toLowerCase());
  ok("dave: scoped == full under displacement (both claims + commit in scope)", equiv(ev, "dave", tip));
}
{
  // 5. bare ocancel releases a name-offer lock → owner can then transfer; ocancel must be in scope
  const reg = V15_HEIGHT + 10, off = reg + COMMIT_MAX_BLOCKS + 20, canc = off + 5, xfer = canc + 5, tip = xfer + 500;
  const offer = prop({ v: 1, t: "offer", give: { name: "erin" }, want: { value: VAL.toString() }, taker: B } as CairnXRecord, { proposer: A, height: off, expiresEpoch: EP(tip) + 50 });
  const ev = [
    regDirect("erin", A, reg),
    offer,
    prop({ v: 1, t: "ocancel" } as CairnXRecord, { proposer: A, height: canc }),            // bare cancel-all → releases the lock
    prop({ v: 1, t: "nxfer", name: "erin", to: C } as CairnXRecord, { proposer: A, height: xfer }), // only works if unlocked
  ];
  const r = resolve(ev, tip).names["erin"]!;
  ok("erin: bare ocancel unlocked the name, transfer to C succeeded", r.owner === C.toLowerCase() && r.locked === false);
  ok("erin: scoped == full with a bare ocancel in the path", equiv(ev, "erin", tip));
  const h = nameHistory(ev, "erin");
  ok("history includes the bare ocancel", h.events.some((e) => e.kind === "ocancel"));
}
{
  // 6. never-registered name → both undefined (trivially equal, no crash)
  const ev = [regDirect("alice", A, V15_HEIGHT + 10)];
  ok("unregistered name: scoped == full (both undefined)", equiv(ev, "ghost", V15_HEIGHT + 100));
  ok("unregistered name: empty history", nameHistory(ev, "ghost").events.length === 0);
}
{
  // 7. lapse + premium reclaim: jump past the term+grace, a new party reclaims at the decaying premium
  const reg = V15_HEIGHT + 10;
  const epochsPastLapse = 5;
  const lapseEpoch = EP(reg) + NAME_TERM_EPOCHS + NAME_GRACE_EPOCHS + epochsPastLapse;
  const hReclaim = lapseEpoch * EPOCH_LEN + 10;          // epochOf(hReclaim) === lapseEpoch
  const tip = hReclaim + 500;
  const salt = "b0b0b0b0b0b0b0b0";
  const hFin = hReclaim + REG_COMMIT_MAX_BLOCKS + 2;                                    // after the displacement freeze
  const graceEndEp = EP(reg) + NAME_TERM_EPOCHS + NAME_GRACE_EPOCHS;
  const premiumAtFin = expiredClaimFee("frank", EP(hFin) - graceEndEp, hFin);           // premium priced at the FINALIZE height
  // V26 (recapture) is ACTIVE: a lapsed name is reclaimed via the sealed reserve->finalize flow. `nfinalize` MUST
  // be in the name-scoped hint set (the namehist fix) or the scoped replay stalls at `pending` and diverges from full.
  const ev = [
    regDirect("frank", A, reg),                                                         // A registers below V25 (pay-now owned)
    prop({ v: 1, t: "ncommit", commit: nameCommit("frank", salt, B) } as CairnXRecord, { proposer: B, height: hReclaim }),          // B's blind recapture commit
    prop({ v: 1, t: "name", name: "frank", salt } as CairnXRecord, { proposer: B, height: hReclaim + 1 }),                          // PAYMENT-FREE recapture reserve
    prop({ v: 1, t: "nfinalize", name: "frank", salt } as CairnXRecord, { proposer: B, height: hFin, paidTo: feeTo(TREASURY_ADDR, premiumAtFin) }), // finalize the premium
  ];
  const r = resolve(ev, tip).names["frank"]!;
  ok("frank: sealed recapture (reserve->finalize) by B after lapse", r.owner === B.toLowerCase() && !r.pending && !r.viaFill);
  ok("frank: scoped == full across a lapse + sealed recapture (nfinalize now in scope)", equiv(ev, "frank", tip));
}
{
  // 8. v1.9 nprofile (doc 36): the profile is part of names[name], so namehist MUST reproduce it
  // (the sufficiency invariant). Below V19 the record is a dormant no-op, so these run at v1.9 heights.
  const base = V19_HEIGHT + 10, tip = base + 1000;
  const P = { display: "Alice", "com.twitter": "alice", avatar: "https://a.co/x.png", "2": "x", "10": "y" };
  {
    const ev = [
      regDirect("nina", A, base),
      prop({ v: 1, t: "nprofile", name: "nina", p: P } as CairnXRecord, { proposer: A, height: base + 20 }),
    ];
    const r2 = resolve(ev, tip).names["nina"]!;
    let profOk = false; try { assert.deepEqual(r2.profile, P); profOk = true; } catch { /* order-independent content check */ }
    ok("nina: profile set at a v1.9 height", profOk);
    ok("nina: nameHistory includes the nprofile event", nameHistory(ev, "nina").events.some((e) => e.kind === "nprofile"));
    ok("nina: scoped == full WITH a profile (sufficiency invariant holds)", equiv(ev, "nina", tip));
  }
  {
    const ev = [
      regDirect("opal", A, base),
      prop({ v: 1, t: "nprofile", name: "opal", p: P } as CairnXRecord, { proposer: A, height: base + 20 }),
      prop({ v: 1, t: "nxfer", name: "opal", to: B } as CairnXRecord, { proposer: A, height: base + 40 }),
    ];
    const r2 = resolve(ev, tip).names["opal"]!;
    ok("opal: transfer clears the profile + moves owner", r2.owner === B.toLowerCase() && r2.profile === undefined);
    ok("opal: scoped == full across set-then-transfer", equiv(ev, "opal", tip));
  }
  {
    const ev = [
      regDirect("pearl", A, base),
      prop({ v: 1, t: "nprofile", name: "pearl", p: P } as CairnXRecord, { proposer: B, height: base + 20 }), // B is not the owner
    ];
    ok("pearl: non-owner nprofile rejected (no profile)", resolve(ev, tip).names["pearl"]!.profile === undefined);
    ok("pearl: scoped == full with a rejected non-owner nprofile", equiv(ev, "pearl", tip));
  }
}
{
  // 9. attest kind labeling (src/namehist.ts pass 3): an attest with an UNKNOWN score on a name offer
  // is labeled "attest" (diagnostic honesty), NEVER defaulted to "fill", kind is diagnostic only; the
  // wallet re-derives meaning from the verified record.
  const reg = V15_HEIGHT + 10, off = reg + COMMIT_MAX_BLOCKS + 20, attH = off + 5, tip = attH + 500;
  const offer = prop({ v: 1, t: "offer", give: { name: "gwen" }, want: { value: VAL.toString() }, taker: B } as CairnXRecord, { proposer: A, height: off, expiresEpoch: EP(tip) + 50 });
  const weird = att({ proposalId: offer.id, attester: B, score: 7, height: attH });   // 7 is no SCORE_* constant
  const ev = [regDirect("gwen", A, reg), offer, weird];
  const entry = nameHistory(ev, "gwen").events.find((e) => e.txid === weird.txid);
  ok("gwen: unknown-score attest on a name offer is kind 'attest' (never 'fill')", entry !== undefined && entry.kind === "attest");
}

// ── seeded fuzz ─────────────────────────────────────────────────────────────
// mulberry32, reproducible (no Math.random, so a failure is replayable from the seed)
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

console.log("\nseeded fuzz (every name-event category × token noise × multiple names):");
const NAMES = ["alpha", "bravo", "charlie"];
let fuzzPass = 0, fuzzDiverge = 0;
const TRIALS = 1500;
for (let trial = 0; trial < TRIALS; trial++) {
  const rnd = rng(0x51A5 + trial * 2654435761);
  const pickA = () => ADDRS[Math.floor(rnd() * ADDRS.length)]!;
  const ev: ChainEvent[] = [];
  let h = V15_HEIGHT + 5;
  // a token to make noise valid (deploy once)
  ev.push(prop({ v: 1, t: "deploy", ticker: "NOISE", decimals: 0, supply: "1000000", mint: "open", mintLimit: "1000000" } as CairnXRecord, { proposer: A, height: h, paidTo: feeTo(TREASURY_ADDR, 100_000_000n) }));
  ev.push(prop({ v: 1, t: "mint", ticker: "NOISE", amount: "1000000" } as CairnXRecord, { proposer: A, height: h }));
  const nOps = 6 + Math.floor(rnd() * 18);
  const liveOffer: Record<string, string | null> = {}; // name → open name-offer id (for cancels)
  for (let i = 0; i < nOps; i++) {
    h += 1 + Math.floor(rnd() * 80);
    const name = NAMES[Math.floor(rnd() * NAMES.length)]!;
    const who = pickA(), to = pickA();
    const r = rnd();
    if (r < 0.20) { ev.push(...regCommitReveal(name, who, h, h + 1 + Math.floor(rnd() * (COMMIT_MAX_BLOCKS - 1)))); h += COMMIT_MAX_BLOCKS; }
    else if (r < 0.34) ev.push(regDirect(name, who, h));
    else if (r < 0.48) ev.push(prop({ v: 1, t: "nset", name, addr: to } as CairnXRecord, { proposer: who, height: h }));
    else if (r < 0.60) ev.push(prop({ v: 1, t: "nxfer", name, to } as CairnXRecord, { proposer: who, height: h }));
    else if (r < 0.70) ev.push(prop({ v: 1, t: "nrenew", name } as CairnXRecord, { proposer: who, height: h, paidTo: feeTo(TREASURY_ADDR, nameRegFee(name, h)) }));
    else if (r < 0.82) { const s = sellName(name, who, to, h, h + 1 + Math.floor(rnd() * 5)); ev.push(...s); liveOffer[name] = (s[0] as ProposeEvent).id; h += 6; }
    else if (r < 0.88) { const oid = liveOffer[name]; if (oid) { ev.push(att({ proposalId: oid, attester: who, score: SCORE_CANCEL, height: h })); liveOffer[name] = null; } }
    else if (r < 0.94) ev.push(prop({ v: 1, t: "ocancel" } as CairnXRecord, { proposer: who, height: h })); // bare cancel-all
    else { // token noise (must NOT affect any name's scoped state)
      const amt = String(1 + Math.floor(rnd() * 100));
      ev.push(prop({ v: 1, t: "transfer", ticker: "NOISE", to, amount: amt } as CairnXRecord, { proposer: who, height: h }));
    }
    // occasional same-height second event to stress pos ordering
    if (rnd() < 0.15) ev.push(prop({ v: 1, t: "nset", name: NAMES[Math.floor(rnd() * NAMES.length)]!, addr: pickA() } as CairnXRecord, { proposer: pickA(), height: h, pos: 2 }));
  }
  const tip = h + 500;
  let allEq = true;
  for (const nm of [...NAMES, "neverseen"]) {
    if (!equiv(ev, nm, tip)) allEq = false;
    // Zero-false-flag guarantee: on every SOUND lifecycle the exact-compare check must agree with
    // the invariant and keep scopedReplaySufficient=true (a false flag here would break green on real names).
    if (!equivServed(ev, nm, tip)) allEq = false;
  }
  allEq ? fuzzPass++ : fuzzDiverge++;
  if (!allEq && fuzzDiverge <= 3) console.log(`    ↑ trial ${trial} diverged (${ev.length} events)`);
}
ok(`fuzz: ${fuzzPass}/${TRIALS} histories: scoped == full, and check mode serves sufficient hints that replay to the full record for every name (0 diverged; ${servedPruned} served histories pruned)`, fuzzDiverge === 0 && servedPruned > 0);

// ── v1.9 seeded fuzz: interleave nprofile with every name op at V19+ heights ──
console.log("\nv1.9 seeded fuzz (nprofile interleaved, the profile must ride the scoped replay):");
const PKEYS = ["avatar", "display", "com.twitter", "url", "2", "10", "a.b"];
let pPass = 0, pDiverge = 0, sawProfile = 0;
const PTRIALS = 600;
for (let trial = 0; trial < PTRIALS; trial++) {
  const rnd = rng(0xB19 + trial * 2654435761);
  const pickA = () => ADDRS[Math.floor(rnd() * ADDRS.length)]!;
  const ev: ChainEvent[] = [];
  let h = V19_HEIGHT + 5;
  const nOps = 6 + Math.floor(rnd() * 16);
  const liveOffer: Record<string, string | null> = {};
  for (let i = 0; i < nOps; i++) {
    h += 1 + Math.floor(rnd() * 60);
    const name = NAMES[Math.floor(rnd() * NAMES.length)]!;
    const who = pickA(), to = pickA();
    const r = rnd();
    if (r < 0.20) ev.push(regDirect(name, who, h));
    else if (r < 0.34) ev.push(prop({ v: 1, t: "nset", name, addr: to } as CairnXRecord, { proposer: who, height: h }));
    else if (r < 0.50) { // nprofile (the new op): a small random charset-valid profile, or empty (= clear)
      const k = 1 + Math.floor(rnd() * 3);
      const p: Record<string, string> = {};
      if (rnd() > 0.15) for (let j = 0; j < k; j++) p[PKEYS[Math.floor(rnd() * PKEYS.length)]!] = "v" + Math.floor(rnd() * 9);
      ev.push(prop({ v: 1, t: "nprofile", name, p } as CairnXRecord, { proposer: who, height: h }));
    }
    else if (r < 0.64) ev.push(prop({ v: 1, t: "nxfer", name, to } as CairnXRecord, { proposer: who, height: h }));
    else if (r < 0.74) ev.push(prop({ v: 1, t: "nrenew", name } as CairnXRecord, { proposer: who, height: h, paidTo: feeTo(TREASURY_ADDR, nameRegFee(name, h)) }));
    else if (r < 0.88) { const s = sellName(name, who, to, h, h + 1 + Math.floor(rnd() * 5)); ev.push(...s); liveOffer[name] = (s[0] as ProposeEvent).id; h += 6; }
    else { const oid = liveOffer[name]; if (oid) { ev.push(att({ proposalId: oid, attester: who, score: SCORE_CANCEL, height: h })); liveOffer[name] = null; } }
  }
  const tip = h + 500;
  let allEq = true;
  for (const nm of NAMES) { if (resolve(ev, tip).names[nm]?.profile) sawProfile++; if (!equiv(ev, nm, tip) || !equivServed(ev, nm, tip)) allEq = false; }
  allEq ? pPass++ : pDiverge++;
  if (!allEq && pDiverge <= 3) console.log(`    ↑ v1.9 trial ${trial} diverged (${ev.length} events)`);
}
ok(`v1.9 fuzz: ${pPass}/${PTRIALS}: scoped == full and the served hints replay to it with nprofile interleaved (${sawProfile} live profiles seen, 0 diverged)`, pDiverge === 0 && sawProfile > 0);
ok(`both fuzzes: ${servedSuperseded} served histories had a superseded nset or nprofile in the unpruned selection, and ${supersededLeft} served one`, servedSuperseded > 0 && supersededLeft === 0);

// ── The open-lane claim-fill exception the taker-bound fuzz can't reach ──
console.log("\nOpen-lane claim-to-fill (the documented sufficiency EXCEPTION, scoped replay is insufficient):");
{
  const H = V17_HEIGHT + 100;
  const tip = H + 12;
  // A owns alice (registered well before the commit window so it is sellable)
  const reg = regDirect("alice", A, H - 300);
  // A lists alice as an OPEN, non-taker CSD offer (the V17 open lane)
  const aliceOffer = prop({ v: 1, t: "offer", give: { name: "alice" }, want: { value: VAL.toString() } } as CairnXRecord, { proposer: A, height: H + 5, expiresEpoch: epochOf(H + 60) + 200 });
  // B consumes its 3-live-claim cap on 3 UNRELATED open offers (deploy+mint inventory → 3 offers → 3 claims)
  const dep = prop({ v: 1, t: "deploy", ticker: "DEKOY", decimals: 0, supply: "1000", mint: "issuer" } as CairnXRecord, { proposer: B, height: H, paidTo: { [TREASURY_ADDR]: DEPLOY_FEE.toString() } });
  const mintRec = prop({ v: 1, t: "mint", ticker: "DEKOY", amount: "1000" } as CairnXRecord, { proposer: B, height: H + 1 });
  const decoyOffers = [0, 1, 2].map((i) => prop({ v: 1, t: "offer", give: { ticker: "DEKOY", amount: "1" }, want: { value: "1" } } as CairnXRecord, { proposer: B, height: H + 2 + i }));
  const decoyClaims = decoyOffers.map((o, i) => att({ proposalId: o.id, attester: B, score: SCORE_CLAIM, confidence: 0, height: H + 6 + i }));
  // B claims alice (its 4th live claim → capped → no-op) then fills (no live claim by B → no-op), both no-op on the FULL chain
  const bClaim = att({ proposalId: aliceOffer.id, attester: B, score: SCORE_CLAIM, confidence: 0, height: H + 10 });
  const bFill = att({ proposalId: aliceOffer.id, attester: B, score: SCORE_FILL, height: H + 11, paidTo: { [A]: (VAL + makerRebate(VAL)).toString(), [TREASURY_ADDR]: tradeFee(VAL, 150).toString() } });
  const full = [reg, dep, mintRec, ...decoyOffers, ...decoyClaims, aliceOffer, bClaim, bFill] as ChainEvent[];

  ok("open lane: FULL chain keeps alice with the seller (B's 4th claim capped, fill no-op)", resolve(full, tip).names["alice"]?.owner === A);
  ok("open lane: NAME-SCOPED replay misroutes alice to the attacker (the 3 decoy claims are out of name scope)", resolve(pick(full, "alice"), tip).names["alice"]?.owner === B);
  ok("open lane: the sufficiency invariant genuinely BREAKS here (scoped != full), the DIVERGE log above is EXPECTED", !equiv(full, "alice", tip));
  ok("open lane: nameHistory flags scopedReplaySufficient=FALSE → the wallet MUST fail closed (the cure)", nameHistory(full, "alice").scopedReplaySufficient === false);
  ok("open lane: check mode (the service's) flags it too: the fill the scoped replay applied decided the name", nameHistory(full, "alice", { tipHeight: tip }).scopedReplaySufficient === false);
  // no FALSE POSITIVE: a benign taker-bound name sale stays sufficient
  const benign = [regDirect("bob", A, V15_HEIGHT + 10), ...sellName("bob", A, B, V15_HEIGHT + 400, V15_HEIGHT + 410)] as ChainEvent[];
  ok("open lane: a benign taker-bound name sale stays scopedReplaySufficient=true (no false positive) + scoped==full", nameHistory(benign, "bob").scopedReplaySufficient === true && equiv(benign, "bob", V15_HEIGHT + 1000));
}

// ── A name-for-TOKEN fill is ALSO scoped-insufficient (out-of-scope buyer
// balance), even when TAKER-BOUND, so the flag must not be gated on the open lane / V17 alone ──
console.log("\nName-for-token fill (scoped-insufficient via out-of-scope buyer token balance):");
{
  const H = V15_HEIGHT + 500;
  const tip = H + 20;
  // A owns 'tokname' (registered well before the commit window)
  const reg = regDirect("tokname", A, H - 300);
  // B holds 100 TOKB (deploy+mint, events that are NOT in tokname's scope)
  const dep = prop({ v: 1, t: "deploy", ticker: "TOKB", decimals: 0, supply: "1000", mint: "issuer" } as CairnXRecord, { proposer: B, height: H, paidTo: { [TREASURY_ADDR]: DEPLOY_FEE.toString() } });
  const mintRec = prop({ v: 1, t: "mint", ticker: "TOKB", amount: "100" } as CairnXRecord, { proposer: B, height: H + 1 });
  // A lists tokname for 10 TOKB, TAKER-BOUND to B (the strong case: even a taker-bound token sale is unsound)
  const offer = prop({ v: 1, t: "offer", give: { name: "tokname" }, want: { ticker: "TOKB", amount: "10" }, taker: B } as CairnXRecord, { proposer: A, height: H + 5, expiresEpoch: epochOf(H + 60) + 200 });
  const fill = att({ proposalId: offer.id, attester: B, score: SCORE_FILL, confidence: CONF_TOKEN_FILL, height: H + 6 }); // token fill needs the debit marker
  const full = [reg, dep, mintRec, offer, fill] as ChainEvent[];

  ok("token want: FULL chain moves tokname to the buyer (B has the 10 TOKB)", resolve(full, tip).names["tokname"]?.owner === B);
  ok("token want: NAME-SCOPED replay does NOT (B's TOKB balance is out of name scope → fill rejected → stale owner A)", resolve(pick(full, "tokname"), tip).names["tokname"]?.owner === A);
  ok("token want: sufficiency BREAKS (scoped != full), DIVERGE log expected", !equiv(full, "tokname", tip));
  ok("token want: nameHistory flags scopedReplaySufficient=FALSE even though the offer is TAKER-BOUND", nameHistory(full, "tokname").scopedReplaySufficient === false);
  ok("token want: check mode (the service's) flags it too: the full chain applied the fill", nameHistory(full, "tokname", { tipHeight: tip }).scopedReplaySufficient === false);
}

// ── The MAX_PENDING_REG reservation-cap scoping gap, closed by the
// EXACT sufficiency compare (the `check` param). A proposer holding 3 pending reservations reveals a
// 4th name: the FULL chain cap-rejects the reveal (the name stays unregistered), but a name-scoped
// replay cannot see the other reservations and ACCEPTS it, then accepts the follow-on nfinalize+nset,
// resolving to an owner the real chain never registered (the forged-green verified:true shape). ──
console.log("\nReservation-cap (V25 sealed), scoped replay forges a registration the chain rejected:");
{
  const H = V25_HEIGHT + 100;
  const salts = ["11".repeat(8), "22".repeat(8), "33".repeat(8), "44".repeat(8)];
  // A's 3 blocker reservations (commit → payment-free reveal, never finalized → live pending)
  const blockers: ChainEvent[] = [];
  ["blocka", "blockb", "blockc"].forEach((nm, k) => {
    blockers.push(
      prop({ v: 1, t: "ncommit", commit: nameCommit(nm, salts[k]!, A) } as CairnXRecord, { proposer: A, height: H + k }),
      prop({ v: 1, t: "name", name: nm, salt: salts[k] } as CairnXRecord, { proposer: A, height: H + k + 1 }),
    );
  });
  // A's 4th name: full chain rejects the reveal at the cap; A follows through anyway (fee-bearing
  // nfinalize, a real burn, plus an nset pointing the name at A's address)
  const hc = H + 5, hFin = hc + REG_COMMIT_MAX_BLOCKS + 2;
  const target: ChainEvent[] = [
    prop({ v: 1, t: "ncommit", commit: nameCommit("coinbase", salts[3]!, A) } as CairnXRecord, { proposer: A, height: hc }),
    prop({ v: 1, t: "name", name: "coinbase", salt: salts[3] } as CairnXRecord, { proposer: A, height: hc + 1 }),
    prop({ v: 1, t: "nfinalize", name: "coinbase", salt: salts[3] } as CairnXRecord, { proposer: A, height: hFin, paidTo: feeTo(TREASURY_ADDR, nameRegFee("coinbase", hFin)) }),
    prop({ v: 1, t: "nset", name: "coinbase", addr: A } as CairnXRecord, { proposer: A, height: hFin + 2 }),
  ];
  const full = [...blockers, ...target];
  const tip = hFin + 5;

  ok("reservation cap: FULL chain keeps coinbase UNREGISTERED (4th reveal cap-rejected)", resolve(full, tip).names["coinbase"] === undefined);
  ok("reservation cap: NAME-SCOPED replay registers coinbase to the attacker (cap is out of name scope)", resolve(pick(full, "coinbase"), tip).names["coinbase"]?.owner === A);
  ok("reservation cap: the sufficiency invariant genuinely BREAKS (scoped != full), the DIVERGE log above is EXPECTED", !equiv(full, "coinbase", tip));
  ok("reservation cap: WITHOUT the check param the class flags miss this (documents why the exact compare exists)", nameHistory(full, "coinbase").scopedReplaySufficient === true);
  const checked = nameHistory(full, "coinbase", { tipHeight: tip });
  ok("reservation cap: WITH the check (library mode) the exact compare flags scopedReplaySufficient=FALSE, the cure", checked.scopedReplaySufficient === false);
  ok("reservation cap: the caveat names the out-of-scope-state class", /out-of-name-scope state/.test(checked.caveat ?? ""));
  ok("reservation cap: service mode (explicit fullRecord: undefined = unregistered on the full chain) also flags FALSE",
    nameHistory(full, "coinbase", { tipHeight: tip, fullRecord: undefined }).scopedReplaySufficient === false);
  // control: with only 2 blockers the 4th-name reveal is A's 3rd pending, accepted on the full chain,
  // scoped == full, and the check keeps the flag TRUE (no false positive at the cap boundary)
  const full2 = [...blockers.slice(0, 4), ...target];   // 2 blockers (2 events each)
  ok("reservation cap, control: at 2 blockers the registration is REAL (full chain owner = A)", resolve(full2, tip).names["coinbase"]?.owner === A);
  ok("reservation cap, control: scoped == full and the checked flag stays TRUE (no false positive)",
    equiv(full2, "coinbase", tip) && nameHistory(full2, "coinbase", { tipHeight: tip }).scopedReplaySufficient === true);
  // service mode on the real record: passing the caller's memoized full-chain record flags nothing
  ok("reservation cap, control: service mode (fullRecord = the real record) stays TRUE",
    nameHistory(full2, "coinbase", { tipHeight: tip, fullRecord: resolve(full2, tip).names["coinbase"] }).scopedReplaySufficient === true);
}

console.log(`\nnamehist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
