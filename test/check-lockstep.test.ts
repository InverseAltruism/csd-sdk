// Runs scripts/check-lockstep.mjs on a throwaway workspace against a stand-in registry (fetch replaced through
// --import), for the published-pin rule: a published version's exact peer on a workspace package must equal that
// package's current version, as its dependencies must.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "lockstep-"));
const put = (path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
/** The script's output when the registry holds api@0.1.0 published with `peer` as its exact core peer. */
function run(peer: string): string {
  const meta = JSON.stringify({ peerDependencies: { core: peer } });
  const stub = `globalThis.fetch = async (u) => String(u).endsWith("/api/0.1.0") ? new Response(${JSON.stringify(meta)}) : new Response("", { status: 404 });`;
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, join(root, "scripts/check-lockstep.mjs")], { encoding: "utf8" });
  return r.stdout + r.stderr;
}

try {
  for (const f of ["check-lockstep.mjs", "published-dist.mjs", "workspace.mjs", "git-head.mjs"]) cpSync(join(repo, "scripts", f), join(root, "scripts", f));
  put("packages/core/package.json", JSON.stringify({ name: "core", version: "1.1.0" }));
  put("packages/api/package.json", JSON.stringify({ name: "api", version: "0.1.0", peerDependencies: { core: "workspace:*" } }));
  for (const d of ["core", "api"]) { put(`packages/${d}/src/index.ts`, ""); put(`packages/${d}/dist/index.js`, ""); }
  console.log("check-lockstep published pins:");
  const honest = run("1.1.0");   // the stand-in answers api@0.1.0 with no tarball: proof the registry was read
  ok("honest: a published exact peer equal to the workspace version is no pin error", !/published pinning/.test(honest) && /api@0\.1\.0: registry metadata names no tarball/.test(honest), honest);
  const out = run("1.0.0");
  ok("a published exact peer behind the workspace version fails, naming the bump", /api@0\.1\.0 is published pinning core@1\.0\.0 as a peer, workspace has 1\.1\.0 \(bump api\)/.test(out), out);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
