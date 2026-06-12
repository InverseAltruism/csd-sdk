#!/usr/bin/env node
// Lockstep invariant (see CONSENSUS_CHANGES.md): every package in this workspace carries the
// SAME version, and every inter-package dependency is "workspace:*" (which pnpm converts to the
// exact version at publish time — no ^/~ ranges can ship). Exits 1 with a report on violation.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkgsDir = join(root, "packages");
const pkgs = readdirSync(pkgsDir)
  .map((d) => {
    try { return JSON.parse(readFileSync(join(pkgsDir, d, "package.json"), "utf8")); }
    catch { return null; }
  })
  .filter(Boolean);

const errors = [];
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
