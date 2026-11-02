// The workspace packages and their npm registry entries, read by check-lockstep.mjs, npm-window.mjs and
// verify-tarball.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { headTree, readBlobs } from "./git-head.mjs";

export const REGISTRY = "https://registry.npmjs.org";

/**
 * Every packages/<dir>/package.json under `root`, parsed, with `__dir` set to <dir>. A directory without a readable
 * package.json is skipped.
 * @param {string} root
 * @returns {Array<Record<string, any> & { __dir: string }>}
 */
export function workspacePackages(root) {
  const pkgsDir = join(root, "packages");
  /** @type {Array<Record<string, any> & { __dir: string }>} */
  const out = [];
  for (const d of readdirSync(pkgsDir)) {
    let p;
    try { p = JSON.parse(readFileSync(join(pkgsDir, d, "package.json"), "utf8")); }
    catch { continue; } // not a package directory
    out.push(Object.assign(p, { __dir: d }));
  }
  return out;
}

/**
 * Every packages/<dir>/package.json of the HEAD commit, parsed, with `__dir` set to <dir>: the manifests a release
 * publishes, whatever the working copy holds. Throws when git cannot read HEAD under packages/.
 * @param {string} root
 * @returns {Array<Record<string, any> & { __dir: string }>}
 */
export function workspacePackagesAtHead(root) {
  const pkgsDir = join(root, "packages");
  const tree = headTree(pkgsDir);
  const rels = tree ? [...tree.keys()].filter((r) => /^[^/]+\/package\.json$/.test(r)) : [];
  const blobs = tree && readBlobs(pkgsDir, rels.map((r) => /** @type {string} */ (tree.get(r))));
  if (!blobs) throw new Error(`git cannot read the workspace manifests at HEAD under ${pkgsDir}`);
  return rels.map((r, i) => Object.assign(JSON.parse(/** @type {Buffer} */ (blobs[i]).toString("utf8")), { __dir: r.split("/")[0] }));
}

/** Package name -> version. @param {Array<Record<string, any>>} pkgs @returns {Map<string, string>} */
export const versionMap = (pkgs) => new Map(pkgs.map((p) => [p.name, p.version]));

/**
 * The registry document of one published version: `{ status, meta }`, `meta` null unless the status is 200.
 * @param {string} name
 * @param {string} version
 * @returns {Promise<{ status: number, meta: any }>}
 */
export async function registryVersion(name, version) {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
  return { status: res.status, meta: res.ok ? await res.json() : null };
}
