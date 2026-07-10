#!/usr/bin/env node
// Cross-repo pin-coherence guard (shared-core de-dup, cairn docs/Plans/46 — audit Batch-3).
//
// cairnx-core is the single source of the CairnX convention; every consumer must pin the SAME published
// version (or carry a vendored bundle of it). The within-csd-sdk check-lockstep.mjs cannot see the sibling
// consumer repos, so this best-effort check asserts they agree. Run from the csd-sdk repo with the sibling
// repos checked out under the same parent (the dev/host layout). Skips any repo that isn't present.
//
//   node scripts/check-consumer-pins.mjs        # exit 1 if a consumer pins a different cairnx-core
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL("..", import.meta.url).pathname, ".."); // parent of csd-sdk (siblings live here)
const canonical = JSON.parse(readFileSync(join(ROOT, "csd-sdk/packages/cairnx/package.json"), "utf8")).version;

// consumers that pin cairnx-core directly via npm (the bundled consumers — cairn UI / cairn-wallet — carry a
// vendored esbuild instead and are guarded by their own check-vendor-fresh + PROVENANCE, not a pin).
// Tiers (Plans/68 D3): "strict" = any pin mismatch is fatal (live replayers and their operator CLI must
// never lag at all). "graded" = a lag is fatal ONLY when the pinned-version..canonical diff touches the
// consensus surface (packages/cairnx/src/{resolve,records,types}.ts — the bytes a replayer derives state
// from); a helpers-only lag (preflight/primary/client-selector logic) is an ADVISORY nudge, because the
// lagging consumer still computes byte-identical canonical state. Grading needs the cairnx-core-<ver> tag
// to compute the diff; an unknown pinned version fails CLOSED (fatal) rather than guessing.
const CONSUMERS = [
  ["cairnx svc", "cairnx/package.json", "strict"],
  ["cairn-cli", "cairn-cli/package.json", "strict"],
  ["cairn-sdk", "cairn-sdk/package.json", "graded"],
  ["clarvis", "clarvis/package.json", "graded"], // second-source resolver; usually on its own host — skips here
];

const { execSync } = await import("node:child_process");
const SDK = join(ROOT, "csd-sdk");
const CONSENSUS_SURFACE = ["packages/cairnx/src/resolve.ts", "packages/cairnx/src/records.ts", "packages/cairnx/src/types.ts"];
/** "" when ver..HEAD leaves the consensus surface untouched; a --stat summary when it drifted; null when unknowable. */
function consensusDrift(ver) {
  // ver comes from a sibling package.json (trusted), but guard the shape anyway before it reaches a
  // shell tag ref: anything but an exact semver is treated as unknowable (fail-closed to fatal drift).
  if (!/^\d+\.\d+\.\d+$/.test(String(ver))) return null;
  try {
    return execSync(`git -C ${SDK} diff cairnx-core-${ver} HEAD --stat -- ${CONSENSUS_SURFACE.join(" ")}`, { encoding: "utf8" }).trim();
  } catch { return null; }
}

console.log(`cairnx-core canonical version: ${canonical}`);
let bad = 0, seen = 0, advis = 0;
for (const [name, rel, tier] of CONSUMERS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.log(`  • ${name}: not present — skip`); continue; }
  seen++;
  const dep = JSON.parse(readFileSync(p, "utf8")).dependencies?.["@inversealtruism/cairnx-core"];
  if (dep === canonical) { console.log(`  ✓ ${name} pins cairnx-core ${dep}`); continue; }
  if (tier === "graded") {
    const drift = consensusDrift(dep);
    if (drift === "") { console.warn(`  ⚠ ${name} pins cairnx-core ${dep} != canonical ${canonical} — helpers-only lag (consensus surface identical); re-pin when convenient`); advis++; continue; }
    if (drift === null) { console.error(`  ✗ ${name} pins cairnx-core ${dep} — UNKNOWN version (no cairnx-core-${dep} tag to grade against) — treat as drift, re-pin`); bad++; continue; }
    console.error(`  ✗ ${name} pins cairnx-core ${dep} != canonical ${canonical} — CONSENSUS-SURFACE DRIFT, a live replayer on it forks:\n${drift.split("\n").map((l) => "      " + l).join("\n")}`);
    bad++; continue;
  }
  console.error(`  ✗ ${name} pins cairnx-core ${dep} != canonical ${canonical} — re-pin + reinstall + (svc) restart`); bad++;
}
if (bad) { console.error(`\nconsumer-pin coherence FAILED (${bad}/${seen})`); process.exit(1); }
console.log(`\nconsumer-pin coherence OK (${seen} npm-pinning consumers${advis ? `, ${advis} advisory helpers-only lag` : ""}). Bundled consumers (cairn UI, wallet) are guarded by their own vendor-freshness gates.`);

// ── ADVISORY (never fails the run): vendored-consumer lag. The wallet/cairn PROVENANCE pins a
// csd-sdk commit; their freshness gates prove the bundle matches THAT commit, but nothing says how
// far behind HEAD it sits. Re-vendoring is deliberate (release-gated), so this only WARNS when the
// pinned commit is older than ~14 days of csd-sdk history — a nudge, not a gate.
const STALE_DAYS = 14;
for (const [name, rel] of [["cairn-wallet", "cairn-wallet/src/vendor/PROVENANCE.json"], ["cairn UI", "cairn/public/vendor/PROVENANCE.json"]]) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.log(`  • ${name}: no PROVENANCE — skip`); continue; }
  try {
    const commit = JSON.parse(readFileSync(p, "utf8")).csdSdkCommit;
    const { execSync } = await import("node:child_process");
    const sdk = join(ROOT, "csd-sdk");
    const at = Number(execSync(`git -C ${sdk} log -1 --format=%ct ${commit}`, { encoding: "utf8" }).trim()) * 1000;
    const head = Number(execSync(`git -C ${sdk} log -1 --format=%ct HEAD`, { encoding: "utf8" }).trim()) * 1000;
    const lagDays = Math.floor((head - at) / 86_400_000);
    if (lagDays > STALE_DAYS) console.warn(`  ⚠ ${name} vendors csd-sdk ${String(commit).slice(0, 12)} — ${lagDays} days behind HEAD (advisory; re-vendor when convenient)`);
    else console.log(`  ✓ ${name} vendor commit is ${lagDays}d behind HEAD (fresh enough)`);
  } catch (e) { console.log(`  • ${name}: lag check skipped (${e?.message?.split("\n")[0] ?? e})`); }
}
