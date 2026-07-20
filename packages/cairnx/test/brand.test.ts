// B6a rider: the EXECUTABLE compile gate for the ProvenOfferTerms brand. Spawns tsc --noEmit over
// test/fixtures/brand-usage.ts, whose @ts-expect-error lines assert that a hand-built terms object is a
// COMPILE ERROR at the opt-in bindOfferTerms overload while every legitimate/legacy use still compiles.
// RED conditions (either direction of drift):
//   - the brand is weakened (a literal satisfies the 3-arg overload) -> "Unused '@ts-expect-error'" -> tsc fails
//   - the brand over-reaches (a legitimate use stops compiling)      -> a real error               -> tsc fails
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "brand-usage.ts");
const require_ = createRequire(import.meta.url);
const tsc = path.join(path.dirname(require_.resolve("typescript/package.json")), "bin", "tsc");

const r = spawnSync(process.execPath, [
  tsc, "--noEmit", "--strict", "--noUncheckedIndexedAccess",
  "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
  "--skipLibCheck", fixture,
], { encoding: "utf8" });

if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
}
assert.equal(r.status, 0, "brand compile gate: tsc --noEmit over fixtures/brand-usage.ts must be CLEAN (a failure means the ProvenOfferTerms brand drifted - weakened or over-reaching)");
console.log("cairnx-core brand compile gate: 1 passed (hand-built terms are a compile error at the opt-in legs; legacy uses compile)");
