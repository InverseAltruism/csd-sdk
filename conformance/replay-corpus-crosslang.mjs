// Real-chain cross-implementation conformance, offline: replay the committed on-chain corpus
// (packages/cairnx/test/vectors/replay-corpus.json) through the shipping JS resolver and the
// independent Python port at EVERY pinned height of replay-hashes.json and assert
//   canonicalState(JS.resolve)  ===  Python.resolve  and  stateHash(JS)  ===  the pinned hash (CONVENTION §34.1).
// cases.json is hand-built; this is the same check over what the chain actually carried (fclaim, V29).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canonicalState, resolve, stateHash } from "../packages/cairnx/dist/index.js";

const vec = (f) => JSON.parse(readFileSync(new URL(`../packages/cairnx/test/vectors/${f}`, import.meta.url), "utf8"));
const corpus = vec("replay-corpus.json");
const pinned = vec("replay-hashes.json");

const heights = Object.keys(pinned.hashes).map(Number).sort((a, b) => a - b);
if (heights.length < 21) { console.error(`expected at least 21 pinned heights, got ${heights.length}`); process.exit(1); }
const jobs = heights.map((H) => ({ events: corpus.events.filter((e) => e.height <= H), tipHeight: H }));
const states = jobs.map((j) => resolve(j.events, j.tipHeight));
const jsOut = states.map(canonicalState);

const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: jobs }), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (py.status !== 0) { console.error("python ref failed:\n", py.stderr); process.exit(1); }
const pyOut = JSON.parse(py.stdout).resolve;

console.log(`=== replay corpus cross-impl (${corpus.events.length} on-chain events, JS ⇄ Python ⇄ pinned stateHash) ===`);
let fail = 0;
heights.forEach((H, i) => {
  const pyEqJs = pyOut[i] === jsOut[i];
  const hashOk = stateHash(states[i]) === `0x${pinned.hashes[String(H)]}`;
  if (pyEqJs && hashOk) { console.log(`  ✓ @${H}`); return; }
  fail++;
  console.error(`  ✗ @${H}  py==js:${pyEqJs}  js==pin:${hashOk}`);
  if (!pyEqJs) {
    const a = jsOut[i], b = pyOut[i];
    let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
    console.error(`     first divergence at offset ${k}: JS …${a.slice(Math.max(0, k - 40), k + 60)}  PY …${b.slice(Math.max(0, k - 40), k + 60)}`);
  }
});
console.log(`\nreplay corpus cross-impl: ${heights.length - fail}/${heights.length} byte-identical, ${fail} diverged`);
process.exit(fail ? 1 : 0);
