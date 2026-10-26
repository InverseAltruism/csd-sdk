// The workspace packages and their npm registry entries, read by check-lockstep.mjs and npm-window.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
 * The registry document of one published version: `{ status, meta }`, `meta` null unless the status is 200.
 * @param {string} name
 * @param {string} version
 * @returns {Promise<{ status: number, meta: any }>}
 */
export async function registryVersion(name, version) {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
  return { status: res.status, meta: res.ok ? await res.json() : null };
}
