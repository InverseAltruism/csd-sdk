// Generator for the vectors of CONVENTION §34 (packages/cairnx/test/vectors/hashes.json). Each case states the facts it
// exists for (`want`): a value rebuilt here byte by byte with node:crypto, the result of another case it must equal or
// differ from, or a refusal. The shipping JS functions (the built dist) must meet them before their results are
// recorded as `expect`. The corpus part pins both hashes over replay-corpus.json at every height of replay-hashes.json;
// its state hashes must be those pins. hashes-crosslang.mjs replays the file against the Python reference.
// Run: node conformance/gen-hashes-vectors.mjs (after building packages/cairnx).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as lib from "../packages/cairnx/dist/index.js";
import { corpusHashes, runHashCase } from "./hashes-run.mjs";

const { canonicalJson } = lib;
const START = "0x" + "00".repeat(32);
const sha = (b) => createHash("sha256").update(b).digest();

// §34.2 by hand: blocks as [height, [[pos, txid, author], ...]] in the order hashed.
function byHand(blocks, from = START) {
  let e = Buffer.from(from.slice(2), "hex");
  for (const [h, rows] of blocks) {
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(BigInt(h));
    const body = rows.map(([p, id, who]) => {
      const pos = Buffer.alloc(4);
      pos.writeUInt32BE(p);
      return Buffer.concat([pos, Buffer.from(id.slice(2), "hex"), Buffer.from(who.slice(2), "hex")]);
    });
    e = sha(Buffer.concat([e, sha(Buffer.concat([head, ...body]))]));
  }
  return "0x" + e.toString("hex");
}

const H = 100_000, MAX_H = 2 ** 53 - 1, MAX_P = 2 ** 32 - 1;
const AU = "0x" + "a1".repeat(20), AV = "0x" + "b2".repeat(20);
const id = (n) => "0x" + n.toString(16).padStart(64, "0");
const DIGITS = "0x" + "0123456789abcdef".repeat(4);
const P = (height, pos, txid, proposer = AU) => ({ kind: "propose", id: txid, proposer, height, pos });
const A = (height, pos, txid, attester = AU) => ({ kind: "attest", txid, attester, height, pos });
const blk = (height, events) => ({ height, events });
const rows = (events) => events.map((e) => [e.pos, e.kind === "propose" ? e.id : e.txid, e.kind === "propose" ? e.proposer : e.attester]);

const C = [];
const c = (name, blocks, want, prev) => C.push({ name, ...(prev !== undefined ? { prev } : {}), blocks, want });

const one = [P(H, 1, DIGITS), A(H, 3, id(2))], two = [P(H + 5, 2, id(3), AV)];
c("one-block", [blk(H, one)], { value: byHand([[H, rows(one)]]) });
c("two-blocks", [blk(H, one), blk(H + 5, two)], { value: byHand([[H, rows(one)], [H + 5, rows(two)]]) });
c("empty-block-between", [blk(H, one), blk(H + 2, []), blk(H + 5, two)], { sameAs: "two-blocks" });
c("empty-blocks-only", [blk(H, []), blk(H + 1, [])], { value: START });
c("no-blocks", [], { value: START });
{
  const posOrder = [A(H, 1, id(10)), P(H, 2, id(11))];
  c("attest-before-propose", [blk(H, posOrder)], { value: byHand([[H, rows(posOrder)]]) });
  c("attest-before-propose-in-apply-order", [blk(H, [posOrder[1], posOrder[0]])], { sameAs: "attest-before-propose" });
}
c("listed-out-of-position-order", [blk(H, [one[1], one[0]]), blk(H + 5, two)], { sameAs: "two-blocks" });
c("same-order-other-positions", [blk(H, [P(H, 2, DIGITS), A(H, 7, id(2))]), blk(H + 5, [P(H + 5, 4, id(3), AV)])], { differs: "two-blocks" });
c("differs-in-an-author", [blk(H, [one[0], A(H, 3, id(2), AV)]), blk(H + 5, two)], { differs: "two-blocks" });
c("differs-in-a-position", [blk(H, [one[0], A(H, 4, id(2))]), blk(H + 5, two)], { differs: "two-blocks" });
c("differs-in-a-height", [blk(H, one), blk(H + 6, [P(H + 6, 2, id(3), AV)])], { differs: "two-blocks" });
c("differs-in-a-txid", [blk(H, [one[0], A(H, 3, id(4))]), blk(H + 5, two)], { differs: "two-blocks" });
c("kind-is-not-hashed", [blk(H, [one[0], P(H, 3, id(2))]), blk(H + 5, two)], { sameAs: "two-blocks" });
c("other-fields-are-not-read", [blk(H, [{ ...one[0], uri: "{}", paidTo: { [AU]: "1" } }, { ...one[1], score: 1 }]), blk(H + 5, two)], { sameAs: "two-blocks" });
c("range-maxima", [blk(MAX_H, [P(MAX_H, MAX_P, id(5))])], { value: byHand([[MAX_H, [[MAX_P, id(5), AU]]]]) });
c("height-and-position-zero", [blk(0, [P(0, 0, id(6))])], { value: byHand([[0, [[0, id(6), AU]]]]) });
c("continues-from-prev", [blk(H + 9, [A(H + 9, 1, id(7))])], { value: byHand([[H, rows(one)], [H + 5, rows(two)], [H + 9, [[1, id(7), AU]]]]) },
  byHand([[H, rows(one)], [H + 5, rows(two)]]));
c("prev-with-an-empty-block", [blk(H, [])], { value: byHand([[H, rows(one)]]) }, byHand([[H, rows(one)]]));

// Refusals.
c("two-heights-in-one-step", [blk(H, [P(H, 1, id(1)), P(H + 1, 2, id(2))])],
  { steps: { error: 0 }, list: byHand([[H, [[1, id(1), AU]]], [H + 1, [[2, id(2), AU]]]]) });
c("event-height-not-the-step-height", [blk(H, [P(H + 1, 1, id(1))])], { steps: { error: 0 }, list: byHand([[H + 1, [[1, id(1), AU]]]]) });
c("repeated-position", [blk(H, [P(H, 2, id(1)), A(H, 2, id(2))])], { steps: { error: 0 }, list: "error" });
c("height-below-the-previous", [blk(H + 1, [P(H + 1, 1, id(1))]), blk(H, [P(H, 1, id(2))])],
  { steps: byHand([[H + 1, [[1, id(1), AU]]], [H, [[1, id(2), AU]]]]), list: "error" });
c("height-twice", [blk(H, [P(H, 1, id(1))]), blk(H + 1, [P(H + 1, 1, id(2))]), blk(H, [P(H, 2, id(3))])], { list: "error" });
c("txid-31-bytes", [blk(H, [P(H, 1, "0x" + "ab".repeat(31))])], { steps: { error: 0 }, list: "error" });
c("txid-upper-case", [blk(H, [P(H, 1, "0x" + "AB".repeat(32))])], { steps: { error: 0 }, list: "error" });
c("txid-without-0x", [blk(H, [A(H, 1, "ab".repeat(32))])], { steps: { error: 0 }, list: "error" });
c("attest-without-txid", [blk(H, [{ kind: "attest", id: id(1), attester: AU, height: H, pos: 1 }])], { steps: { error: 0 }, list: "error" });
c("author-21-bytes", [blk(H, [P(H, 1, id(1), "0x" + "a1".repeat(21))])], { steps: { error: 0 }, list: "error" });
c("author-upper-case", [blk(H, [A(H, 1, id(1), "0x" + "A1".repeat(20))])], { steps: { error: 0 }, list: "error" });
c("kind-unknown", [blk(H, [{ ...P(H, 1, id(1)), kind: "transfer" }])], { steps: { error: 0 }, list: "error" });
c("height-2p53", [blk(2 ** 53, [P(2 ** 53, 1, id(1))])], { steps: { error: 0 }, list: "error" });
c("height-negative", [blk(-1, [P(-1, 1, id(1))])], { steps: { error: 0 }, list: "error" });
c("height-fraction", [blk(1.5, [P(1.5, 1, id(1))])], { steps: { error: 0 }, list: "error" });
c("height-text", [blk("100000", [P("100000", 1, id(1))])], { steps: { error: 0 }, list: "error" });
c("position-2p32", [blk(H, [P(H, 2 ** 32, id(1))])], { steps: { error: 0 }, list: "error" });
c("position-negative", [blk(H, [P(H, -1, id(1))])], { steps: { error: 0 }, list: "error" });
c("position-fraction", [blk(H, [P(H, 1.5, id(1))])], { steps: { error: 0 }, list: "error" });
c("refused-in-a-later-block", [blk(H, one), blk(H + 1, [P(H + 1, 1, id(9)), P(H + 1, 1, id(8))])], { steps: { error: 1 }, list: "error" });
c("empty-block-with-a-bad-height", [blk(-1, [])], { steps: { error: 0 }, list: START });
c("prev-upper-case", [blk(H, one)], { steps: { error: 0 } }, "0x" + "AB".repeat(32));
c("prev-31-bytes", [blk(H, one)], { steps: { error: 0 } }, "0x" + "00".repeat(31));
c("prev-refused-with-an-empty-block", [blk(H, [])], { steps: { error: 0 } }, "00".repeat(32));

// ── check the facts, record the JS results ──
const fails = [];
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const named = Object.fromEntries(C.map((x) => [x.name, x]));
if (lib.EVENTS_HASH_START !== START) fails.push(`EVENTS_HASH_START is ${canonicalJson(lib.EVENTS_HASH_START ?? null)}`);
for (const x of C) x.expect = runHashCase(lib, x);
for (const x of C) {
  const w = x.want, g = x.expect;
  const other = w.sameAs ?? w.differs;
  if (other !== undefined && !named[other]) { fails.push(`${x.name}: no case ${other}`); continue; }
  if ("value" in w && !(g.steps === w.value && (!("list" in g) || g.list === w.value))) fails.push(`${x.name}: got ${canonicalJson(g)}`);
  if (w.sameAs && !(typeof g.steps === "string" && same(g, named[other].expect))) fails.push(`${x.name}: ${canonicalJson(g)} is not ${w.sameAs}'s`);
  if (w.differs && !(typeof g.steps === "string" && typeof named[other].expect.steps === "string" && g.steps !== named[other].expect.steps && g.list === g.steps))
    fails.push(`${x.name}: does not differ from ${w.differs} (${canonicalJson(g)})`);
  if ("steps" in w && !same(g.steps, w.steps)) fails.push(`${x.name}: steps ${canonicalJson(g.steps)}`);
  if ("list" in w && !same(g.list, w.list)) fails.push(`${x.name}: list ${canonicalJson(g.list)}`);
}

const vec = (f) => new URL(`../packages/cairnx/test/vectors/${f}`, import.meta.url);
const corpusRaw = readFileSync(vec("replay-corpus.json"));
const corpus = JSON.parse(corpusRaw.toString("utf8"));
const pinned = JSON.parse(readFileSync(vec("replay-hashes.json"), "utf8"));
const heights = Object.keys(pinned.hashes).map(Number).sort((a, b) => a - b);
let real = {};
try { real = corpusHashes(lib, corpus.events, heights); } catch (e) { fails.push(`corpus: ${e.message}`); }
for (const h of heights) {
  const got = real[String(h)], upTo = corpus.events.filter((e) => e.height <= h);
  const blocks = [...new Set(upTo.map((e) => e.height))].sort((a, b) => a - b)
    .map((bh) => [bh, rows(upTo.filter((e) => e.height === bh).sort((a, b) => a.pos - b.pos))]);
  if (got?.stateHash !== "0x" + pinned.hashes[String(h)]) fails.push(`corpus @${h}: stateHash ${got?.stateHash} is not the replay-hashes.json pin`);
  if (got?.eventsHash !== byHand(blocks)) fails.push(`corpus @${h}: eventsHash ${got?.eventsHash} is not the value rebuilt by hand`);
}
if (fails.length) { for (const f of fails) console.error(`  FACT FAILED ${f}`); console.error(`\n${fails.length} fact(s) failed: hashes.json not written`); process.exit(1); }

const line = ({ want: _w, ...x }) => JSON.stringify(x);
const corpusPart = { file: "replay-corpus.json", sha256: createHash("sha256").update(corpusRaw).digest("hex"), heights: real };
writeFileSync(vec("hashes.json"), `{"format":1,"generatedFrom":"shipping JS functions, conformance/gen-hashes-vectors.mjs","start":"${START}",\n`
  + `"cases":[\n${C.map(line).join(",\n")}\n],\n"corpus":${JSON.stringify(corpusPart)}}\n`);
console.log(`wrote ${C.length} cases and ${heights.length} corpus heights -> hashes.json (every hand-written fact held)`);
