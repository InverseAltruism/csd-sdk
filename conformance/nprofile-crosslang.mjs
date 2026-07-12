// v1.9 nprofile (doc 36) — cross-language conformance + resolver semantics + dormancy.
// JS reference (cairnx-core dist) vs the INDEPENDENT Python port (cairnx_ref.py): byte-identical
// canonical state on every scenario, plus the doc-36 §5 edge-case ledger asserted on the JS side.
// A determinism fork (key sort, integer-index ordering, gate height) OR a wrong clear/owner-gate
// would diverge here. Non-self-fulfilling: the two impls share no code.
import { spawnSync } from "node:child_process";
import {
  parseRecord, resolve, canonicalState, nameClaim, nameProfile, nameXfer,
  V11_HEIGHT, V12_HEIGHT, V13_HEIGHT, V14_HEIGHT, V15_HEIGHT, V16_HEIGHT, V17_HEIGHT, V18_HEIGHT, V19_HEIGHT, V20_HEIGHT,
  V21_HEIGHT, V22_HEIGHT, V23_HEIGHT, V24_HEIGHT, V25_HEIGHT, V26_HEIGHT, V27_HEIGHT, V28_HEIGHT,
  CLAIM_WINDOW_BLOCKS, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS, FCLAIM_MAX_EPOCH_AHEAD, FILL_TIP_MARGIN, RESERVED_NAMES,
  COMMIT_MAX_BLOCKS, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, MAX_PENDING_REG, MAX_OFFER_EPOCHS, DEPLOY_FEE,
  EPOCH_LEN, TREASURY_ADDR, PROFILE_MAX_KEYS, PROFILE_MAX_VALUE_BYTES, nameRegFee,
} from "../packages/cairnx/dist/index.js";
import { canonicalJson, payloadHash } from "../packages/codec/dist/index.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ FAIL: " + n)); if (c) console.log("  ✓ " + n); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
let seq = 0;
const txid = () => "0x" + String(++seq).padStart(64, "0");
const prop = (height, who, built, paidTo = {}) => ({
  kind: "propose", id: txid(), proposer: who, uri: built.uri, payloadHash: built.payloadHash,
  expiresEpoch: 9_999_999, height, pos: 0, paidTo,
});
const regFee = (name, h) => ({ [TREASURY_ADDR]: nameRegFee(name, h).toString() });
const reg = (h, who, name) => prop(h, who, nameClaim({ name }), regFee(name, h));
const prof = (h, who, name, p) => prop(h, who, nameProfile({ name, p }));
const xfer = (h, who, name, to) => prop(h, who, nameXfer({ name, to }));

const R = V19_HEIGHT - 5;     // register (≥ V11, fee paid)
const P = V19_HEIGHT + 5;     // set profile (≥ V19)
const TIP = V19_HEIGHT + 10;
const PRE = V19_HEIGHT - 10;  // below the v1.9 gate

// ── PART 1: record parse parity (FULL parse_record both sides) ──
const recordCorpus = [
  ["clean nprofile", { v:1,t:"nprofile",name:"alice",p:{display:"Alice","com.twitter":"alice",avatar:"https://a.co/x.png"} }, true],
  ["empty p (clear)", { v:1,t:"nprofile",name:"alice",p:{} }, true],
  ["integer-index keys", { v:1,t:"nprofile",name:"alice",p:{"2":"a","10":"b",avatar:"c"} }, true],
  ["dotted 32-char key", { v:1,t:"nprofile",name:"alice",p:{["a"+".b".repeat(15)]:"x"} }, true],
  ["emoji value", { v:1,t:"nprofile",name:"alice",p:{avatar:"\u{1F600}"} }, true],
  ["256-byte value OK", { v:1,t:"nprofile",name:"alice",p:{bio:"x".repeat(256)} }, true],
  ["16 keys OK", { v:1,t:"nprofile",name:"alice",p:Object.fromEntries(Array.from({length:16},(_,i)=>["k"+i,"v"])) }, true],
  ["astral key REJECTED", { v:1,t:"nprofile",name:"alice",p:{"\u{1D7D8}":"x"} }, false],
  ["uppercase key REJECTED", { v:1,t:"nprofile",name:"alice",p:{Avatar:"x"} }, false],
  ["trailing-newline key REJECTED", { v:1,t:"nprofile",name:"alice",p:{"avatar\n":"x"} }, false],
  ["leading-dot key REJECTED", { v:1,t:"nprofile",name:"alice",p:{".eth":"x"} }, false],
  ["trailing-dot key REJECTED", { v:1,t:"nprofile",name:"alice",p:{"com.":"x"} }, false],
  ["underscore key REJECTED", { v:1,t:"nprofile",name:"alice",p:{a_b:"x"} }, false],
  ["space key REJECTED", { v:1,t:"nprofile",name:"alice",p:{"a b":"x"} }, false],
  ["33-char key REJECTED", { v:1,t:"nprofile",name:"alice",p:{["a".repeat(33)]:"x"} }, false],
  ["non-string value REJECTED", { v:1,t:"nprofile",name:"alice",p:{n:5} }, false],
  ["bool value REJECTED", { v:1,t:"nprofile",name:"alice",p:{n:true} }, false],
  ["nested-object value REJECTED", { v:1,t:"nprofile",name:"alice",p:{x:{a:"1"}} }, false],
  ["array value REJECTED", { v:1,t:"nprofile",name:"alice",p:{x:["1"]} }, false],
  ["extra top-level key REJECTED", { v:1,t:"nprofile",name:"alice",p:{},evil:1 }, false],
  ["missing p REJECTED", { v:1,t:"nprofile",name:"alice" }, false],
  ["array p REJECTED", { v:1,t:"nprofile",name:"alice",p:[] }, false],
  ["bad name REJECTED", { v:1,t:"nprofile",name:"Alice",p:{} }, false],
  ["reserved name REJECTED", { v:1,t:"nprofile",name:"admin",p:{} }, false],
  ["oversize value REJECTED", { v:1,t:"nprofile",name:"alice",p:{bio:"x".repeat(257)} }, false],
  ["17 keys REJECTED", { v:1,t:"nprofile",name:"alice",p:Object.fromEntries(Array.from({length:17},(_,i)=>["k"+i,"v"])) }, false],
];
const jsParse = recordCorpus.map(([, r]) => parseRecord(canonicalJson(r), payloadHash(r)) !== null);

// ── PART 2: resolve scenarios (byte-identical canonical state + semantic asserts) ──
const P_RICH = { "2": "a", "10": "b", avatar: "\u{1F600}", "com.twitter": "alice", display: "Alice" };
const s5reg = reg(PRE - 1, ALICE, "alice");   // shared by S5 + S7 so the dormancy equality isolates the no-op nprofile
const scenarios = {
  S1_set:        { ev: [reg(R, ALICE, "alice"), prof(P, ALICE, "alice", P_RICH)], tip: TIP },
  S2_xfer_clear: { ev: [reg(R, ALICE, "alice"), prof(P, ALICE, "alice", P_RICH), xfer(P + 1, ALICE, "alice", BOB)], tip: TIP },
  S3_lww:        { ev: [reg(R, ALICE, "alice"), prof(P, ALICE, "alice", { a: "1" }), prof(P + 1, ALICE, "alice", { b: "2" })], tip: TIP },
  S4_empty_clear:{ ev: [reg(R, ALICE, "alice"), prof(P, ALICE, "alice", { a: "1" }), prof(P + 1, ALICE, "alice", {})], tip: TIP },
  S5_dormant:    { ev: [s5reg, prof(PRE, ALICE, "alice", P_RICH)], tip: PRE + 2 },
  S6_owner_gate: { ev: [reg(R, ALICE, "alice"), prof(P, BOB, "alice", { a: "1" })], tip: TIP },
  S7_reg_only:   { ev: [s5reg], tip: PRE + 2 },   // identical register event → isolates the dormant no-op
};
const jsStates = {};
for (const [k, s] of Object.entries(scenarios)) jsStates[k] = canonicalState(resolve(s.ev, s.tip));

// ── boundary scenarios: place an nprofile EXACTLY at the v1.9 gate and one block below, so each
// impl applies ITS OWN V19_HEIGHT — a gate-height drift between impls diverges the canonical state. ──
scenarios.S8_at_gate = { ev: [reg(V19_HEIGHT - 5, ALICE, "alice"), prof(V19_HEIGHT, ALICE, "alice", { a: "1" })], tip: V19_HEIGHT };
scenarios.S9_below_gate = { ev: [reg(V19_HEIGHT - 5, ALICE, "alice"), prof(V19_HEIGHT - 1, ALICE, "alice", { a: "1" })], tip: V19_HEIGHT - 1 };
for (const k of ["S8_at_gate", "S9_below_gate"]) jsStates[k] = canonicalState(resolve(scenarios[k].ev, scenarios[k].tip));

// ── Python independent outputs ──
const order = Object.keys(scenarios);
const job = { parseFull: recordCorpus.map(([, r]) => r), resolve: order.map((k) => ({ events: scenarios[k].ev, tipHeight: scenarios[k].tip })), consts: 1 };
const py = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify(job), encoding: "utf8" });
if (py.status !== 0) { console.error("python ref failed:", py.stderr); process.exit(1); }
const pj = JSON.parse(py.stdout);

console.log("=== v1.9 nprofile cross-language conformance (JS ⇄ Python) ===");
console.log("-- record parse parity (full parse_record both sides) --");
recordCorpus.forEach(([label, , expect], i) =>
  ok(`parse "${label}": JS==Py==${expect}`, jsParse[i] === pj.parseFull[i] && jsParse[i] === expect));

console.log("-- consensus constant PARITY (H1: a gate-height drift is invisible to JS-derived heights) --");
const JS_CONSTS = {
  V11_HEIGHT, V12_HEIGHT, V13_HEIGHT, V14_HEIGHT, V15_HEIGHT, V16_HEIGHT, V17_HEIGHT, V18_HEIGHT, V19_HEIGHT, V20_HEIGHT,
  V21_HEIGHT, V22_HEIGHT, V23_HEIGHT, V24_HEIGHT, V25_HEIGHT, V26_HEIGHT, V27_HEIGHT, V28_HEIGHT,
  CLAIM_WINDOW_BLOCKS, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS, FCLAIM_MAX_EPOCH_AHEAD, FILL_TIP_MARGIN,
  COMMIT_MAX_BLOCKS, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, MAX_PENDING_REG, MAX_OFFER_EPOCHS, DEPLOY_FEE,
  EPOCH_LEN, TREASURY_ADDR, PROFILE_MAX_KEYS, PROFILE_MAX_VALUE_BYTES,
};
for (const [k, v] of Object.entries(JS_CONSTS)) ok(`const ${k}: JS(${v}) == Python(${pj.consts[k]})`, v === pj.consts[k]);
// CX-CONF-RESERVED-UNGATED: RESERVED_NAMES is consensus but was outside the parity loop. Compare as a sorted list.
ok(`const RESERVED_NAMES: JS == Python (sorted)`, JSON.stringify([...RESERVED_NAMES].sort()) === JSON.stringify(pj.consts.RESERVED_NAMES));

console.log("-- resolve: canonical state byte-identical (incl. gate-boundary S8/S9) --");
order.forEach((k, i) => ok(`${k} canonicalState JS≡Python`, jsStates[k] === pj.resolve[i]));
ok("S8 nprofile EXACTLY at V19_HEIGHT is applied", resolve(scenarios.S8_at_gate.ev, scenarios.S8_at_gate.tip).names["alice"].profile?.a === "1");
ok("S9 nprofile one block BELOW V19_HEIGHT is dormant", resolve(scenarios.S9_below_gate.ev, scenarios.S9_below_gate.tip).names["alice"].profile === undefined);

console.log("-- resolver semantics (the doc-36 §5 ledger, JS side) --");
const st = (k) => resolve(scenarios[k].ev, scenarios[k].tip).names["alice"];
ok("S1 profile is set as written", eq(st("S1_set").profile, P_RICH));
ok("S2 a SALE/transfer clears profile + moves owner to buyer", st("S2_xfer_clear").owner === BOB && st("S2_xfer_clear").profile === undefined);
ok("S3 last-write-wins (2nd nprofile replaces the whole map)", eq(st("S3_lww").profile, { b: "2" }));
ok("S4 empty p clears the profile", st("S4_empty_clear").profile === undefined);
ok("S5 nprofile below V19 is a DORMANT no-op (profile absent)", st("S5_dormant").profile === undefined);
ok("S5 dormancy: pre-v1.9 state byte-IDENTICAL to register-only (no field shift)", jsStates.S5_dormant === jsStates.S7_reg_only);
ok("S6 owner-gate: a non-owner cannot set the profile", st("S6_owner_gate").profile === undefined);
ok("S7 integer-index keys round-trip in state (canonicalState handles them)", st("S1_set").profile["2"] === "a" && st("S1_set").profile["10"] === "b");

// ── JS-only: lone-surrogate value rejected (avoids non-UTF8 stdin transport to Python) ──
ok("lone-surrogate value REJECTED (JS)", parseRecord(canonicalJson({ v:1,t:"nprofile",name:"alice",p:{avatar:"\uD835"} }), payloadHash({ v:1,t:"nprofile",name:"alice",p:{avatar:"\uD835"} })) === null);

console.log(`\nnprofile cross-lang: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
