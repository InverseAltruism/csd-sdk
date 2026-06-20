#!/usr/bin/env node
// Lockstep invariant (see CONSENSUS_CHANGES.md): every package in this workspace carries the
// SAME version, and every inter-package dependency is "workspace:*" (which pnpm converts to the
// exact version at publish time — no ^/~ ranges can ship). Exits 1 with a report on violation.
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

const versions = new Set(pkgs.map((p) => p.version));
if (versions.size !== 1) {
  errors.push(`version drift: ${pkgs.map((p) => `${p.name}@${p.version}`).join(", ")}`);
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
console.log(`lockstep OK: ${pkgs.length} packages all @${[...versions][0]}, inter-deps workspace:*`);
