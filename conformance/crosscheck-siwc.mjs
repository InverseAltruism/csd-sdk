// SIWC cross-language conformance: feed the same field-sets to the shipping JS impl
// (@inversealtruism/csd-siwc) and the independent Python reference (siwc_ref.py) and assert
// byte-identical message + digest, plus equality with the pinned vectors. Run:
//   node conformance/crosscheck-siwc.mjs          (verify JS ⇄ Python ⇄ pinned)
//   node conformance/crosscheck-siwc.mjs emit      (regenerate packages/siwc/test/vectors.json)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildSiwcMessage, siwcDigest, CSD_CHAIN_MAINNET } from "../packages/siwc/dist/index.js";

const CHAIN = CSD_CHAIN_MAINNET;
const A = "0x" + "ab".repeat(20);
const cases = [
  { domain: "casino.example", account: A, uri: "https://casino.example/login", version: "1", chainId: CHAIN, nonce: "abc123def456", issuedAt: "2026-06-17T12:00:00Z", expirationTime: "2026-06-17T12:10:00Z" },
  { domain: "casino.example", account: A, statement: "Sign in to CSD Casino.", uri: "https://casino.example/login", version: "1", chainId: CHAIN, nonce: "abc123def456", issuedAt: "2026-06-17T12:00:00Z", expirationTime: "2026-06-17T12:10:00Z" },
  { domain: "app.example:8443", account: A, statement: "Welcome 🦄 — sign in", uri: "https://app.example:8443/", version: "1", chainId: CHAIN, nonce: "Zx9Qw8Rt7Yu6", issuedAt: "2026-06-17T00:00:00Z", expirationTime: "2026-06-17T00:05:00Z", notBefore: "2026-06-17T00:00:00Z", requestId: "req-42", resources: ["https://app.example/a", "https://app.example/b"] },
  // astral codepoint + U+FFFF boundary inside the statement (UTF-8 hashing must agree across langs)
  { domain: "x.example", account: A, statement: "𝕊ign ￿ edge", uri: "https://x.example/", version: "1", chainId: CHAIN, nonce: "nonce1234", issuedAt: "2026-06-17T01:02:03Z", expirationTime: "2026-06-17T01:12:03Z" },
];

const jsResults = cases.map((f) => { const m = buildSiwcMessage(f); return { message: m, digest: siwcDigest(m) }; });

if (process.argv[2] === "emit") {
  writeFileSync(new URL("../packages/siwc/test/vectors.json", import.meta.url), JSON.stringify(jsResults, null, 2) + "\n");
  console.log(`wrote ${jsResults.length} SIWC vectors`);
  process.exit(0);
}

const py = spawnSync("python3", [new URL("./siwc_ref.py", import.meta.url).pathname], { input: JSON.stringify({ cases }), encoding: "utf8" });
if (py.status !== 0) { console.error("python ref failed:", py.stderr); process.exit(1); }
const pyResults = JSON.parse(py.stdout).results;

const vURL = new URL("../packages/siwc/test/vectors.json", import.meta.url);
const vectors = existsSync(vURL) ? JSON.parse(readFileSync(vURL, "utf8")) : null;

let fail = 0;
for (let i = 0; i < cases.length; i++) {
  const j = jsResults[i], p = pyResults[i], v = vectors?.[i];
  const okJsPy = j.message === p.message && j.digest === p.digest;
  const okPin = v ? (j.message === v.message && j.digest === v.digest) : true;
  if (!okJsPy || !okPin) {
    fail++;
    console.error(`  ❌ case ${i}: JS⇄Py=${okJsPy} pinned=${okPin}`);
    if (!okJsPy) console.error(`     JS ${j.digest}\n     PY ${p.digest}`);
  } else console.log(`  ✅ case ${i}: JS == Python${v ? " == pinned" : ""}  (${j.digest.slice(0, 14)}…)`);
}
if (fail) { console.error(`SIWC crosscheck FAILED: ${fail}/${cases.length}`); process.exit(1); }
console.log(`SIWC crosscheck OK: ${cases.length} cases — JS ⇄ Python byte-identical${vectors ? " ⇄ pinned vectors" : ""}`);
