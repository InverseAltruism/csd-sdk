// Compare a published npm tarball's dist/ with a local build, in memory (nothing from the tarball is written to
// disk or executed). Used by check-lockstep.mjs for every package version that is already on npm.
//
// What the check detects: a published version whose dist/ differs from this tree's build of the same version
// (one version, two code states, the M4 accident class). What it does not: a hostile tarball crafted so that
// npm's extraction differs from this reader, and any newly published version (only versions equal to the
// workspace version are examined, so an attacker who can publish would publish a new one). The reader refuses
// every archive shape `pnpm pack` does not emit for these packages (checked 2026-10-19 on all 10 registry
// tarballs and fresh packs): each header is POSIX ustar ("ustar\0" + "00"), type "0", printable-ASCII name of
// at most 100 bytes with no prefix and no linkname, an 11-digit octal size and a 6-digit octal checksum in
// their canonical terminations; every path is under package/, canonical, and unique when compared
// case-insensitively (directory components included; names are ASCII, so no two Unicode spellings of one
// path can occur); only zeros follow the end-of-archive block. A whole-tarball sha512 compare is not used because pnpm 10.32.1 orders the packed
// package.json "dependencies" by which workspace:* resolution finishes first: packs of csd-tx matched the
// registry 11 times in 15, csd-registry 3 in 10, csd-siwc and csd-light 9 in 10 (2026-10-19).
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * True when `bytes` match the registry's `dist.integrity` (an SRI "sha512-<base64>" string).
 * @param {Uint8Array} bytes
 * @param {unknown} integrity
 */
export function integrityOk(bytes, integrity) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity ?? ""));
  return m !== null && createHash("sha512").update(bytes).digest("base64") === m[1];
}

/** @param {Uint8Array} b */
const latin1 = (b) => Array.from(b, (c) => String.fromCharCode(c)).join("");
/** @param {Uint8Array} b */
const allZero = (b) => b.every((c) => c === 0);

/**
 * The regular files of a gzipped ustar archive, keyed by path (`package/...`). Throws on anything outside the
 * rule in the header comment, so an unexpected archive fails the check instead of being compared partially.
 * @param {Uint8Array} tgz
 * @returns {Map<string, Uint8Array>}
 */
export function untar(tgz) {
  const buf = gunzipSync(tgz);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {Set<string>} */
  const fileKeys = new Set();
  /** @type {Set<string>} */
  const dirKeys = new Set();
  const key = (/** @type {string} */ p) => p.toLowerCase();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (allZero(h)) {
      if (!allZero(buf.subarray(off))) throw new Error("tar: data after the end-of-archive block");
      break;
    }
    if (latin1(h.subarray(257, 265)) !== "ustar\u000000") throw new Error("tar: not a POSIX ustar header (magic and version)");
    const ck = latin1(h.subarray(148, 156));
    if (!/^[0-7]{6}(\0 | \0)$/.test(ck)) throw new Error("tar: checksum field not in canonical form");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
    if (parseInt(ck.slice(0, 6), 8) !== sum) throw new Error("tar: header checksum mismatch");
    const sz = latin1(h.subarray(124, 136));
    if (!/^[0-7]{11}[ \0]$/.test(sz)) throw new Error("tar: size field not in canonical form");
    const size = parseInt(sz.slice(0, 11), 8);
    const nameField = h.subarray(0, 100);
    const nul = nameField.indexOf(0);
    const nameBytes = nul < 0 ? nameField : nameField.subarray(0, nul);
    if (nul >= 0 && !allZero(nameField.subarray(nul))) throw new Error("tar: bytes after the name terminator");
    if (!nameBytes.length || !nameBytes.every((c) => c >= 0x20 && c <= 0x7e)) throw new Error("tar: name is not printable ASCII");
    const path = latin1(nameBytes);
    if (!allZero(h.subarray(345, 500))) throw new Error(`tar: ${path}: a name prefix is not emitted by pnpm pack`);
    const type = String.fromCharCode(h[156] ?? 0);
    if (type !== "0") throw new Error(`tar: entry type "${type}" (${path}) is not a regular file`);
    if (!allZero(h.subarray(157, 257))) throw new Error(`tar: ${path}: a linkname on a regular file`);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new Error(`tar: truncated entry ${path}`);
    off += 512 + Math.ceil(size / 512) * 512;
    const segs = path.split("/");
    if (path.includes("\\") || segs[0] !== "package" || segs.length < 2 || segs.some((g) => g === "" || g === "." || g === ".."))
      throw new Error(`tar: path ${JSON.stringify(path)} is not a canonical path under package/`);
    const k = key(path);
    if (fileKeys.has(k) || dirKeys.has(k)) throw new Error(`tar: two entries install to ${path} (compared case-insensitively)`);
    for (let i = 1; i < segs.length; i++) {
      const d = key(segs.slice(0, i).join("/"));
      if (fileKeys.has(d)) throw new Error(`tar: ${path} collides with a file at a directory component`);
      dirKeys.add(d);
    }
    fileKeys.add(k);
    files.set(path, Uint8Array.from(body));
  }
  return files;
}

/**
 * Differences between the tarball's `package/dist/` files and a local `dist/` directory, one line each.
 * Empty means byte-identical file sets.
 * @param {Map<string, Uint8Array>} tarFiles
 * @param {string} distDir
 * @returns {string[]}
 */
export function diffDist(tarFiles, distDir) {
  const PREFIX = "package/dist/";
  /** @type {Map<string, Uint8Array>} */
  const published = new Map();
  for (const [p, b] of tarFiles) if (p.startsWith(PREFIX)) published.set(p.slice(PREFIX.length), b);
  /** @type {Map<string, Uint8Array>} */
  const local = new Map();
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else local.set(r, readFileSync(join(dir, e.name)));
    }
  };
  if (existsSync(distDir)) walk(distDir, "");
  /** @type {string[]} */
  const out = [];
  for (const [p, b] of published) {
    const l = local.get(p);
    if (!l) out.push(`dist/${p} is published but missing from the local build`);
    else if (Buffer.compare(Buffer.from(b), Buffer.from(l)) !== 0) out.push(`dist/${p} differs from the local build`);
  }
  for (const p of local.keys()) if (!published.has(p)) out.push(`dist/${p} is in the local build but not published`);
  return out.sort();
}
