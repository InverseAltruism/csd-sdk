#!/usr/bin/env node
// Release invariant (see CONSENSUS_CHANGES.md): packages are versioned on INDEPENDENT cadence:
// `cairnx-core` tracks consensus activation heights and bumps ahead of the stable `csd-*` primitives,
// which move on their own. They need NOT share a version. Coherence is checked below by: (1) every
// inter-package dependency is "workspace:*", which pnpm freezes to the dependency's EXACT current
// version when the dependent publishes; (2) the published graph: a package version already on npm
// keeps the pins it shipped with, so those pins must equal the current workspace versions (bump the
// dependent when its dependency moves); (3) the published dist: for each package whose workspace
// version is already on npm, the registry tarball's dist/ must equal this tree's build byte for byte,
// so changed source at a published version fails until the version is bumped. It catches that
// accident (one version, two code states); it is not a defence against a hostile registry: it never
// looks at a newly published version, and a tarball crafted to extract differently under npm is out
// of scope, though published-dist.mjs refuses every archive shape `pnpm pack` does not emit (its
// header says why a whole-tarball hash compare is not used); (4) the M4 dist-freshness check for versions
// not yet on npm: publish-guard runs this script and the package tests before prepack rebuilds, so
// those tests run on the dist that exists. Cross-package byte-identity is enforced separately by the conformance job,
// CI's "REAL lockstep guard". Exits 1 with a report on violation.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { integrityOk, untar, diffDist } from "./published-dist.mjs";

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
// source: the exact seam where the live indexer once ran node_modules bytes the npm version lacked. Guard:
// every package's built `dist/` must exist and be no older than its `src/`. Reject-loud (rebuild before publish).
const newestMs = (dir) => { let m = 0; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : (m = Math.max(m, statSync(p).mtimeMs)); } }; if (existsSync(dir)) walk(dir); return m; };
for (const p of pkgs) {
  const base = join(pkgsDir, p.__dir), distDir = join(base, "dist"), srcDir = join(base, "src");
  if (!existsSync(srcDir)) continue;
  if (!existsSync(distDir)) { errors.push(`${p.name}: no dist/; run \`pnpm -r build\` before publish (M4)`); continue; }
  if (newestMs(distDir) + 1000 < newestMs(srcDir)) errors.push(`${p.name}: dist/ OLDER than src/; rebuild so published bytes match source (M4)`);
}

// A package that keeps a CHANGELOG.md ships it: pnpm pack does not add it on its own, and a breaking
// release whose migration note is missing from the tarball leaves npm consumers without it.
for (const p of pkgs) {
  if (existsSync(join(pkgsDir, p.__dir, "CHANGELOG.md")) && !(p.files ?? []).includes("CHANGELOG.md"))
    errors.push(`${p.name}: CHANGELOG.md exists but is not in package.json "files", so the tarball omits it`);
}

// Independent cadence: packages need NOT share a version (cairnx-core bumps ahead on consensus
// heights). Coherence comes from the workspace:* check below (pnpm freezes each inter-dep to the
// exact published version), not from version-equality. Here we only sanity-check valid semver and
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

// Published graph: csd-crypto@0.1.15 shipped pinning csd-codec@0.1.15; codec then moved to 0.1.16
// without a crypto bump, so consumers resolved two codecs while every check above passed.
const workspaceVersion = new Map(pkgs.map((p) => [p.name, p.version]));
await Promise.all(pkgs.filter((p) => !p.private).map(async (p) => {
  const res = await fetch(`https://registry.npmjs.org/${p.name.replace("/", "%2f")}/${p.version}`);
  if (res.status === 404) return; // not published yet: pnpm pins the current workspace versions at publish
  if (!res.ok) { errors.push(`${p.name}@${p.version}: npm registry returned HTTP ${res.status}`); return; }
  const meta = await res.json();
  for (const [dep, pinned] of Object.entries(meta.dependencies ?? {})) {
    const current = workspaceVersion.get(dep);
    if (current !== undefined && pinned !== current) {
      errors.push(`${p.name}@${p.version} is published pinning ${dep}@${pinned}, workspace has ${current} (bump ${p.name})`);
    }
  }
  if (typeof meta.dist?.tarball !== "string") { errors.push(`${p.name}@${p.version}: registry metadata names no tarball`); return; }
  const tgz = await fetch(meta.dist.tarball);
  if (!tgz.ok) { errors.push(`${p.name}@${p.version}: tarball download returned HTTP ${tgz.status}`); return; }
  const bytes = new Uint8Array(await tgz.arrayBuffer());
  if (!integrityOk(bytes, meta.dist.integrity)) { errors.push(`${p.name}@${p.version}: tarball does not match the registry's sha512 integrity`); return; }
  let files;
  try { files = untar(bytes); } catch (e) { errors.push(`${p.name}@${p.version}: tarball unreadable (${e instanceof Error ? e.message : e})`); return; }
  for (const d of diffDist(files, join(pkgsDir, p.__dir, "dist"))) {
    errors.push(`${p.name}@${p.version}: ${d}; this tree builds different bytes at a published version (bump ${p.name})`);
  }
}));

if (errors.length) {
  console.error("lockstep check FAILED:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`lockstep OK: ${pkgs.length} packages, inter-deps workspace:*, published pins match workspace, published dist equals this build, dist fresh (M4)`);
console.log("  versions: " + pkgs.map((p) => `${p.name.replace("@inversealtruism/", "")}@${p.version}`).join(", "));
