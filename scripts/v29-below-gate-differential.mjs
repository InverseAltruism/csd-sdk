#!/usr/bin/env node
// v29-below-gate-differential.mjs - the B9 safety proof (the analog of scripts/seal-differential.mjs).
//
// PROVES: with EVERY event height below V29 (88,000), the 0.1.40-to-be tree (this HEAD, with the gated M4+M5
// change) produces canonicalState(resolve(events, tip)) BYTE-IDENTICAL to the 0.1.39-to-be baseline (commit
// 6d71e31, the B6-seal HEAD before B9). This is the empirical proof that the V29 change is INERT below the gate:
// a mixed-version fleet cannot fork while the tip is under 88,000.
//
// The corpus deliberately includes the exact M4 (duplicated event) and M5 (3 filled fclaim holds + a 4th claim)
// shapes placed BELOW the gate, so that a GATE LEAK - a gated branch mutated to fire under 88,000 - diverges and
// this script reds. That is the mutation RED-FIRST for the differential.
//
// Usage: node scripts/v29-below-gate-differential.mjs [baselineRef]   (default: 6d71e31, 0.1.39-to-be)
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_REF = process.argv[2] ?? "6d71e31";   // B6-seal HEAD (0.1.39-to-be), pre-B9
const die = (msg) => { console.error(`V29-BELOW-GATE FAIL: ${msg}`); process.exit(1); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
const step = (s) => console.log(`\n== V29-BELOW-GATE: ${s} ==`);

// ── build the baseline dist in a throwaway worktree ──────────────────────────────────────────────────
step(`baseline build (git worktree @ ${BASELINE_REF})`);
const wt = mkdtempSync(join(tmpdir(), "csd-sdk-v29-"));
process.on("exit", () => { try { sh("git", ["worktree", "remove", "--force", wt]); } catch { /* best effort */ } try { rmSync(wt, { recursive: true, force: true }); } catch { /* ditto */ } });
{
  let r = sh("git", ["worktree", "add", "--detach", wt, BASELINE_REF], { stdio: "inherit" });
  if (r.status !== 0) die("git worktree add failed");
  r = sh("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: wt, stdio: "inherit" });
  if (r.status !== 0) die("pnpm install in the baseline worktree failed");
  for (const f of ["@inversealtruism/csd-codec", "@inversealtruism/cairnx-core"]) {
    r = sh("pnpm", ["--filter", f, "build"], { cwd: wt, stdio: "inherit" });
    if (r.status !== 0) die(`baseline build of ${f} failed`);
  }
}
const OLD = await import(pathToFileURL(join(wt, "packages", "cairnx", "dist", "index.js")).href);
const NEW = await import(pathToFileURL(join(ROOT, "packages", "cairnx", "dist", "index.js")).href);
if (NEW.V29_HEIGHT !== 88_000) die(`NEW.V29_HEIGHT=${NEW.V29_HEIGHT}, expected 88000 (operator decision)`);
if (OLD.V29_HEIGHT !== undefined) die(`baseline ${BASELINE_REF} already knows V29_HEIGHT - wrong baseline`);
const V29 = NEW.V29_HEIGHT;

let diverged = 0;
const diffCase = (name, events, tip) => {
  if (events.some((e) => e.height >= V29) || tip >= V29) die(`corpus bug: ${name} has an event/tip >= V29 (this differential must stay strictly below the gate)`);
  const a = OLD.canonicalState(OLD.resolve(events, tip));
  const b = NEW.canonicalState(NEW.resolve(events, tip));
  if (a !== b) {
    diverged++;
    let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
    console.error(`  DIVERGED ${name} @char ${k}`);
    console.error(`    old: ${a.slice(Math.max(0, k - 40), k + 80)}`);
    console.error(`    new: ${b.slice(Math.max(0, k - 40), k + 80)}`);
  }
};

// shared builders (record bytes are identical old<->new; construct with NEW and feed both)
const T = NEW.TREASURY_ADDR, A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
let n = 1; const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
const epochOf = (h) => Math.floor(h / NEW.EPOCH_LEN);
const PE = (b, h, who, ee, pos, paidTo, id = nid()) => ({ kind: "propose", id, proposer: who, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height: h, pos, paidTo });
const AE = (pid, who, h, paidTo, score = NEW.SCORE_FILL, conf = 0, pos = 0) => ({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence: conf, height: h, pos, paidTo });
const roots = () => ([
  PE(NEW.deploy({ ticker: "AAA", decimals: 0, supply: "100000", mint: "issuer" }), 40000, A, 9e9, 0, { [T]: String(NEW.DEPLOY_FEE) }),
  PE(NEW.mint({ ticker: "AAA", amount: "100000" }), 40001, A, 9e9, 0, {}),
]);
const mkOffer = (id, h, opt = {}) => PE(NEW.offer({ give: { ticker: "AAA", amount: "10" }, want: { value: opt.value ?? "500000000", payto: A }, ...(opt.min ? { min: opt.min } : {}), ...(opt.taker ? { taker: opt.taker } : {}) }), h, A, 9e9, 0, {}, id);
const payFor = (events, oid, pay, tip) => Object.fromEntries(NEW.requiredFillOutputs(NEW.resolve(events, tip).offers[oid], pay).map((x) => [x.to, String(x.value)]));

// ── 1. explicit leak-catchers (the M4/M5 shapes placed BELOW the gate; a gate leak reds here) ──────────
step("leak-catchers: the exact M4/M5 shapes, entirely below V29");
{
  // M5: 3 FILLED fclaim holds + a 4th claim, all near 80,000. Both dists must DENY the 4th (bug preserved
  // below the gate). If the M5 status predicate leaks below V29, NEW grants -> divergence.
  const gh = 79_980, E = epochOf(gh) + 2;
  const o1 = nid(), o2 = nid(), o3 = nid(), o4 = nid();
  const ev = [...roots(), mkOffer(o1, gh), mkOffer(o2, gh), mkOffer(o3, gh), mkOffer(o4, gh)];
  const g1 = PE(NEW.fclaim({ offer: o1 }), gh, B, E, 0, {}); ev.push(g1);
  const g2 = PE(NEW.fclaim({ offer: o2 }), gh, B, E, 1, {}); ev.push(g2);
  const g3 = PE(NEW.fclaim({ offer: o3 }), gh, B, E, 2, {}); ev.push(g3);
  for (const [oid, g] of [[o1, g1], [o2, g2], [o3, g3]]) ev.push(AE(g.id, B, gh + 5, payFor(ev, oid, "500000000", gh + 5)));
  ev.push(PE(NEW.fclaim({ offer: o4 }), 80_000, B, epochOf(80_000) + 2, 0, {}));
  diffCase("leak-M5:3-filled-holds+4th@80000", ev, 80_050);
}
{
  // M4: a duplicated partial fill near 80,000. Both dists must DOUBLE-credit below the gate. If the dedup
  // leaks below V29, NEW single-credits -> divergence.
  const gh = 79_995, E = epochOf(gh) + 2, oid = nid();
  const ev = [...roots(), mkOffer(oid, gh, { value: "500000000", min: "100000000" })];
  const g = PE(NEW.fclaim({ offer: oid }), gh, B, E, 0, {}); ev.push(g);
  const fill = AE(g.id, B, 80_000, payFor(ev, oid, "400000000", gh + 2));
  ev.push(fill); ev.push({ ...fill });
  diffCase("leak-M4:dup-partial-fill@80000", ev, 80_020);
}

// ── 2. seeded generated corpus (deterministic; both dists see identical inputs; ALL heights < V29) ─────
step("seeded generated corpus, all heights strictly below V29");
{
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mulberry32(0x29_be10);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const cov = { offers: 0, grants: 0, fills: 0, partials: 0, legacyClaims: 0, dups: 0 };
  const N = 400;
  for (let i = 0; i < N; i++) {
    const base = pick([30_100, 33_700, 38_500, 40_200, 46_500, 60_010, 70_000, 80_000, 87_900, 87_940]); // +50 tip stays < V29
    const ev = [...roots()];
    const oid = nid();
    const partial = rnd() < 0.45;
    const taker = !partial && rnd() < 0.25;
    const want = String(100_000_000 + Math.floor(rnd() * 900_000_000));
    ev.push(mkOffer(oid, base, { value: want, ...(taker ? { taker: B } : {}), ...(partial ? { min: String(Math.max(1, Math.floor(Number(want) / 5))) } : {}) }));
    let fillTarget = oid;
    if (base >= 60_000 && !taker && rnd() < 0.85) {                       // fclaim lane
      const g = PE(NEW.fclaim({ offer: oid }), base + 1, B, NEW.fclaimEpochFor(base + 1, 9e9), 0, {}); ev.push(g); fillTarget = g.id;
    } else if (base >= 34_000 && base < 60_000 && !taker && rnd() < 0.6) { // legacy claim lane
      ev.push(AE(oid, B, base + 1, {}, NEW.SCORE_CLAIM)); cov.legacyClaims++;
    }
    if (rnd() < 0.85) {
      const o = NEW.resolve(ev, base + 3).offers[oid];
      if (o && o.status === "open" && (o.claimTxid || o.taker || base < 34_000 || fillTarget !== oid)) {
        const pay = partial ? String(Math.max(1, Math.floor(Number(want) / 5))) : want;
        const outs = NEW.requiredFillOutputs(o, pay);
        if (outs) {
          const f = AE(fillTarget, taker ? B : B, base + 2, Object.fromEntries(outs.map((x) => [x.to, String(x.value)])));
          ev.push(f);
          if (rnd() < 0.3) { ev.push({ ...f }); cov.dups++; }             // duplicate the fill sometimes (all below V29)
        }
      }
    }
    if (rnd() < 0.2) ev.push(AE(oid, A, base + 4, {}, NEW.SCORE_CANCEL));
    for (const tip of [base + 2, base + 6, base + 50]) diffCase(`gen:${i}@${tip}`, ev, tip);
    const o = NEW.resolve(ev, base + 6).offers[oid];
    if (o) cov.offers++;
    if (o?.claimTxid) cov.grants++;
    if (o?.status === "filled" || o?.fills?.length) cov.fills++;
    if (o?.paid && o.paid !== "0" && o.status === "open") cov.partials++;
  }
  console.log(`  coverage: ${JSON.stringify(cov)} over ${N} sequences x 3 tips`);
  for (const [k, floor] of [["offers", 200], ["grants", 40], ["fills", 60], ["partials", 15], ["legacyClaims", 15], ["dups", 20]]) {
    if (cov[k] < floor) die(`corpus coverage collapsed: ${k}=${cov[k]} < floor ${floor} (a thin corpus proves nothing)`);
  }
}

if (diverged) die(`${diverged} divergence(s) below V29 - the change is NOT inert below the gate (a fork risk)`);
console.log(`\nV29-BELOW-GATE PASS: 0.1.40-to-be == ${BASELINE_REF} (0.1.39-to-be), canonicalState byte-identical for every event/tip below 88,000`);
