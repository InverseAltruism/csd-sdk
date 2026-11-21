// Token moves (CONVENTION §41), the moves an applied entry records where balances move. Three layers: the shipped vectors
// (test/vectors/moves.json, written by hand in conformance/gen-moves-vectors.mjs); conformance/moves-check.mjs (the
// identity, the mint totals, each fill's moves from its fill record, none on a refused entry) over the replay corpus at
// every pinned height and over every case file; and one honest transfer and one honest fill written out on the call
// shape a reader sends, resolve(events, tip) and then events[i].moves.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkMoves } from "../../../conformance/moves-check.mjs";
import {
  CONF_TOKEN_FILL, DEPLOY_FEE, SCORE_FILL, TREASURY_ADDR, V29_HEIGHT, deploy, epochOf, mint, offer, resolve, transfer,
  type CairnXState, type ChainEvent, type ProposeEvent, type TokenMove,
} from "../src/index.js";

// Each check runs to the end and is counted, so a mutation reports every check it turns red.
let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try {
    const r = fn() as unknown;
    if (r !== undefined) throw new Error(`test "${name}" returned a value - use assert`);
    pass++; console.log("  ok", name);
  } catch (e) { fail++; console.log(`  FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
};
const read = (f: string) => JSON.parse(readFileSync(new URL(`./vectors/${f}`, import.meta.url), "utf8"));
const problemsOf = (st: CairnXState) => checkMoves(st, TREASURY_ADDR).problems;

type Entry = { id: string; kind: string; moves: TokenMove[] };
type Case = { name: string; tipHeight: number; events: ChainEvent[]; moves: Entry[] };
const vectors = read("moves.json") as { format: number; cases: Case[] };

t("moves.json is format 1, its 12 cases hold every leg", () => {
  assert.equal(vectors.format, 1);
  assert.equal(vectors.cases.length, 12);
  const legs = new Set(vectors.cases.flatMap((c) => c.moves.flatMap((e) => e.moves.map((m) => m.leg))));
  assert.deepEqual([...legs].sort(), ["fee", "fill", "mint", "sale", "xfer"]);
});
for (const c of vectors.cases) {
  const st = resolve(c.events, c.tipHeight);
  t(`vector ${c.name}: the entries that carry moves, and their moves`, () =>
    assert.deepEqual(st.events.filter((e) => Object.hasOwn(e, "moves")).map((e) => ({ id: e.id, kind: e.kind, moves: e.moves })), c.moves));
  t(`vector ${c.name}: moves-check`, () => assert.deepEqual(problemsOf(st), []));
}

const legTotal = { xfer: 0, mint: 0, fill: 0, sale: 0, fee: 0 };
const tally = (st: CairnXState) => {
  const r = checkMoves(st, TREASURY_ADDR);
  for (const l of Object.keys(legTotal) as TokenMove["leg"][]) legTotal[l] += r.legs[l];
  return r;
};
const corpus = read("replay-corpus.json") as { tipHeight: number; events: ChainEvent[] };
const heights = [...Object.keys((read("replay-hashes.json") as { hashes: Record<string, string> }).hashes).map(Number), corpus.tipHeight];
let corpusPairs = 0;
t(`moves-check over the replay corpus at ${heights.length} heights`, () => {
  for (const h of heights) {
    const r = tally(resolve(corpus.events.filter((e) => e.height <= h), h));
    assert.deepEqual(r.problems, [], `at ${h}`);
    corpusPairs += r.pairs;
  }
  for (const [l, n] of Object.entries(legTotal)) assert.ok(n > 0, `the corpus has ${l} moves`);
});

const caseFiles = ["cases.json", "cases-rules.json", "cases-v29.json", "cases-convention.json", "forward.json"];
let caseInputs = 0;
t(`moves-check over every case of ${caseFiles.join(", ")} and the resolve cases of codes.json`, () => {
  const all = [
    ...caseFiles.flatMap((f) => (read(f) as { cases: { name: string; events: ChainEvent[]; tipHeight: number }[] }).cases.map((c) => ({ ...c, name: `${f}:${c.name}` }))),
    ...(read("codes.json") as { resolve: { name: string; events: ChainEvent[]; tipHeight: number }[] }).resolve.map((c) => ({ ...c, name: `codes.json:${c.name}` })),
  ];
  for (const c of all) { assert.deepEqual(tally(resolve(c.events, c.tipHeight)).problems, [], c.name); caseInputs++; }
});

t("every entry of the corpus at its tip keeps the 0.2.7 keys in their order, `moves` only last", () => {
  for (const e of resolve(corpus.events, corpus.tipHeight).events) {
    const keys = Object.keys(e);
    if (Object.hasOwn(e, "moves")) assert.equal(keys.pop(), "moves", `${e.id}: moves is the last key`);
    assert.ok(["height,pos,id,kind,ok,code", "height,pos,id,kind,ok,code,note"].includes(keys.join()), `${e.id}: ${keys.join()}`);
  }
});

// The honest paths, on the call shape a reader sends.
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const H = V29_HEIGHT + 12_000;
let n = 0x7e000000;
const id = () => "0x" + (n++).toString(16).padStart(64, "0");
const propose = (b: { uri: string; payloadHash: string }, height: number, proposer: string, paidTo: Record<string, string> = {}, expiresEpoch = 9_000_000_000): ProposeEvent =>
  ({ kind: "propose", id: id(), proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch, height, pos: 0, paidTo });
const fee = { [TREASURY_ADDR]: String(DEPLOY_FEE) };

t("an honest transfer: its entry is the 0.2.7 entry plus one xfer move", () => {
  const events = [
    propose(deploy({ ticker: "DUST", decimals: 0, supply: "1000", mint: "open", mintLimit: "1000" }), H, A, fee),
    propose(mint({ ticker: "DUST", amount: "100" }), H + 1, A),
    propose(transfer({ ticker: "DUST", to: B, amount: "40" }), H + 2, A),
  ];
  const st = resolve(events, H + 3);
  assert.equal(JSON.stringify(st.events[2]), JSON.stringify({
    height: H + 2, pos: 0, id: events[2]!.id, kind: "transfer", ok: true, code: "TOKEN_TRANSFERRED",
    moves: [{ leg: "xfer", ticker: "DUST", from: A, to: B, amount: "40" }],
  }));
  assert.deepEqual(st.balances.DUST, { [A]: { available: "60", locked: "0" }, [B]: { available: "40", locked: "0" } });
});

t("an honest token-for-token fill: sale to payto, fee to the treasury, then the give", () => {
  const o = propose(offer({ give: { ticker: "DUST", amount: "10" }, want: { ticker: "GEMS", amount: "2000" } }), H + 4, A, {}, epochOf(H) + 50);
  const events: ChainEvent[] = [
    propose(deploy({ ticker: "DUST", decimals: 0, supply: "1000", mint: "issuer" }), H, A, fee),
    propose(mint({ ticker: "DUST", amount: "100" }), H + 1, A),
    propose(deploy({ ticker: "GEMS", decimals: 0, supply: "100000", mint: "issuer" }), H + 2, B, fee),
    propose(mint({ ticker: "GEMS", amount: "100000" }), H + 3, B),
    o,
    { kind: "attest", txid: id(), proposalId: o.id, attester: B, score: SCORE_FILL, confidence: CONF_TOKEN_FILL, height: H + 5, pos: 0, paidTo: {} },
  ];
  const st = resolve(events, H + 6);
  const fill = st.events[5]!;
  assert.equal(fill.code, "FILL_APPLIED");
  assert.deepEqual(fill.moves, [
    { leg: "sale", ticker: "GEMS", from: B, to: A, amount: "2000" },
    { leg: "fee", ticker: "GEMS", from: B, to: TREASURY_ADDR, amount: "30" },
    { leg: "fill", ticker: "DUST", from: A, to: B, amount: "10" },
  ]);
  assert.deepEqual(problemsOf(st), []);
});

// moves-check is the seal's oracle: each doctored log below must fail it.
const doctor = (name: string, edit: (st: CairnXState) => void, expect: RegExp) => t(`moves-check refuses ${name}`, () => {
  const c = vectors.cases.find((x) => x.name === "token-fill-token")!;
  const st = structuredClone(resolve(c.events, c.tipHeight));
  edit(st);
  const p = problemsOf(st);
  assert.ok(p.some((x) => expect.test(x)), p.join(" | ") || "no problem found");
});
const fillEntry = (st: CairnXState) => st.events.find((e) => e.kind === "fill" && e.ok)!;
doctor("a fill without its fee move", (st) => { fillEntry(st).moves!.splice(1, 1); }, /the fill record gives|identity/);
doctor("a mint move above the credit", (st) => { st.events.find((e) => e.kind === "mint")!.moves![0]!.amount = "101"; }, /mint moves of DUST sum to 101|identity/);
doctor("moves on a refused entry", (st) => {
  st.events.push({ height: 1, pos: 0, id: "0x01", kind: "transfer", ok: false, code: "TOKEN_BALANCE_LOW", moves: [{ leg: "xfer", ticker: "DUST", from: A, to: B, amount: "1" }] });
}, /carries moves/);
doctor("an applied transfer without moves", (st) => { st.events.push({ height: 1, pos: 0, id: "0x02", kind: "transfer", ok: true, code: "TOKEN_TRANSFERRED" }); }, /not one xfer move/);
doctor("a zero move", (st) => { fillEntry(st).moves!.push({ leg: "fill", ticker: "DUST", from: A, to: B, amount: "0" }); }, /bad amount 0|the fill record gives/);

console.log(`token moves: ${pass} passed, ${fail} failed (${vectors.cases.length} vectors; corpus at ${heights.length} heights, ${corpusPairs} pair checks; ${caseInputs} case inputs; moves per leg ${JSON.stringify(legTotal)})`);
if (fail) process.exit(1);
