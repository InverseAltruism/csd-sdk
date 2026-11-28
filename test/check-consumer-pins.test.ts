// Runs scripts/check-consumer-pins.mjs against a throwaway parent directory (a git checkout of fixture
// cairnx-core sources plus fixture consumer manifests), so no sibling working tree is read.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n${detail}`}`); };

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
  write(join(sdk, "packages/cairnx/src/resolve/market.ts"), "export const market = 1;\n");
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

  // resolve() dispatches into packages/cairnx/src/resolve/*.ts, so a change there alone is consensus drift.
  git("tag", "cairnx-core-1.2.0");
  write(join(sdk, "packages/cairnx/src/resolve/market.ts"), "export const market = 2;\n");
  setCore("1.3.0");
  git("commit", "-qam", "1.3.0");
  pin("cairnx", "1.3.0"); pin("cairn-sdk", "1.2.0");
  r = run();
  ok("graded: a lag across a resolve/ handler change fails", r.code === 1 && /CONSENSUS-SURFACE DRIFT/.test(r.out) && /resolve\/market\.ts/.test(r.out));

  // One core per consumer: cairnx-api 0.1.0 is tagged where the core is 1.3.0, 0.2.0 where it is 1.4.0.
  const pins = (repo: string, core: string, api: string, section = "dependencies") => write(join(parent, repo, "package.json"),
    JSON.stringify(section === "dependencies" ? { dependencies: { "@inversealtruism/cairnx-core": core, "@inversealtruism/cairnx-api": api } }
      : { dependencies: { "@inversealtruism/cairnx-core": core }, [section]: { "@inversealtruism/cairnx-api": api } }));
  const setApi = (version: string) => write(join(sdk, "packages/cairnx-api/package.json"),
    JSON.stringify({ name: "@inversealtruism/cairnx-api", version, peerDependencies: { "@inversealtruism/cairnx-core": "workspace:*" } }));
  git("tag", "cairnx-core-1.3.0");
  setApi("0.1.0");
  git("add", "-A"); git("commit", "-qm", "cairnx-api 0.1.0"); git("tag", "cairnx-api-0.1.0");
  write(join(sdk, "packages/cairnx/src/preflight.ts"), "export const preflight = 3;\n");
  setCore("1.4.0"); setApi("0.2.0");
  git("commit", "-qam", "1.4.0"); git("tag", "cairnx-api-0.2.0");
  pin("cairnx", "1.4.0"); pins("cairn-sdk", "1.3.0", "0.1.0");
  r = run();
  ok("one core: a consumer on the core its cairnx-api was published against passes, beside a helpers-only lag",
    r.code === 0 && /cairn-sdk pins cairnx-api 0\.1\.0 \(dependencies\) on its cairnx-core 1\.3\.0/.test(r.out) && /helpers-only lag/.test(r.out));
  pins("cairn-sdk", "1.4.0", "0.1.0");
  r = run();
  ok("one core: a canonical core pin under a cairnx-api published against another core fails",
    r.code === 1 && /cairn-sdk pins cairnx-core 1\.4\.0 but cairnx-api 0\.1\.0 \(dependencies\) was published against cairnx-core 1\.3\.0: TWO CORES/.test(r.out) && /FAILED \(1\/2\)/.test(r.out));
  for (const section of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
    pins("cairn-sdk", "1.4.0", "0.1.0", section);
    r = run();
    ok(`one core: a cairnx-api pin under ${section} is checked and fails on two cores`, r.code === 1 && new RegExp(`cairnx-api 0\\.1\\.0 \\(${section}\\) was published against cairnx-core 1\\.3\\.0: TWO CORES`).test(r.out));
    pins("cairn-sdk", "1.4.0", "0.2.0", section);
    r = run();
    ok(`one core: a cairnx-api pin under ${section} on the pinned core passes`, r.code === 0 && new RegExp(`cairn-sdk pins cairnx-api 0\\.2\\.0 \\(${section}\\) on its cairnx-core 1\\.4\\.0`).test(r.out));
  }
  pins("cairn-sdk", "1.3.0", "0.2.0");
  r = run();
  ok("one core: a graded consumer's advisory lag does not excuse two cores", r.code === 1 && /cairn-sdk pins cairnx-core 1\.3\.0 but cairnx-api 0\.2\.0 \(dependencies\) was published against cairnx-core 1\.4\.0/.test(r.out));
  pins("cairn-sdk", "1.4.0", "0.2.0"); pins("cairnx", "1.4.0", "0.1.0");
  r = run();
  ok("one core: a strict consumer at the canonical core with an older cairnx-api fails", r.code === 1 && /cairnx svc pins cairnx-core 1\.4\.0 but cairnx-api 0\.1\.0/.test(r.out) && /cairn-sdk pins cairnx-api 0\.2\.0 \(dependencies\) on its cairnx-core 1\.4\.0/.test(r.out));
  pins("cairnx", "1.4.0", "0.1.5");
  r = run();
  ok("one core: a cairnx-api version with no tag fails closed", r.code === 1 && /cairnx svc pins cairnx-api 0\.1\.5 \(dependencies\): UNKNOWN version/.test(r.out));
  git("tag", "cairnx-api-0.3.0");   // a hand-placed tag on a commit whose cairnx-api manifest names 0.2.0
  pins("cairnx", "1.4.0", "0.3.0");
  r = run();
  ok("one core: a tag whose cairnx-api manifest names another version fails closed", r.code === 1 && /cairnx svc pins cairnx-api 0\.3\.0 \(dependencies\): UNKNOWN version/.test(r.out));
  pins("cairnx", "1.4.0", "0.2.0");
  r = run();
  ok("one core: both consumers on one core pass", r.code === 0 && /consumer-pin coherence OK \(2 npm-pinning consumers\)/.test(r.out));

  // The same rule for cairnx-replica, an exact peer on cairnx-core: replica 0.1.0 is tagged where the core is 1.4.0,
  // replica 0.2.0 where it is 1.5.0.
  const setReplica = (version: string) => write(join(sdk, "packages/replica/package.json"),
    JSON.stringify({ name: "@inversealtruism/cairnx-replica", version, peerDependencies: { "@inversealtruism/cairnx-core": "workspace:*" } }));
  const deps = (repo: string, d: Record<string, string>) => write(join(parent, repo, "package.json"),
    JSON.stringify({ dependencies: Object.fromEntries(Object.entries(d).map(([k, v]) => [`@inversealtruism/${k}`, v])) }));
  setReplica("0.1.0");
  git("add", "-A"); git("commit", "-qm", "replica 0.1.0"); git("tag", "cairnx-replica-0.1.0");
  deps("cairn-sdk", { "cairnx-core": "1.4.0", "cairnx-replica": "0.1.0" });
  r = run();
  ok("one core: a consumer on the core its cairnx-replica was published against passes",
    r.code === 0 && /cairn-sdk pins cairnx-replica 0\.1\.0 \(dependencies\) on its cairnx-core 1\.4\.0/.test(r.out), r.out);
  write(join(sdk, "packages/cairnx/src/preflight.ts"), "export const preflight = 4;\n");
  setCore("1.5.0"); setReplica("0.2.0");
  git("commit", "-qam", "1.5.0, replica 0.2.0"); git("tag", "cairnx-replica-0.2.0");
  pin("cairnx", "1.5.0");
  deps("cairn-sdk", { "cairnx-core": "1.5.0", "cairnx-replica": "0.1.0" });
  r = run();
  ok("one core: a core pin under a cairnx-replica published against another core fails",
    r.code === 1 && /cairn-sdk pins cairnx-core 1\.5\.0 but cairnx-replica 0\.1\.0 \(dependencies\) was published against cairnx-core 1\.4\.0: TWO CORES/.test(r.out), r.out);
  deps("cairn-sdk", { "cairnx-core": "1.5.0", "cairnx-replica": "0.1.5" });
  r = run();
  ok("one core: a cairnx-replica version with no tag fails closed", r.code === 1 && /cairn-sdk pins cairnx-replica 0\.1\.5 \(dependencies\): UNKNOWN version/.test(r.out), r.out);
  deps("cairn-sdk", { "cairnx-core": "1.5.0", "cairnx-replica": "0.2.0", "cairnx-pin": "0.1.0" });
  r = run();
  ok("one core: a consumer on the replica built on its core passes, a cairnx-pin pin beside it asks no tag",
    r.code === 0 && /consumer-pin coherence OK \(2 npm-pinning consumers\)/.test(r.out) && !/cairnx-pin/.test(r.out), r.out);

  // The replay a replica runs on its pinned core reads more than resolve(): the rule from a block to events, the held
  // replay context and the hashes replicas compare. A lag across a change to one of them alone is consensus drift.
  git("tag", "cairnx-core-1.5.0");
  const REPLAY = ["events", "hashes", "paidto", "replay-context"];
  for (const f of [...REPLAY, "verifyfill"]) write(join(sdk, `packages/cairnx/src/${f}.ts`), `export const v = 1;\n`);
  setCore("1.5.1");
  git("add", "-A"); git("commit", "-qm", "1.5.1"); git("tag", "cairnx-core-1.5.1");
  let prev = "1.5.1";
  for (const [i, f] of [...REPLAY, "verifyfill"].entries()) {
    const next = `1.6.${i}`;
    write(join(sdk, `packages/cairnx/src/${f}.ts`), `export const v = ${i + 2};\n`);
    setCore(next);
    git("commit", "-qam", next); git("tag", `cairnx-core-${next}`);
    pin("cairnx", next); deps("cairn-sdk", { "cairnx-core": prev });
    r = run();
    if (f === "verifyfill") ok("graded, control: a lag across a change to verifyfill.ts alone stays a helpers-only lag", r.code === 0 && /helpers-only lag/.test(r.out), r.out);
    else ok(`graded: a lag across a change to ${f}.ts alone fails`, r.code === 1 && /CONSENSUS-SURFACE DRIFT/.test(r.out) && new RegExp(`${f}\\.ts`).test(r.out), r.out);
    prev = next;
  }
} finally {
  rmSync(parent, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
