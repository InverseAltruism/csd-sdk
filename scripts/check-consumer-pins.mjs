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
const CONSUMERS = [
  ["cairnx svc", "cairnx/package.json"],
  ["cairn-cli", "cairn-cli/package.json"],
];

console.log(`cairnx-core canonical version: ${canonical}`);
let bad = 0, seen = 0;
for (const [name, rel] of CONSUMERS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.log(`  • ${name}: not present — skip`); continue; }
  seen++;
  const dep = JSON.parse(readFileSync(p, "utf8")).dependencies?.["@inversealtruism/cairnx-core"];
  if (dep === canonical) console.log(`  ✓ ${name} pins cairnx-core ${dep}`);
  else { console.error(`  ✗ ${name} pins cairnx-core ${dep} != canonical ${canonical} — re-pin + reinstall + (svc) restart`); bad++; }
}
if (bad) { console.error(`\nconsumer-pin coherence FAILED (${bad}/${seen})`); process.exit(1); }
console.log(`\nconsumer-pin coherence OK (${seen} npm-pinning consumers). Bundled consumers (cairn UI, wallet) are guarded by their own vendor-freshness gates.`);

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
