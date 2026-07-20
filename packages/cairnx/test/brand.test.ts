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
import { readdirSync, readFileSync, statSync } from "node:fs";
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

// B6 gate fold-in (G10): PRODUCTION-CALL guard for the tests-only escape hatch.
// unsafeMintProvenOfferTerms brands a HAND-BUILT (unproven) terms object so it can open the opt-in
// bind legs - exactly the W2 defect class the brand exists to make unrepresentable. It may be DEFINED
// (its single export in verifyfill.ts) but must be referenced NOWHERE in production src: a call from a
// non-test source file would smuggle an unproven terms object past the brand. The compile gate above
// catches a WEAKENED brand; this source-scan catches an escape-hatch CALL from production. It reds the
// moment the identifier appears in any non-test src file outside its one definition site.
const IDENT = "unsafeMintProvenOfferTerms";
const DEF_RE = /export\s+const\s+unsafeMintProvenOfferTerms\b/;
const srcRoot = path.join(here, "..", "src");
const srcFiles: string[] = [];
(function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) { if (entry !== "test") walk(p); }
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) srcFiles.push(p);
  }
})(srcRoot);

const offending: string[] = [];
let definitions = 0;
for (const f of srcFiles) {
  const rel = path.relative(srcRoot, f);
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (!line.includes(IDENT)) return;
    if (DEF_RE.test(line)) { definitions++; return; }   // the sole permitted occurrence: the export itself
    offending.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}
assert.equal(offending.length, 0,
  `unsafeMintProvenOfferTerms (tests-only escape hatch) must NEVER be referenced from production src ` +
  `(${srcFiles.length} non-test src files scanned). Offending references:\n${offending.join("\n")}`);
// anchor the scan to a live definition: if the export is renamed/removed the guard would silently pass
// on every file (dead-green), so require the definition to exist exactly once.
assert.equal(definitions, 1,
  `expected exactly ONE definition of unsafeMintProvenOfferTerms in src (the escape-hatch export); found ${definitions} ` +
  `(a source-scan anchored to a missing definition is dead-green - worse than no scan)`);
console.log(`cairnx-core brand source-scan: 1 passed (unsafeMintProvenOfferTerms referenced only at its definition; ${srcFiles.length} non-test src files scanned)`);
