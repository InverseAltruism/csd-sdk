// META-1 (resolve half) — cross-IMPLEMENTATION conformance for the FULL ledger.
// Feed the shipping JS resolver and the independent Python port (cairnx_ref.py) the SAME
// language-neutral vectors (packages/cairnx/test/vectors/cases.json) and assert byte-identity:
//   canonicalState(JS.resolve)  ===  Python.resolve  ===  JSON.stringify(expectedState)
// A JS-only ledger fork (a fee/sort/rounding/serialization divergence) diverges HERE.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canonicalState, resolve } from "../packages/cairnx/dist/index.js";

const casesPath = new URL("../packages/cairnx/test/vectors/cases.json", import.meta.url);
const { format, cases } = JSON.parse(readFileSync(casesPath, "utf8"));
if (format !== 2) { console.error("expected vectors format 2"); process.exit(1); }

// JS side
const jsOut = cases.map((c) => canonicalState(resolve(c.events, c.tipHeight)));
const expected = cases.map((c) => JSON.stringify(c.expectedState));

// Python side (one subprocess, all cases)
const job = { resolve: cases.map((c) => ({ events: c.events, tipHeight: c.tipHeight })) };
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify(job), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (py.status !== 0) { console.error("python ref failed:\n", py.stderr); process.exit(1); }
const pyOut = JSON.parse(py.stdout).resolve;

console.log("=== META-1 resolve() cross-impl (JS ⇄ Python ⇄ pinned vectors) ===");
let pass = 0, fail = 0;
for (let i = 0; i < cases.length; i++) {
  const name = cases[i].name;
  const jsVsExp = jsOut[i] === expected[i];
  const pyVsJs = pyOut[i] === jsOut[i];
  if (jsVsExp && pyVsJs) { pass++; console.log(`  ✓ ${name}`); continue; }
  fail++;
  console.error(`  ✗ ${name}`);
  if (!jsVsExp) console.error(`     JS != expectedState (vector self-check failed — JS/dist stale?)`);
  if (!pyVsJs) {
    console.error(`     Python != JS — FIRST DIVERGENCE:`);
    const a = jsOut[i], b = pyOut[i];
    let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
    console.error(`       at offset ${k}:`);
    console.error(`       JS : …${a.slice(Math.max(0, k - 40), k + 60)}`);
    console.error(`       PY : …${b.slice(Math.max(0, k - 40), k + 60)}`);
  }
}
console.log(`\nresolve cross-impl: ${pass}/${cases.length} byte-identical, ${fail} diverged`);
process.exit(fail ? 1 : 0);
