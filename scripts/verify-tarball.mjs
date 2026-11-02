#!/usr/bin/env node
// The publish gate over the tarball itself: `npm publish <tgz>` runs no package hook, so publish-guard.mjs does not
// see these bytes. A tarball passes when, read with published-dist.mjs's reader (which refuses every archive shape
// `pnpm pack` does not emit):
//   - package/package.json names the committed manifest's package and version (the package directory's
//     package.json at HEAD), carries no "workspace:" specifier, pins each workspace dependency at its current
//     workspace version and every other dependency as that manifest declares it, keeps its other fields, and keeps
//     only scripts it declares with the same text;
//   - every other file outside dist/ is the HEAD commit's file at that path, byte for byte (`git ls-tree` and
//     `git cat-file`), so an ignored, untracked or skip-worktree file pnpm packed fails; dist/ equals the tree's
//     build file for file (both directions);
//   - every `files` entry that exists in the tree is in the tarball.
// The pack is not byte-reproducible (published-dist.mjs says why), so files are compared, not a tarball hash.
//
// Usage: node scripts/verify-tarball.mjs <package dir> <tarball>      exit 0 = these bytes may be published
import { execFileSync } from "node:child_process";
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
 * The HEAD commit's regular files among `rels` (paths relative to `pkgDir`): path -> bytes, a path HEAD lacks absent.
 * null when git cannot read HEAD there (not a checkout, no commit, git missing): the caller refuses the tarball.
 * @param {string} pkgDir @param {string[]} rels @returns {Map<string, Buffer> | null}
 */
function headFiles(pkgDir, rels) {
  /** @param {string[]} args @param {string} [input] */
  const git = (args, input) => execFileSync("git", args, { cwd: pkgDir, input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
  /** @type {Map<string, string>} */
  const oids = new Map();
  try {
    for (const e of git(["ls-tree", "-r", "-z", "HEAD", "--", "."]).toString("utf8").split("\0")) {
      const m = /^(?:100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(e);
      if (m) oids.set(/** @type {string} */ (m[2]), /** @type {string} */ (m[1]));
    }
  } catch {
    return null;
  }
  const want = rels.filter((r) => oids.has(r));
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  if (!want.length) return out;
  let raw;
  try { raw = git(["cat-file", "--batch"], want.map((r) => oids.get(r)).join("\n") + "\n"); } catch { return null; }
  let at = 0;
  for (const r of want) {   // each answer is "<oid> blob <size>\n<bytes>\n", in request order
    const nl = raw.indexOf(10, at);
    const [oid, type, size] = raw.subarray(at, nl).toString("utf8").split(" ");
    if (oid !== oids.get(r) || type !== "blob") return null;
    out.set(r, raw.subarray(nl + 1, nl + 1 + Number(size)));
    at = nl + 2 + Number(size);
  }
  return out;
}

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
  const rels = [...files.keys()].filter((p) => !p.startsWith("package/dist/")).map((p) => p.slice("package/".length));
  const head = headFiles(pkgDir, rels.includes("package.json") ? rels : [...rels, "package.json"]);
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
    const committed = head.get(p.slice("package/".length));
    if (!committed) out.push(`${p} is not in the commit (HEAD): an ignored or untracked file`);
    else if (Buffer.compare(Buffer.from(b), committed) !== 0) out.push(`${p} differs from the commit's (HEAD)`);
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
