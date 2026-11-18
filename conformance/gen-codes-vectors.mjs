// Generator for the vectors of CONVENTION §40 (packages/cairnx/test/vectors/codes.json), the reason codes. Each resolve
// case is a short event stream whose expected log entry (kind and code) is written by hand next to each event, or
// none where the resolver writes no entry; the built dist must meet every expectation before the file is written,
// and no expectation is read back from resolve(). The expected `ok` is the code's outcome in the table. Rewrites the
// whole file, one case per line.
// Run: node conformance/gen-codes-vectors.mjs (after building packages/cairnx).
import { writeFileSync } from "node:fs";
import * as R from "../packages/cairnx/dist/index.js";

const T = R.TREASURY_ADDR;
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const HASH = "0x" + "ef".repeat(32);
let n = 0xc0de0000;
const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
const fee = (v) => ({ [T]: String(v) });

// A Propose and its expected entry: [kind, code], or null for no entry.
const P = (built, height, who, expect, { paid = {}, ee = R.epochOf(height) + 1000, pos = 1 } = {}) => ({
  event: { kind: "propose", id: nid(), proposer: who, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch: ee, height, pos, paidTo: paid },
  expect,
});

const cases = [];
const C = (name, tipHeight, items) => cases.push({ name, tipHeight, items });

// ── tokens (src/resolve/tokens.ts) ──
const H = 50_000;
const issuer = (ticker, supply = "1000") => R.deploy({ ticker, decimals: 0, supply, mint: "issuer" });
const DEPLOYED = ["deploy", "TOKEN_DEPLOYED"];
C("deploy-applied", H + 5, [P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) })]);
C("deploy-ticker-taken", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(issuer("AAA"), H + 1, B, ["deploy", "TOKEN_TICKER_TAKEN"], { paid: fee(R.DEPLOY_FEE) }),
]);
C("deploy-fee-unpaid", H + 5, [P(issuer("AAA"), H, A, ["deploy", "TREASURY_FEE_UNPAID"], { paid: fee(R.DEPLOY_FEE - 1) })]);
C("mint-issuer", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
]);
C("mint-open", H + 5, [
  P(R.deploy({ ticker: "OPN", decimals: 0, supply: "1000", mint: "open", mintLimit: "10" }), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "OPN" }), H + 1, B, ["mint", "TOKEN_MINTED"]),
]);
C("mint-unknown-ticker", H + 5, [P(R.mint({ ticker: "NOPE", amount: "1" }), H, A, ["mint", "TOKEN_UNKNOWN"])]);
C("mint-supply-exhausted", H + 5, [
  P(issuer("AAA", "10"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
  P(R.mint({ ticker: "AAA", amount: "1" }), H + 2, A, ["mint", "TOKEN_SUPPLY_EXHAUSTED"]),
]);
C("mint-not-issuer", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "1" }), H + 1, B, ["mint", "TOKEN_NOT_ISSUER"]),
]);
C("mint-issuer-without-amount", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA" }), H + 1, A, ["mint", "TOKEN_MINT_AMOUNT_REQUIRED"]),
]);
C("transfer-applied", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
  P(R.transfer({ ticker: "AAA", to: B, amount: "10" }), H + 2, A, ["transfer", "TOKEN_TRANSFERRED"]),
]);
C("transfer-unknown-ticker", H + 5, [P(R.transfer({ ticker: "NOPE", to: B, amount: "1" }), H, A, ["transfer", "TOKEN_UNKNOWN"])]);
C("transfer-balance-low", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
  P(R.transfer({ ticker: "AAA", to: B, amount: "11" }), H + 2, A, ["transfer", "TOKEN_BALANCE_LOW"]),
]);
C("tmeta-applied", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.tokenMeta({ ticker: "AAA", hash: HASH }), H + 1, A, ["tmeta", "TOKEN_META_SET"]),
]);
C("tmeta-before-v15", R.V15_HEIGHT, [
  P(issuer("AAA"), R.V11_HEIGHT, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.tokenMeta({ ticker: "AAA", hash: HASH }), R.V15_HEIGHT - 1, A, ["tmeta", "GATE_NOT_ACTIVE"]),
]);
C("tmeta-unknown-ticker", H + 5, [P(R.tokenMeta({ ticker: "NOPE", hash: HASH }), H, A, ["tmeta", "TOKEN_UNKNOWN"])]);
C("tmeta-not-issuer", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.tokenMeta({ ticker: "AAA", hash: HASH }), H + 1, B, ["tmeta", "TOKEN_NOT_ISSUER"]),
]);

// ── check every expectation against the built dist, then write ──
const outcome = (code) => R.REASON_CODE_OUTCOME[code];
const fails = [];
const key = (x) => JSON.stringify(x);
const resolveCases = cases.map(({ name, tipHeight, items }) => {
  const events = items.map((i) => i.event);
  const expect = items.filter((i) => i.expect !== null).map(({ event, expect: [kind, code] }) => {
    if (outcome(code) === undefined) fails.push(`${name}: ${code} is not in the table`);
    return [event.kind === "propose" ? event.id : event.txid, kind, outcome(code) === "applied", code];
  });
  const got = R.resolve(events, tipHeight).events.map((e) => [e.id, e.kind, e.ok, e.code ?? null]);
  const want = expect.map(key).sort(), have = got.map(key).sort();
  if (key(want) !== key(have)) fails.push(`${name}: expected ${key(expect)}, resolve() wrote ${key(got)}`);
  return { name, tipHeight, events, expect };
});
const names = new Set();
for (const c of cases) { if (names.has(c.name)) fails.push(`${c.name}: repeated name`); names.add(c.name); }
if (fails.length) { for (const f of fails) console.error(`  EXPECTATION FAILED ${f}`); console.error(`\n${fails.length} expectation(s) failed: codes.json not written`); process.exit(1); }

const path = new URL("../packages/cairnx/test/vectors/codes.json", import.meta.url);
writeFileSync(path, `{"format":1,"generatedFrom":"hand-written expectations, conformance/gen-codes-vectors.mjs",\n`
  + `"resolve":[\n${resolveCases.map((c) => JSON.stringify(c)).join(",\n")}\n],\n"records":[\n]}\n`);
const codes = new Set(resolveCases.flatMap((c) => c.expect.map((e) => e[3])));
console.log(`wrote ${resolveCases.length} resolve cases (${codes.size} codes) -> codes.json (every hand-written expectation held)`);
