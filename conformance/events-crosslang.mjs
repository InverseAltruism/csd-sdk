// CONVENTION §33 across implementations: every case of packages/cairnx/test/vectors/events.json through the shipping
// JS rule (the built dist) and the independent Python reference (cairnx_ref.py, job "events"), requiring
//   canonicalJson(JS result)  ===  Python's canonical JSON  ===  canonicalJson(expect)
// for each case, byte for byte.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as rule from "../packages/cairnx/dist/index.js";
import { runBlockCase, runTxCase } from "./events-run.mjs";

const { canonicalJson } = rule;
const file = JSON.parse(readFileSync(new URL("../packages/cairnx/test/vectors/events.json", import.meta.url), "utf8"));
if (file.format !== 1 || canonicalJson(file.rule) !== canonicalJson(rule.CAIRNX_EVENT_RULE)) {
  console.error("events.json: expected format 1 and the rule CAIRNX_EVENT_RULE"); process.exit(1);
}
const cases = [
  ...file.tx.map((c) => ({ name: c.name, js: canonicalJson(runTxCase(rule, c, file.rule)), want: canonicalJson(c.expect) })),
  ...file.blocks.map((c) => ({ name: c.name, js: canonicalJson(runBlockCase(rule, c, file.rule)), want: canonicalJson(c.expect) })),
];
const job = { events: { rule: file.rule, tx: file.tx, blocks: file.blocks } };
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify(job), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (py.status !== 0) { console.error("python ref failed:\n", py.stderr); process.exit(1); }
const out = JSON.parse(py.stdout).events;
const pyOut = [...out.tx, ...out.blocks];
if (pyOut.length !== cases.length) { console.error(`python answered ${pyOut.length} cases of ${cases.length}`); process.exit(1); }

console.log(`=== events rule cross-impl (CONVENTION §33: JS ⇄ Python ⇄ events.json, ${file.tx.length} tx + ${file.blocks.length} blocks cases) ===`);
let fail = 0;
cases.forEach((c, i) => {
  const p = pyOut[i];
  if (c.js === c.want && p === c.js) { console.log(`  ✓ ${c.name}`); return; }
  fail++;
  console.error(`  ✗ ${c.name}  js==expect:${c.js === c.want}  py==js:${p === c.js}`);
  const a = c.js, b = p;
  let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
  console.error(`     first divergence at offset ${k}: JS …${a.slice(Math.max(0, k - 40), k + 60)}  PY …${b.slice(Math.max(0, k - 40), k + 60)}`);
});
console.log(`\nevents rule cross-impl: ${cases.length - fail}/${cases.length} byte-identical, ${fail} diverged`);
process.exit(fail ? 1 : 0);
