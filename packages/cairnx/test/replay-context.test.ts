// The held replay context (src/replay-context.ts) against resolve(): each answer compared with resolve() over the same
// prefix at that tip, whole result in the typed text of conformance/sweep-streams.mjs. Walked: every height of the
// sweep streams from two below their first event to their tip (D, over 284,000 blocks, at its dense tips; the four
// malformed ones until the context refuses), every event height of the replay corpus with the height below each and
// every pinned height, the growth streams at 500 at every event height and their tips; the same walks with answers at
// seeded random steps against one step per block; every answer re-read at the end (a later advance changes none), and,
// on the streams, every answer written over (no later answer moves). The seal walks wider (step (i)). Then a reorg (a context thrown away and rebuilt), each refusal with the context unchanged and the
// caller's fallback, the one predicate both the fold and the context read, and the sloppy-mode refusal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { growthStreams } from "../../../conformance/growth-streams.mjs";
import { contextWalk, denseTips, stringifyNumbers, sweepStreams, upTo, type ContextWalk } from "../../../conformance/sweep-streams.mjs";
import * as R from "../src/index.js";
import type { ChainEvent } from "../src/index.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; };
const total = { inputs: 0, prefixes: 0, answers: 0, refusals: 0, scribbled: 0, kept: 0, tried: 0, blocked: 0, stepCompares: 0 };
const check = (name: string, w: ContextWalk) => {
  assert.deepEqual(w.diffs, [], `${name}: answers that differ from resolve()`);
  assert.deepEqual(w.badRefusals, [], `${name}: a refusal whose code does not match the predicate`);
  assert.deepEqual(w.threwDiff, [], `${name}: a throw that is not resolve()'s`);
  assert.equal(w.changed, 0, `${name}: an answer changed after it was returned`);
  total.kept += w.kept; total.tried += w.tried; total.blocked += w.blocked;
};
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const heightsOf = (events: readonly ChainEvent[]) => [...new Set(events.map((e) => e.height).filter(R.isChainHeight))].sort((a, b) => a - b);
let seed = 0x5eed;
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// One input: the walk at every tip of `tips` (answers re-read at the end), the walk with every answer written over, and
// a walk answering at a seeded random subset of those tips, compared with the one-step walk at each of its tips.
const walkAll = (name: string, events: readonly ChainEvent[], tips: number[], finalTip?: unknown, scribbled = true) => {
  total.inputs++; total.prefixes += heightsOf(events).length;
  const one = contextWalk(R, events, tips, { finalTip });
  check(name, one);
  total.answers += one.answers; total.refusals += one.refusals;
  if (scribbled) { const w = contextWalk(R, events, tips, { finalTip, scribbleAnswers: true }); check(`${name} (answers written over)`, w); total.scribbled += w.answers; }
  const some = tips.filter(() => rng() < 0.2);
  const stepped = contextWalk(R, events, some);
  check(`${name} (random steps)`, stepped);
  for (const [t, text] of stepped.texts) { assert.equal(text, one.texts.get(t), `${name}@${t}: random steps against one step per block`); total.stepCompares++; }
  return one;
};

// ── the differential ──
const malformed = new Set(["X", "X2", "Y", "Y2"]);
for (const s of sweepStreams(R)) {
  const hs = heightsOf(s.events), tip = Number(s.tipHeight);
  const w = walkAll(`sweep ${s.key}`, s.events, Number.isSafeInteger(tip) && tip - hs[0]! <= 20_000 ? range(hs[0]! - 2, tip) : denseTips(s.events, s.tipHeight, R.EPOCH_LEN), s.tipHeight);
  ok(malformed.has(s.key) ? w.refusals === 1 && w.refusalCodes.domain === 1 : w.refusals === 0, `sweep ${s.key}: ${malformed.has(s.key) ? "refused once, for the domain" : "answered at every tip"}`);
}
const corpus = JSON.parse(readFileSync(new URL("./vectors/replay-corpus.json", import.meta.url), "utf8")) as { events: ChainEvent[] };
const pins = Object.keys(JSON.parse(readFileSync(new URL("./vectors/replay-hashes.json", import.meta.url), "utf8")).hashes).map(Number);
walkAll("corpus", corpus.events, [...new Set([...heightsOf(corpus.events).flatMap((h) => [h - 1, h]), ...pins])].sort((a, b) => a - b), undefined, false);
for (const s of growthStreams(R, 500)) walkAll(`growth ${s.key}`, s.events, [...new Set([...heightsOf(s.events), ...s.tips, s.tipHeight])].sort((a, b) => a - b));

// ── a reorg: the context on the old branch is thrown away and a new one built on the new branch ──
let reorgs = 0;
for (const s of sweepStreams(R).filter((x) => !malformed.has(x.key))) {
  const hs = heightsOf(s.events), fork = hs[Math.floor(hs.length / 2)]!;
  const old = R.newReplayContext();
  old.advance(Number(s.tipHeight), [...s.events]);
  old.stateAt(Number(s.tipHeight));
  const branch = [...s.events.filter((e) => e.height <= fork), ...s.events.filter((e) => e.height > fork).filter((_, i) => i % 2 === 0).map((e) => ({ ...e, height: e.height + 1 }))];
  const tip = Number(s.tipHeight) + 1, fresh = R.newReplayContext();
  fresh.advance(fork, branch.filter((e) => e.height <= fork));
  fresh.advance(tip, branch.filter((e) => e.height > fork));
  assert.equal(stringifyNumbers(fresh.stateAt(tip)), stringifyNumbers(R.resolve(branch, tip)), `${s.key}: the rebuilt context after a reorg at ${fork}`);
  reorgs++;
}
ok(reorgs === 8, "a context rebuilt after a reorg equals resolve() on the new branch, on each in-domain sweep stream");

// ── refusals: the context unchanged, and the caller's fallback ──
{
  const s = sweepStreams(R).find((x) => x.key === "A")!;
  const hs = heightsOf(s.events), h = hs[2]!, ctx = R.newReplayContext();
  ctx.advance(h, upTo(s.events, h));
  const before = stringifyNumbers(ctx.stateAt(h));
  const unchanged = (code: string, call: () => unknown) => {
    let got: unknown;
    try { call(); } catch (e) { got = e; }
    ok(got instanceof R.ReplayContextRefusal && got.code === code, `"${code}" refused`);
    ok(ctx.height === h && stringifyNumbers(ctx.stateAt(h)) === before, `"${code}": the context's height and answer unchanged`);
  };
  const late = s.events.find((e) => e.height === h)!, next = s.events.find((e) => e.height > h)!;
  unchanged("domain", () => ctx.advance(h + 5, [{ ...next, height: "90005" as unknown as number }]));
  unchanged("domain", () => ctx.advance(Number.NaN, []));
  unchanged("order", () => ctx.advance(h - 1, []));
  unchanged("order", () => ctx.advance(next.height, [late]));
  unchanged("order", () => ctx.advance(next.height - 1, [next]));
  unchanged("tip", () => ctx.stateAt(h + 1));
  unchanged("tip", () => ctx.stateAt(h - 1));
  // after each refusal the honest call goes through and still equals resolve()
  ctx.advance(Number(s.tipHeight), s.events.filter((e) => e.height > h));
  ok(stringifyNumbers(ctx.stateAt(Number(s.tipHeight))) === stringifyNumbers(R.resolve(s.events, Number(s.tipHeight))), "after the refusals the context goes on to equal resolve() at the tip");
  // the caller's fallback for a domain refusal: resolve() over the same events, the full replay (stream Y, pinned
  // against 0.2.8 by sweep.test.ts)
  const y = sweepStreams(R).find((x) => x.key === "Y")!, cy = R.newReplayContext();
  let code: unknown;
  try { cy.advance(90_001, [...y.events]); } catch (e) { code = (e as R.ReplayContextRefusal).code; }
  ok(code === "domain" && cy.height === -1, "a stream with a string height is refused before any write");
  ok(R.stateHash(R.resolve(y.events, y.tipHeight)).slice(2, 18) === "39077cf82797df0b", "and the caller's resolve() over the same events gives the full replay's answer");
}
{
  // a handler that throws (a null proposer): resolve() throws over the same events, and the context is then broken
  const s = sweepStreams(R).find((x) => x.key === "A")!;
  const hs = heightsOf(s.events), h = hs[1]!, ctx = R.newReplayContext();
  ctx.advance(h, upTo(s.events, h));
  const bad = { ...s.events.find((e) => e.height > h && e.kind === "propose")!, proposer: null } as unknown as ChainEvent;
  const events = [...upTo(s.events, h), bad];
  let fromResolve = "", fromContext = "";
  try { R.resolve(events, bad.height); } catch (e) { fromResolve = String(e); }
  try { ctx.advance(bad.height, [bad]); } catch (e) { fromContext = String(e); }
  ok(fromResolve !== "" && fromContext === fromResolve, "a throwing handler: advance throws resolve()'s error");
  for (const call of [() => ctx.stateAt(h), () => ctx.advance(bad.height + 1, [])]) {
    let got: unknown;
    try { call(); } catch (e) { got = e; }
    ok(got instanceof R.ReplayContextRefusal && got.code === "broken" && ctx.height === h, `"broken" refused, the height unchanged`);
  }
}

// ── constructed: a duplicate id across two advances at V29 or above (the growth edge streams hold the duplicated
// offer id around a same-block ocancel below V29) ──
{
  const s = sweepStreams(R).find((x) => x.key === "A")!;
  const first = s.events.find((e) => e.kind === "propose")!, repeat = { ...first, height: first.height + 3 };
  const events = [...s.events, repeat];
  ok(first.height >= R.V29_HEIGHT, "the stream lies at V29 or above");
  const w = contextWalk(R, events, range(first.height - 1, Number(s.tipHeight) + 3));
  check("a duplicate id across two advances", w);
  ok(w.answers > 0, "a duplicate id across two advances: each answer equals resolve()");
}
// ── the one predicate ──
{
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const fold = src("resolve.ts"), context = src("replay-context.ts");
  ok(/const inDomain = [^\n]*\bisChainHeight\(height\)/.test(fold) && /\bisChainHeight\b[^\n]*\} from "\.\/types\.js"/.test(fold.replace(/\n\s*/g, " ")), "the fold's split reads isChainHeight from types.ts");
  ok(/import \{[^}]*\bisChainHeight\b[^}]*\} from "\.\/types\.js"/.test(context) && /!isChainHeight\(toHeight\)/.test(context) && /!isChainHeight\(e\.height\)/.test(context), "the context's refusal reads the same isChainHeight");
  ok(!/Number\.isSafeInteger/.test(fold) && !/Number\.isSafeInteger/.test(context), "neither holds a second safe-integer rule");
  const values: unknown[] = [0, 1, -5, 2 ** 53 - 1, Number.NaN, Infinity, -Infinity, 0.5, 2 ** 53, "90000", "x9", "", null, undefined, true, [90000], {}, 90000n];
  for (const v of values) {
    let code: unknown = "answered";
    try { R.newReplayContext().advance(v as number, []); } catch (e) { code = (e as R.ReplayContextRefusal).code; }
    assert.equal(code === "domain", !R.isChainHeight(v), `the context refuses ${String(v)} exactly when isChainHeight does`);
    assert.equal(R.isChainHeight(v), Number.isSafeInteger(v), `isChainHeight(${String(v)}) is Number.isSafeInteger`);
  }
  pass++;
}

// ── sloppy mode: the frozen shared parts rely on a write to a frozen object throwing ──
{
  const dist = new URL("../dist/index.cjs", import.meta.url);
  const code = readFileSync(dist, "utf8");
  ok(code.startsWith('"use strict";'), "the CommonJS build declares strict mode");
  const mod = { exports: {} as Record<string, unknown> };
  const run = new vm.Script(`(function (exports, require, module) {${code.slice('"use strict";'.length)}\n})`, { filename: "index-sloppy.cjs" }).runInThisContext();
  run(mod.exports, createRequire(dist), mod);
  let got: unknown;
  try { (mod.exports.newReplayContext as () => unknown)(); } catch (e) { got = e; }
  ok((got as { code?: string })?.code === "sloppy", "a context refuses to start where a write to a frozen shared part would be ignored instead of throwing (sloppy mode)");
}

console.log(`replay context: ${pass} passed; ${total.inputs} inputs, ${total.prefixes} event heights; one step per block: ${total.answers} answers equal to resolve() and ${total.refusals} refusals; ${total.stepCompares} answers at random steps equal to one step per block; ${total.kept} answers re-read unchanged after later advances; ${total.scribbled} answers written over (${total.tried} writes, ${total.blocked} refused by a frozen part) with every later answer equal to resolve(); ${reorgs} reorgs`);
