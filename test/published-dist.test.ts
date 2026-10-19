// Offline checks of the published-dist comparison check-lockstep.mjs runs against npm tarballs. Fixtures are
// packed by the system tar in the three header formats an npm tarball can carry (gnu, ustar, pax).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { integrityOk, untar, diffDist } from "../scripts/published-dist.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const throws = (n: string, f: () => unknown, re: RegExp) => { let m = ""; try { f(); } catch (e) { m = String(e instanceof Error ? e.message : e); } ok(n, re.test(m)); };

const work = mkdtempSync(join(tmpdir(), "published-dist-"));
const LONG = "a".repeat(60) + "/" + "b".repeat(60) + ".js";   // over the 100-byte name field
const pkgDir = join(work, "pkg");
mkdirSync(join(pkgDir, "package", "dist", "mm"), { recursive: true });
mkdirSync(join(pkgDir, "package", "dist", "a".repeat(60)), { recursive: true });
writeFileSync(join(pkgDir, "package", "README.md"), "readme\n");
writeFileSync(join(pkgDir, "package", "dist", "index.js"), "export const x = 1;\n");
writeFileSync(join(pkgDir, "package", "dist", "mm", "index.d.ts"), "export declare const y: 2;\n");
writeFileSync(join(pkgDir, "package", "dist", LONG), "long\n");
const pack = (format: string, dir = pkgDir): Uint8Array => {
  const out = join(work, `${format}.tgz`);
  execFileSync("tar", [`--format=${format}`, "-czf", out, "-C", dir, "package"]);
  return new Uint8Array(readFileSync(out));
};
const localDist = (): string => { const d = mkdtempSync(join(work, "local-")); cpSync(join(pkgDir, "package", "dist"), d, { recursive: true }); return d; };

try {
  console.log("untar reads every header format with the right names:");
  for (const format of ["gnu", "ustar", "pax"]) {
    const files = untar(pack(format));
    const names = [...files.keys()].sort();
    ok(`${format}: regular files only, long name intact`, JSON.stringify(names) === JSON.stringify(["package/README.md", `package/dist/${LONG}`, "package/dist/index.js", "package/dist/mm/index.d.ts"].sort()));
    ok(`${format}: bytes intact`, new TextDecoder().decode(files.get("package/dist/index.js")) === "export const x = 1;\n");
  }
  // Old GNU headers keep atime/ctime where ustar keeps the name prefix (offset 345); only a POSIX "ustar\0" magic
  // makes that field a prefix.
  const gnu = gunzipSync(pack("gnu"));
  for (let off = 0; off + 512 <= gnu.length; off += 512) if (gnu.subarray(off + 257, off + 262).toString() === "ustar") gnu.write("12345670123", off + 345, "latin1");
  ok("gnu: bytes at the ustar prefix offset are not read as a prefix", [...untar(gzipSync(gnu)).keys()].includes("package/dist/index.js"));

  console.log("diffDist:");
  const tgz = pack("pax");
  ok("honest: an identical local build has no difference", diffDist(untar(tgz), localDist()).length === 0);
  const changed = localDist(); writeFileSync(join(changed, "index.js"), "export const x = 2;\n");
  ok("a changed file is reported", JSON.stringify(diffDist(untar(tgz), changed)) === JSON.stringify(["dist/index.js differs from the local build"]));
  const extra = localDist(); writeFileSync(join(extra, "extra.js"), "");
  ok("a file only in the local build is reported", JSON.stringify(diffDist(untar(tgz), extra)) === JSON.stringify(["dist/extra.js is in the local build but not published"]));
  const missing = localDist(); rmSync(join(missing, "mm"), { recursive: true });
  ok("a published file missing locally is reported", JSON.stringify(diffDist(untar(tgz), missing)) === JSON.stringify(["dist/mm/index.d.ts is published but missing from the local build"]));
  ok("no local dist at all reports every published file", diffDist(untar(tgz), join(work, "absent")).length === 3);
  ok("files outside dist/ (README) are not compared", !diffDist(untar(tgz), localDist()).some((d) => d.includes("README")));

  console.log("integrityOk:");
  const sri = "sha512-" + createHash("sha512").update(tgz).digest("base64");
  ok("honest: the registry's sha512 SRI of the bytes verifies", integrityOk(tgz, sri));
  const flipped = Uint8Array.from(tgz); flipped[flipped.length - 1]! ^= 0x01;
  ok("one flipped byte fails", !integrityOk(flipped, sri));
  ok("a sha1 SRI is refused", !integrityOk(tgz, "sha1-" + createHash("sha1").update(tgz).digest("base64")));
  ok("missing integrity is refused", !integrityOk(tgz, undefined));

  console.log("untar refuses what it cannot compare:");
  const linkDir = join(work, "link");
  cpSync(pkgDir, linkDir, { recursive: true });
  symlinkSync("index.js", join(linkDir, "package", "dist", "alias.js"));
  throws("a symlink entry throws", () => untar(pack("ustar", linkDir)), /entry type "2"/);
  throws("a truncated archive throws", () => untar(tgz.subarray(0, tgz.length - 20)), /./);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
