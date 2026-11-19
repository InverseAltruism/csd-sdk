// The witness rule and the reader's other paths that the review of 2026-11-19 found open: a witness behind the
// replica confirms only at the compared height; a confirmation does not survive the chain being replaced (a rollback,
// a reload, a reset); a disagreement voids it; any valid higher tip denies; a read with waitMs waits out a slow
// commit; a witness out of form is silent; a confirmation is stamped when the witness answered and a clock set back
// voids it; a caller behind the store is BRANCH_UNRESOLVED. Every clock is the test's. The read around a commit in
// flight is commit.test.ts.
import * as core from "@inversealtruism/cairnx-core";
import { FINAL_DEPTH, TREASURY_ADDR, nameRegFee, resolve, stateHash, type CairnXState } from "@inversealtruism/cairnx-core";
import { hostedBlocks, hostedWitness, nodeWitness } from "../src/browser.js";
import { coreCheck, gatesOf } from "../src/gates.js";
import { chainExtends } from "../src/loop.js";
import { memoryStore, open, type BlockRow, type Source, type Step, type Store, type Witness, type WitnessTip } from "../src/index.js";
import { fixtureSource, fixtures, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { all, ANCHOR, callerHeaders, front, ORIGIN } from "./hosted-harness.js";
import { branchFrom, cap, json, node } from "./node-harness.js";
import { callerReader, hashAt, nodeSource, OWN, synth, timeAt, witnessOn } from "./reader-harness.js";

const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const noted = (a: { notes: readonly { code: string }[] }, c: string) => a.notes.some((n) => n.code === c);
const MIN = 60_000, TIP = cap.to;
let now = timeAt(TIP) * 1000 + MIN;
const clock = () => now;
const truth = (h: number): CairnXState => resolve(corpus.events.filter((e) => e.height <= h), h);
const HOLDER = Object.keys(truth(TIP - FINAL_DEPTH).balances.CAIRN!)[0]!;
const branch = (f: number) => ({ ...all, ...branchFrom(f) });
const closing: { close(): Promise<void> }[] = [];
/** A reader under a caller root over `answers` to `tip`, advanced once. */
async function onChain(answers: typeof all, tip: number, witnesses: Witness[], extra: { store?: Store } = {}) {
  const x = await callerReader(tip, { witnesses, clock, ...extra });
  x.served.answers = x.ch.c.answers = answers;
  closing.push(x.r);
  return { ...x, s: await x.r.advance() };
}

console.log("B1, a witness behind the replica confirms only at the compared height:");
const b1 = await onChain(branch(30_287), TIP, [witnessOn(all, 30_290).witness]);
ok("replica at 30,300 on a branch from 30,287, the witness at 30,290 on the recorded chain: NOT_WITNESSED, no confirmation",
  codes(b1.s) === "NOT_WITNESSED" && b1.s.witnessed === null && !b1.s.verified);
now = timeAt(30_296) * 1000 + MIN;
const near = await onChain(branch(30_290), 30_296, [witnessOn(all, 30_295).witness]);
ok("replica at 30,296 on a branch from 30,290, the witness at 30,295 on the recorded chain (the chains differ at 30,295): NOT_WITNESSED",
  codes(near.s) === "NOT_WITNESSED" && near.s.witnessed === null && !near.s.verified);
now = timeAt(TIP) * 1000 + MIN;
const held0 = await onChain(all, TIP, [witnessOn(all, 30_290).witness]);
ok("an honest witness at 30,290, where the replica holds no hash: it cannot compare, so NOT_WITNESSED and no SOURCES_DISAGREE",
  codes(held0.s) === "NOT_WITNESSED" && !noted(held0.s, "SOURCES_DISAGREE"));
const b76 = await onChain(branch(30_225), TIP, [witnessOn(all, 30_224).witness]);
ok("a witness 76 blocks behind, the replica on a branch from 30,225: NOT_WITNESSED", codes(b76.s) === "NOT_WITNESSED" && b76.s.witnessed === null);
now = timeAt(30_298) * 1000 + MIN;
const behind12 = await onChain(all, 30_298, [witnessOn(all, 30_286).witness]);
ok("an honest witness 12 behind at a block the replica holds (an event at 30,286): verified, confirmed there", behind12.s.verified && behind12.s.witnessed?.height === 30_286);
const behind13 = await onChain(all, 30_299, [witnessOn(all, 30_286).witness]);
ok("the same witness 13 behind: NOT_WITNESSED", codes(behind13.s) === "NOT_WITNESSED");
now = timeAt(TIP) * 1000 - 15 * MIN;   // so the tip stays under 30 minutes old to the end of the case
const lag = witnessOn(all, TIP), renew = await onChain(all, TIP, [lag.witness]), at0 = renew.s.witnessed?.at;
lag.w.tip = 30_224;
now += 20 * MIN;
const r20 = await renew.r.advance();
now += 11 * MIN;
const r31 = await renew.r.advance();
ok("a witness that falls 76 behind does not renew the confirmation: its time kept at 20 minutes, WITNESS_SILENT at 31",
  r20.witnessed?.at === at0 && r20.verified && codes(r31) === "WITNESS_SILENT", JSON.stringify({ at0, r20: r20.witnessed, w20: codes(r20), w31: codes(r31) }));
now = timeAt(TIP) * 1000 + MIN;
const nullHash: Witness = { ...witnessOn(all, TIP).witness, hashAt: async () => null };
const nh = await onChain(all, TIP - 3, [nullHash]);
ok("a witness ahead whose hashAt answers null is no confirmation", nh.s.witnessed === null && codes(nh.s).includes("NOT_WITNESSED"));

console.log("B2, a confirmation does not survive the chain being replaced:");
{
  const T = TIP - 5;
  now = timeAt(T) * 1000 + MIN;
  const base = witnessOn(all, TIP);
  let asked: (() => void) | null = null;
  const first = new Promise<void>((go) => { asked = go; });
  const slow: Witness = { ...base.witness, async hashAt(h, s) { asked?.(); await new Promise((r) => setTimeout(r, 50)); return base.witness.hashAt(h, s); } };
  const x = await callerReader(T, { witnesses: [slow], clock });
  closing.push(x.r);
  const p1 = x.r.advance();
  await first;
  x.served.answers = x.ch.c.answers = branch(30_290);
  const p2 = x.r.advance();
  await p1;
  base.w.silent = true;
  const s3 = await x.r.advance();
  ok("advance() during a run joins it (the same promise); the next run rolls back to the branch, and the confirmation of the old chain is void: NOT_WITNESSED",
    p2 === p1 && s3.lastReorg !== null && s3.cursor?.hash === hashAt(T, branch(30_290)) && codes(s3) === "NOT_WITNESSED" && s3.witnessed === null,
    JSON.stringify({ same: p2 === p1, reorg: s3.lastReorg?.to.height, cursor: s3.cursor?.height, onBranch: s3.cursor?.hash === hashAt(T, branch(30_290)), why: codes(s3), w: s3.witnessed }));
}
{
  now = timeAt(TIP) * 1000 + MIN;
  const store = memoryStore(), ch = callerHeaders({ answers: all, tip: 30_290 }), served = { answers: all };
  const src = () => hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: ch.headers }, fetch: front(served).f });
  const w = witnessOn(all, 30_290), a = await open({ source: src(), store, witnesses: [w.witness], clock }), a0 = await a.advance();
  ch.c.answers = served.answers = branch(30_200); ch.c.tip = TIP;
  const b = await open({ source: src(), store, clock });
  await b.advance();
  w.w.silent = true;
  const a1 = await a.advance();
  ok("open twice on one store: the other reader rolls it back below the confirmation; this one reloads (CURSOR_MOVED) and answers NOT_WITNESSED",
    a0.verified && a1.cursor?.hash === hashAt(TIP, branch(30_200)) && codes(a1) === "NOT_WITNESSED" && a1.witnessed === null);
  closing.push(a, b);
}
{
  now = timeAt(TIP) * 1000 + MIN;
  const store = memoryStore(), w = witnessOn(all, 30_290), x = await callerReader(30_290, { store, witnesses: [w.witness], clock });
  closing.push(x.r);
  const s0 = await x.r.advance();
  await store.reset();
  w.w.silent = true;
  x.ch.c.tip = TIP;
  await x.r.advance();
  now += 2_000;
  const s2 = await x.r.advance();
  ok("store.reset() between reads: the loop reloads and refills, the confirmation taken before is void: NOT_WITNESSED",
    s0.verified && s2.cursor?.height === TIP && codes(s2) === "NOT_WITNESSED" && s2.witnessed === null);
}
{
  const rows = (hs: number[]) => hs.map((height) => ({ height }) as BlockRow);
  const a = rows([1, 2, 3]);
  ok("chainExtends: only rows that keep every held row and add above them extend the chain; a cut, a swap or an emptying does not",
    chainExtends(a, [...a, ...rows([4])], 3, 4) && chainExtends(a, a, 3, 5) && !chainExtends(a, a.slice(0, 2), 3, 2) && !chainExtends(a, [a[0]!, a[1]!, ...rows([3])], 3, 4) &&
    !chainExtends(a, [], 3, -1) && !chainExtends(a, a, 3, 3) && chainExtends([], rows([5]), -1, 5));
}

console.log("S1, S2: a witness can deny, never grant:");
{
  now = timeAt(30_288) * 1000 - 20 * MIN;
  const w = witnessOn(all, 30_275), x = await callerReader(30_275, { witnesses: [w.witness], clock });
  closing.push(x.r);
  const s0 = await x.r.advance();
  x.served.answers = x.ch.c.answers = branch(30_276); x.ch.c.tip = 30_288; w.w.tip = 30_288;
  now = timeAt(30_288) * 1000 + MIN;
  const s1 = await x.r.advance();
  ok("confirmed at 30,275, then 13 blocks of a branch the witness contradicts at 30,288: NOT_WITNESSED, noted SOURCES_DISAGREE",
    s0.verified && codes(s1) === "NOT_WITNESSED" && noted(s1, "SOURCES_DISAGREE") && s1.witnessed === null);
}
now = timeAt(TIP) * 1000 + MIN;
const two = await onChain(all, TIP, [witnessOn(all, TIP).witness, witnessOn(branch(TIP - 3), TIP, { id: "other", origin: "https://other.example" }).witness]);
ok("two witnesses, one on another branch at the replica's tip: NOT_WITNESSED, noted SOURCES_DISAGREE", codes(two.s) === "NOT_WITNESSED" && noted(two.s, "SOURCES_DISAGREE"));
{
  const T = 30_280;
  now = timeAt(T) * 1000 + MIN;
  const w = witnessOn(all, T), x = await onChain(all, T, [w.witness]);
  w.w.tip = T + 20;
  now += MIN;
  const s1 = await x.r.advance();
  ok("a witness naming a valid header 20 above the replica: TIP_BEHIND_PEER (no plausibility cap)", x.s.verified && codes(s1) === "TIP_BEHIND_PEER");
}

console.log("S3, a read during a commit in flight:");
{
  now = timeAt(TIP) * 1000 + MIN;
  const AL = `0x${"a1".repeat(20)}`, f = fixtures({ lower: true });
  const reg = f.prop({ v: 1, t: "name", name: "alice" }, { proposer: AL, height: 30_010, paidTo: { [TREASURY_ADDR]: String(nameRegFee("alice", 30_010)) } });
  const set = f.prop({ v: 1, t: "nset", name: "alice", addr: AL }, { proposer: AL, height: 30_290 });
  const tip = { height: TIP, hash: synth(TIP), time: now / 1000 };
  let mode: "fill" | "reorg" | "idle" = "fill";
  const source: Source = { basis: OWN, floor: null, tip: async () => tip, async next(ctx): Promise<Step> {
    const at = ctx.cursor?.height ?? -1;
    if (mode === "reorg") { mode = "idle"; return { kind: "reorg", to: { height: 30_295, hash: synth(30_295) }, tip: { height: 30_295, hash: synth(30_295), time: now / 1000 } }; }
    if (at >= tip.height || mode === "idle") return { kind: "idle", tip: ctx.cursor === null ? tip : { height: at, hash: ctx.cursor.hash, time: now / 1000 } };
    return { kind: "blocks", blocks: [{ height: 30_010, hash: synth(30_010), events: [reg] }, { height: 30_290, hash: synth(30_290), events: [set] }].filter((b) => b.height > at), cursor: { height: tip.height, hash: tip.hash }, tip };
  } };
  const inner = memoryStore();
  let slow = false, inCommit: (() => void) | null = null;
  const store: Store = { ...inner, async commit(c) { if (slow) { inCommit?.(); await new Promise((r) => setTimeout(r, 30)); } return inner.commit(c); } };
  const r = await open({ source, store, clock });
  closing.push(r);
  await r.advance();
  const before = await r.primary(AL);
  await r.advance();   // the run the read started
  slow = true; mode = "reorg";
  type P = Awaited<ReturnType<typeof r.primary>>;
  const mid = new Promise<[P, P]>((go) => { inCommit = () => { void Promise.all([r.primary(AL), r.primary(AL, { waitMs: 10_000 })]).then(go); }; });
  const adv = r.advance(), [now0, waited] = await mid;
  await adv;
  const after = await r.primary(AL);
  ok("primary read while a rollback's commit awaits a slow store: with waitMs 0 NOT_SYNCED (commit in flight), with waitMs it waits and answers as after (SHALLOW, alice shown)",
    codes(before) === "SHALLOW" && codes(now0) === "NOT_SYNCED" && !now0.verified && codes(waited) === "SHALLOW" && codes(after) === "SHALLOW" && !waited.verified && waited.shown?.name === "alice");
}

console.log("S4, a witness out of form is silent, with a note:");
for (const [label, answer] of [["{}", {}], ["{ gates: null }", { gates: null }], ["a table with a string height", { gates: { ...gatesOf(core), V12_HEIGHT: "30300" } }]] as const) {
  now = timeAt(TIP) * 1000 + MIN;
  let asks = 0;
  const w: Witness = { ...witnessOn(all, TIP).witness, rules: async () => { asks++; return answer as never; } };
  const x = await callerReader(TIP, { witnesses: [w], clock });
  closing.push(x.r);
  const s = await x.r.advance().then((v) => v, () => null), st = (() => { try { return x.r.status(); } catch { return null; } })();
  const rd = await x.r.balance("CAIRN", HOLDER).then((v) => v, () => null);
  await x.r.advance();
  ok(`rules() answering ${label}: nothing throws; the witness is silent (NOT_WITNESSED), noted WITNESS_MALFORMED, asked again next round`,
    s !== null && st !== null && rd !== null && codes(s) === "NOT_WITNESSED" && noted(s, "WITNESS_MALFORMED") && asks === 2);
}
{
  const bad: Witness = { ...witnessOn(all, TIP).witness, tip: async () => ({ height: -1, hash: "0x12" }) as unknown as WitnessTip };
  const x = await onChain(all, TIP, [bad]);
  ok("a tip out of form: NOT_WITNESSED, noted WITNESS_MALFORMED", codes(x.s) === "NOT_WITNESSED" && noted(x.s, "WITNESS_MALFORMED"));
  let asks = 0;
  const good: Witness = { ...witnessOn(all, TIP).witness, rules: async () => { asks++; return { gates: gatesOf(core) }; } };
  const y = await onChain(all, TIP, [good]);
  await y.r.advance(); await y.r.advance();
  ok("a well-formed table is asked once and kept", y.s.verified && asks === 1);
}

console.log("S5, time:");
{
  const t0 = timeAt(TIP) * 1000 + MIN;
  now = t0;
  const w = witnessOn(all, TIP), x = await onChain(all, TIP, [w.witness]);
  w.w.silent = true;
  now = t0 - 120 * MIN;
  const back = x.r.status();
  now = t0 - 120 * MIN + 149 * MIN;
  const later = await x.r.advance();
  ok("the clock set back 2 hours after a confirmation voids it: NOT_WITNESSED then, and 149 real minutes on with the clock 2 hours behind",
    x.s.verified && codes(back) === "NOT_WITNESSED" && codes(later) === "NOT_WITNESSED", JSON.stringify({ first: codes(x.s), back: codes(back), later: codes(later) }));
}
{
  const t0 = timeAt(TIP) * 1000 - 39 * MIN;
  now = t0;
  const w = witnessOn(all, TIP), ch = callerHeaders({ answers: all, tip: TIP });
  const inner = hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: ch.headers }, fetch: front({ answers: all }).f });
  let steps = 0;
  const slowSrc: Source = { ...inner, async next(ctx) { const st = await inner.next(ctx); if (++steps === 1) w.w.silent = true; now += 5 * MIN; return st; } };
  const r = await open({ source: slowSrc, witnesses: [w.witness], clock });
  closing.push(r);
  const s = await r.advance();
  ok(`a confirmation is stamped when the witness answered: an advance of ${steps} steps and ${(now - t0) / MIN} minutes answers WITNESS_SILENT`,
    s.witnessed?.at === t0 && codes(s) === "WITNESS_SILENT");
}

console.log("S7, a caller behind the store:");
{
  now = timeAt(TIP) * 1000 + MIN;
  const w = witnessOn(all, TIP), x = await onChain(all, TIP, [w.witness]);
  w.w.silent = true;
  x.ch.c.tip = 30_290;
  const s1 = await x.r.advance(), a = await x.r.balance("CAIRN", HOLDER);
  ok("the caller's tip falls to 30,290 under a store at 30,300: BRANCH_UNRESOLVED, nothing rolled back, the caller's tip reported",
    x.s.verified && codes(s1) === "BRANCH_UNRESOLVED" && codes(a) === "BRANCH_UNRESOLVED" && s1.cursor?.height === TIP && s1.at?.tipHeight === 30_290 && s1.lastReorg === null, JSON.stringify({ first: codes(x.s), s1: codes(s1), a: codes(a), tip: s1.at?.tipHeight, err: s1.lastError }));
}

console.log("S6, the paths no test pinned:");
now = timeAt(TIP) * 1000 + MIN;
for (const [name, ws] of [["no witness", []], ["hostedWitness", [hostedWitness({ origin: "https://second.example", fetch: front({ answers: all }).f })]]] as const) {
  const r = await open({ source: hostedBlocks({ origin: ORIGIN, root: { kind: "anchor", anchor: ANCHOR }, fetch: front({ answers: all }).f }), witnesses: [...ws], clock });
  closing.push(r);
  const s = await r.advance({ budgetMs: 600_000 }), st = await r.state();
  ok(`an anchor root advanced to 30,300 with ${name}: ${ws.length === 0 ? "NOT_WITNESSED" : "verified, its state resolve()'s at the deep height"}`, s.cursor?.height === TIP &&
    (ws.length === 0 ? codes(s) === "NOT_WITNESSED" : s.verified && st.verified && stateHash(st.value) === stateHash(truth(TIP - FINAL_DEPTH))));
}
const fx300: BlockFixture = { ...fx, to: TIP, toHash: hashAt(TIP), blocks: fx.blocks.filter((b) => b.height <= TIP) };
const feed2 = fixtureSource(fx300, { tipTime: now / 1000 }), lvl2 = await open({ source: { ...feed2, basis: { kind: "feed", feed: "f", inclusion: true } }, clock });
closing.push(lvl2);
const l2 = await lvl2.advance();
ok("a feed with inclusion proofs (level 2): LEVEL_FEED", l2.level === 2 && codes(l2) === "LEVEL_FEED");
{
  const filled = memoryStore();
  await (await open({ source: nodeSource(), store: filled, clock })).advance();
  let resets = 0;
  const corrupt: Store = { ...filled, async *rows(from) { for await (const r of filled.rows(from)) yield { ...r, eventsHash: `0x${"0".repeat(64)}` }; }, reset: async () => { resets++; await filled.reset(); } };
  const rc = await open({ source: nodeSource(), store: corrupt, clock });
  closing.push(rc);
  ok("a store whose rows do not match its meta is reset once", resets === 1);
  let resets2 = 0;
  const throwing: Store = { ...memoryStore(), open: async () => { throw new Error("disk gone"); }, reset: async () => { resets2++; } };
  const rt = await open({ source: nodeSource(), store: throwing, clock });
  closing.push(rt);
  ok("a store that throws at open is not reset: NOT_SYNCED, noted STORE_UNAVAILABLE", resets2 === 0 && codes(rt.status()) === "NOT_SYNCED" && noted(rt.status(), "STORE_UNAVAILABLE"));
}
{
  const hw = hostedWitness({ origin: "https://second.example", fetch: front({ answers: all }).f }), nw = nodeWitness({ node: "http://203.0.113.9:8789", fetch: node({ answers: cap.answers }).f });
  const sig = new AbortController().signal;
  ok("hostedWitness.hashAt and nodeWitness.hashAt answer the recorded hash at a height", (await hw.hashAt(30_200, sig)) === hashAt(30_200) && (await nw.hashAt(30_200, sig)) === hashAt(30_200));
  const lie = JSON.stringify({ tip: hashAt(TIP - 1), height: TIP, chainwork: "0" });
  const hwLie = hostedWitness({ origin: "https://second.example", fetch: front({ answers: all, fail: (p) => (p === "/api/rpc/tip" ? json(lie) : null) }).f });
  const nwLie = nodeWitness({ node: "http://203.0.113.9:8789", fetch: node({ answers: cap.answers, tipOf: () => JSON.parse(lie) }).f });
  ok("a tip whose header (or block) at that height is another block: no tip from either witness", (await hwLie.tip(sig)) === null && (await nwLie.tip(sig)) === null);
}
{
  let steps = 0;
  const counted: Source = { ...nodeSource(), async next(ctx) { steps++; return nodeSource().next(ctx); } };
  const r = await open({ source: counted, clock });
  closing.push(r);
  const seen: boolean[] = [];
  const off = r.subscribe((s) => seen.push(s.verified));
  const a0 = await r.balance("CAIRN", HOLDER);
  await new Promise((go) => setTimeout(go, 50));
  const started = steps > 0;
  const r2 = await open({ source: nodeSource(), clock });
  closing.push(r2);
  const waited = await r2.balance("CAIRN", HOLDER, { waitMs: 10_000 });
  off();
  await r.advance();
  ok("a read starts an advance and answers at once (NOT_SYNCED); with waitMs it waits for it (verified)", codes(a0) === "NOT_SYNCED" && started && waited.verified);
  ok("subscribe: the listener gets the status after an advance and none after it is removed", seen.length === 1 && seen[0] === true);
  const s = r.status(), deep0 = await r.balance("CAIRN", HOLDER, { minDepth: 0 });
  ok("status() is read at FINAL_DEPTH; a read at depth 0 carries the cursor's hash in at", s.at?.depth === FINAL_DEPTH && deep0.at?.hash === hashAt(TIP));
  ok("an events limit above 1,000: INPUT_INVALID", codes(await r.events(null, { limit: 1_001 })) === "INPUT_INVALID");
  await r.close();
  ok("after close() the reader answers NOT_SYNCED", codes(r.status()) === "NOT_SYNCED");
}
{
  const older: Record<string, number> = { ...gatesOf(core) };
  delete older.V29_HEIGHT;
  const alt = { ...core, resolve: (...a: Parameters<typeof resolve>) => resolve(...a), V29_HEIGHT: 99_999 };
  const r = await open({ source: nodeSource(), core: alt as never, clock });
  closing.push(r);
  ok("a gate one table lacks makes them differ from that gate on; before a tip the tables are compared whole",
    coreCheck(undefined, older).differ(88_000) && !coreCheck(undefined, older).differ(87_999) && codes(r.status()) === "RULES_DIFFER,NOT_SYNCED");
}

for (const r of closing) await r.close();
done("cairnx-replica witness");
