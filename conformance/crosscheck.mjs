// META-1 (audit) — cross-IMPLEMENTATION conformance: feed the JS reference (the shipping codec /
// cairnx-core) and the INDEPENDENT Python reference (cairnx_ref.py) the SAME corpus
// and assert byte-identity on every determinism-critical primitive. A JS-only fork (a UTF-16-vs-
// codepoint key sort, a dropped onlyKeys decoy guard) would diverge here. This
// is the second-implementation co-sign the byte-contract previously lacked.
import { spawnSync } from "node:child_process";
// relative dist paths (workspace package names don't resolve from this standalone dir)
import { canonicalJson, payloadHash } from "../packages/codec/dist/index.js";
import { parseRecord } from "../packages/cairnx/dist/index.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };

// ── corpus: the fork-prone shapes the audits found ──
const canonCorpus = [
  { b: 1, a: 2, "\u{1D7D8}": 3 },                 // astral key — UTF-16 vs codepoint sort divergence
  { "￿": 1, "\u{10000}": 2 },                // BMP-max vs first astral (the exact boundary)
  { z: [3, { y: 1, x: 2 }], a: 9 },               // nested
  { t: "name", name: "alice", salt: "00ff", v: 1 },
  "scalar", 42, true, null, [1, [2, [3]]],
];
const recordCorpus = [
  // [label, record, bothShouldAccept]
  ["clean name", { v: 1, t: "name", name: "alice", salt: "00112233445566778899aabbccddeeff" }, true],
  ["name + astral decoy key", { v: 1, t: "name", name: "alice", salt: "00112233445566778899aabbccddeeff", "\u{1D7D8}": 1 }, false],
  ["name + lone-surrogate decoy", { v: 1, t: "name", name: "alice", salt: "00112233445566778899aabbccddeeff", "\uD800x": 1 }, false],
  ["clean transfer", { v: 1, t: "transfer", ticker: "GOLD", to: "0x" + "11".repeat(20), amount: "100" }, true],
  ["transfer + extra key", { v: 1, t: "transfer", ticker: "GOLD", to: "0x" + "11".repeat(20), amount: "100", evil: 1 }, false],
];
// C1/C2 end-to-end: raw records with a trailing-\n (or other control char) in a regex-gated field, run
// through the FULL parse gate on both sides (JS parseRecord ⇄ Python parse_record). Both MUST reject the
// dirty ones and accept the clean one — the exact fork the .match→.fullmatch fix closes. [label, record, expectAccept]
const SALT16 = "00112233445566778899aabbccddeeff";
const TO20 = "0x" + "11".repeat(20);
const c1Corpus = [
  ["clean name", { v: 1, t: "name", name: "alice", salt: SALT16 }, true],
  ["name trailing \\n", { v: 1, t: "name", name: "alice\n", salt: SALT16 }, false],
  ["name embedded \\n", { v: 1, t: "name", name: "al\nice", salt: SALT16 }, false],
  ["name trailing \\r", { v: 1, t: "name", name: "alice\r", salt: SALT16 }, false],
  ["salt trailing \\n", { v: 1, t: "name", name: "alice", salt: SALT16 + "\n" }, false],
  ["clean transfer", { v: 1, t: "transfer", ticker: "GOLD", to: TO20, amount: "100" }, true],
  ["ticker trailing \\n", { v: 1, t: "transfer", ticker: "GOLD\n", to: TO20, amount: "100" }, false],
  ["amount trailing \\n", { v: 1, t: "transfer", ticker: "GOLD", to: TO20, amount: "100\n" }, false],
  ["to-addr trailing \\n", { v: 1, t: "transfer", ticker: "GOLD", to: TO20 + "\n", amount: "100" }, false],
  ["v is boolean true (Python True==1 trap)", { v: true, t: "transfer", ticker: "GOLD", to: TO20, amount: "100" }, false],
  ["transfer ts 2^53 (unsafe int)", { v: 1, t: "transfer", ticker: "GOLD", to: TO20, amount: "100", ts: 2 ** 53 }, false],
  ["transfer ts safe", { v: 1, t: "transfer", ticker: "GOLD", to: TO20, amount: "100", ts: 1781387000 }, true],
  ["offer ts 2^53 (unsafe int)", { v: 1, t: "offer", give: { ticker: "GOLD", amount: "10" }, want: { value: "100" }, ts: 2 ** 53 }, false],
  ["offer ts safe", { v: 1, t: "offer", give: { ticker: "GOLD", amount: "10" }, want: { value: "100" }, ts: 1781387000 }, true],
  ["bid ts 2^53 (unsafe int)", { v: 1, t: "bid", want: { ticker: "GOLD", amount: "10" }, give: { value: "100" }, ts: 2 ** 53 }, false],
  ["bid ts safe", { v: 1, t: "bid", want: { ticker: "GOLD", amount: "10" }, give: { value: "100" }, ts: 1781387000 }, true],
  // canonical_json raises on these in Python; each must read as one rejected record, not abort the batch
  ["transfer ts float (Python canonical_json raises)", { v: 1, t: "transfer", ticker: "GOLD", to: TO20, amount: "100", ts: 1.5 }, false],
  ["name lone-surrogate value (Python payload_hash raises)", { v: 1, t: "name", name: "alice\uD800", salt: SALT16 }, false],
];

// ── JS reference outputs ──
const jsCanon = canonCorpus.map((v) => { try { return { ok: true, v: canonicalJson(v) }; } catch (e) { return { ok: false, err: String(e.message || e) }; } });
const jsPh = canonCorpus.filter((v) => v && typeof v === "object").map((v) => payloadHash(v));
const phCorpus = canonCorpus.filter((v) => v && typeof v === "object");
const jsRecords = recordCorpus.map(([, r]) => parseRecord(canonicalJson(r), payloadHash(r)) !== null);

const jsC1 = c1Corpus.map(([, r]) => parseRecord(canonicalJson(r), payloadHash(r)) !== null);

// ── Python independent outputs ──
const job = { canon: canonCorpus, payloadHash: phCorpus, records: recordCorpus.map(([, r]) => r), parseFull: c1Corpus.map(([, r]) => r) };
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify(job), encoding: "utf8" });
if (py.status !== 0) { console.error("python ref failed:", py.stderr); process.exit(1); }
const pj = JSON.parse(py.stdout);

console.log("=== META-1 cross-implementation conformance (JS ⇄ Python) ===");
// canonical JSON byte-identity
jsCanon.forEach((j, i) => {
  const p = pj.canon[i];
  ok(`canonicalJson #${i} byte-identical (${JSON.stringify(canonCorpus[i]).slice(0, 32)})`, j.ok === p.ok && (j.ok ? j.v === p.v : true));
});
// payload hash identity
jsPh.forEach((h, i) => ok(`payloadHash #${i} identical`, h === pj.payloadHash[i]));
// record validation: same accept/reject AND matches the expectation
recordCorpus.forEach(([label, , expect], i) => {
  ok(`record gate "${label}": JS==Python==${expect}`, jsRecords[i] === pj.records[i] && jsRecords[i] === expect);
});
// C1/C2 end-to-end: full parse gate agrees AND matches the expected accept/reject (trailing-control-char fork)
c1Corpus.forEach(([label, , expect], i) => {
  ok(`parse gate "${label}": JS==Python==${expect}`, jsC1[i] === pj.parseFull[i] && jsC1[i] === expect);
});

console.log(`\nMETA-1 cross-impl: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
