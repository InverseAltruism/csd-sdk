// A read around a step's commit (reader.ts, loop.ts committing()): a read issued at any microtask offset around a
// rollback's commit answers from the state before it or after it, never from the half state between; a read waits for
// a commit in flight at most its own `waitMs`, or until its signal aborts, and past that answers NOT_SYNCED with
// nothing shown; a commit that never settles leaves advance() pending (the store's failure) and no read hanging.
// Real timers bound the waits here; no verdict depends on them.
import { TREASURY_ADDR, nameRegFee } from "@inversealtruism/cairnx-core";
import { memoryStore, open, type Answer, type Source, type Step, type Store } from "../src/index.js";
import { fixtures } from "../src/testing.js";
import { done, ok } from "./check.js";
import { cap } from "./node-harness.js";
import { OWN, synth, timeAt } from "./reader-harness.js";

const MIN = 60_000, TIP = cap.to, now = timeAt(TIP) * 1000 + MIN, clock = () => now;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const AL = `0x${"a1".repeat(20)}`;
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await null; };
type Primary = Answer<{ readonly address: string; readonly name: string | null }>;

// alice registered at 30,010 and set as AL's primary at 30,290, tip 30,300: primary is SHALLOW at the default depth
// before the rollback to 30,295 and after it. `arm(h)` makes the next step that rollback; `h` runs when next() is
// entered for it, which then takes `delay` microtasks.
function script(delay: number) {
  const f = fixtures({ lower: true });
  const reg = f.prop({ v: 1, t: "name", name: "alice" }, { proposer: AL, height: 30_010, paidTo: { [TREASURY_ADDR]: String(nameRegFee("alice", 30_010)) } });
  const set = f.prop({ v: 1, t: "nset", name: "alice", addr: AL }, { proposer: AL, height: 30_290 });
  const tip = { height: TIP, hash: synth(TIP), time: now / 1000 };
  let mode: "fill" | "reorg" | "idle" = "fill", inNext: () => void = () => undefined;
  const source: Source = { basis: OWN, floor: null, tip: async () => tip, async next(ctx): Promise<Step> {
    const at = ctx.cursor?.height ?? -1;
    if (mode === "reorg") { mode = "idle"; inNext(); await ticks(delay); return { kind: "reorg", to: { height: 30_295, hash: synth(30_295) }, tip: { height: 30_295, hash: synth(30_295), time: now / 1000 } }; }
    if (at >= tip.height || mode === "idle") return { kind: "idle", tip: ctx.cursor === null ? tip : { height: at, hash: ctx.cursor.hash, time: now / 1000 } };
    return { kind: "blocks", blocks: [{ height: 30_010, hash: synth(30_010), events: [reg] }, { height: 30_290, hash: synth(30_290), events: [set] }].filter((b) => b.height > at), cursor: { height: tip.height, hash: tip.hash }, tip };
  } };
  return { source, arm: (h: () => void) => { mode = "reorg"; inNext = h; } };
}

console.log("reads at microtask offsets around a rollback's commit:");
{
  const verified: string[] = [];
  let runs = 0, shallow = 0, inFlight = 0;
  for (let j = 0; j <= 6; j++) for (let k = 0; k <= 40; k++) {
    const inner = memoryStore(), late = { on: false };
    const store: Store = { ...inner, async commit(c) { if (late.on) await ticks(j); return inner.commit(c); } };
    const sc = script(12), r = await open({ source: sc.source, store, clock });
    await r.advance();
    late.on = true;
    let got: Promise<Primary> | null = null;
    sc.arm(() => { got = ticks(k).then(() => r.primary(AL)); });
    await r.advance();
    const a = await got!;
    runs++;
    if (a.verified) verified.push(`j=${j},k=${k}`);
    else if (codes(a) === "SHALLOW") shallow++;
    else if (codes(a) === "NOT_SYNCED" && a.why[0]?.detail === "a step's commit is in flight" && a.shown === null) inFlight++;
    await r.close();
  }
  ok(`${runs} reads, commits 0 to 6 microtasks late, reads 0 to 40 after the step begins: none verified, each SHALLOW or NOT_SYNCED (commit in flight, nothing shown) (${shallow} and ${inFlight})`,
    runs === 287 && verified.length === 0 && shallow + inFlight === runs && inFlight > 0, verified.join(" "));
}

console.log("the bound of a read's wait for a slow commit:");
async function inCommit(hold: number) {
  const inner = memoryStore();
  let slow = false, entered = () => undefined as void;
  const store: Store = { ...inner, async commit(c) { if (slow) { entered(); await new Promise((go) => { if (Number.isFinite(hold)) setTimeout(go, hold); }); } return inner.commit(c); } };
  const sc = script(0), r = await open({ source: sc.source, store, clock });
  await r.advance();
  slow = true;
  const there = new Promise<void>((go) => { entered = go; });
  sc.arm(() => undefined);
  const adv = r.advance();
  await there;
  return { r, adv };
}
const timed = async (p: Promise<Primary>) => { const t = performance.now(), a = await p; return { a, ms: performance.now() - t }; };
const cut = new AbortController();
cut.abort();
{
  const { r, adv } = await inCommit(400);
  const status = r.status();
  const [w0, w50, ab, wLong] = await Promise.all([timed(r.primary(AL)), timed(r.primary(AL, { waitMs: 50 })), timed(r.primary(AL, { waitMs: 5_000, signal: cut.signal })), timed(r.primary(AL, { waitMs: 5_000 }))]);
  const inFlight = (x: { a: Primary }) => codes(x.a) === "NOT_SYNCED" && x.a.why[0]?.detail === "a step's commit is in flight" && !x.a.verified && x.a.shown === null;
  ok(`a 400 ms commit: status() NOT_SYNCED meanwhile; waitMs 0 answers in ${w0.ms.toFixed(0)} ms, an aborted signal in ${ab.ms.toFixed(0)} ms, each NOT_SYNCED (commit in flight)`,
    codes(status) === "NOT_SYNCED" && !status.verified && inFlight(w0) && w0.ms < 200 && inFlight(ab) && ab.ms < 200);
  ok(`waitMs 50 answers NOT_SYNCED after ${w50.ms.toFixed(0)} ms; waitMs 5,000 waits for the commit and answers SHALLOW after ${wLong.ms.toFixed(0)} ms`,
    inFlight(w50) && w50.ms >= 40 && w50.ms < 300 && codes(wLong.a) === "SHALLOW" && wLong.ms >= 300);
  await adv;
  await r.close();
}
{
  const { r, adv } = await inCommit(Number.POSITIVE_INFINITY);
  const [w0, w50, ab] = await Promise.all([timed(r.primary(AL)), timed(r.primary(AL, { waitMs: 50 })), timed(r.primary(AL, { waitMs: 5_000, signal: cut.signal }))]);
  const pending = await Promise.race([adv.then(() => "settled"), new Promise<string>((go) => setTimeout(() => go("pending"), 300))]);
  ok(`a commit that never settles: reads answer NOT_SYNCED in ${w0.ms.toFixed(0)}, ${w50.ms.toFixed(0)} and ${ab.ms.toFixed(0)} ms; advance() stays pending (the store's failure)`,
    [w0, w50, ab].every((x) => codes(x.a) === "NOT_SYNCED" && x.ms < 300) && pending === "pending");
  // Not closed: close() waits for the run, which this store never ends.
}

done("cairnx-replica commit");
