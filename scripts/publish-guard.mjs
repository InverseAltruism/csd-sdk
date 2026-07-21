#!/usr/bin/env node
// prepublishOnly guard (Plan 56 item 15; Plan 57 B1; REBIND B6d M13). Asserts, born from the 0.1.22
// incident where a raw `npm publish` shipped an artifact with unresolved workspace:* specifiers:
//   1. the publish MUST run under pnpm (pnpm rewrites workspace:* to exact versions at pack time;
//      npm does not and ships the broken protocol string verbatim).
//   2. check-lockstep.mjs must pass (dist freshness M4 + workspace:* interdeps), so the bytes
//      published come from current source.
//   3. (B6d / REBIND M13) the package's OWN test suite must pass, and for cairnx-core the root
//      cross-language conformance gate (test:crosslang) must pass too - previously nothing between
//      a red consensus suite and `pnpm publish`. Opt-out is EXPLICIT ONLY (CSD_PUBLISH_SKIP_TESTS=1,
//      loudly announced), never a silent skip.
// Runs with cwd = the package being published (npm/pnpm lifecycle contract).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ua = process.env.npm_config_user_agent ?? "";
if (!ua.includes("pnpm")) {
  console.error("publish-guard: REFUSING to publish under a non-pnpm client.");
  console.error(`  user agent: ${ua || "(unset)"}`);
  console.error("  npm leaves workspace:* specifiers unresolved in the published manifest (the 0.1.22 incident).");
  console.error("  Use: pnpm publish (or pnpm -r publish) from the csd-sdk root.");
  process.exit(1);
}

const lockstep = join(dirname(fileURLToPath(import.meta.url)), "check-lockstep.mjs");
const r = spawnSync(process.execPath, [lockstep], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("publish-guard: check-lockstep failed; rebuild dists before publishing.");
  process.exit(r.status ?? 1);
}

// ── B6d (REBIND M13): the publish gate runs the tests ──────────────────────────────────────────────
const skippedTests = process.env.CSD_PUBLISH_SKIP_TESTS === "1";
if (skippedTests) {
  console.error("publish-guard: ##########################################################");
  console.error("publish-guard: ##  TESTS SKIPPED - CSD_PUBLISH_SKIP_TESTS=1 is set.    ##");
  console.error("publish-guard: ##  You are publishing WITHOUT this package's suite     ##");
  console.error("publish-guard: ##  (and without the crosslang fork gate for            ##");
  console.error("publish-guard: ##  cairnx-core). This is on the record.                ##");
  console.error("publish-guard: ##########################################################");
} else {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const run = (args, cwd, what) => {
    console.log(`publish-guard: running ${what} (pnpm ${args.join(" ")}) ...`);
    const t = spawnSync("pnpm", args, { stdio: "inherit", cwd });
    if (t.status !== 0) {
      console.error(`publish-guard: ${what} FAILED (exit ${t.status ?? `signal ${t.signal}`}) - REFUSING to publish.`);
      console.error("publish-guard: fix the failure, or opt out EXPLICITLY with CSD_PUBLISH_SKIP_TESTS=1.");
      process.exit(typeof t.status === "number" && t.status !== 0 ? t.status : 1); // MUTATE_M13_TESTGATE (delete -> a red suite publishes)
    }
  };
  if (pkg.scripts?.test) run(["run", "test"], process.cwd(), `${pkg.name} test suite`);
  else console.log(`publish-guard: ${pkg.name} declares no test script (nothing to run)`);
  if (pkg.name === "@inversealtruism/cairnx-core") {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    run(["run", "test:crosslang"], repoRoot, "cross-language conformance gate (test:crosslang)");
  }
}

// B8-docs (REBIND): the success line must not claim a test gate that did not run (output-over-claim).
if (skippedTests) console.log("publish-guard: pnpm client + lockstep OK; tests SKIPPED (CSD_PUBLISH_SKIP_TESTS=1) - NO test gate ran");
else console.log("publish-guard: pnpm client + lockstep + test gate OK");
