#!/usr/bin/env node
// Release invariant (see CONSENSUS_CHANGES.md): packages are versioned on INDEPENDENT cadence —
// `cairnx-core` tracks consensus activation heights and bumps ahead of the stable `csd-*` primitives,
// which move on their own. They need NOT share a version. Coherence is instead guaranteed by two
// things, BOTH checked below: (1) every inter-package dependency is "workspace:*", which pnpm freezes
// to the publishing package's EXACT current version at publish time (no ^/~ ranges can ship, so a
// consumer can never resolve a mismatched pair); (2) the M4 dist-freshness check (published bytes come
// from current source). Cross-package byte-identity is enforced separately by the conformance job —
// CI's "REAL lockstep guard". Exits 1 with a report on violation.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkgsDir = join(root, "packages");
const pkgs = readdirSync(pkgsDir)
  .map((d) => {
    try { return Object.assign(JSON.parse(readFileSync(join(pkgsDir, d, "package.json"), "utf8")), { __dir: d }); }
    catch { return null; }
  })
  .filter(Boolean);

const errors = [];

// M4 (same-version/different-bytes provenance): the bytes a version publishes MUST come from its CURRENT
// source — the exact seam where the live indexer once ran node_modules bytes the npm version lacked. Guard:
// every package's built `dist/` must exist and be no older than its `src/`. Reject-loud (rebuild before publish).
const newestMs = (dir) => { let m = 0; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : (m = Math.max(m, statSync(p).mtimeMs)); } }; if (existsSync(dir)) walk(dir); return m; };
for (const p of pkgs) {
  const base = join(pkgsDir, p.__dir), distDir = join(base, "dist"), srcDir = join(base, "src");
  if (!existsSync(srcDir)) continue;
  if (!existsSync(distDir)) { errors.push(`${p.name}: no dist/ — run \`pnpm -r build\` before publish (M4)`); continue; }
  if (newestMs(distDir) + 1000 < newestMs(srcDir)) errors.push(`${p.name}: dist/ OLDER than src/ — rebuild so published bytes match source (M4)`);
}

// Independent cadence: packages need NOT share a version (cairnx-core bumps ahead on consensus
// heights). Coherence comes from the workspace:* check below — pnpm freezes each inter-dep to the
// exact published version — not from version-equality. Here we only sanity-check valid semver and
// surface the version map for review.
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
for (const p of pkgs) {
  if (!semver.test(String(p.version))) errors.push(`${p.name}: invalid semver version "${p.version}"`);
}

const ours = new Set(pkgs.map((p) => p.name));
for (const p of pkgs) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(p[field] ?? {})) {
      if (ours.has(dep) && range !== "workspace:*") {
        errors.push(`${p.name} ${field}.${dep} = "${range}" (must be "workspace:*")`);
      }
    }
  }
}

if (errors.length) {
  console.error("lockstep check FAILED:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`lockstep OK: ${pkgs.length} packages, inter-deps workspace:*, dist fresh (M4)`);
console.log("  versions: " + pkgs.map((p) => `${p.name.replace("@inversealtruism/", "")}@${p.version}`).join(", "));
