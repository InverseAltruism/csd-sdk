// Compare a published npm tarball's dist/ with a local build, in memory (nothing from the tarball is written to
// disk or executed). Used by check-lockstep.mjs for every package version that is already on npm.
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
 * The regular files of a gzipped tar, keyed by path. Throws on links, devices and any entry type it does not
 * know, so an unexpected archive fails the check instead of being compared partially.
 * @param {Uint8Array} tgz
 * @returns {Map<string, Uint8Array>}
 */
export function untar(tgz) {
  const buf = gunzipSync(tgz);
  const dec = new TextDecoder();
  /** @param {Uint8Array} b */
  const cstr = (b) => { const z = b.indexOf(0); return dec.decode(z < 0 ? b : b.subarray(0, z)); };
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {string | null} */
  let nextName = null;
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if ((h[124] ?? 0) & 0x80) throw new Error("tar: base-256 size field not supported");
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("tar: bad size field");
    const posix = cstr(h.subarray(257, 263)) === "ustar" && h[262] === 0;
    const prefix = posix ? cstr(h.subarray(345, 500)) : "";
    const name = nextName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
    nextName = null;
    const type = String.fromCharCode(h[156] ?? 0);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new Error(`tar: truncated entry ${name}`);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "0" || type === "\0") files.set(name, Uint8Array.from(body));
    else if (type === "5" || type === "g") continue;
    else if (type === "L") nextName = cstr(body);
    else if (type === "x") nextName = paxPath(dec.decode(body));
    else throw new Error(`tar: entry type "${type}" (${name}) is not a regular file or directory`);
  }
  return files;
}

/** @param {string} pax */
function paxPath(pax) {
  for (const rec of pax.split("\n")) {
    const m = /^\d+ path=(.*)$/.exec(rec);
    if (m) return m[1] ?? null;
  }
  return null;
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
