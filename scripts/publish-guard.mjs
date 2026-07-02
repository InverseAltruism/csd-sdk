#!/usr/bin/env node
// prepublishOnly guard (Plan 56 item 15; Plan 57 B1). Two asserts, both born from the 0.1.22
// incident where a raw `npm publish` shipped an artifact with unresolved workspace:* specifiers:
//   1. the publish MUST run under pnpm (pnpm rewrites workspace:* to exact versions at pack time;
//      npm does not and ships the broken protocol string verbatim).
//   2. check-lockstep.mjs must pass (dist freshness M4 + workspace:* interdeps), so the bytes
//      published come from current source.
// Runs with cwd = the package being published (npm/pnpm lifecycle contract).
import { spawnSync } from "node:child_process";
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
console.log("publish-guard: pnpm client + lockstep OK");
