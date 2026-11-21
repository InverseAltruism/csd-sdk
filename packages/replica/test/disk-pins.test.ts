// A disk store across a change of pin or basis (design section 5), on the production call shape open(ownNode(...)) over
// the recorded node, with pins from derivePin over cairnx-core's fixture: 30,000 and 30,270. A store is kept only under
// a newer pin with one key, its cursor at or above the pin, its rows giving the pin's block hash, events hash and log
// digest, the state replayed at the bind; each sequence that breaks one of these is reset (the newer log read). Then a
// confirmation that is not stored, and a reorg below the pin while the store was closed.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINAL_DEPTH, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { diskStore, hosted, open, ownNode, type Pin, type ReplicaStatus } from "../src/server.js";
import { derivePin } from "../src/derive-pin.js";
import { fixtureSource, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { all, front, ORIGIN } from "./hosted-harness.js";
import { branchFrom, cap, NODE, node, type Answers } from "./node-harness.js";
import { hashAt, timeAt, witnessOn } from "./reader-harness.js";

const root = mkdtempSync(join(tmpdir(), "cairnx-replica-pins-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `s${n++}`);
const P1 = 30_000, P2 = 30_270, TIP = cap.to;
let now = timeAt(TIP) * 1000 + 60_000;
const clock = () => now;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const truthAt = (deep: number) => stateHash(resolve(corpus.events.filter((e) => e.height <= deep), deep));
const upTo = (h: number, f: BlockFixture = fx): BlockFixture => ({ ...f, to: h, toHash: hashAt(h), blocks: f.blocks.filter((b) => b.height <= h) });
const d1 = await derivePin(upTo(P1)), d2 = await derivePin(upTo(P2));
const reads = new Map<string, number>();
const pinOf = (d: typeof d1, name: string, o: Partial<Omit<Pin, "log">> = {}): Pin =>
  ({ ...d.pin, ...o, log: async () => { reads.set(name, (reads.get(name) ?? 0) + 1); return d.log; } });
const logReads = (name: string) => reads.get(name) ?? 0;
const pin1 = pinOf(d1, "pin1"), pin2 = pinOf(d2, "pin2");
const pinHeight = (s: ReplicaStatus) => (s.vouch.kind === "pinned" ? s.vouch.pin.height : null);
const storedPin = (dir: string): number | null => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).meta.basis.pin?.height ?? null;

// open(ownNode({ node, dir, pin })) over the recorded node to `tip` (default 30,300), one advance; the status, whether
// its deep state is resolve()'s over the corpus, and how many blocks at or below `below` it read.
async function run(dir: string, pin: Pin, o: { tip?: number; answers?: Answers; node?: string; below?: number } = {}) {
  const nn = node({ answers: o.answers ?? cap.answers, tip: o.tip ?? TIP });
  const r = await open({ ...ownNode({ node: o.node ?? NODE, dir, pin, fetch: nn.f }), clock }), s = await r.advance(), st = await r.state();
  await r.close();
  const tip = o.tip ?? TIP, below = nn.log.filter((l) => /^\/block\/height\/[0-9]+$/.test(l.path) && Number(l.path.split("/")[3]) <= (o.below ?? -1)).length;
  return { s, below, honest: s.verified && s.cursor?.height === tip && st.verified && stateHash(st.value) === truthAt(tip - FINAL_DEPTH) };
}

console.log("the honest newer pin, on the production call shape:");
const K = fresh();
const k0 = await run(K, pin1, { tip: 30_290 });
ok("filled under the pin at 30,000 to 30,290: verified", k0.honest && logReads("pin1") === 1, codes(k0.s));
const k1 = await run(K, pin2, { below: P2 });
ok("reopened under the pin at 30,270, the cursor above it, the rows equal: kept, its log not read, no block at or below 30,270 read, verified under it at 30,300",
  k1.honest && logReads("pin2") === 0 && k1.below === 0 && pinHeight(k1.s) === P2, `${codes(k1.s)} reads=${logReads("pin2")} below=${k1.below}`);
ok("its next commit records the newer pin in meta.json", storedPin(K) === P2);
const k2 = await run(K, pin1);
ok("then the older pin: reset, its log read again and the blocks from it refilled, verified under it",
  k2.honest && logReads("pin1") === 2 && pinHeight(k2.s) === P1 && storedPin(K) === P1, codes(k2.s));

console.log("each other change resets:");
const C = fresh();
await run(C, pin1, { tip: 30_200 });
const c1 = await run(C, pin2, { below: P2 });
ok("a cursor below the newer pin (30,200 under 30,270): reset, refilled from the newer log, verified", c1.honest && logReads("pin2") === 1 && c1.below === 0 && storedPin(C) === P2, codes(c1.s));
const F = fresh(), feedStore = diskStore({ dir: F }), feed = await open({ source: fixtureSource(upTo(TIP), { tipTime: timeAt(TIP) }), store: feedStore, clock });
await feed.advance(); await feed.close();
const f1 = await run(F, pinOf(d1, "feed"), { below: P1 });
ok("a store a feed filled, whose events hash at 30,000 is the pin's, reopened under the pin: reset, refilled from the log and blocks, verified",
  f1.honest && logReads("feed") === 1 && f1.below === 0 && storedPin(F) === P1, codes(f1.s));
// Another release's log at 30,000: the fixture without the first block that holds a transaction, its descriptor derived honestly.
const dropped = fx.blocks.find((b) => b.txs.length > 0)!.height, dOther = await derivePin(upTo(P1, { ...fx, blocks: fx.blocks.filter((b) => b.height !== dropped) }));
const O = fresh();
await run(O, pin1);
const o1 = await run(O, pinOf(dOther, "other"));
ok(`another release's log at the same height (the block at ${dropped} left out): reset and refilled from that log, not kept`,
  logReads("other") === 1 && o1.s.cursor?.height === TIP && pinHeight(o1.s) === P1 && o1.s.verified && dOther.pin.eventsHash !== d1.pin.eventsHash, codes(o1.s));
const B = fresh();
await run(B, pin1);
const b1 = await run(B, pinOf(d2, "origin"), { node: "http://localhost:8789" });
ok("another node, so another body origin, under the newer pin: reset, refilled from the newer log", b1.honest && logReads("origin") === 1, codes(b1.s));
const A = fresh();
await run(A, pin1);
const live = witnessOn(all, TIP), ha = await open({ ...hosted({ pin: pinOf(d2, "anchor"), origin: ORIGIN, witness: live.witness, fetch: front({ answers: all }).f }), store: diskStore({ dir: A }), clock });
const ha1 = await ha.advance();
await ha.close();
ok("an own-node store reopened under an anchor root at the newer pin: reset, refilled from the newer log, verified", ha1.verified && logReads("anchor") === 1 && storedPin(A) === P2, codes(ha1));

console.log("a newer pin whose descriptor the rows do not give: reset (the bind would refuse a kept one; nothing is verified):");
const bad: [string, Partial<Omit<Pin, "log">>, string][] = [
  ["another block hash", { blockHash: hashAt(P2 - 1) }, "blockHash"],
  ["another events hash", { eventsHash: d1.pin.eventsHash }, "eventsHash"],
  ["another log digest", { logSha256: d1.pin.logSha256 }, "logSha256"],
];
for (const [name, edit, tag] of bad) {
  const dir = fresh();
  await run(dir, pin1);
  const r = await run(dir, pinOf(d2, tag, edit));
  ok(`${name} at 30,270: reset (its log read, the store emptied), not verified`, logReads(tag) === 1 && !r.s.verified && !existsSync(join(dir, "meta.json")), `${codes(r.s)} reads=${logReads(tag)}`);
}
const S = fresh();
await run(S, pin1);
const s1 = await run(S, pinOf(d2, "state", { stateHash: d1.pin.stateHash }));
ok("another state hash at 30,270 (every other value the rows give): kept, and the bind's replay refuses it PIN_MISMATCH, not verified",
  logReads("state") === 0 && !s1.s.verified && codes(s1.s).split(",").includes("PIN_MISMATCH"), codes(s1.s));

const G = fresh(), gatesPin = (tag: string) => pinOf(d2, tag, { gates: { ...d2.pin.gates, V99_HEIGHT: 30_010 }, stateHash: d1.pin.stateHash });
await run(G, pin1);
const g1 = await run(G, gatesPin("gates-kept")), g2 = await run(fresh(), gatesPin("gates-fresh"));
ok("a newer pin of another gate table (so another state hash) over a kept store: RULES_DIFFER, as over a fresh one, not PIN_MISMATCH",
  logReads("gates-kept") === 0 && [g1, g2].every((g) => !g.s.verified && codes(g.s).split(",").includes("RULES_DIFFER") && !codes(g.s).split(",").includes("PIN_MISMATCH")),
  `${codes(g1.s)} / ${codes(g2.s)}`);

console.log("a store kept under an anchor root:");
{
  const dir = fresh(), wa = witnessOn(all, TIP), at = (pin: Pin) => open({ ...hosted({ pin, origin: ORIGIN, witness: wa.witness, fetch: front({ answers: all }).f }), store: diskStore({ dir }), clock });
  const h0 = await at(pinOf(d1, "hosted1")), h0s = await h0.advance();
  await h0.close();
  const h1 = await at(pinOf(d2, "hosted2")), h1s = await h1.advance(), h1t = await h1.state();
  await h1.close();
  ok("hosted under the pin at 30,000, then under 30,270 over the same directory: kept (that log not read), verified at 30,300, the deep state resolve()'s",
    h0s.verified && logReads("hosted2") === 0 && h1s.verified && h1s.cursor?.height === TIP && pinHeight(h1s) === P2 && h1t.verified && stateHash(h1t.value) === truthAt(TIP - FINAL_DEPTH),
    `${codes(h0s)} / ${codes(h1s)} reads=${logReads("hosted2")}`);
}

console.log("what a reopen does not carry:");
const W = fresh(), wit = witnessOn(all, 30_200);
const hostedAt = (tip: number) => open({ ...hosted({ pin: pin1, origin: ORIGIN, witness: wit.witness, fetch: front({ answers: all, tip }).f }), store: diskStore({ dir: W }), clock });
now = timeAt(30_200) * 1000 + 60_000;
const w0 = await hostedAt(30_200), w0s = await w0.advance();
await w0.close();
now = timeAt(TIP) * 1000 + 60_000;
wit.w.tip = TIP; wit.w.silent = true;
const w1 = await hostedAt(TIP), w1s = await w1.advance();
wit.w.silent = false;
const w1t = await w1.advance();
await w1.close();
ok("a confirmation earned at 30,200, the store reopened at 30,300: NOT_WITNESSED while the witness is silent, verified once it answers",
  w0s.verified && w0s.cursor?.height === 30_200 && codes(w1s) === "NOT_WITNESSED" && w1s.cursor?.height === TIP && w1t.verified, `${codes(w0s)} / ${codes(w1s)} / ${codes(w1t)}`);
const R = fresh();
await run(R, pin1);
const r1 = await run(R, pin1, { answers: branchFrom(29_990) });
ok("a reorg below the pin while the store was closed: PIN_OFF_CHAIN, not verified", codes(r1.s).split(",").includes("PIN_OFF_CHAIN") && !r1.s.verified, codes(r1.s));

done("cairnx-replica disk store across pins");
