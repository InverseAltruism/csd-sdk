#!/usr/bin/env node
// seal-differential.mjs - the seal for a cairnx-core change that must move no state (the referee runs it at the gate).
//
// PROVES: the tree's cairnx-core dist resolves every input below as the baseline release does (default
// cairnx-core-0.2.4): canonicalState byte for byte, and the whole resolve() result (the applied log with its order, ids,
// kinds, ok and notes, recaptures, fclaims, feesPaid, key order) identical once each log entry's `code` is left out;
// with a code baseline (a ref that already writes codes), the whole result identical to it including `code`; against
// a baseline that writes no token moves (CONVENTION §41, before cairnx-core 0.2.8) each entry's `moves` is left out
// too, and every input's moves pass conformance/moves-check.mjs against the state they produced;
// parseRecord accepts exactly what the baseline accepts; the client helpers give the baseline's verdicts for equal
// arguments. If this script does not exit 0, NOTHING PUBLISHES.
//
// What it does, in order:
//   1. settled-tree check: scripts/check-lockstep.mjs (dist not older than src);
//   2. every vector file present at the baseline is unchanged in the working tree; 2b content-pins the replay corpus
//      and hashes, and the vector and fixture files added after the baseline;
//   3. builds the BASELINE dist from the baseline ref in a throwaway git worktree (pnpm install --frozen-lockfile,
//      build codec + cairnx), and the code baseline's the same way when one is given; binds each build to npm: for
//      codec and cairnx-core at the version the ref's manifest names, when npm holds that version, its tarball must
//      pass its sha512 integrity check and hold a dist/ byte-identical to the build (scripts/published-dist.mjs
//      registryBind), so the old side that runs is what npm serves; a version npm does not hold is named, not bound;
//   4. resolve differential, old vs new, over (a) the case files, (b) a seeded generated corpus with coverage floors
//      read back from the BASELINE outputs, (c) the replay corpus at every pinned height and every event height,
//      (d) the sequences of conformance/fuzz-resolve.mjs --emit, (e) the resolve cases of test/vectors/codes.json when
//      present, and the cases of forward.json and moves.json, (f) the streams of conformance/growth-streams.mjs at full
//      size (16,000 registrations; 20,000 open bids, offers with holds, live reservations, live recaptures; 2,000 bulk
//      cancels and 2,000 displacements over 20,000 offers; the V21 crossing; the edges), each with the expectations it
//      was built to meet read from the new log, and the streams of conformance/sweep-streams.mjs, (d2) the sequences of
//      conformance/fuzz-resolve.mjs --expiry (offers, bids, reservations and recapture reservations that end between
//      events), with a floor per kind of expiry read back from the baseline outputs and each sequence resolved again
//      with events that write nothing (CONVENTION section 5), (w) a dense walk over the sequences of (d2) and the sweep
//      streams: each at every tip from two below its first event to its tip (over a span of more than 2,000 blocks,
//      every tip within three epochs above each event height and beside each expiry height and gate), against the
//      code baseline's whole result when one is given, else the baseline's canonicalState, (g) when the tree has the
//      replay's check mode (packages/cairnx/test/support/check-replay.ts), every input of (a), (c), (d), (d2), the
//      codes.json cases of (e), (f) and the sweep streams replayed with it: each indexed read compared with the plain
//      walk, each expiry checked to land at the first height it is due, the index invariants asserted after every
//      event (every 64th on a stream of more than 1,000 events);
//      when the new build has the code table, every log entry carries a code whose outcome is its `ok`;
//      (h) the token moves of every input of (a) to (f) checked by conformance/moves-check.mjs (the identity of §41,
//      the mint total, each fill's moves from its fill record, no moves on a refused entry), with a floor on the moves
//      of each leg so a thin run fails;
//   5. parse differential: parseRecord null-ness old vs new over every Propose of step 4 and a seeded mutation corpus
//      (and the record cases of codes.json); where the new build has explainRecord it must agree with parseRecord;
//   6. client-surface differential: bindOfferTerms, provenOfferTerms, previewFill / requiredFillOutputs / fillIsSafe /
//      claimWindowOf / claimGraceOf / hasLiveClaim / fillTargetId / feeBpsAt over adversarial grids, the same arguments
//      on both sides;
//   7. the per-code count of the new build's log over every input of step 4;
//   8. pnpm test:crosslang (the fork gate) - exit 0 required (SEAL_SKIP_CROSSLANG=1 runs steps 1-7 then exits 3 SEAL
//      INCOMPLETE: authoring iteration only; it can never produce a SEAL PASS).
//
// Usage: node scripts/seal-differential.mjs [baselineRef] [codeBaselineRef]
//        baselineRef defaults to the cairnx-core-0.2.4 tag; codeBaselineRef (none by default) is the tree before a
//        state-neutral change to code-writing source, compared including `code`.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { registryBind } from "./published-dist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_REF = process.argv[2] ?? "cairnx-core-0.2.4";
const CODE_BASELINE_REF = process.argv[3];
const die = (msg) => { console.error(`SEAL FAIL: ${msg}`); process.exit(1); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
const step = (s) => console.log(`\n== SEAL: ${s} ==`);
const VEC = "packages/cairnx/test/vectors";
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, ...rel.split("/")), "utf8"));

// ── 1. settled tree ────────────────────────────────────────────────────────────────────────────────
step("settled-tree check (check-lockstep: dist fresh, workspace pins)");
{
  const r = sh(process.execPath, [join(ROOT, "scripts", "check-lockstep.mjs")], { stdio: "inherit" });
  if (r.status !== 0) die("check-lockstep failed (stale dist or broken pins) - rebuild, then re-run");
}

// ── 2. the pinned vector files must not have moved ─────────────────────────────────────────────────
// Every listed file that exists at the baseline is compared with the WORKING TREE (staged or not), so an uncommitted
// edit fails too. A file that is missing at an older baseline ref is skipped and named. A moved pin is a moved goalpost:
// a change here is a new gate's business, never a state-neutral release's.
const PINNED_AT_BASELINE = [
  `${VEC}/cases.json`, `${VEC}/cases-rules.json`, `${VEC}/cases-v29.json`, `${VEC}/replay-corpus.json`,
  `${VEC}/replay-hashes.json`, `${VEC}/wa-parity-corpus.json`, `${VEC}/VECTORS.md`,
  "packages/cairnx/test/fixtures/primary-vectors.json",
];
step(`vector-file non-movement vs ${BASELINE_REF} (working tree)`);
{
  const present = PINNED_AT_BASELINE.filter((p) => sh("git", ["cat-file", "-e", `${BASELINE_REF}:${p}`]).status === 0);
  const absent = PINNED_AT_BASELINE.filter((p) => !present.includes(p));
  const r = sh("git", ["diff", "--stat", BASELINE_REF, "--", ...present]);
  if (r.status !== 0) die(`git diff against ${BASELINE_REF} failed: ${r.stderr}`);
  if (r.stdout.trim() !== "") die(`a pinned vector file moved since the baseline:\n${r.stdout}`);
  console.log(`  ${present.length} pinned files unchanged since the baseline${absent.length ? `; not at the baseline, skipped: ${absent.join(", ")}` : ""}`);
}

// ── 2b. content pins ───────────────────────────────────────────────────────────────────────────────
// replay-corpus.json + replay-hashes.json: sha256 + floors, so a narrowed corpus cannot self-certify (vectors.test.ts
// recomputes hashes FROM the corpus). The files added after cairnx-core-0.2.4 (the event-rule, hash, convention,
// forward-resolution and token-move vectors and the recorded block fixture) are pinned by sha256 here, since a diff
// against the baseline cannot see them move.
//
// UPDATE POINT: REPLAY_CORPUS_PIN and ADDED_SINCE_BASELINE are the ONE place a sanctioned vector change touches, in the
// SAME commit as the change. Floors only ever RISE (minEvents, minFclaim and minPinnedHeights up, heightSpan wider or
// equal, tipHeight up).
const REPLAY_CORPUS_PIN = {
  corpusFile: `${VEC}/replay-corpus.json`,
  corpusSha256: "83cc1e1a7cadeb7743cf47974589b3f729820d8fcaff563f0c84a60a63b0e9f8",
  hashesFile: `${VEC}/replay-hashes.json`,
  hashesSha256: "26ebd3a23fedcf32afb5cae6751edb0353676efe3f0445db6a929be4491724ec",
  format: 1,
  tipHeight: 117_000,
  minEvents: 1_133,                        // event-count floor: an extension ADDS events, never removes
  minFclaim: 4,                            // fclaim-record floor (the V28 open-lane claim)
  minPinnedHeights: 21,                    // floor on the replay-hashes.json pin set
  heightSpan: { lo: 29_865, hi: 116_988 }, // coverage floor: events must still span this range
};
const ADDED_SINCE_BASELINE = {
  [`${VEC}/events.json`]: "0f61da38fb17a5eb758759b56410090a9491b54642102139d7e330275cb81f0b",
  [`${VEC}/hashes.json`]: "affc644f6608eeb0ddf4de7f679b55aa6160f910f47a3199e3e31dde397f6b6d",
  [`${VEC}/cases-convention.json`]: "9cb61caf0ea391cc3cd370207d7623b99ac91485d34c051e763f671bb3ca76be",
  [`${VEC}/forward.json`]: "bc56213e507fa6f6ba7c6f2da1f4180215cb8e3ea07c95c33177c1b688aa2b2c",
  [`${VEC}/moves.json`]: "5ad6b3ed11b0ceb4addf4ea1586246e67f76aa0ff0eb05ab9c59558efcc9fbe8",
  "packages/cairnx/test/fixtures/events-blocks.json": "46f02644c048078d0da2f3623f251e3e6acd6d3d39b5ce38f40672369ed7c58c",
};
step("content pins (replay corpus sha256 + floors; files added after the baseline)");
let corpus;
{
  const { createHash } = await import("node:crypto");
  const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
  const P = REPLAY_CORPUS_PIN;
  const corpusRaw = readFileSync(join(ROOT, ...P.corpusFile.split("/")));
  const hashesRaw = readFileSync(join(ROOT, ...P.hashesFile.split("/")));
  const bad = [];
  const gotC = sha256hex(corpusRaw);
  if (gotC !== P.corpusSha256) bad.push(`replay-corpus.json content moved: sha256 ${gotC} != pinned ${P.corpusSha256}`);
  const gotH = sha256hex(hashesRaw);
  if (gotH !== P.hashesSha256) bad.push(`replay-hashes.json content moved: sha256 ${gotH} != pinned ${P.hashesSha256}`);
  let pinned;
  try { corpus = JSON.parse(corpusRaw.toString("utf8")); pinned = JSON.parse(hashesRaw.toString("utf8")); }
  catch (e) { die(`replay corpus/hashes unparseable: ${e.message}`); }
  if (corpus.format !== P.format) bad.push(`replay-corpus format ${corpus.format} != pinned ${P.format}`);
  if (corpus.tipHeight !== P.tipHeight) bad.push(`replay-corpus tipHeight ${corpus.tipHeight} != pinned ${P.tipHeight}`);
  const evs = Array.isArray(corpus.events) ? corpus.events : [];
  if (evs.length < P.minEvents) bad.push(`replay-corpus narrowed: ${evs.length} events < floor ${P.minEvents} (a thin corpus proves nothing)`);
  const nFclaim = evs.filter((e) => e.kind === "propose" && typeof e.uri === "string" && e.uri.includes('"t":"fclaim"')).length;
  if (nFclaim < P.minFclaim) bad.push(`replay-corpus narrowed: ${nFclaim} fclaim records < floor ${P.minFclaim}`);
  const hts = evs.map((e) => e.height).filter((h) => Number.isFinite(h));
  const lo = hts.length ? Math.min(...hts) : Infinity, hi = hts.length ? Math.max(...hts) : -Infinity;
  if (!(lo <= P.heightSpan.lo && hi >= P.heightSpan.hi)) bad.push(`replay-corpus height span [${lo}, ${hi}] no longer covers the pinned floor [${P.heightSpan.lo}, ${P.heightSpan.hi}]`);
  const nPins = Object.keys(pinned.hashes ?? {}).length;
  if (nPins < P.minPinnedHeights) bad.push(`replay-hashes narrowed: ${nPins} pinned heights < floor ${P.minPinnedHeights}`);
  if (pinned.tipHeight !== corpus.tipHeight) bad.push(`replay-hashes tipHeight ${pinned.tipHeight} != corpus tipHeight ${corpus.tipHeight}`);
  corpus.pinnedHeights = Object.keys(pinned.hashes ?? {}).map(Number);
  for (const [rel, want] of Object.entries(ADDED_SINCE_BASELINE)) {
    const got = sha256hex(readFileSync(join(ROOT, ...rel.split("/"))));
    if (got !== want) bad.push(`${rel} content moved: sha256 ${got} != pinned ${want}`);
  }
  if (bad.length) {
    for (const m of bad) console.error(`  PIN VIOLATION: ${m}`);
    die(`${bad.length} content pin violation(s): update the pins only in the SAME commit as a sanctioned vector change, never to silence this`);
  }
  console.log(`  replay corpus: ${evs.length} events (${nFclaim} fclaim), span [${lo}, ${hi}], tip ${corpus.tipHeight}, ${nPins} pinned heights; ${Object.keys(ADDED_SINCE_BASELINE).length} later files; every sha256 ok`);
}

// ── 3. build the baseline dists in throwaway worktrees ─────────────────────────────────────────────
const worktrees = [];
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));   // so the cleanup below runs
process.on("exit", () => {
  for (const w of worktrees) {
    try { sh("git", ["worktree", "remove", "--force", w]); } catch { /* best effort */ }
    try { rmSync(w, { recursive: true, force: true }); } catch { /* ditto */ }
  }
});
const buildAt = (ref) => {
  step(`baseline build (git worktree @ ${ref})`);
  const w = mkdtempSync(join(tmpdir(), "csd-sdk-seal-"));
  worktrees.push(w);
  let r = sh("git", ["worktree", "add", "--detach", w, ref], { stdio: "inherit" });
  if (r.status !== 0) die(`git worktree add ${ref} failed`);
  r = sh("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: w, stdio: "inherit" });
  if (r.status !== 0) die(`pnpm install in the ${ref} worktree failed`);
  for (const f of ["@inversealtruism/csd-codec", "@inversealtruism/cairnx-core"]) {
    r = sh("pnpm", ["--filter", f, "build"], { cwd: w, stdio: "inherit" });
    if (r.status !== 0) die(`build of ${f} at ${ref} failed`);
  }
  return w;
};
// The build of `ref` in `w` against npm's tarball of the same version, for the two packages the differential loads.
// Each outcome is kept for the final lines, so a pass that ran on an unbound baseline says so where the verdict is.
// A release tag names versions a window published (docs/release.md), so npm answering 404 for one fails the seal.
const binds = [];
const bindToNpm = async (ref, w) => {
  step(`registry bind (${ref}: each build against npm's tarball of its version)`);
  for (const dir of ["codec", "cairnx"]) {
    const { name, version } = JSON.parse(readFileSync(join(w, "packages", dir, "package.json"), "utf8"));
    const b = await registryBind(name, version, join(w, "packages", dir, "dist"));
    if (b.state === "failed") die(`${ref}: the build of ${name}@${version} is not what npm serves:\n    ${b.reasons.join("\n    ")}`);
    if (b.state === "unpublished" && /^cairnx-core-\d+\.\d+\.\d+$/.test(ref)) die(`${ref} is a release tag, yet npm answers 404 for ${name}@${version}`);
    const line = b.state === "bound" ? `${ref}: ${name}@${version} bound to npm (${b.files} dist files byte-identical, sha512 integrity ok)`
      : `${ref}: ${name}@${version} not on npm, not bound`;
    binds.push({ bound: b.state === "bound", line });
    console.log(`  ${line}`);
  }
};
const wt = buildAt(BASELINE_REF);
await bindToNpm(BASELINE_REF, wt);
const OLD = await import(pathToFileURL(join(wt, "packages", "cairnx", "dist", "index.js")).href);
const codeWt = CODE_BASELINE_REF ? buildAt(CODE_BASELINE_REF) : null;
if (codeWt) await bindToNpm(CODE_BASELINE_REF, codeWt);
const CODE = codeWt ? await import(pathToFileURL(join(codeWt, "packages", "cairnx", "dist", "index.js")).href) : null;
const NEW = await import(pathToFileURL(join(ROOT, "packages", "cairnx", "dist", "index.js")).href);
const { checkMoves } = await import(pathToFileURL(join(ROOT, "conformance", "moves-check.mjs")).href);
// Whether a build writes token moves (CONVENTION §41): the log of one issuer deploy and one mint. A baseline that writes
// none is compared with each new entry's `moves` left out; one that writes them is compared with them.
const writesMoves = (lib) => {
  const A = "0x" + "a1".repeat(20);
  const d = NEW.deploy({ ticker: "MOV", decimals: 0, supply: "10", mint: "issuer" }), m = NEW.mint({ ticker: "MOV", amount: "10" });
  const ev = [
    { kind: "propose", id: "0x" + "01".repeat(32), proposer: A, uri: d.uri, payloadHash: d.payloadHash, expiresEpoch: 9e9, height: 29_900, pos: 0, paidTo: { [NEW.TREASURY_ADDR]: String(NEW.DEPLOY_FEE) } },
    { kind: "propose", id: "0x" + "02".repeat(32), proposer: A, uri: m.uri, payloadHash: m.payloadHash, expiresEpoch: 9e9, height: 29_901, pos: 0, paidTo: {} },
  ];
  return lib.resolve(ev, 29_901).events.some((e) => Object.hasOwn(e, "moves"));
};
const OLD_MOVES = writesMoves(OLD), CODE_MOVES = CODE ? writesMoves(CODE) : false;
if (!writesMoves(NEW)) die("the tree's build writes no token moves (CONVENTION §41)");
console.log(`  token moves written: ${BASELINE_REF} ${OLD_MOVES ? "yes" : "no"}${CODE ? `, ${CODE_BASELINE_REF} ${CODE_MOVES ? "yes" : "no"}` : ""}, the tree yes`);

// ── 4. resolve differential ────────────────────────────────────────────────────────────────────────
let diverged = 0;
let smallest = null;                         // the diverging resolve input with the fewest events
let smallestUri = null;                      // the shortest uri parseRecord disagrees on
const problems = [];                         // failures that are not a divergence (a corpus too thin to prove anything)
const proposes = new Map();                  // uri + payloadHash of every Propose step 4 feeds, for step 5
const codeCount = new Map();                 // code -> entries of the new build's log carrying it
const uncoded = new Map();                   // kind -> entries of the new build's log without a code
const OUTCOME = NEW.REASON_CODE_OUTCOME;     // absent before the code table exists
const stripCodes = (s) => ({ ...s, events: s.events.map(({ code: _code, ...e }) => e) });
const stripMoves = (s) => ({ ...s, events: s.events.map(({ moves: _moves, ...e }) => e) });
const moveLegs = { xfer: 0, mint: 0, fill: 0, sale: 0, fee: 0 };
const movesSeen = { inputs: 0, pairs: 0, entries: 0 };
const firstDiff = (a, b) => { let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++; return k; };
const divergedBy = new Map();                // what differed -> how many checks
const bump = (what) => { diverged++; divergedBy.set(what, (divergedBy.get(what) ?? 0) + 1); };
const report = (name, what, events, a, b) => {
  bump(what);
  if (!smallest || events.length < smallest.n) smallest = { name, what, n: events.length };
  if (diverged > 20) return;
  const k = firstDiff(a, b);
  console.error(`  DIVERGED ${name} (${what}, ${events.length} events) @char ${k}`);
  console.error(`    old: ${a.slice(Math.max(0, k - 60), k + 100)}`);
  console.error(`    new: ${b.slice(Math.max(0, k - 60), k + 100)}`);
};
const lastMs = { old: 0, new: 0 };            // the last diffCase's resolve times (one run each, informational)
const diffCase = (name, events, tip) => {
  for (const e of events) if (e.kind === "propose") proposes.set(`${e.uri}\u0000${e.payloadHash}`, { uri: e.uri, payloadHash: e.payloadHash });
  let t0 = performance.now();
  const os = OLD.resolve(events, tip);
  lastMs.old = performance.now() - t0;
  t0 = performance.now();
  const ns = NEW.resolve(events, tip);
  lastMs.new = performance.now() - t0;
  const a = OLD.canonicalState(os), b = NEW.canonicalState(ns);
  if (a !== b) report(name, "canonicalState", events, a, b);
  const fa = JSON.stringify(os), fb = JSON.stringify(stripCodes(OLD_MOVES ? ns : stripMoves(ns)));
  if (fa !== fb) report(name, `full state without code${OLD_MOVES ? "" : " and moves"}`, events, fa, fb);
  if (CODE) {
    const fc = JSON.stringify(CODE.resolve(events, tip)), fn = JSON.stringify(CODE_MOVES ? ns : stripMoves(ns));
    if (fc !== fn) report(name, `full state with code${CODE_MOVES ? "" : ", without moves,"} vs ${CODE_BASELINE_REF}`, events, fc, fn);
  }
  const mv = checkMoves(ns, NEW.TREASURY_ADDR, events);
  movesSeen.inputs++; movesSeen.pairs += mv.pairs; movesSeen.entries += mv.entries;
  for (const l of Object.keys(moveLegs)) moveLegs[l] += mv.legs[l];
  if (mv.problems.length) {
    bump("token moves");
    if (!smallest || events.length < smallest.n) smallest = { name, what: "token moves", n: events.length };
    if (diverged <= 20) console.error(`  MOVES ${name}: ${mv.problems.slice(0, 3).join("; ")}${mv.problems.length > 3 ? ` (and ${mv.problems.length - 3} more)` : ""}`);
  }
  for (const e of ns.events) {
    if (!("code" in e)) {
      uncoded.set(e.kind, (uncoded.get(e.kind) ?? 0) + 1);
      // a build with the code table writes a code on every entry
      if (OUTCOME) { bump("an entry without a code"); if (diverged <= 20) console.error(`  NO CODE ${name}: entry ${e.id} kind ${e.kind}`); }
      continue;
    }
    codeCount.set(e.code, (codeCount.get(e.code) ?? 0) + 1);
    const outcome = OUTCOME?.[e.code];
    if (outcome !== (e.ok ? "applied" : "refused")) {
      bump("a code that is unknown or contradicts ok");
      if (diverged <= 20) console.error(`  BAD CODE ${name}: entry ${e.id} kind ${e.kind} ok ${e.ok} carries ${JSON.stringify(e.code)} (outcome ${outcome ?? "unknown"})`);
    }
  }
  return ns;
};

step("resolve differential (a): the case files, old vs new and vs their frozen expectedState");
{
  let n = 0;
  for (const f of ["cases.json", "cases-rules.json", "cases-v29.json", "cases-convention.json"]) {
    const { format, cases } = readJson(`${VEC}/${f}`);
    if (format !== 2) die(`unexpected ${f} format ${format}`);
    for (const c of cases) {
      const ns = diffCase(`${f}:${c.name}`, c.events, c.tipHeight);
      if (NEW.canonicalState(ns) !== JSON.stringify(c.expectedState)) { bump("frozen expectedState"); console.error(`  PINNED EXPECTATION MOVED: ${f}:${c.name}`); }
      n++;
    }
  }
  console.log(`  ${n} cases diffed (canonicalState, full state without code${OLD_MOVES ? "" : " and moves"}, frozen expectedState)`);
}

step("resolve differential (b): seeded generated corpus with baseline-read coverage floors");
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

step("resolve differential (c): the replay corpus at every pinned height and every event height");
{
  const heights = [...new Set([...corpus.pinnedHeights, ...corpus.events.map((e) => e.height)])].sort((a, b) => a - b);
  const byHeight = [...corpus.events].sort((a, b) => a.height - b.height);   // stable: within a height, corpus order
  let upto = 0;
  for (const h of heights) {
    while (upto < byHeight.length && byHeight[upto].height <= h) upto++;
    diffCase(`corpus@${h}`, byHeight.slice(0, upto), h);
  }
  console.log(`  ${heights.length} heights (${corpus.pinnedHeights.length} pinned, ${corpus.events.length} events at the tip)`);
}

// The fuzz corpus comes from the cross-language fuzzer's own generator, so the two differentials cannot drift apart.
const FUZZ_N = 20_000, FUZZ_SEED = 0x5ea1_c0de;
step(`resolve differential (d): conformance/fuzz-resolve.mjs --emit, ${FUZZ_N} sequences, seed ${FUZZ_SEED}`);
{
  const file = join(wt, "seal-fuzz.json");
  const r = sh(process.execPath, [join(ROOT, "conformance", "fuzz-resolve.mjs"), String(FUZZ_N), String(FUZZ_SEED), "--emit", file]);
  if (r.status !== 0) die(`fuzz-resolve --emit failed: ${r.stderr || r.stdout}`);
  const seqs = JSON.parse(readFileSync(file, "utf8"));
  if (seqs.length !== FUZZ_N) die(`fuzz-resolve emitted ${seqs.length} sequences, not ${FUZZ_N}`);
  let events = 0, threw = 0;
  seqs.forEach((s, i) => {
    events += s.events.length;
    let oldThrow = null, newThrow = null;
    try { OLD.resolve(s.events, s.tipHeight); } catch (e) { oldThrow = String(e?.message ?? e); }
    try { NEW.resolve(s.events, s.tipHeight); } catch (e) { newThrow = String(e?.message ?? e); }
    if (oldThrow !== null || newThrow !== null) {
      threw++;
      if (oldThrow !== newThrow) report(`fuzz#${i}`, "throw", s.events, String(oldThrow), String(newThrow));
      return;
    }
    diffCase(`fuzz#${i}`, s.events, s.tipHeight);
  });
  console.log(`  ${seqs.length} sequences, ${events} events${threw ? `, ${threw} threw in both builds alike` : ""}`);
}

// The expiry sequences: the same generator's --expiry mode, so that sweeps between events have something to do.
const SW = await import(pathToFileURL(join(ROOT, "conformance", "sweep-streams.mjs")).href);
const EXPIRY_N = 3_000;
const BASE = CODE ?? OLD;                     // the baseline the floors are read from and the dense walk compares with
step(`resolve differential (d2): conformance/fuzz-resolve.mjs --expiry --emit, ${EXPIRY_N} sequences, seed ${FUZZ_SEED}, floors read from ${CODE ? CODE_BASELINE_REF : BASELINE_REF}`);
const expirySeqs = [];
{
  const file = join(wt, "seal-fuzz-expiry.json");
  const r = sh(process.execPath, [join(ROOT, "conformance", "fuzz-resolve.mjs"), String(EXPIRY_N), String(FUZZ_SEED), "--expiry", "--emit", file]);
  if (r.status !== 0) die(`fuzz-resolve --expiry --emit failed: ${r.stderr || r.stdout}`);
  expirySeqs.push(...JSON.parse(readFileSync(file, "utf8")));
  if (expirySeqs.length !== EXPIRY_N) die(`fuzz-resolve --expiry emitted ${expirySeqs.length} sequences, not ${EXPIRY_N}`);
  const reach = { offer: 0, bid: 0, reservation: 0, recapture: 0, v21: 0 };
  let events = 0, inert = 0, inertDiffs = 0;
  expirySeqs.forEach((s, i) => {
    events += s.events.length;
    const ns = diffCase(`expiry#${i}`, s.events, s.tipHeight);
    const k = SW.expiryKinds(BASE, s.events, BASE.resolve(s.events, s.tipHeight));
    for (const x of Object.keys(reach)) if (k[x]) reach[x]++;
    const added = SW.inertEvents(SW.denseTips(s.events, s.tipHeight, NEW.EPOCH_LEN, SW.dueHeights(NEW, s.events), 300));
    inert += added.length;
    if (JSON.stringify(NEW.resolve([...added, ...s.events], s.tipHeight)) !== JSON.stringify(ns)) { inertDiffs++; bump("events that write nothing changed a result"); }
  });
  const floor = Math.floor(EXPIRY_N / 50);
  console.log(`  ${EXPIRY_N} sequences, ${events} events; reach (sequences with that expiry and a later event, read from the baseline): ${JSON.stringify(reach)}, floor ${floor} each`);
  console.log(`  events that write nothing: ${inert} added, ${inertDiffs} result(s) changed`);
  for (const [k, n] of Object.entries(reach)) if (n < floor) problems.push(`expiry reach too thin: ${k} ${n} < floor ${floor} (a thin run proves nothing)`);
}

const CODES_FILE = `${VEC}/codes.json`;
const codesVectors = existsSync(join(ROOT, ...CODES_FILE.split("/"))) ? readJson(CODES_FILE) : null;
step(`resolve differential (e): the resolve cases of ${CODES_FILE}${codesVectors ? "" : " (absent)"}, and the cases of forward.json and moves.json`);
if (codesVectors) {
  for (const c of codesVectors.resolve) diffCase(`codes.json:${c.name}`, c.events, c.tipHeight);
  console.log(`  ${codesVectors.resolve.length} cases diffed`);
}
for (const f of ["forward.json", "moves.json"]) {
  const { cases } = readJson(`${VEC}/${f}`);
  for (const c of cases) diffCase(`${f}:${c.name}`, c.events, c.tipHeight);
  console.log(`  ${cases.length} ${f} cases diffed`);
}

step("resolve differential (f): conformance/growth-streams.mjs at full size, with each stream's expectations");
{
  const G = await import(pathToFileURL(join(ROOT, "conformance", "growth-streams.mjs")).href);
  let inputs = 0;
  for (const s of G.fullGrowthStreams(NEW)) {
    const before = diverged;
    diffCase(`${s.key} ${s.label}@${s.tipHeight}`, s.events, s.tipHeight);
    const oldMs = lastMs.old, newMs = lastMs.new;
    inputs++;
    for (const tip of s.tips) { diffCase(`${s.key} ${s.label}@${tip}`, s.events, tip); inputs++; }
    const missed = s.expect(G.resolverAt(NEW.resolve, s));
    for (const m of missed) problems.push(`${s.key} ${s.label}: expected ${m}`);
    console.log(`  ${s.key} ${s.label}: ${s.events.length} events, ${1 + s.tips.length} tip(s), ${diverged - before} divergence(s), ${missed.length ? `${missed.length} expectation(s) MISSED` : "expectations met"}; one run: baseline ${Math.round(oldMs)} ms, tree ${Math.round(newMs)} ms`);
  }
  for (const s of SW.sweepStreams(NEW)) {
    diffCase(`sweep ${s.key}@${s.tipHeight}`, s.events, s.tipHeight);
    inputs++;
    const missed = s.expect(G.resolverAt(NEW.resolve, s));
    for (const m of missed) problems.push(`sweep ${s.key} ${s.label}: expected ${m}`);
  }
  console.log(`  ${inputs} stream inputs diffed (growth streams and the ${SW.sweepStreams(NEW).length} sweep streams)`);
}

step(`resolve differential (w): a dense walk over the ${EXPIRY_N} sequences of (d2) and the sweep streams, against ${CODE ? `${CODE_BASELINE_REF}'s whole result` : `${BASELINE_REF}'s canonicalState`}`);
{
  let walks = 0, tips = 0, walkDiffs = 0;
  const walk = (name, events, tip) => {
    walks++;
    for (const t of SW.denseTips(events, tip, NEW.EPOCH_LEN, [...SW.dueHeights(NEW, events), ...Object.values(NEW.GATE_HEIGHTS)])) {
      const upto = events.filter((e) => e.height <= t);
      const ns = NEW.resolve(upto, t), bs = BASE.resolve(upto, t);
      const a = CODE ? JSON.stringify(bs) : OLD.canonicalState(bs);
      const b = CODE ? JSON.stringify(CODE_MOVES ? ns : stripMoves(ns)) : NEW.canonicalState(ns);
      tips++;
      if (a !== b) { walkDiffs++; report(`${name}@${t}`, "dense walk", upto, a, b); }
    }
  };
  expirySeqs.forEach((s, i) => walk(`expiry#${i}`, s.events, s.tipHeight));
  for (const s of SW.sweepStreams(NEW)) walk(`sweep ${s.key}`, s.events, s.tipHeight);
  console.log(`  ${walks} walks, ${tips} tips, ${walkDiffs} tip(s) differ`);
}

const CHECK_SCRIPT = "packages/cairnx/test/support/check-replay.ts";
const hasCheck = existsSync(join(ROOT, ...CHECK_SCRIPT.split("/")));
step(`resolve differential (g): the replay's check mode over the inputs of (a), (c), (d), (d2), the codes.json cases of (e), (f) and the sweep streams${hasCheck ? "" : " (absent in this tree)"}`);
if (hasCheck) {
  const r = sh("pnpm", ["--filter", "@inversealtruism/cairnx-core", "exec", "tsx", "test/support/check-replay.ts", join(wt, "seal-fuzz.json"), join(wt, "seal-fuzz-expiry.json")], { stdio: "inherit" });
  if (r.status !== 0) { bump("check mode"); console.error("  CHECK MODE FAILED (the first failing input is printed above)"); }
}

// The floors sit below what the inputs of (a) to (f) give (the per-leg counts this step prints); an input set that
// thins below one fails the seal. Floors only ever RISE.
const MOVE_FLOORS = { inputs: 22_000, xfer: 8_000, mint: 50_000, fill: 43_000, sale: 1_300, fee: 1_300 };
step("resolve differential (h): token moves (CONVENTION §41) over every input of (a) to (f), conformance/moves-check.mjs");
{
  console.log(`  ${movesSeen.inputs} inputs, ${movesSeen.entries} entries with moves, identity on ${movesSeen.pairs} (ticker, address) pairs; moves per leg: ${Object.entries(moveLegs).map(([l, n]) => `${l} ${n}`).join(", ")}; ${divergedBy.get("token moves") ?? 0} input(s) failed`);
  if (movesSeen.inputs < MOVE_FLOORS.inputs) problems.push(`token moves checked on ${movesSeen.inputs} inputs < floor ${MOVE_FLOORS.inputs}`);
  for (const l of Object.keys(moveLegs)) if (moveLegs[l] < MOVE_FLOORS[l]) problems.push(`token moves too thin: ${l} ${moveLegs[l]} < floor ${MOVE_FLOORS[l]} (a thin run proves nothing)`);
}

// ── 5. parse differential ──────────────────────────────────────────────────────────────────────────
const PARSE_MUTATIONS = 20_000;
step(`parse differential: every Propose above, the record cases of codes.json, and ${PARSE_MUTATIONS} seeded mutations`);
{
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mulberry32(0x9a75e);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const recordCount = new Map();
  let accepted = 0, refused = 0, checked = 0;
  const check = (name, uri, payloadHash) => {
    checked++;
    const a = OLD.parseRecord(uri, payloadHash), b = NEW.parseRecord(uri, payloadHash);
    if ((a === null) !== (b === null) || (a !== null && JSON.stringify(a) !== JSON.stringify(b))) {
      bump("parseRecord");
      if (!smallestUri || uri.length < smallestUri.length) smallestUri = uri;
      if (diverged <= 20) console.error(`  PARSE DIVERGED ${name}: old ${a === null ? "null" : "record"} new ${b === null ? "null" : "record"} for ${uri}`);
    }
    if (b === null) refused++; else accepted++;
    if (typeof NEW.explainRecord === "function") {
      const x = NEW.explainRecord(uri, payloadHash);
      const agrees = x.ok ? (b !== null && JSON.stringify(x.record) === JSON.stringify(b)) : (b === null && OUTCOME?.[x.code] === "refused" && x.code.startsWith("RECORD_"));
      if (!agrees) { bump("explainRecord against parseRecord"); if (diverged <= 20) console.error(`  EXPLAIN DISAGREES ${name}: ${JSON.stringify(x)} vs parseRecord ${b === null ? "null" : "record"} for ${uri}`); }
      if (!x.ok) recordCount.set(x.code, (recordCount.get(x.code) ?? 0) + 1);
    }
  };
  for (const [i, p] of [...proposes.values()].entries()) check(`propose#${i}`, p.uri, p.payloadHash);
  if (codesVectors) for (const c of codesVectors.records) check(`codes.json:${c.name}`, c.uri, c.payloadHash);
  // Mutations of the valid records above: each sample re-canonicalised and re-hashed (most of the time) so the rules past
  // the canonical and hash gates are reached, with one to three edits from the classes the record rules check.
  const valid = [...proposes.values()].map((p) => OLD.parseRecord(p.uri, p.payloadHash)).filter((r) => r !== null);
  if (valid.length < 50) die(`only ${valid.length} valid records to mutate`);
  const KEYS = ["v", "t", "x", "memo", "ts", "salt", "min", "bid", "taker", "to", "amount", "ticker", "name", "give", "want", "p", "commit", "offer", "hash", "addr", "decimals", "supply", "mint", "mintLimit", "\u{10000}k"];
  const VALUES = [0, 1, -1, 1.5, 9007199254740993, 1e21, "", "x", "0", "1", "007", "1e3", "79228162514264337593543950335", "79228162514264337593543950336",
    "ADMIN", "admin", "csd", "-ab", "a".repeat(33), "AB", "ABCDEFGHIJKLM", "\uD800", "0x" + "ab".repeat(20), "0x" + "AB".repeat(20), "0x" + "ab".repeat(32), "00112233445566778899aabbccddeeff",
    null, true, [], {}, { value: "1" }, { ticker: "AAA", amount: "1" }, { name: "alice" }, { "x.y": "1" }];
  const TYPES = ["deploy", "mint", "transfer", "offer", "bid", "ocancel", "ncommit", "name", "nfinalize", "nxfer", "nset", "nrenew", "nprofile", "tmeta", "fclaim", "zzz"];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const edit = (o, depth) => {
    const keys = Object.keys(o);
    const k = pick(keys.length ? keys : ["x"]);
    const sub = o[k];
    switch (ri(0, 6)) {
      case 0: delete o[k]; break;
      case 1: o[pick(KEYS)] = clone(pick(VALUES)); break;
      case 2: o[k] = clone(pick(VALUES)); break;
      case 3: if (sub && typeof sub === "object" && !Array.isArray(sub) && depth < 2) edit(sub, depth + 1); else o[k] = clone(pick(VALUES)); break;
      case 4: o.t = pick(TYPES); break;
      case 5: o.v = pick([2, "1", 0, 1]); break;
      default: if (typeof sub === "string") o[k] = pick([sub.toUpperCase(), sub + "0", sub.slice(1), sub + "\uD800", sub.repeat(20)]); else o[k] = clone(pick(VALUES));
    }
  };
  const before = { accepted, refused };
  // A field replaced by another value its rule accepts, so about half the samples stay valid and a refactor that
  // refuses more is caught as surely as one that accepts more.
  const SAME_RULE = {
    ticker: ["ZZZ", "AB1", "TOKEN99"], amount: ["1", "12345", "79228162514264337593543950335"], value: ["0", "7", "100000000"],
    supply: ["1", "1000000"], mintLimit: ["1", "500"], min: ["1"], name: ["alice2", "a", "x-1", "z".repeat(32)],
    to: ["0x" + "cd".repeat(20)], payto: ["0x" + "cd".repeat(20)], taker: ["0x" + "cd".repeat(20)], addr: ["0x" + "00".repeat(20)],
    memo: ["", "hi", "é".repeat(64)], ts: [0, 5, 9007199254740991], salt: ["00112233445566778899aabbccddeeff", "A".repeat(128)],
    decimals: [0, 8], hash: ["0x" + "ef".repeat(32)], commit: ["0x" + "ef".repeat(32)], offer: ["0x" + "ef".repeat(32)],
    bid: ["0x" + "ef".repeat(32)], p: [{}, { url: "https://x" }, { "csd.p2p": "y" }],
  };
  const substitute = (o, depth) => {
    const keys = Object.keys(o).filter((k) => SAME_RULE[k] || (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])));
    if (!keys.length) return;
    const k = pick(keys);
    if (SAME_RULE[k]) o[k] = clone(pick(SAME_RULE[k]));
    else if (depth < 2) substitute(o[k], depth + 1);
  };
  for (let i = 0; i < PARSE_MUTATIONS; i++) {
    const r = clone(pick(valid));
    if (rnd() < 0.5) { for (let j = ri(1, 2); j > 0; j--) substitute(r, 0); }
    else for (let j = ri(1, 3); j > 0; j--) edit(r, 0);
    let uri, ph;
    try { uri = NEW.canonicalJson(r); ph = NEW.payloadHash(r); } catch { continue; }
    const damage = ri(0, 19);
    if (damage === 0) uri = uri + " ";                                   // not canonical
    else if (damage === 1) ph = ph.slice(0, -1) + (ph.endsWith("0") ? "1" : "0"); // another hash
    else if (damage === 2) uri = uri.replace(/^\{/, "{ ");               // not canonical, still JSON
    else if (damage === 3) ph = ph.toUpperCase();                        // the same hash in upper case
    check(`mutation#${i}`, uri, ph);
  }
  const mut = { accepted: accepted - before.accepted, refused: refused - before.refused };
  console.log(`  ${checked} records checked: ${accepted} accepted, ${refused} refused by the new build (the mutations: ${mut.accepted} accepted, ${mut.refused} refused)${typeof NEW.explainRecord === "function" ? "; explainRecord agrees with parseRecord on each" : ""}`);
  if (mut.accepted < 1_000 || mut.refused < 1_000) problems.push(`mutation corpus too thin: ${mut.accepted} accepted, ${mut.refused} refused (each needs 1,000)`);
  if (recordCount.size) console.log(`  record codes: ${[...recordCount].sort().map(([c, n]) => `${c} ${n}`).join(", ")}`);
  for (const [c, n] of recordCount) codeCount.set(c, (codeCount.get(c) ?? 0) + n);
}

// ── 6. client-surface differential (equal arguments on both sides) ─────────────────────────────────
step("client-surface differential: the same arguments on both sides, old vs new verdicts");
let surfChecks = 0;
{
  const eq = (name, a, b) => { surfChecks++; const sa = JSON.stringify(a, (_, v) => typeof v === "bigint" ? String(v) : v), sb = JSON.stringify(b, (_, v) => typeof v === "bigint" ? String(v) : v); if (sa !== sb) { bump("client surface"); console.error(`  SURFACE DIVERGED ${name}: old=${sa} new=${sb}`); } };
  const LEGS_OFF = { give: false, wantType: false };
  const H = 60_002;
  const A = "0x" + "a1".repeat(20), C = "0x" + "c3".repeat(20);
  const recCsd = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: A } };
  const recMin = { ...recCsd, min: "100000000" };
  const recTok = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5" } };
  const recName = { v: 1, t: "offer", give: { name: "gemname" }, want: { value: "500000000", payto: A }, taker: C, bid: "0x" + "bb".repeat(32) };
  for (const [rn, rec] of [["csd", recCsd], ["min", recMin], ["tok", recTok], ["name", recName]]) {
    for (const h of [29_000, 33_599, 33_600, 60_000]) {
      const to = OLD.provenOfferTerms(rec, h), tn = NEW.provenOfferTerms(rec, h);
      for (const f of ["height", "feeBps", "value", "taker", "bid", "min", "giveTicker", "giveAmount", "giveName", "wantType"]) eq(`provenOfferTerms(${rn},${h}).${f}`, to[f], tn[f]);
      const servedGrid = [
        rec, { ...rec, height: h, feeBps: OLD.feeBpsAt(h), want: rec.want }, { height: h, feeBps: OLD.feeBpsAt(h), want: { value: "500000000" } },
        { height: h + 1, feeBps: 0, want: { value: "1" }, taker: C, bid: "0xbb", min: "1" },
        { height: h, feeBps: OLD.feeBpsAt(h), want: { value: "500000000" }, min: "" }, {}, null,
      ];
      for (let i = 0; i < servedGrid.length; i++) {
        eq(`bindOfferTerms(${rn},${h},served#${i},default)`, OLD.bindOfferTerms(servedGrid[i], to), NEW.bindOfferTerms(servedGrid[i], tn));
        eq(`bindOfferTerms(${rn},${h},served#${i},legs off)`, OLD.bindOfferTerms(servedGrid[i], to, LEGS_OFF), NEW.bindOfferTerms(servedGrid[i], tn, LEGS_OFF));
      }
      // honest served shapes: the default legs accept them
      const honest = servedGrid[1];
      const honestVariants = [
        honest,
        { ...honest, give: { ...rec.give }, want: { ...rec.want } },
        { ...honest, taker: honest.taker ?? null, bid: honest.bid ?? null },
        { ...honest, ...(honest.taker ? { taker: honest.taker.toUpperCase() } : {}), ...(honest.bid ? { bid: honest.bid.toUpperCase() } : {}) },
        { ...honest, id: "0x" + "0e".repeat(32), seller: A, status: "open", expiresEpoch: 9e15, paid: "0", delivered: "0", fills: [] },
      ];
      for (let i = 0; i < honestVariants.length; i++) {
        surfChecks++;
        if (NEW.bindOfferTerms(honestVariants[i], tn) !== false) { bump("client surface"); console.error(`  DEFAULT LEGS OVER-REFUSE bindOfferTerms(${rn},${h},honest#${i})`); }
        eq(`bindOfferTerms(${rn},${h},honest#${i},default)`, OLD.bindOfferTerms(honestVariants[i], to), NEW.bindOfferTerms(honestVariants[i], tn));
      }
      // the default legs refuse every give or want-type lie on the honest shape; legs off keeps the two-leg verdict
      const giveLies = rec.give.name !== undefined
        ? [{ name: rec.give.name + "x" }, { ticker: "AAA", amount: "10" }, {}]
        : [{ ...rec.give, amount: String(BigInt(rec.give.amount) * 1_000_000n) }, { ...rec.give, ticker: rec.give.ticker + "X" }, { name: "gemname" }, { ticker: rec.give.ticker }];
      const wantLies = rec.want.ticker !== undefined ? [{ value: "500000000", payto: A }] : [];
      const lies = [...giveLies.map((g) => ({ ...honest, give: g })), ...wantLies.map((w) => ({ ...honest, want: w }))];
      for (let i = 0; i < lies.length; i++) {
        surfChecks++;
        if (NEW.bindOfferTerms(lies[i], tn) !== true) { bump("client surface"); console.error(`  DEFAULT LEG LOST bindOfferTerms(${rn},${h},lie#${i}) not refused by default`); }
        eq(`bindOfferTerms(${rn},${h},lie#${i},default)`, OLD.bindOfferTerms(lies[i], to), NEW.bindOfferTerms(lies[i], tn));
        eq(`bindOfferTerms(${rn},${h},lie#${i},legs off)`, OLD.bindOfferTerms(lies[i], to, LEGS_OFF), NEW.bindOfferTerms(lies[i], tn, LEGS_OFF));
      }
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
    eq(`claimWindowOf(${cu})`, OLD.claimWindowOf(cu), NEW.claimWindowOf(cu));
    eq(`claimWindowOf(${cu},fc)`, OLD.claimWindowOf(cu, "0xfc"), NEW.claimWindowOf(cu, "0xfc"));
    eq(`claimGraceOf(${cu})`, OLD.claimGraceOf(cu), NEW.claimGraceOf(cu));
    eq(`claimGraceOf(${cu},fc)`, OLD.claimGraceOf(cu, "0xfc"), NEW.claimGraceOf(cu, "0xfc"));
  }
  for (const h of [29_000, 29_960, 33_599, 33_600, 60_000]) eq(`feeBpsAt(${h})`, OLD.feeBpsAt(h), NEW.feeBpsAt(h));
  // the amount and name checks parseRecord reads, also exported on their own
  for (const s of ["0", "1", "007", "79228162514264337593543950335", "79228162514264337593543950336", "", "1e3", "-1", 5, null, undefined])
    for (const opts of [undefined, {}, { allowZero: false }, { allowZero: true }]) eq(`parseAmount(${String(s)},${JSON.stringify(opts)})`, OLD.parseAmount(s, opts), NEW.parseAmount(s, opts));
  for (const n of ["alice", "a", "a-1", "-a", "a-", "Alice", "admin", "csd", "x".repeat(32), "x".repeat(33), "", 5, null]) eq(`isName(${String(n)})`, OLD.isName(n), NEW.isName(n));
  console.log(`  ${surfChecks} client-surface checks (equal arguments; the default legs accept honest shapes and refuse each lie)`);
}

// ── 7. per-code count ──────────────────────────────────────────────────────────────────────────────
step("per-code count of the new build's log over every input of step 4 (record codes: step 5)");
{
  if (codeCount.size) console.log(`  ${[...codeCount].sort().map(([c, n]) => `${c} ${n}`).join("\n  ")}`);
  if (uncoded.size) console.log(`  entries without a code, by kind: ${[...uncoded].sort().map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (Array.isArray(NEW.REASON_CODES)) {
    const unreached = NEW.REASON_CODES.filter((c) => !codeCount.has(c));
    console.log(`  ${NEW.REASON_CODES.length - unreached.length} of ${NEW.REASON_CODES.length} codes reached; unreached: ${unreached.length ? unreached.join(", ") : "none"}`);
  }
}

for (const p of problems) console.error(`  ${p}`);
if (diverged || problems.length) {
  console.error(`  divergences by what differed: ${[...divergedBy].map(([w, n]) => `${w} ${n}`).join(", ")}`);
  if (smallest) console.error(`  smallest diverging resolve input: ${smallest.name} (${smallest.what}, ${smallest.n} event(s))`);
  if (smallestUri) console.error(`  shortest uri parseRecord disagrees on: ${smallestUri}`);
  die(`${diverged} divergence(s) between the ${BASELINE_REF} baseline and the tree${problems.length ? `, ${problems.length} other failure(s)` : ""}`);
}
console.log(`\nSEAL: resolve, parse and client surface identical to ${BASELINE_REF} (state byte for byte; the log once ${OLD_MOVES ? "`code` is" : "`code` and `moves` are"} left out)${CODE ? `; the whole result identical to ${CODE_BASELINE_REF} including \`code\`${CODE_MOVES ? "" : ", once `moves` is left out"}` : ""}; token moves pass the identity on ${movesSeen.inputs} inputs (${Object.entries(moveLegs).map(([l, n]) => `${l} ${n}`).join(", ")})`);

// ── 8. the real fork gate ──────────────────────────────────────────────────────────────────────────
if (process.env.SEAL_SKIP_CROSSLANG === "1") {
  console.log("SEAL: test:crosslang SKIPPED (SEAL_SKIP_CROSSLANG=1 - authoring iteration only, NEVER at the gate)");
  console.error("\nSEAL INCOMPLETE: steps 1-7 ran, but the crosslang fork gate did NOT. This run seals nothing; re-run without SEAL_SKIP_CROSSLANG before any bump/publish.");
  process.exit(3);
}
step("pnpm test:crosslang");
{
  const r = sh("pnpm", ["run", "test:crosslang"], { stdio: "inherit" });
  if (r.status !== 0) die("test:crosslang failed");
}

if (binds.length !== 2 * (CODE ? 2 : 1)) die(`${binds.length} bind outcomes for ${CODE ? 2 : 1} baseline(s): a baseline ran without a bind`);
for (const b of binds) console.log(`SEAL: bind ${b.line}`);
const unbound = binds.filter((b) => !b.bound).length;
console.log(`\nSEAL PASS: byte-identical ${BASELINE_REF} baseline differential + crosslang green; ${binds.length - unbound} of ${binds.length} baseline builds bound to npm${unbound ? `, ${unbound} NOT BOUND (not on npm)` : ""}. A bump/publish may proceed.`);
