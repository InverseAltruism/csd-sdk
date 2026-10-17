// Live-node tests are opt-in: with CSD_RPC unset, each test that can reach a node skips by name and makes no
// network request (test/fixtures/no-network.mjs ends the process on any fetch or TCP connect).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = pathToFileURL(path.join(ROOT, "test", "fixtures", "no-network.mjs")).href;
const LIVE_CAPABLE: [string, RegExp][] = [
  ["test/oracle.test.ts", /SKIP: oracle tests: CSD_RPC unset/],
  ["test/security.test.ts", /SKIP: light forged-chain tests: CSD_RPC unset/],
  ["packages/client/test/client.test.ts", /SKIP: csd-client live test: CSD_RPC unset/],
  ["packages/light/test/light.test.ts", /SKIP: live light tests: CSD_RPC unset/],
];

const env = { ...process.env };
delete env.CSD_RPC;
let pass = 0;
for (const [file, skipLine] of LIVE_CAPABLE) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, path.join(ROOT, file)], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(/NETWORK ATTEMPT/.test(r.stderr), false, `${file} made a network request with CSD_RPC unset:\n${r.stderr}`);
  assert.equal(r.status, 0, `${file} exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, skipLine, `${file} must name its skip`);
  pass++;
  console.log(`  ok ${file}: skipped by name, no network request`);
}
console.log(`live opt-in: ${pass} passed`);
