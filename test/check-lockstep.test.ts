// Runs scripts/check-lockstep.mjs, and scripts/publish-guard.mjs which runs it, on a throwaway workspace against a
// stand-in registry (fetch replaced through NODE_OPTIONS --import, so the guard's child process gets it too): the
// workspace:* rule, the published-pin rule (a published version's exact peer on a workspace package must equal that
// package's current version, as its dependencies must), the published-dist compare and its integrity check, and the
// guard's refusal of a non-pnpm client.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "lockstep-"));
const put = (path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
const CORE_DIST = "export const v = 1;\n";

/** What the stand-in registry serves: URL suffix -> a JSON document or tarball bytes; any other URL is a 404. */
type Served = Record<string, object | Uint8Array>;
/** A script's exit code and output with fetch answered from `served`. */
function run(served: Served, o: { script?: string; cwd?: string; env?: Record<string, string> } = {}): { code: number | null; out: string } {
  const table = Object.fromEntries(Object.entries(served).map(([k, v]) => [k, v instanceof Uint8Array ? { b64: Buffer.from(v).toString("base64") } : { json: v }]));
  const stub = `const t = ${JSON.stringify(table)}; globalThis.fetch = async (u) => { u = String(u);
    for (const [k, v] of Object.entries(t)) if (u.endsWith(k)) return v.b64 !== undefined ? new Response(Buffer.from(v.b64, "base64")) : new Response(JSON.stringify(v.json));
    return new Response("", { status: 404 }); };`;
  // pnpm sets npm_config_* when it runs this test; the guard reads npm_config_user_agent, so each case sets its own
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k) && k !== "CSD_PUBLISH_SKIP_TESTS"));
  const r = spawnSync(process.execPath, [join(root, "scripts", o.script ?? "check-lockstep.mjs")], { encoding: "utf8", cwd: o.cwd ?? root,
    env: { ...env, ...o.env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(stub)}` } });
  return { code: r.status, out: r.stdout + r.stderr };
}
/** The registry entry of api@0.1.0, published with `peer` as its exact core peer and no tarball. */
const api = (peer: string): Served => ({ "/api/0.1.0": { peerDependencies: { core: peer } } });
/** The registry entry and tarball of core@1.1.0 holding `dist` as dist/index.js, in the plain-file ustar shape the reader accepts. */
function core(dist: string, o: { integrityOf?: string } = {}): Served {
  const x = mkdtempSync(join(root, "t-"));
  mkdirSync(join(x, "package", "dist"), { recursive: true });
  writeFileSync(join(x, "package", "package.json"), JSON.stringify({ name: "core", version: "1.1.0" }));
  writeFileSync(join(x, "package", "dist", "index.js"), dist);
  const out = join(x, "core.tgz");
  execFileSync("tar", ["--format=ustar", "--no-recursion", "-czf", out, "-C", x, "package/package.json", "package/dist/index.js"]);
  const bytes = new Uint8Array(readFileSync(out));
  const sri = (b: Uint8Array) => "sha512-" + createHash("sha512").update(b).digest("base64");
  const integrity = o.integrityOf === undefined ? sri(bytes) : sri(new TextEncoder().encode(o.integrityOf));
  return { "/core/1.1.0": { dist: { tarball: "https://registry.invalid/core-1.1.0.tgz", integrity } }, "/core-1.1.0.tgz": bytes };
}

try {
  for (const f of ["check-lockstep.mjs", "publish-guard.mjs", "published-dist.mjs", "workspace.mjs", "git-head.mjs"]) cpSync(join(repo, "scripts", f), join(root, "scripts", f));
  const apiManifest = JSON.stringify({ name: "api", version: "0.1.0", peerDependencies: { core: "workspace:*" } });
  put("packages/core/package.json", JSON.stringify({ name: "core", version: "1.1.0" }));
  put("packages/api/package.json", apiManifest);
  for (const d of ["core", "api"]) put(`packages/${d}/src/index.ts`, "");
  put("packages/core/dist/index.js", CORE_DIST);
  put("packages/api/dist/index.js", "");

  console.log("check-lockstep workspace:*:");
  const unpublished = run({});
  ok("honest: nothing published, inter-deps workspace:*: lockstep OK", unpublished.code === 0 && /lockstep OK/.test(unpublished.out), unpublished.out);
  // the rule covers every dependency kind the script reads: dependencies, devDependencies and peerDependencies
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    put("packages/api/package.json", JSON.stringify({ name: "api", version: "0.1.0", [field]: { core: "1.1.0" } }));
    const exact = run({});
    put("packages/api/package.json", apiManifest);
    ok(`an intra-workspace ${field} entry pinned to an exact version, not workspace:*, fails`,
      exact.code === 1 && new RegExp(`api ${field}\\.core = "1\\.1\\.0" \\(must be "workspace:\\*"\\)`).test(exact.out), exact.out);
  }

  console.log("check-lockstep published pins:");
  const honest = run(api("1.1.0")).out;   // the stand-in answers api@0.1.0 with no tarball: proof the registry was read
  ok("honest: a published exact peer equal to the workspace version is no pin error", !/published pinning/.test(honest) && /api@0\.1\.0: registry metadata names no tarball/.test(honest), honest);
  const out = run(api("1.0.0")).out;
  ok("a published exact peer behind the workspace version fails, naming the bump", /api@0\.1\.0 is published pinning core@1\.0\.0 as a peer, workspace has 1\.1\.0 \(bump api\)/.test(out), out);

  console.log("check-lockstep published dist:");
  const same = run(core(CORE_DIST));
  ok("honest: core@1.1.0 on the registry with this tree's dist: lockstep OK", same.code === 0 && /lockstep OK/.test(same.out), same.out);
  const other = run(core("export const v = 2;\n"));
  ok("core@1.1.0 published with a dist that is not this tree's build fails, naming the file and the bump",
    other.code === 1 && /core@1\.1\.0: dist\/index\.js differs from the local build; this tree builds different bytes at a published version \(bump core\)/.test(other.out), other.out);
  // the served bytes hold this tree's dist, so only the integrity check refuses them
  const forged = run(core(CORE_DIST, { integrityOf: "other bytes" }));
  ok("a tarball that does not match the registry's sha512 integrity fails", forged.code === 1 && /core@1\.1\.0: tarball does not match the registry's sha512 integrity/.test(forged.out), forged.out);

  console.log("publish-guard client check:");
  const guard = (env: Record<string, string>) => run({}, { script: "publish-guard.mjs", cwd: join(root, "packages", "core"), env });
  const viaPnpm = guard({ npm_config_user_agent: "pnpm/10.32.1 npm/? node/v22.0.0 linux x64" });
  ok("honest: under pnpm the guard runs check-lockstep and passes (core declares no test script)",
    viaPnpm.code === 0 && /lockstep OK/.test(viaPnpm.out) && /publish-guard: pnpm client \+ lockstep \+ test gate OK/.test(viaPnpm.out), viaPnpm.out);
  const viaNpm = guard({ npm_config_user_agent: "npm/10.9.0 node/v22.0.0 linux x64 workspaces/false" });
  ok("a publish under npm is refused before check-lockstep runs", viaNpm.code === 1 && /REFUSING to publish under a non-pnpm client/.test(viaNpm.out) && !/lockstep OK/.test(viaNpm.out), viaNpm.out);
  const unset = guard({});
  ok("a publish with no user agent is refused", unset.code === 1 && /user agent: \(unset\)/.test(unset.out), unset.out);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
