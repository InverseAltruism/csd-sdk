// Reads of the HEAD commit, which is what a release publishes. The working copy can differ from HEAD while
// `git status` is clean (ignored files, skip-worktree and assume-unchanged entries), so release checks read HEAD.
import { execFileSync } from "node:child_process";

/** @param {string} cwd @param {string[]} args @param {string} [input] */
const git = (cwd, args, input) => execFileSync("git", args, { cwd, input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });

/**
 * The regular files of HEAD under `dir`: path relative to `dir` -> blob id. null when git cannot read HEAD there
 * (not a checkout, no commit, git missing).
 * @param {string} dir @returns {Map<string, string> | null}
 */
export function headTree(dir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  try {
    for (const e of git(dir, ["ls-tree", "-r", "-z", "HEAD", "--", "."]).toString("utf8").split("\0")) {
      const m = /^(?:100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(e);
      if (m) out.set(/** @type {string} */ (m[2]), /** @type {string} */ (m[1]));
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * The bytes of each blob id, in order (one `git cat-file --batch`); null when git cannot read one.
 * @param {string} dir @param {string[]} oids @returns {Buffer[] | null}
 */
export function readBlobs(dir, oids) {
  if (!oids.length) return [];
  let raw;
  try { raw = git(dir, ["cat-file", "--batch"], oids.join("\n") + "\n"); } catch { return null; }
  /** @type {Buffer[]} */
  const out = [];
  let at = 0;
  for (const want of oids) {   // each answer is "<oid> blob <size>\n<bytes>\n", in request order
    const nl = raw.indexOf(10, at);
    const [oid, type, size] = raw.subarray(at, nl).toString("utf8").split(" ");
    if (oid !== want || type !== "blob") return null;
    out.push(raw.subarray(nl + 1, nl + 1 + Number(size)));
    at = nl + 2 + Number(size);
  }
  return out;
}
