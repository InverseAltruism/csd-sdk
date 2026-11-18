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

// Cases sent as literal JSON text, since JSON.stringify writes 100000.0 and 1e5 as 100000 and so erases those spellings:
// `mk(s)` writes a case with each number spelled by `s`, and its twin spells them as JSON.stringify does. The u64 fields
// stay decimal strings, as in the vector file.
const hex = (b, n = 32) => `"0x${b.repeat(n)}"`, PAY = `[{"value":"7","scriptPubkey":${hex("b2", 20)}}]`;
const attest = (s, pos, score, conf, txid = "e1") => `{"pos":${s(pos)},"txid":${hex(txid)},"app":{"type":"Attest","proposalId":${hex("e3")},"score":${s(score)},"confidence":${s(conf)}},"outputs":${PAY}}`;
const propose = (s, pos) => `{"pos":${s(pos)},"txid":${hex("e3")},"app":{"type":"Propose","domain":"cairnx:v1","payloadHash":${hex("ef")},"uri":"{}","expiresEpoch":"5000"},"outputs":${PAY}}`;
const txCase = (name, h, tx, rule = "") => (s) =>
  `{"name":"${name}"${rule ? `,"rule":{"domain":"cairnx:v1","activationHeight":${s(rule)}}` : ""},"input":${tx(s).replace(/^\{/, `{"height":${s(h)},`)},"author":${hex("a1", 20)}}`;
const blockCase = (name, h, txs) => (s) => `{"name":"${name}","blocks":[{"height":${s(h)},"txs":[${txs.map((t) => t(s)).join(",")}]}],"authors":{"0x${"e1".repeat(32)}":${hex("a1", 20)},"0x${"e3".repeat(32)}":${hex("a1", 20)}}}`;
const coinbase = (s) => `{"pos":${s("0.0")},"txid":${hex("c0")},"app":{"type":"None"},"outputs":${PAY}}`;
const asIs = (x) => x, plain = (x) => String(Number(x));
const rawTx = [
  [txCase("raw-attest-spellings", "100000.0", (s) => attest(s, "4.0", "1e2", "0.0")), "twin"],
  [txCase("raw-propose-height-1e5-pos-3e0", "1e5", (s) => propose(s, "3e0")), "twin"],
  [txCase("raw-rule-activation-29860.0", "29860", (s) => propose(s, "1"), "29860.0"), "twin"],
  [txCase("raw-pos-1.5", "100000", (s) => attest(s, "1.5", "100", "0")), "error"],
  [txCase("raw-score-1.5", "100000", (s) => attest(s, "1", "1.5", "0")), "error"],
  [txCase("raw-height-true", "true", (s) => attest(s, "1", "100", "0")), "error"],
  [txCase("raw-pos-true", "100000", (s) => attest(s, "true", "100", "0")), "error"],
  [txCase("raw-confidence-true", "100000", (s) => attest(s, "1", "100", "true")), "error"],
];
const rawBlocks = [
  [blockCase("raw-block-mixed-spellings", "1e5", [coinbase, (s) => propose(s, "1"), (s) => attest(s, "2.0", "1e2", "0")]), "twin"],
  [blockCase("raw-block-pos-1.5", "100000", [coinbase, (s) => propose(s, "1.5")]), { error: 0 }],
  [blockCase("raw-block-height-true", "true", [coinbase, (s) => propose(s, "1")]), { error: 0 }],
];
const literal = (list, run, isResult) => list.map(([mk, want]) => {
  const c = JSON.parse(mk(asIs));
  const twin = want === "twin" ? run(rule, JSON.parse(mk(plain)), file.rule) : want;
  if (want === "twin" && !isResult(twin)) { console.error(`${c.name}: its twin gives no result`); process.exit(1); }
  return { name: c.name, text: mk(asIs), js: canonicalJson(run(rule, c, file.rule)), want: canonicalJson(twin) };
});
const lit = [...literal(rawTx, runTxCase, (r) => r !== null && typeof r === "object"), ...literal(rawBlocks, runBlockCase, (r) => Array.isArray(r?.events) && r.events.length > 0)];
const pyLit = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], {
  input: `{"events":{"rule":${JSON.stringify(file.rule)},"tx":[${lit.slice(0, rawTx.length).map((c) => c.text).join(",")}],"blocks":[${lit.slice(rawTx.length).map((c) => c.text).join(",")}]}}`,
  encoding: "utf8",
});
if (pyLit.status !== 0) { console.error("python ref failed on the literal JSON cases:\n", pyLit.stderr); process.exit(1); }
const litOut = JSON.parse(pyLit.stdout).events;
lit.forEach((c, i) => {
  cases.push({ name: c.name, js: c.js, ok: c.js === c.want });
  pyOut.push(i < rawTx.length ? litOut.tx[i] : litOut.blocks[i - rawTx.length]);
});

console.log(`=== events rule cross-impl (CONVENTION §33: JS ⇄ Python ⇄ events.json, ${file.tx.length} tx + ${file.blocks.length} blocks cases, + ${fixture.blocks.length} recorded blocks ⇄ ${corpus.events.length} corpus events, + ${lit.length} literal JSON cases) ===`);
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
