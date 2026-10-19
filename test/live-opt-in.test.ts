// Live-node tests are opt-in: with CSD_RPC unset, each test that can reach a node skips by name, prints no pass
// count when it is live-only, and makes no network request (test/fixtures/no-network.mjs ends the process on any fetch or TCP connect).
// With CSD_RPC set to a node that does not answer, each live-only suite fails (a refused loopback port).
import assert from "node:assert/strict";
import { createServer } from "node:net";
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

// security.test.ts runs offline assertions and skips only its forged-chain part; the others are live-only.
const liveOnly = (f: string) => f !== "test/security.test.ts";
const env = { ...process.env };
delete env.CSD_RPC;
let pass = 0;
for (const [file, skipLine] of LIVE_CAPABLE) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, path.join(ROOT, file)], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(/NETWORK ATTEMPT/.test(r.stderr), false, `${file} made a network request with CSD_RPC unset:\n${r.stderr}`);
  assert.equal(r.status, 0, `${file} exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, skipLine, `${file} must name its skip`);
  if (liveOnly(file)) assert.equal(/\d+ passed/.test(r.stdout), false, `${file} printed a pass count after skipping:\n${r.stdout}`);
  pass++;
  console.log(`  ok ${file}: skipped by name, no network request`);
}
const refused = await new Promise<string>((done) => {
  const srv = createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => done(`http://127.0.0.1:${port}`));
  });
});
for (const [file] of LIVE_CAPABLE.filter(([f]) => liveOnly(f))) {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, file)], { cwd: ROOT, env: { ...env, CSD_RPC: refused }, encoding: "utf8" });
  assert.equal(r.status, 1, `${file} exited ${r.status} with CSD_RPC set and no node:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /FAIL: .*CSD_RPC=.* set but no node answers \/tip/, `${file} must name the failure`);
  pass++;
  console.log(`  ok ${file}: CSD_RPC set, no node -> fails by name`);
}
console.log(`live opt-in: ${pass} passed`);
