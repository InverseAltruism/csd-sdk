// Compare a published npm tarball's dist/ with a local build, in memory (nothing from the tarball is written to
// disk or executed). Used by check-lockstep.mjs for every package version that is already on npm.
//
// untar accepts only what `pnpm pack` emits for these packages (checked 2026-10-19 on all 10 registry tarballs
// and fresh packs): POSIX ustar headers with a valid checksum, regular-file entries, all under `package/`.
// It refuses, rather than interprets, anything an installer could read differently from this reader: PAX
// extended headers, GNU long-name headers, links and other entry types, roots other than `package/`, paths
// with empty, `.` or `..` segments, absolute paths, backslashes, two entries with the same install path,
// and non-zero bytes after the end-of-archive block.
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

/**
 * The regular files of a gzipped ustar archive, keyed by path (`package/...`). Throws on anything outside the
 * rule in the header comment, so an unexpected archive fails the check instead of being compared partially.
 * @param {Uint8Array} tgz
 * @returns {Map<string, Uint8Array>}
 */
export function untar(tgz) {
  const buf = gunzipSync(tgz);
  const dec = new TextDecoder("utf-8", { fatal: true });
  /** @param {Uint8Array} b */
  const cstr = (b) => { const z = b.indexOf(0); return dec.decode(z < 0 ? b : b.subarray(0, z)); };
  /** @param {Uint8Array} b @param {string} what */
  const octal = (b, what) => {
    const t = cstr(b).trim();
    if (!/^[0-7]+$/.test(t)) throw new Error(`tar: bad ${what} field`);
    return parseInt(t, 8);
  };
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      if (!buf.subarray(off).every((b) => b === 0)) throw new Error("tar: data after the end-of-archive block");
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
    if (octal(h.subarray(148, 156), "checksum") !== sum) throw new Error("tar: header checksum mismatch");
    if (cstr(h.subarray(257, 263)) !== "ustar" || h[262] !== 0) throw new Error("tar: not a POSIX ustar header");
    const size = octal(h.subarray(124, 136), "size");
    const prefix = cstr(h.subarray(345, 500));
    const raw = prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100));
    const type = String.fromCharCode(h[156] ?? 0);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new Error(`tar: truncated entry ${raw}`);
    off += 512 + Math.ceil(size / 512) * 512;
    const isDir = type === "5";
    if (!isDir && type !== "0" && type !== "\0") throw new Error(`tar: entry type "${type}" (${raw}) is not a regular file or directory`);
    const path = isDir && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    const segs = path.split("/");
    if (path.includes("\\") || segs[0] !== "package" || (!isDir && segs.length < 2) || segs.some((g) => g === "" || g === "." || g === ".."))
      throw new Error(`tar: path ${JSON.stringify(raw)} is not a canonical path under package/`);
    if (seen.has(path)) throw new Error(`tar: two entries install to ${path}`);
    seen.add(path);
    if (!isDir) files.set(path, Uint8Array.from(body));
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
