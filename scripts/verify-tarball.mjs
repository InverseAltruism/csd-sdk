#!/usr/bin/env node
// The publish gate over the tarball itself: `npm publish <tgz>` runs no package hook, so publish-guard.mjs does not
// see these bytes. A tarball passes when, read with published-dist.mjs's reader (which refuses every archive shape
// `pnpm pack` does not emit):
//   - package/package.json names the tree's package and version, carries no "workspace:" specifier, pins each
//     workspace dependency at its current workspace version and every other dependency as the tree declares it,
//     keeps the tree's other fields, and keeps only scripts the tree declares with the same text;
//   - every other file equals the tree's file at the same path, and dist/ equals the tree's build file for file
//     (both directions);
//   - every `files` entry that exists in the tree is in the tarball.
// The pack is not byte-reproducible (published-dist.mjs says why), so files are compared, not a tarball hash.
//
// Usage: node scripts/verify-tarball.mjs <package dir> <tarball>      exit 0 = these bytes may be published
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffDist, untar } from "./published-dist.mjs";
import { workspacePackages } from "./workspace.mjs";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** @param {unknown} v @returns {string} JSON with object keys sorted, so key order does not count */
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/**
 * Why the tarball is not the package at `pkgDir` as pnpm would pack it; empty when it is.
 * @param {Uint8Array} tgz
 * @param {string} pkgDir
 * @param {Map<string, string>} versions every workspace package name -> its workspace version
 * @returns {string[]}
 */
export function verifyTarball(tgz, pkgDir, versions) {
  /** @type {Map<string, Uint8Array>} */
  let files;
  try { files = untar(tgz); } catch (e) { return [`unreadable tarball (${e instanceof Error ? e.message : e})`]; }
  const out = [];
  const tree = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const raw = files.get("package/package.json");
  if (!raw) return ["package/package.json is missing"];
  const text = new TextDecoder().decode(raw);
  if (text.includes("workspace:")) out.push("package.json carries a workspace: specifier");
  const packed = JSON.parse(text);
  if (packed.name !== tree.name || packed.version !== tree.version)
    out.push(`package.json is ${packed.name}@${packed.version}, the tree is ${tree.name}@${tree.version}`);
  for (const f of DEP_FIELDS) {
    const want = Object.fromEntries(Object.entries(tree[f] ?? {}).map(([d, spec]) =>
      [d, String(spec).startsWith("workspace:") ? versions.get(d) ?? `(no workspace package ${d})` : spec]));
    if (canon(packed[f] ?? {}) !== canon(want)) out.push(`package.json ${f} ${canon(packed[f] ?? {})}, expected ${canon(want)}`);
  }
  for (const [k, v] of Object.entries(packed.scripts ?? {}))
    if (tree.scripts?.[k] !== v) out.push(`package.json script "${k}" is not the tree's`);
  const rest = (/** @type {Record<string, unknown>} */ m) =>
    canon(Object.fromEntries(Object.entries(m).filter(([k]) => k !== "scripts" && !DEP_FIELDS.includes(k))));
  if (rest(packed) !== rest(tree)) out.push("package.json fields other than scripts and dependencies differ from the tree's");
  for (const [p, b] of files) {
    if (p === "package/package.json" || p.startsWith("package/dist/")) continue;
    const local = join(pkgDir, p.slice("package/".length));
    if (!existsSync(local)) out.push(`${p} is not in the tree`);
    else if (Buffer.compare(Buffer.from(b), readFileSync(local)) !== 0) out.push(`${p} differs from the tree's`);
  }
  out.push(...diffDist(files, join(pkgDir, "dist")));
  for (const f of tree.files ?? []) {
    if (!existsSync(join(pkgDir, f))) continue;
    if (![...files.keys()].some((p) => p === `package/${f}` || p.startsWith(`package/${f}/`))) out.push(`"files" entry ${f} is not in the tarball`);
  }
  return out;
}

/** Workspace name -> version for the repo at `root`. @param {string} root */
export const workspaceVersions = (root) => new Map(workspacePackages(root).map((p) => [p.name, p.version]));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [pkgDir, tgz] = process.argv.slice(2);
  if (!pkgDir || !tgz) { console.error("usage: node scripts/verify-tarball.mjs <package dir> <tarball>"); process.exit(2); }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fails = verifyTarball(new Uint8Array(readFileSync(tgz)), resolve(pkgDir), workspaceVersions(root));
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(fails.length ? `verify-tarball: ${tgz}: ${fails.length} failed, do not publish` : `verify-tarball: ${tgz}: OK`);
  process.exit(fails.length ? 1 : 0);
}
