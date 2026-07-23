#!/usr/bin/env node
// seal-differential.mjs - the B6-SEAL author-side harness (the referee executes this at the gate).
//
// PROVES: with every new B6 feature OFF (no opts.sums, 2-arg bindOfferTerms, 1-arg claimWindowOf,
// no new function called), the tree's cairnx-core dist is BYTE-IDENTICAL to the published 0.1.38
// baseline - on the full pinned record corpus, on a seeded adversarial corpus, and on the legacy
// API surface. If this script does not exit 0, NOTHING PUBLISHES (B6-SEAL is a hard go/no-go).
//
// What it does, in order:
//   1. settled-tree check: scripts/check-lockstep.mjs (dist not older than src);
//   2. pins non-movement of the vector corpus itself: git diff <baseline>..HEAD over
//      packages/cairnx/test/vectors/ B6-era pins (cases.json + wa-parity + VECTORS.md) must be EMPTY;
//   3. builds the BASELINE dist from the 0.1.38 release commit in a throwaway git worktree
//      (pnpm install --frozen-lockfile, build codec + cairnx);
//   4. corpus differential: canonicalState(resolve(events, tip)) old vs new, byte for byte, over
//      (a) every pinned vector case and (b) a seeded generated corpus with coverage floors read
//      back from the BASELINE outputs (grants/fills/partials must actually occur);
//   5. legacy-surface differential: bindOfferTerms (2-arg), provenOfferTerms legacy fields,
//      previewFill / requiredFillOutputs / fillIsSafe / claimWindowOf(1-arg) / claimGraceOf /
//      hasLiveClaim / fillTargetId / feeBpsAt over adversarial grids - equal verdicts everywhere;
//   6. pnpm test:crosslang (the real fork gate, incl. the repaired V28 legs) - exit 0 required
//      (set SEAL_SKIP_CROSSLANG=1 only for iterative authoring, never at the gate).
//
// Usage: node scripts/seal-differential.mjs [baselineRef]     (default: the 0.1.38 release commit)
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_REF = process.argv[2] ?? "84f22d7";   // release: cairnx-core 0.1.38 + csd-tx 0.1.17
const die = (msg) => { console.error(`SEAL FAIL: ${msg}`); process.exit(1); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
const step = (s) => console.log(`\n== SEAL: ${s} ==`);

// ── 1. settled tree ────────────────────────────────────────────────────────────────────────────────
step("settled-tree check (check-lockstep: dist fresh, workspace pins)");
{
  const r = sh(process.execPath, [join(ROOT, "scripts", "check-lockstep.mjs")], { stdio: "inherit" });
  if (r.status !== 0) die("check-lockstep failed (stale dist or broken pins) - rebuild, then re-run");
}

// ── 2. the pinned corpus itself must not have moved ────────────────────────────────────────────────
// SCOPED to the B6-era pinned files ONLY (not the whole directory): B9 added packages/cairnx/test/vectors/
// cases-v29.json, a NEW V29-gate golden set that this seal deliberately does NOT diff (its cases exercise the
// V29 relaxation, so old-vs-new DIVERGES by design). The B6-era pins below MUST still be byte-frozen - a moved
// pin is a moved goalpost. If a future batch adds another vectors/*.json, list it in the DIFF_PINS below only
// after confirming it is a new gate's file and not a mutation of these.
// B8-hash (2026-07-23, per docs/Plans/71-B8-HASH-SPEC.md in the cairn repo): replay-hashes.json is EXEMPTED
// from this list by the same narrowing pattern B9 established. It is the deliberate B8-hash deliverable
// (the V28-inclusive baseline re-pin, stop-rule verified: every pre-existing 45,959-era height reproduced
// byte-identically before the V24..V28 entries were ADDED) and, together with the new replay-corpus.json,
// it is independently guarded by the load-bearing vectors.test.ts recompute-and-assert (mutation-proven).
// The narrowing drops nothing pre-existing: the B6-era byte-identity proof is unaffected.
const B6_ERA_PINS = [
  "packages/cairnx/test/vectors/cases.json",
  "packages/cairnx/test/vectors/wa-parity-corpus.json",
  "packages/cairnx/test/vectors/VECTORS.md",
];
step(`vector-corpus non-movement vs ${BASELINE_REF} (B6-era pins: ${B6_ERA_PINS.map((p) => p.split("/").pop()).join(" / ")})`);
{
  const r = sh("git", ["diff", "--stat", `${BASELINE_REF}..HEAD`, "--", ...B6_ERA_PINS]);
  if (r.status !== 0) die(`git diff against ${BASELINE_REF} failed: ${r.stderr}`);
  if (r.stdout.trim() !== "") die(`a B6-era pinned vector file moved since the baseline:\n${r.stdout}\n(a moved pin is a moved goalpost; B6/B9 must not touch these)`);
  console.log("  B6-era vector pins unchanged since baseline (the V29 cases-v29.json is a separate, deliberately-diverging gate set)");
}

// ── 3. build the baseline dist in a throwaway worktree ─────────────────────────────────────────────
step(`baseline build (git worktree @ ${BASELINE_REF})`);
const wt = mkdtempSync(join(tmpdir(), "csd-sdk-seal-"));
const cleanup = () => { try { sh("git", ["worktree", "remove", "--force", wt]); } catch { /* best effort */ } try { rmSync(wt, { recursive: true, force: true }); } catch { /* ditto */ } };
process.on("exit", cleanup);
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

// ── 4a. pinned vector corpus differential ──────────────────────────────────────────────────────────
step("corpus differential: pinned vectors (old dist vs new dist, byte for byte)");
let diverged = 0;
const diffCase = (name, events, tip) => {
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
{
  const { format, cases } = JSON.parse(readFileSync(join(ROOT, "packages", "cairnx", "test", "vectors", "cases.json"), "utf8"));
  if (format !== 2) die(`unexpected cases.json format ${format}`);
  for (const c of cases) {
    diffCase(`vector:${c.name}`, c.events, c.tipHeight);
    // and the frozen expectation still holds on the NEW dist (replay non-movement on the pinned corpus)
    if (NEW.canonicalState(NEW.resolve(c.events, c.tipHeight)) !== JSON.stringify(c.expectedState)) { diverged++; console.error(`  PINNED EXPECTATION MOVED: ${c.name}`); }
  }
  console.log(`  ${cases.length} pinned vectors diffed (old vs new AND vs frozen expectedState)`);
}

// ── 4b. seeded generated corpus (deterministic; both dists see identical inputs) ───────────────────
step("corpus differential: seeded generated corpus with baseline-read coverage floors");
{
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mulberry32(0xb6_5ea1);          // FIXED seed: the corpus is part of the harness
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const T = NEW.TREASURY_ADDR;
  const ADDRS = ["0x" + "a1".repeat(20), "0x" + "b2".repeat(20), "0x" + "c3".repeat(20), "0x" + "d4".repeat(20)];
  let n = 1; const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
  const PE = (b, h, who, ee, pos, paidTo, id = nid()) => ({ kind: "propose", id, proposer: who, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height: h, pos, paidTo });
  const AE = (pid, who, h, paidTo, score, conf = 0, pos = 0) => ({ kind: "attest", txid: nid(), proposalId: pid, attester: who, score, confidence: conf, height: h, pos, paidTo });
  const cov = { offers: 0, grants: 0, fills: 0, partials: 0, legacyClaims: 0, cancels: 0 };
  const N = 400;
  for (let i = 0; i < N; i++) {
    const A = pick(ADDRS); let B = pick(ADDRS); if (B === A) B = ADDRS[(ADDRS.indexOf(A) + 1) % ADDRS.length];
    const base = pick([30_100, 33_700, 38_500, 40_200, 46_500, 59_900, 59_990, 60_000, 60_010, 61_000]);
    const ev = [
      PE(NEW.deploy({ ticker: "AAA", decimals: 0, supply: "100000", mint: "issuer" }), 29_900, A, 9e9, 0, { [T]: String(NEW.DEPLOY_FEE) }),
      PE(NEW.mint({ ticker: "AAA", amount: "100000" }), 29_901, A, 9e9, 0, {}),
    ];
    const oid = nid();
    const partial = rnd() < 0.4;
    const taker = !partial && rnd() < 0.3;
    const want = String(100_000_000 + Math.floor(rnd() * 900_000_000));
    ev.push(PE(NEW.offer({ give: { ticker: "AAA", amount: String(1 + Math.floor(rnd() * 50)) }, want: { value: want, payto: A }, ...(taker ? { taker: B } : {}), ...(partial ? { min: String(Math.max(1, Math.floor(Number(want) / 5))) } : {}) }), base, A, epochOf2(base) + 3 + Math.floor(rnd() * 90), 0, {}, oid));
    let fillTarget = oid;
    if (base >= 60_000 && rnd() < 0.8) {                                   // fclaim lane
      const g = PE(NEW.fclaim({ offer: oid }), base + 1, B, NEW.fclaimEpochFor(base + 1, 9e9), 0, {}, nid());
      ev.push(g); fillTarget = g.id;
    } else if (base >= 34_000 && base < 60_000 && !taker && rnd() < 0.6) { // legacy claim lane
      ev.push(AE(oid, B, base + 1, {}, NEW.SCORE_CLAIM));
    }
    if (rnd() < 0.85) {
      const st = OLD.resolve(ev, base + 3);                                // size the payment from the BASELINE
      const o = st.offers[oid];
      if (o && o.status === "open") {
        const pay = partial ? String(Math.max(1, Math.floor(Number(want) / 5))) : want;
        const outs = OLD.requiredFillOutputs(o, pay);
        if (outs) ev.push(AE(fillTarget, taker ? B : B, base + 2 + Math.floor(rnd() * 3), Object.fromEntries(outs.map((x) => [x.to, String(x.value)])), NEW.SCORE_FILL));
      }
    }
    if (rnd() < 0.2) ev.push(AE(oid, A, base + 4, {}, NEW.SCORE_CANCEL));
    for (const tip of [base + 2, base + 6, base + 50, 62_000]) diffCase(`gen:${i}@${tip}`, ev, tip);
    const stC = OLD.resolve(ev, base + 6);                                  // coverage, read from the BASELINE
    const o = stC.offers[oid];
    if (o) cov.offers++;
    if (o?.claimTxid) cov.grants++;
    if (o?.claimedBy && !o?.claimTxid) cov.legacyClaims++;
    if (o?.status === "filled" || o?.fills?.length) cov.fills++;   // whole fills flip status and carry no fills[]
    if (o?.paid && o.paid !== "0" && o.status === "open") cov.partials++;
    if (o?.status === "cancelled") cov.cancels++;
  }
  console.log(`  coverage (baseline-read): ${JSON.stringify(cov)} over ${N} sequences x 4 tips`);
  for (const [k, floor] of [["offers", 200], ["grants", 30], ["fills", 60], ["partials", 10], ["legacyClaims", 20], ["cancels", 15]]) {
    if (cov[k] < floor) die(`generated-corpus coverage collapsed: ${k}=${cov[k]} < floor ${floor} (a thin corpus proves nothing)`);
  }
}
function epochOf2(h) { return Math.floor(h / NEW.EPOCH_LEN); }

// ── 5. legacy-surface differential (every feature OFF) ─────────────────────────────────────────────
step("legacy-surface differential: pre-B6 call shapes, old vs new verdicts");
let surfChecks = 0;
{
  const eq = (name, a, b) => { surfChecks++; const sa = JSON.stringify(a, (_, v) => typeof v === "bigint" ? String(v) : v), sb = JSON.stringify(b, (_, v) => typeof v === "bigint" ? String(v) : v); if (sa !== sb) { diverged++; console.error(`  SURFACE DIVERGED ${name}: old=${sa} new=${sb}`); } };
  const H = 60_002;
  const A = "0x" + "a1".repeat(20), C = "0x" + "c3".repeat(20);
  const recCsd = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } };
  const recMin = { ...recCsd, min: "100000000" };
  const recTok = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5" } };
  const recName = { v: 1, t: "offer", give: { name: "gemname" }, want: { value: "500000000", payto: A }, taker: C, bid: "0x" + "bb".repeat(32) };
  for (const [rn, rec] of [["csd", recCsd], ["min", recMin], ["tok", recTok], ["name", recName]]) {
    for (const h of [29_000, 33_599, 33_600, 60_000]) {
      const to = OLD.provenOfferTerms(rec, h), tn = NEW.provenOfferTerms(rec, h);
      // LEGACY FIELDS bit-identical (the new giveTicker/wantType fields are additive; 2-arg bind ignores them)
      for (const f of ["height", "feeBps", "value", "taker", "bid", "min"]) eq(`provenOfferTerms(${rn},${h}).${f}`, to[f], tn[f]);
      const servedGrid = [
        rec, { ...rec, height: h, feeBps: OLD.feeBpsAt(h), want: rec.want }, { height: h, feeBps: OLD.feeBpsAt(h), want: { value: "500000000" } },
        { height: h + 1, feeBps: 0, want: { value: "1" }, taker: C, bid: "0xbb", min: "1" },
        { height: h, feeBps: OLD.feeBpsAt(h), want: { value: "500000000" }, min: "" }, {}, null,
      ];
      for (let i = 0; i < servedGrid.length; i++) eq(`bindOfferTerms(${rn},${h},served#${i})`, OLD.bindOfferTerms(servedGrid[i], to), NEW.bindOfferTerms(servedGrid[i], tn));
    }
  }
  const offers = [
    { id: "0x" + "01".repeat(32), seller: A, give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A }, status: "open", expiresEpoch: 9e15, height: H - 50, feeBps: 150 },
    { id: "0x" + "02".repeat(32), seller: A, give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A }, status: "open", expiresEpoch: 9e15, height: H - 50, feeBps: 150, min: "100000000", paid: "400000000", delivered: "8", fills: [] },
    { id: "0x" + "03".repeat(32), seller: A, give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: A }, status: "open", expiresEpoch: 9e15, height: H - 50, feeBps: 150 },
    { id: "0x" + "04".repeat(32), seller: A, give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A }, status: "open", expiresEpoch: 9e15, height: H - 50, feeBps: 150, claimedBy: C, claimUntilHeight: H + 20, claimTxid: "0x" + "f9".repeat(32) },
    { id: "0x" + "05".repeat(32), seller: A, give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A }, status: "cancelled", expiresEpoch: 9e15, height: H - 50, feeBps: 150 },
  ];
  for (const o of offers) for (const pay of ["1", "100000000", "500000000", "600000000"]) for (const me of [A, C]) for (const tip of [33_999, 46_500, H]) {
    eq(`previewFill(${o.id.slice(0, 6)},${pay})`, OLD.previewFill(o, pay), NEW.previewFill(o, pay));
    eq(`requiredFillOutputs(${o.id.slice(0, 6)},${pay})`, OLD.requiredFillOutputs(o, pay), NEW.requiredFillOutputs(o, pay));
    eq(`fillIsSafe(${o.id.slice(0, 6)},${me.slice(0, 6)},${pay},${tip})`, OLD.fillIsSafe(o, me, pay, tip), NEW.fillIsSafe(o, me, pay, tip));
    eq(`hasLiveClaim(${o.id.slice(0, 6)},${me.slice(0, 6)},${tip})`, OLD.hasLiveClaim(o, me, tip), NEW.hasLiveClaim(o, me, tip));
    eq(`fillTargetId(${o.id.slice(0, 6)},${tip})`, OLD.fillTargetId(o, tip), NEW.fillTargetId(o, tip));
  }
  for (const cu of [38_415, 38_440, 43_440, 60_060, 60_090]) {
    eq(`claimWindowOf(${cu})`, OLD.claimWindowOf(cu), NEW.claimWindowOf(cu));           // 1-arg ONLY: the legacy shape
    eq(`claimGraceOf(${cu})`, OLD.claimGraceOf(cu), NEW.claimGraceOf(cu));
    eq(`claimGraceOf(${cu},fc)`, OLD.claimGraceOf(cu, "0xfc"), NEW.claimGraceOf(cu, "0xfc"));
  }
  for (const h of [29_000, 29_960, 33_599, 33_600, 60_000]) eq(`feeBpsAt(${h})`, OLD.feeBpsAt(h), NEW.feeBpsAt(h));
  console.log(`  ${surfChecks} legacy-surface checks (2-arg/1-arg call shapes only)`);
}

if (diverged) die(`${diverged} divergence(s) between the 0.1.38 baseline and the tree - the D4 zero-semantic-payload claim is FALSE`);
console.log("\nSEAL: corpus + legacy surface BYTE-IDENTICAL to the 0.1.38 baseline with every new feature off");

// ── 6. the real fork gate ──────────────────────────────────────────────────────────────────────────
if (process.env.SEAL_SKIP_CROSSLANG === "1") {
  console.log("SEAL: test:crosslang SKIPPED (SEAL_SKIP_CROSSLANG=1 - authoring iteration only, NEVER at the gate)");
} else {
  step("pnpm test:crosslang (incl. the repaired V28 legs + the new tripwires)");
  const r = sh("pnpm", ["run", "test:crosslang"], { stdio: "inherit" });
  if (r.status !== 0) die("test:crosslang failed");
}

console.log("\nSEAL PASS: byte-identical baseline differential + crosslang green. Hop 2 (bump/publish) may proceed.");
