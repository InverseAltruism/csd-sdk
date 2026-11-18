// CONVENTION §34 across implementations: every case of packages/cairnx/test/vectors/hashes.json and both hashes over
// the committed corpus at every pinned height, through the shipping JS functions (the built dist) and the independent
// Python reference (cairnx_ref.py, job "hashes"), requiring JS === Python === the file, byte for byte. Two more parts
// the vector file cannot carry: the state hash of complete resolve() results (diagnostic fields included), and cases
// sent as literal JSON text, since JSON.stringify writes 100000.0 and 1e5 as 100000 and so erases those spellings.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as lib from "../packages/cairnx/dist/index.js";
import { corpusHashes, runHashCase } from "./hashes-run.mjs";

const { canonicalJson } = lib;
const vec = (f) => JSON.parse(readFileSync(new URL(`../packages/cairnx/test/vectors/${f}`, import.meta.url), "utf8"));
const file = vec("hashes.json"), corpus = vec(file.corpus.file), pinned = vec("replay-hashes.json");
const heights = Object.keys(file.corpus.heights).map(Number).sort((a, b) => a - b);
if (file.format !== 1 || heights.length < 21) { console.error("hashes.json: expected format 1 and at least 21 corpus heights"); process.exit(1); }
const python = (text) => {
  const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (py.status !== 0) { console.error("python ref failed:\n", py.stderr); process.exit(1); }
  return JSON.parse(py.stdout);
};

const out = python(JSON.stringify({ hashes: { cases: file.cases, corpus: { events: corpus.events, heights } } })).hashes;
if (out.cases.length !== file.cases.length) { console.error(`python answered ${out.cases.length} cases of ${file.cases.length}`); process.exit(1); }

// Complete resolve() results, as JSON.
const full = [["empty", [], 100_000], ...[60_000, 88_000, 117_000].map((h) => [String(h), corpus.events.filter((e) => e.height <= h), h])]
  .map(([name, events, tip]) => ({ name, state: lib.resolve(events, tip) }));
for (const f of full) if (!["events", "recaptures", "fclaims"].every((k) => k in f.state)) { console.error(`state ${f.name} lacks a diagnostic field`); process.exit(1); }

// Literal JSON text: `mk(s)` writes a case with each number spelled by `s`; a twin spells them as JSON.stringify does.
const AU = `"0x${"a1".repeat(20)}"`;
const ev = (s, h, pos, b) => `{"kind":"propose","id":"0x${b.repeat(32)}","proposer":${AU},"height":${s(h)},"pos":${s(pos)}}`;
const block = (name, h, events) => (s) => `{"name":"${name}","blocks":[{"height":${s(h)},"events":[${events.map((e) => e(s)).join(",")}]}]}`;
const asIs = (x) => x, plain = (x) => String(Number(x));
const REFUSED = canonicalJson({ steps: { error: 0 }, list: "error" });
const raw = [
  [block("raw-height-100000.0", "100000.0", [(s) => ev(s, "100000.0", "1", "11")]), "twin"],
  [block("raw-height-1e5-pos-1e0", "1e5", [(s) => ev(s, "1e5", "1e0", "11")]), "twin"],
  [block("raw-mixed-spellings-in-one-block", "100000", [(s) => ev(s, "1e5", "1.0", "11"), (s) => ev(s, "100000.0", "2", "22"), (s) => ev(s, "100000", "3e0", "33")]), "twin"],
  [block("raw-pos-negative-zero", "100000", [(s) => ev(s, "100000", "-0.0", "11")]), "twin"],
  [block("raw-height-1.5", "1.5", [(s) => ev(s, "1.5", "1", "11")]), REFUSED],
  [block("raw-pos-1.5", "100000", [(s) => ev(s, "100000", "1.5", "11")]), REFUSED],
  [block("raw-height-true", "true", [(s) => ev(s, "true", "1", "11")]), REFUSED],
  [block("raw-pos-true", "100000", [(s) => ev(s, "100000", "true", "11")]), REFUSED],
].map(([mk, want]) => {
  const c = JSON.parse(mk(asIs));
  const twin = want === "twin" ? canonicalJson(runHashCase(lib, JSON.parse(mk(plain)))) : want;
  if (want === "twin" && !/"steps":"0x/.test(twin)) { console.error(`${c.name}: its twin is refused`); process.exit(1); }
  return { name: c.name, text: mk(asIs), js: canonicalJson(runHashCase(lib, c)), want: twin };
});
const extra = python(`{"hashes":{"cases":[${raw.map((r) => r.text).join(",")}]},"stateHashes":[${full.map((f) => JSON.stringify(f.state)).join(",")}]}`);

const jsCorpus = corpusHashes(lib, corpus.events, heights);
const rows = [
  { name: "start", js: lib.EVENTS_HASH_START, py: out.start, want: file.start },
  ...file.cases.map((c, i) => ({ name: c.name, js: canonicalJson(runHashCase(lib, c)), py: out.cases[i], want: canonicalJson(c.expect) })),
  ...heights.map((h) => ({ name: `corpus@${h}`, js: canonicalJson(jsCorpus[h]), py: canonicalJson(out.corpus[h]), want: canonicalJson(file.corpus.heights[h]) })),
  ...full.map((f, i) => {
    const js = lib.stateHash(f.state);
    return { name: `complete-state@${f.name}`, js, py: extra.stateHashes[i], want: f.name in pinned.hashes ? `0x${pinned.hashes[f.name]}` : js };
  }),
  ...raw.map((r, i) => ({ name: r.name, js: r.js, py: extra.hashes.cases[i], want: r.want })),
];

console.log(`=== hashes cross-impl (CONVENTION §34: JS ⇄ Python ⇄ hashes.json, ${file.cases.length} cases + ${heights.length} corpus heights + ${full.length} complete states + ${raw.length} literal JSON cases) ===`);
let fail = 0;
for (const r of rows) {
  if (r.js === r.want && r.py === r.js) { console.log(`  ✓ ${r.name}`); continue; }
  fail++;
  console.error(`  ✗ ${r.name}  js==expect:${r.js === r.want}  py==js:${r.py === r.js}\n     JS ${r.js}\n     PY ${r.py}`);
}
console.log(`\nhashes cross-impl: ${rows.length - fail}/${rows.length} byte-identical, ${fail} diverged`);
process.exit(fail ? 1 : 0);
