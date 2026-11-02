#!/usr/bin/env node
// The publish gate over the tarball itself: `npm publish <tgz>` runs no package hook, so publish-guard.mjs does not
// see these bytes. A tarball passes when, read with published-dist.mjs's reader (which refuses every archive shape
// `pnpm pack` does not emit):
//   - package/package.json names the committed manifest's package and version (the package directory's
//     package.json at HEAD), carries no "workspace:" specifier, pins each workspace dependency at the version its
//     package.json at HEAD names (workspaceVersions) and every other dependency as that manifest declares it, keeps
//     its other fields, and keeps only scripts it declares with the same text;
//   - every other file outside dist/ is the HEAD commit's file at that path, byte for byte (`git ls-tree` and
//     `git cat-file`), so an ignored, untracked or skip-worktree file pnpm packed fails; dist/ equals the tree's
//     build file for file (both directions);
//   - every committed file a `files` entry covers is in the tarball, and an entry HEAD holds nothing under (dist)
//     that exists in the tree is in the tarball.
// The pack is not byte-reproducible (published-dist.mjs says why), so files are compared, not a tarball hash.
//
// Usage: node scripts/verify-tarball.mjs <package dir> <tarball>      exit 0 = these bytes may be published
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { headTree, readBlobs } from "./git-head.mjs";
import { diffDist, untar } from "./published-dist.mjs";
import { versionMap, workspacePackagesAtHead } from "./workspace.mjs";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** @param {unknown} v @returns {string} JSON with object keys sorted, so key order does not count */
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/**
 * Why the tarball is not the package at `pkgDir` as pnpm would pack it; empty when it is.
 * @param {Uint8Array} tgz
 * @param {string} pkgDir
 * @param {Map<string, string>} versions every workspace package name -> the version HEAD's manifest names
 * @returns {string[]}
 */
export function verifyTarball(tgz, pkgDir, versions) {
  /** @type {Map<string, Uint8Array>} */
  let files;
  try { files = untar(tgz); } catch (e) { return [`unreadable tarball (${e instanceof Error ? e.message : e})`]; }
  const out = [];
  const committed = headTree(pkgDir);
  const want = committed ? [...files.keys()].map((p) => p.slice("package/".length)).filter((r) => committed.has(r)) : [];
  if (committed && !want.includes("package.json") && committed.has("package.json")) want.push("package.json");
  const blobs = committed && readBlobs(pkgDir, want.map((r) => /** @type {string} */ (committed.get(r))));
  /** @type {Map<string, Buffer> | null} the HEAD bytes of every tarball path HEAD holds, and of package.json */
  const head = blobs ? new Map(want.map((r, i) => [r, /** @type {Buffer} */ (blobs[i])])) : null;
  if (!head) out.push("git cannot read the package at HEAD, so the tarball cannot be checked against the commit");
  else if (!head.has("package.json")) out.push("package.json is not in the commit (HEAD)");
  const tree = JSON.parse((head?.get("package.json") ?? readFileSync(join(pkgDir, "package.json"))).toString("utf8"));
  const raw = files.get("package/package.json");
  if (!raw) return ["package/package.json is missing"];
  const text = new TextDecoder().decode(raw);
  if (text.includes("workspace:")) out.push("package.json carries a workspace: specifier");
  const packed = JSON.parse(text);
  if (packed.name !== tree.name || packed.version !== tree.version)
    out.push(`package.json is ${packed.name}@${packed.version}, the commit's is ${tree.name}@${tree.version}`);
  for (const f of DEP_FIELDS) {
    const want = Object.fromEntries(Object.entries(tree[f] ?? {}).map(([d, spec]) =>
      [d, String(spec).startsWith("workspace:") ? versions.get(d) ?? `(no workspace package ${d})` : spec]));
    if (canon(packed[f] ?? {}) !== canon(want)) out.push(`package.json ${f} ${canon(packed[f] ?? {})}, expected ${canon(want)}`);
  }
  for (const [k, v] of Object.entries(packed.scripts ?? {}))
    if (tree.scripts?.[k] !== v) out.push(`package.json script "${k}" is not the commit's`);
  const rest = (/** @type {Record<string, unknown>} */ m) =>
    canon(Object.fromEntries(Object.entries(m).filter(([k]) => k !== "scripts" && !DEP_FIELDS.includes(k))));
  if (rest(packed) !== rest(tree)) out.push("package.json fields other than scripts and dependencies differ from the commit's");
  for (const [p, b] of files) {
    if (!head || p === "package/package.json" || p.startsWith("package/dist/")) continue;
    const bytes = head.get(p.slice("package/".length));
    if (!bytes) out.push(`${p} is not in the commit (HEAD): an ignored or untracked file`);
    else if (Buffer.compare(Buffer.from(b), bytes) !== 0) out.push(`${p} differs from the commit's (HEAD)`);
  }
  out.push(...diffDist(files, join(pkgDir, "dist")));
  for (const entry of tree.files ?? []) {
    const f = String(entry).replace(/\/+$/, "");
    const under = committed ? [...committed.keys()].filter((r) => r === f || r.startsWith(`${f}/`)) : [];
    // the other direction: every committed file a "files" entry covers ships (one deleted on disk under
    // skip-worktree would not); an entry HEAD holds nothing under (dist/, a build output) must still ship something
    for (const r of under) if (!files.has(`package/${r}`)) out.push(`package/${r} is in the commit (HEAD) but not in the tarball`);
    if (!under.length && existsSync(join(pkgDir, f)) && ![...files.keys()].some((p) => p === `package/${f}` || p.startsWith(`package/${f}/`)))
      out.push(`"files" entry ${f} is not in the tarball`);
  }
  return out;
}

/** Workspace name -> the version HEAD's manifest names, for the repo at `root`; throws when git cannot read HEAD.
 *  @param {string} root */
export const workspaceVersions = (root) => versionMap(workspacePackagesAtHead(root));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [pkgDir, tgz] = process.argv.slice(2);
  if (!pkgDir || !tgz) { console.error("usage: node scripts/verify-tarball.mjs <package dir> <tarball>"); process.exit(2); }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fails = verifyTarball(new Uint8Array(readFileSync(tgz)), resolve(pkgDir), workspaceVersions(root));
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(fails.length ? `verify-tarball: ${tgz}: ${fails.length} failed, do not publish` : `verify-tarball: ${tgz}: OK`);
  process.exit(fails.length ? 1 : 0);
}
