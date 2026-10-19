// Runs scripts/check-consumer-pins.mjs against a throwaway parent directory (a git checkout of fixture
// cairnx-core sources plus fixture consumer manifests), so no sibling working tree is read.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-consumer-pins.mjs");
const parent = mkdtempSync(join(tmpdir(), "consumer-pins-"));
const sdk = join(parent, "sdk-checkout");   // deliberately not named csd-sdk
const write = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
const git = (...args: string[]) => execFileSync("git", ["-C", sdk, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { stdio: "pipe" });
const setCore = (version: string) => write(join(sdk, "packages/cairnx/package.json"), JSON.stringify({ name: "@inversealtruism/cairnx-core", version }));
const pin = (repo: string, version: string) => write(join(parent, repo, "package.json"), JSON.stringify({ dependencies: { "@inversealtruism/cairnx-core": version } }));
const run = () => { const r = spawnSync(process.execPath, [join(sdk, "scripts/check-consumer-pins.mjs")], { encoding: "utf8" }); return { code: r.status, out: r.stdout + r.stderr }; };

try {
  write(join(sdk, "scripts/check-consumer-pins.mjs"), "");
  copyFileSync(SCRIPT, join(sdk, "scripts/check-consumer-pins.mjs"));
  for (const f of ["resolve", "records", "types", "preflight"]) write(join(sdk, `packages/cairnx/src/${f}.ts`), `export const ${f} = 1;\n`);
  setCore("1.0.0");
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "1.0.0"); git("tag", "cairnx-core-1.0.0");
  write(join(sdk, "packages/cairnx/src/resolve.ts"), "export const resolve = 2;\n");
  setCore("1.1.0");
  git("commit", "-qam", "1.1.0"); git("tag", "cairnx-core-1.1.0");
  write(join(sdk, "packages/cairnx/src/preflight.ts"), "export const preflight = 2;\n");
  setCore("1.2.0");
  git("commit", "-qam", "1.2.0");
  // A sibling named csd-sdk at another version: the canonical version comes from the script's own checkout.
  write(join(parent, "csd-sdk/packages/cairnx/package.json"), JSON.stringify({ version: "9.9.9" }));

  console.log("check-consumer-pins:");
  pin("cairnx", "1.2.0"); pin("cairn-sdk", "1.1.0");
  pin("cairn-cli", "0.1.42");   // archived and deprecated on npm; not a consumer any more
  let r = run();
  ok("honest: canonical read from the script's own checkout", /canonical version: 1\.2\.0/.test(r.out));
  ok("honest: strict pin equal, graded helpers-only lag is advisory, exit 0", r.code === 0 && /cairn-sdk pins cairnx-core 1\.1\.0 != canonical 1\.2\.0: helpers-only lag/.test(r.out));
  ok("cairn-cli is not checked", !/cairn-cli/.test(r.out));

  pin("cairn-sdk", "1.0.0");
  r = run();
  ok("graded: a lag across a consensus-surface change fails", r.code === 1 && /CONSENSUS-SURFACE DRIFT/.test(r.out) && /resolve\.ts/.test(r.out));

  pin("cairn-sdk", "1.0.5");
  r = run();
  ok("graded: a pinned version with no tag fails closed", r.code === 1 && /UNKNOWN version/.test(r.out));

  pin("cairn-sdk", "1.2.0"); pin("cairnx", "1.1.0");
  r = run();
  ok("strict: any lag fails", r.code === 1 && /cairnx svc pins cairnx-core 1\.1\.0 != canonical 1\.2\.0: re-pin/.test(r.out));
} finally {
  rmSync(parent, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
