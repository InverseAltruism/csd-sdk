// CONVENTION §33 across implementations: every case of packages/cairnx/test/vectors/events.json through the shipping
// JS rule (the built dist) and the independent Python reference (cairnx_ref.py, job "events"), requiring
//   canonicalJson(JS result)  ===  Python's canonical JSON  ===  canonicalJson(expect)
// for each case, byte for byte. The recorded blocks of packages/cairnx/test/fixtures/events-blocks.json run as one
// more blocks case, whose expected events are the pinned replay corpus sorted into the order of §33.3.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as rule from "../packages/cairnx/dist/index.js";
import { runBlockCase, runTxCase } from "./events-run.mjs";

const { canonicalJson } = rule;
const file = JSON.parse(readFileSync(new URL("../packages/cairnx/test/vectors/events.json", import.meta.url), "utf8"));
if (file.format !== 1 || canonicalJson(file.rule) !== canonicalJson(rule.CAIRNX_EVENT_RULE)) {
  console.error("events.json: expected format 1 and the rule CAIRNX_EVENT_RULE"); process.exit(1);
}
const fixture = JSON.parse(readFileSync(new URL("../packages/cairnx/test/fixtures/events-blocks.json", import.meta.url), "utf8"));
const corpus = JSON.parse(readFileSync(new URL("../packages/cairnx/test/vectors/replay-corpus.json", import.meta.url), "utf8"));
if (fixture.to !== corpus.tipHeight) { console.error(`events-blocks.json ends at ${fixture.to}, the corpus at ${corpus.tipHeight}`); process.exit(1); }
const applyOrder = (e) => [e.height, e.kind === "propose" ? 0 : 1, e.pos];
const sorted = [...corpus.events].sort((a, b) => {
  const x = applyOrder(a), y = applyOrder(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
});
const authors = Object.fromEntries(fixture.blocks.flatMap((b) => b.txs.map((t) => [t.txid, t.author])));
const recorded = { name: `recorded blocks ${fixture.from}..${fixture.to} give the corpus`, blocks: fixture.blocks, authors };
const recordedJs = runBlockCase(rule, recorded, file.rule);

const cases = [
  ...file.tx.map((c) => ({ name: c.name, js: canonicalJson(runTxCase(rule, c, file.rule)), want: canonicalJson(c.expect) })),
  ...file.blocks.map((c) => ({ name: c.name, js: canonicalJson(runBlockCase(rule, c, file.rule)), want: canonicalJson(c.expect) })),
].map((c) => ({ ...c, ok: c.js === c.want }));
// The recorded case's members are the rule's own; its events must be the corpus's.
cases.push({ name: recorded.name, js: canonicalJson(recordedJs), ok: canonicalJson(recordedJs.events ?? null) === canonicalJson(sorted) });
const job = { events: { rule: file.rule, tx: file.tx, blocks: [...file.blocks, recorded] } };
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify(job), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (py.status !== 0) { console.error("python ref failed:\n", py.stderr); process.exit(1); }
const out = JSON.parse(py.stdout).events;
const pyOut = [...out.tx, ...out.blocks];
if (pyOut.length !== cases.length) { console.error(`python answered ${pyOut.length} cases of ${cases.length}`); process.exit(1); }

console.log(`=== events rule cross-impl (CONVENTION §33: JS ⇄ Python ⇄ events.json, ${file.tx.length} tx + ${file.blocks.length} blocks cases, + ${fixture.blocks.length} recorded blocks ⇄ ${corpus.events.length} corpus events) ===`);
let fail = 0;
cases.forEach((c, i) => {
  const p = pyOut[i];
  if (c.ok && p === c.js) { console.log(`  ✓ ${c.name}`); return; }
  fail++;
  console.error(`  ✗ ${c.name}  js==expect:${c.ok}  py==js:${p === c.js}`);
  const a = c.js, b = p;
  let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
  console.error(`     first divergence at offset ${k}: JS …${a.slice(Math.max(0, k - 40), k + 60)}  PY …${b.slice(Math.max(0, k - 40), k + 60)}`);
});
console.log(`\nevents rule cross-impl: ${cases.length - fail}/${cases.length} byte-identical, ${fail} diverged`);
process.exit(fail ? 1 : 0);
