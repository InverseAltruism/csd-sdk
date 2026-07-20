#!/usr/bin/env node
// Glob-driven aggregating test runner for cairnx-core (B6d / REBIND M13; mirrors cairn/test/run.mjs).
//
// Replaces the package.json 10-deep `tsx a && tsx b && ...` chain: the same defect class as F13 - a test
// file ADDED to test/ but forgotten in the chain is silently never run (dead-green), and the chain stops
// at the first failure so later files' verdicts are never seen. This runner:
//   - discovers EVERY test/*.test.ts (sorted) - nothing can be forgotten;
//   - runs them ALL and reports every failure, not just the first;
//   - classifies exit-0-with-`SKIP:` as SKIPPED, visibly (never a silent pass);
//   - hard-fails on a per-file timeout (a hang is a failure, not a skip - the B0b runner lesson);
//   - refuses to report green if discovery collapses (a glob/typo that finds too few files must be LOUD,
//     the exact dead-green shape this repo has been bitten by twice).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

const tests = readdirSync(here).sort().filter((f) => f.endsWith(".test.ts")).map((f) => join("test", f));

// Discovery floor: 10 suites existed when this runner replaced the chain. Deleting/moving suites is a
// deliberate act - update the floor in the same commit, so a silent discovery collapse can never pass.
const DISCOVERY_FLOOR = 10;
if (tests.length < DISCOVERY_FLOOR) {
  process.stderr.write(`test/run.mjs: discovered only ${tests.length} test files (< floor ${DISCOVERY_FLOOR}) - refusing to report green on a collapsed glob\n`);
  process.exit(2);
}

const rawTimeout = process.env.CAIRNX_TEST_TIMEOUT_MS;
const TIMEOUT_MS = rawTimeout === undefined ? 180_000 : Number(rawTimeout);
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  process.stderr.write(`test/run.mjs: CAIRNX_TEST_TIMEOUT_MS must be a positive number, got ${JSON.stringify(rawTimeout)}\n`);
  process.exit(2);
}

// Spawn node with the tsx loader DIRECTLY (not `npx tsx`): spawnSync's timeout kills only the immediate
// child, so an intermediary shell chain would orphan the real test process past the cap.
const require_ = createRequire(import.meta.url);
const tsxDir = join(dirname(require_.resolve("tsx/package.json")), "dist");
const nodeArgs = ["--require", join(tsxDir, "preflight.cjs"), "--import", pathToFileURL(join(tsxDir, "loader.mjs")).href];

let passed = 0;
const skipped = [];
const failed = [];
for (const t of tests) {
  process.stdout.write(`\n── ${t} ──\n`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...nodeArgs, t], {
    cwd: pkgRoot, stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", env: process.env,
    timeout: TIMEOUT_MS, killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,   // a chatty-but-passing test must not be mistaken for a hang (ENOBUFS)
  });
  const secs = (Date.now() - t0) / 1000;
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const didSkip = /^SKIP:/m.test(r.stdout || "");
  if (r.error?.code === "ETIMEDOUT") {
    failed.push(`${t} (TIMED OUT after ${TIMEOUT_MS / 1000}s: a hang is a failure, not a skip)`);
  } else if (r.error) {
    failed.push(`${t} (runner error ${r.error.code || r.error.message} after ${secs.toFixed(1)}s)`);
  } else if (r.status === null && r.signal) {
    failed.push(`${t} (killed by ${r.signal} after ${secs.toFixed(1)}s)`);
  } else if (r.status === 0 && didSkip) {
    skipped.push(t);
  } else if (r.status === 0) {
    passed++;
  } else {
    failed.push(`${t} (exit ${r.status})`);
  }
}

process.stdout.write(`\n========================================\n`);
process.stdout.write(`cairnx test/run.mjs: ${passed}/${tests.length} files passed${skipped.length ? `, ${skipped.length} SKIPPED` : ""}\n`);
if (skipped.length) process.stdout.write(`SKIPPED (printed a SKIP: line):\n  ${skipped.join("\n  ")}\n`);
if (failed.length) {
  process.stdout.write(`FAILED:\n  ${failed.join("\n  ")}\n`);
  process.exit(1);
}
process.stdout.write(`ALL TEST FILES PASS\n`);
