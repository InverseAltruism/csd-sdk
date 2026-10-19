// Offline checks of the published-dist comparison check-lockstep.mjs runs against npm tarballs. Honest inputs: a
// real registry tarball (test/fixtures/npm-csd-crypto-0.1.18.tgz, verbatim from npm), archives from the in-memory
// writer below in the exact header form `pnpm pack` emits, and a system-tar ustar archive of plain files. Hostile
// inputs are built in memory, one per archive shape an installer could read differently from untar.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { integrityOk, untar, diffDist } from "../scripts/published-dist.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const throws = (n: string, f: () => unknown, re: RegExp) => { let m = ""; try { f(); } catch (e) { m = String(e instanceof Error ? e.message : e); } ok(n, re.test(m)); };

// ── in-memory ustar writer (fixtures only); defaults are pnpm pack's header form ──
type Entry = {
  name: string | Uint8Array; body?: string; type?: string; prefix?: string; linkname?: string;
  magic?: string; size?: string; checksum?: (sum: number) => string;
};
const enc = new TextEncoder();
function header(e: Entry, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string | Uint8Array, at: number) => h.set(typeof s === "string" ? Uint8Array.from(s, (c) => c.charCodeAt(0)) : s, at);
  put(e.name, 0); put("000644 \0", 100); put("000000 \0", 108); put("000000 \0", 116);
  put(e.size ?? size.toString(8).padStart(11, "0") + " ", 124); put("05302443100 ", 136);
  put(e.type ?? "0", 156); if (e.linkname) put(e.linkname, 157);
  put(e.magic ?? "ustar\u000000", 257); if (e.prefix) put(e.prefix, 345);
  put("        ", 148);
  const sum = h.reduce((a, b) => a + b, 0);
  put((e.checksum ?? ((s: number) => s.toString(8).padStart(6, "0") + " \0"))(sum), 148);
  return h;
}
function tgz(entries: Entry[], trailer: Uint8Array = new Uint8Array(1024)): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const body = enc.encode(e.body ?? "");
    parts.push(header(e, body.length), body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  parts.push(trailer);
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}
const pax = (records: [string, string][]): string =>
  records.map(([k, v]) => { const r = ` ${k}=${v}\n`; let n = r.length + 1; while (String(n).length + r.length !== n) n++; return `${n}${r}`; }).join("");

const work = mkdtempSync(join(tmpdir(), "published-dist-"));
const pkgDir = join(work, "pkg");
mkdirSync(join(pkgDir, "package", "dist", "mm"), { recursive: true });
writeFileSync(join(pkgDir, "package", "README.md"), "readme\n");
writeFileSync(join(pkgDir, "package", "dist", "index.js"), "export const x = 1;\n");
writeFileSync(join(pkgDir, "package", "dist", "mm", "index.d.ts"), "export declare const y: 2;\n");
const FILES = ["package/README.md", "package/dist/index.js", "package/dist/mm/index.d.ts"];
// Plain files only, as pnpm pack does (no directory entries).
const pack = (format: string, dir = pkgDir, files = FILES): Uint8Array => {
  const out = join(work, `${format}.tgz`);
  execFileSync("tar", [`--format=${format}`, "--no-recursion", "-czf", out, "-C", dir, ...files]);
  return new Uint8Array(readFileSync(out));
};
const localDist = (): string => { const d = mkdtempSync(join(work, "local-")); cpSync(join(pkgDir, "package", "dist"), d, { recursive: true }); return d; };
const HONEST: Entry[] = [{ name: "package/package.json", body: "{}" }, { name: "package/dist/index.js", body: "export const x = 1;\n" }];

try {
  console.log("honest archives:");
  const reg = new Uint8Array(readFileSync(new URL("./fixtures/npm-csd-crypto-0.1.18.tgz", import.meta.url)));
  ok("the npm csd-crypto 0.1.18 tarball matches its registry sha512",
    integrityOk(reg, "sha512-uTCkPg1fmgDKC0N+jOvCwU86pfeES85ncrurbP7JDjbMjjMyTo5/8iqT7kOSwR2B9a2JhSL0JTAEZYOQCabxXg=="));
  const regFiles = untar(reg);
  ok("the npm tarball reads: package.json and dist/index.js present", regFiles.has("package/package.json") && regFiles.has("package/dist/index.js"));
  const sys = pack("ustar");
  ok("system-tar ustar of plain files reads with the right names", JSON.stringify([...untar(sys).keys()].sort()) === JSON.stringify([...FILES].sort()));
  ok("system-tar ustar: bytes intact", new TextDecoder().decode(untar(sys).get("package/dist/index.js")) === "export const x = 1;\n");
  ok("the in-memory writer's honest archive (pnpm header form) reads", untar(tgz(HONEST)).size === 2);
  ok("a checksum terminated NUL then space also reads", untar(tgz([{ ...HONEST[0]!, checksum: (s) => s.toString(8).padStart(6, "0") + "\0 " }])).size === 1);

  console.log("archives an installer could read differently are refused:");
  throws("an entry rooted outside package/ (npm strips the first component, so other/dist/index.js overwrites dist/index.js)",
    () => untar(tgz([...HONEST, { name: "other/dist/index.js", body: "evil" }])), /not a canonical path under package\//);
  throws("two entries with the same install path", () => untar(tgz([...HONEST, { name: "package/dist/index.js", body: "evil" }])), /two entries install to package\/dist\/index\.js/);
  throws("package/DIST/index.js beside package/dist/index.js (case-insensitive filesystems)",
    () => untar(tgz([...HONEST, { name: "package/DIST/index.js", body: "evil" }])), /two entries install to package\/DIST\/index\.js/);
  throws("a file and a directory component that differ only in case", () => untar(tgz([{ name: "package/Dist", body: "x" }, { name: "package/dist/index.js", body: "y" }])), /collides with a file at a directory component/);
  for (const bad of ["package/../dist/index.js", "package/./dist/index.js", "package//dist/index.js", "/package/dist/index.js", "package\\dist\\index.js", "package/dist\\index.js", "package"])
    throws(`non-canonical path ${JSON.stringify(bad)}`, () => untar(tgz([{ name: bad, body: "x" }])), /not a canonical path under package\//);
  throws("a name with a UTF-8 BOM", () => untar(tgz([{ name: Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode("package/dist/index.js")]), body: "x" }])), /not printable ASCII/);
  throws("a non-ASCII name", () => untar(tgz([{ name: enc.encode("package/dist/café.js"), body: "x" }])), /not printable ASCII/);
  throws("bytes after the name's NUL terminator", () => untar(tgz([{ name: "package/a.js\0package/b.js", body: "x" }])), /bytes after the name terminator/);
  throws("a ustar prefix (pnpm pack never sets one)", () => untar(tgz([{ name: "index.js", prefix: "package/dist", body: "x" }])), /a name prefix is not emitted by pnpm pack/);
  throws("a prefix behind a magic whose version is not 00", () => untar(tgz([{ name: "index.js", prefix: "package/dist", magic: "ustar\u0000xx", body: "x" }])), /not a POSIX ustar header \(magic and version\)/);
  throws("a GNU-magic header", () => untar(tgz([{ name: "package/a.js", body: "x", magic: "ustar  \0" }])), /not a POSIX ustar header/);
  throws("a directory entry with a nonzero size hiding a nested header", () => {
    const hidden = Buffer.from(header({ name: "package/dist/index.js" }, 4)).toString("latin1") + "evil";
    return untar(tgz([...HONEST.slice(0, 1), { name: "package/dist/", type: "5", body: hidden }]));
  }, /entry type "5"/);
  throws("a regular file with a nonempty linkname", () => untar(tgz([...HONEST, { name: "package/dist/alias.js", linkname: "index.js" }])), /a linkname on a regular file/);
  throws("an unterminated eight-digit checksum", () => untar(tgz([{ ...HONEST[0]!, checksum: (s) => s.toString(8).padStart(8, "0") }])), /checksum field not in canonical form/);
  throws("a size field without its terminator", () => untar(tgz([{ ...HONEST[0]!, size: "000000000002" }])), /size field not in canonical form/);
  throws("a PAX header whose last path record renames the next entry to dist/index.js",
    () => untar(tgz([...HONEST, { name: "PaxHeader", type: "x", body: pax([["path", "package/README.md"], ["path", "package/dist/index.js"]]) }, { name: "package/README.md", body: "evil" }])),
    /entry type "x"/);
  throws("a global PAX header", () => untar(tgz([{ name: "g", type: "g", body: pax([["path", "x"]]) }, ...HONEST])), /entry type "g"/);
  throws("a type flag NUL (old-style regular file)", () => untar(tgz([{ ...HONEST[0]!, type: "\0" }])), /entry type/);
  throws("a GNU archive", () => untar(pack("gnu")), /not a POSIX ustar header/);
  throws("a system-tar pax archive with a long name", () => {
    const long = "package/" + "a".repeat(120) + ".js";
    writeFileSync(join(pkgDir, long), "x");
    try { return untar(pack("pax", pkgDir, [long])); } finally { rmSync(join(pkgDir, long)); }
  }, /entry type "x"/);
  throws("a symlink entry", () => untar(tgz([...HONEST, { name: "package/dist/alias.js", type: "2" }])), /entry type "2"/);
  throws("a hard-link entry", () => untar(tgz([...HONEST, { name: "package/dist/alias.js", type: "1" }])), /entry type "1"/);
  throws("a header with a wrong checksum", () => {
    const raw = Buffer.concat([header({ name: "package/a.js" }, 0), new Uint8Array(1024)]);
    raw[0] = "q".charCodeAt(0);
    return untar(gzipSync(raw));
  }, /checksum mismatch/);
  const tail = new Uint8Array(1536); tail.set(header({ name: "package/dist/index.js" }, 0), 1024);
  throws("an entry after the end-of-archive block", () => untar(tgz(HONEST, tail)), /data after the end-of-archive block/);
  throws("a truncated archive", () => untar(reg.subarray(0, reg.length - 20)), /./);

  console.log("diffDist:");
  ok("honest: an identical local build has no difference", diffDist(untar(sys), localDist()).length === 0);
  const changed = localDist(); writeFileSync(join(changed, "index.js"), "export const x = 2;\n");
  ok("a changed file is reported", JSON.stringify(diffDist(untar(sys), changed)) === JSON.stringify(["dist/index.js differs from the local build"]));
  const extra = localDist(); writeFileSync(join(extra, "extra.js"), "");
  ok("a file only in the local build is reported", JSON.stringify(diffDist(untar(sys), extra)) === JSON.stringify(["dist/extra.js is in the local build but not published"]));
  const missing = localDist(); rmSync(join(missing, "mm"), { recursive: true });
  ok("a published file missing locally is reported", JSON.stringify(diffDist(untar(sys), missing)) === JSON.stringify(["dist/mm/index.d.ts is published but missing from the local build"]));
  ok("no local dist at all reports every published file", diffDist(untar(sys), join(work, "absent")).length === 2);
  ok("files outside dist/ (README) are not compared", !diffDist(untar(sys), localDist()).some((d) => d.includes("README")));

  console.log("integrityOk:");
  const sri = "sha512-" + createHash("sha512").update(sys).digest("base64");
  ok("honest: the sha512 SRI of the bytes verifies", integrityOk(sys, sri));
  const flipped = Uint8Array.from(sys); flipped[flipped.length - 1]! ^= 0x01;
  ok("one flipped byte fails", !integrityOk(flipped, sri));
  ok("a sha1 SRI is refused", !integrityOk(sys, "sha1-" + createHash("sha1").update(sys).digest("base64")));
  ok("missing integrity is refused", !integrityOk(sys, undefined));

  const linkDir = join(work, "link");
  cpSync(pkgDir, linkDir, { recursive: true });
  symlinkSync("index.js", join(linkDir, "package", "dist", "alias.js"));
  throws("a system-tar symlink entry", () => untar(pack("ustar", linkDir, [...FILES, "package/dist/alias.js"])), /entry type "2"/);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
