// C2 — DIRECT regex-vs-regex differential (the corpus the builder-based fuzzer is structurally blind to).
// For every schema-regex field, feed RAW strings — especially trailing/embedded control chars — to the JS
// validator (.test on ^...$) and the independent Python validator (re.fullmatch) and assert identical
// accept/reject. This is the exact net that was missing: it would have caught C1 (Python re.match accepting
// a trailing "\n" that JS .test rejects), and it guards all 7 regex-gated fields against any future drift.
import { spawnSync } from "node:child_process";
import { AMOUNT_RE, ADDR_RE, TICKER_RE, HASH_RE, NAME_RE, PKEY, SALT_RE } from "../packages/cairnx/dist/index.js";

// All 7 regexes are imported from the shipping codec (single-sourced in types.ts) — no hand-copy to drift.
const JS_RE = { amount: AMOUNT_RE, addr: ADDR_RE, ticker: TICKER_RE, hash: HASH_RE, name: NAME_RE, salt: SALT_RE, pkey: PKEY };

const BASES = {
  amount: ["0", "1", "9", "100", "123456789", "01", "", "-1", "1.0", " 1", "00"],
  addr: ["0x" + "a".repeat(40), "0x" + "A".repeat(40), "0x" + "a".repeat(39), "0xabc", ""],
  ticker: ["ABC", "GOLD", "A1B2", "AB", "A".repeat(12), "A".repeat(13), "abc", "1AB", ""],
  hash: ["0x" + "a".repeat(64), "0x" + "a".repeat(63), "0x" + "A".repeat(64), "0xzz", ""],
  name: ["a", "ab", "alice", "a-b", "a".repeat(32), "a".repeat(33), "-a", "a-", "A", "a_b", ""],
  salt: ["0".repeat(16), "aAbBcCdDeEfF0011", "f".repeat(128), "f".repeat(15), "f".repeat(129), "gg", ""],
  pkey: ["a", "alice", "a.b", "a-b", "a.b.c", "a".repeat(32), ".a", "a.", "a..b", "A", ""],
};

// control chars the `$`-vs-fullmatch and TextDecoder classes care about, plus benign separators.
const TRAILERS = ["\n", "\r", "\f", "\v", "\0", "\t", " ", "", " ", " ", "\r\n", "\n\n"];
const ASTRAL = "\u{1D7D8}";

const cases = [];
for (const field of Object.keys(BASES)) {
  for (const base of BASES[field]) {
    cases.push({ field, s: base });
    for (const tr of TRAILERS) {
      cases.push({ field, s: base + tr });      // trailing control char (the C1 vector)
      cases.push({ field, s: tr + base });       // leading
      cases.push({ field, s: base.slice(0, 1) + tr + base.slice(1) }); // embedded
    }
    cases.push({ field, s: base + ASTRAL });
    cases.push({ field, s: ASTRAL + base });
  }
}

// JS side
const jsOut = cases.map((c) => JS_RE[c.field].test(c.s));
// Python side (re.fullmatch)
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ regex: cases }), encoding: "utf8", maxBuffer: 1 << 28 });
if (py.status !== 0) { console.error("python ref failed:", py.stderr); process.exit(1); }
const pyOut = JSON.parse(py.stdout).regex;

let pass = 0, fail = 0;
for (let i = 0; i < cases.length; i++) {
  if (jsOut[i] === pyOut[i]) { pass++; continue; }
  fail++;
  if (fail <= 20) console.error(`  ✗ field=${cases[i].field} s=${JSON.stringify(cases[i].s)}  JS=${jsOut[i]} PY=${pyOut[i]}`);
}
console.log(`=== C2 regex-vs-regex differential (JS .test ⇄ Python re.fullmatch) ===`);
console.log(`${pass} passed, ${fail} failed  (${cases.length} raw strings × 7 fields)`);
process.exit(fail ? 1 : 0);
