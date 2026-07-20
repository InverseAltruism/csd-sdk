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
  // B8-sdklow: statement "" is DOCUMENTED as "empty == omitted" - both impls must emit the no-statement layout
  { domain: "x.example", account: A, statement: "", uri: "https://x.example/", version: "1", chainId: CHAIN, nonce: "nonce1234", issuedAt: "2026-06-17T01:02:03Z", expirationTime: "2026-06-17T01:12:03Z" },
];

// ── B8-sdklow (REBIND, audit LOW: the SIWC zero-length-field divergence) ────────────────────────────────
// The spec (SiwcFields) requires every present field to be NON-EMPTY (statement excepted: "" == omitted).
// The JS builder throws on `requestId:""` etc., but the Python reference happily emitted `Request ID: `
// for the same input - a cross-language divergence the valid-case differential above can never see
// (two honest implementations disagreeing on whether an artifact is buildable at all). These deny legs
// require BOTH implementations to REFUSE. (The wallet-builder half of the audit LOW lives in cairn-wallet
// and rides its own batch; this closes the csd-sdk half.)
const base5 = { domain: "x.example", account: A, uri: "https://x.example/", version: "1", chainId: CHAIN, nonce: "nonce1234", issuedAt: "2026-06-17T01:02:03Z", expirationTime: "2026-06-17T01:12:03Z" };
const denyCases = [
  ["requestId empty", { ...base5, requestId: "" }],
  ["expirationTime empty", { ...base5, expirationTime: "" }],
  ["notBefore empty", { ...base5, notBefore: "" }],
  ["resource entry empty", { ...base5, resources: ["https://x.example/a", ""] }],
  ["domain empty", { ...base5, domain: "" }],
  ["uri empty", { ...base5, uri: "" }],
  ["issuedAt empty", { ...base5, issuedAt: "" }],
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
// deny legs: each case must be REFUSED by the JS builder (throw) AND by the Python reference (nonzero
// exit on a single-case job). A side that builds what the other refuses is the divergence under test.
for (const [name, f] of denyCases) {
  let jsRefused = false;
  try { buildSiwcMessage(f); } catch { jsRefused = true; }
  const pd = spawnSync("python3", [new URL("./siwc_ref.py", import.meta.url).pathname], { input: JSON.stringify({ cases: [f] }), encoding: "utf8" });
  const pyRefused = pd.status !== 0;
  if (jsRefused && pyRefused) console.log(`  ✅ deny ${name}: BOTH refuse`);
  else { fail++; console.error(`  ❌ deny ${name}: JS ${jsRefused ? "refuses" : "BUILDS"}, Python ${pyRefused ? "refuses" : "BUILDS"} - zero-length divergence`); }
}

if (fail) { console.error(`SIWC crosscheck FAILED: ${fail}`); process.exit(1); }
console.log(`SIWC crosscheck OK: ${cases.length} build cases + ${denyCases.length} deny legs - JS ⇄ Python byte-identical${vectors ? " ⇄ pinned vectors" : ""}`);
