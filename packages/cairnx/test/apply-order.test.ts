// CONVENTION §3 and §33.3, the apply order: applyOrder on each of its four keys, its sign symmetry over a seeded sample,
// and that the committed replay corpus sorted with it is the order resolve() applies, read from the applied log.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  V14_HEIGHT, applyOrder, eventId, resolve, type AttestEvent, type ChainEvent, type ProposeEvent, type ReasonCode,
} from "../src/index.js";

let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; };
const hex = (c: string) => "0x" + c.repeat(64);
const prop = (height: number, pos: number, id: string): ProposeEvent =>
  ({ kind: "propose", id, proposer: "0x" + "a1".repeat(20), uri: "{}", payloadHash: hex("0"), expiresEpoch: 0, height, pos, paidTo: {} });
const att = (height: number, pos: number, txid: string): AttestEvent =>
  ({ kind: "attest", txid, proposalId: hex("e"), attester: "0x" + "b2".repeat(20), score: 1, confidence: 0, height, pos, paidTo: {} });
// a applies before b, and the swapped call says so too.
const before = (a: ChainEvent, b: ChainEvent) => applyOrder(a, b) < 0 && applyOrder(b, a) > 0;

// ── eventId ──
ok("eventId of a Propose is its id", eventId(prop(1, 1, hex("1"))) === hex("1"));
ok("eventId of an Attest is its txid, not its proposal id", eventId(att(1, 1, hex("2"))) === hex("2"));

// ── each key, with every later key pointing the other way ──
ok("a lower height applies first: an Attest at 100 pos 9 before a Propose at 101 pos 1",
  before(att(100, 9, hex("f")), prop(101, 1, hex("0"))));
ok("in one block a Propose applies before an Attest: Propose pos 9 before Attest pos 1",
  before(prop(100, 9, hex("f")), att(100, 1, hex("0"))));
ok("same height and kind, the lower position first (Proposes)", before(prop(100, 1, hex("f")), prop(100, 2, hex("0"))));
ok("same height and kind, the lower position first (Attests)", before(att(100, 1, hex("f")), att(100, 2, hex("0"))));
ok("equal height, kind and position: the lower id first (Proposes)", before(prop(100, 1, hex("a")), prop(100, 1, hex("b"))));
ok("equal height, kind and position: the lower txid first (Attests)", before(att(100, 1, hex("a")), att(100, 1, hex("b"))));
// Ordinal order puts "B" (0x42) before "a" (0x61); a locale collation puts "a" first.
ok("the id order is ordinal code-unit order, not a collation", before(prop(100, 1, "0xB"), prop(100, 1, "0xa")));
const p = prop(100, 3, hex("c")), a = att(100, 3, hex("c"));
ok("the same event gives zero (a Propose)", applyOrder(p, p) === 0 && applyOrder(p, { ...p }) === 0);
ok("the same event gives zero (an Attest)", applyOrder(a, a) === 0 && applyOrder(a, { ...a }) === 0);

// ── sign symmetry over a seeded sample from a small key space, so equal keys are common ──
let seed = 0x9e3779b9;
const rnd = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const ids = ["0x0a", "0x0b", "0xA0", "0x0a0"];
const pick = (): ChainEvent => (rnd(2) ? prop : att)(rnd(3), rnd(3), ids[rnd(ids.length)]!);
const PAIRS = 20_000;
let asym = 0, zeroWrong = 0, zeros = 0;
const sameKeys = (x: ChainEvent, y: ChainEvent) => x.height === y.height && x.kind === y.kind && x.pos === y.pos && eventId(x) === eventId(y);
for (let i = 0; i < PAIRS; i++) {
  const x = pick(), y = pick(), xy = applyOrder(x, y), yx = applyOrder(y, x);
  if (Math.sign(xy) !== -Math.sign(yx)) asym++;
  if ((xy === 0) !== sameKeys(x, y)) zeroWrong++;
  if (xy === 0) zeros++;
}
ok(`antisymmetric over ${PAIRS} seeded pairs (${asym} not)`, asym === 0);
ok(`zero exactly when all four keys are equal (${zeros} equal pairs, ${zeroWrong} wrong)`, zeroWrong === 0 && zeros > 0);

// ── the committed corpus: sorted with applyOrder is the order resolve() applies ──
const corpus = JSON.parse(readFileSync(new URL("./vectors/replay-corpus.json", import.meta.url), "utf8")) as { tipHeight: number; events: ChainEvent[] };
const sorted = [...corpus.events].sort(applyOrder);
ok("the corpus in feed order is not already in apply order (the sort does work)",
  corpus.events.some((e, i) => i > 0 && applyOrder(corpus.events[i - 1]!, e) > 0));
const log = resolve(corpus.events, corpus.tipHeight).events;
const at = new Map(corpus.events.map((e) => [`${e.height}:${e.pos}`, e]));
ok(`each of the ${log.length} log entries is the corpus event at its height and position, by id, once`,
  corpus.events.length === 1133 && log.length === 1129 && new Set(log.map((l) => l.id)).size === log.length &&
  log.every((l) => eventId(at.get(`${l.height}:${l.pos}`) ?? prop(-1, -1, "")) === l.id));
// §16: from V14 a cancel's effect and its log entry wait for the end of its block, in apply order among themselves.
const DEFERRED = new Set<ReasonCode>(["OFFER_CANCELLED", "OFFER_CLOSED_BEFORE_CANCEL", "OFFER_CANCEL_HOLD_LIVE", "OFFER_BULK_CANCELLED"]);
const logged = new Map(log.map((l) => [l.id, l]));
const expected: string[] = [];
let deferredCount = 0;
for (let i = 0; i < sorted.length;) {
  const h = sorted[i]!.height, now: string[] = [], later: string[] = [];
  for (; i < sorted.length && sorted[i]!.height === h; i++) {
    const l = logged.get(eventId(sorted[i]!));
    if (!l) continue;
    (h >= V14_HEIGHT && l.code !== undefined && DEFERRED.has(l.code) ? later : now).push(l.id);
  }
  deferredCount += later.length;
  expected.push(...now, ...later);
}
const actual = log.map((l) => l.id);
const first = actual.findIndex((id, i) => id !== expected[i]);
ok(`the applied log is the corpus sorted with applyOrder, a block's ${deferredCount} deferred cancels at its end (first difference ${first})`,
  first === -1 && expected.length === actual.length);

console.log(`apply order: ${pass} passed (${zeros} of ${PAIRS} seeded pairs equal; ${actual.length} log entries, ${deferredCount} deferred cancels)`);
