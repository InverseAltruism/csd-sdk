// Reader.snapshot() and dryRun()'s `at` over the recorded node (reader-harness.ts): a synced snapshot is resolve()'s
// state of the events held at the tip, named by its block, one frozen object while the state is the same; behind the
// tip it is the cursor's view and `at` names the cursor; with the tip below the cursor it is the tip's view. dryRun's
// `at` is the cursor it was tried above, whatever the tip. A snapshot during a commit is commit.test.ts's.
import { applyOrder, buildRecord, nameRegFee, resolve, stateHash, TREASURY_ADDR } from "@inversealtruism/cairnx-core";
import { open, type Answer, type DryRunTx, type Snapshot, type Source, type Step } from "../src/index.js";
import { READ_ADVANCE_MS } from "../src/reader.js";
import { fixtures } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus } from "./core-files.js";
import { cap } from "./node-harness.js";
import { OWN, hashAt, nodeSource, synth, timeAt } from "./reader-harness.js";

const TIP = cap.to, now = timeAt(TIP) * 1000 + 60_000, clock = () => now;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const view = (a: Answer<Snapshot>): Snapshot | null => (a.verified ? a.value : a.shown);
const held = (h: number) => corpus.events.filter((e) => e.height <= h).sort(applyOrder);
const xfer: DryRunTx = (() => {
  const b = buildRecord({ v: 1, t: "transfer", ticker: "CAIRN", to: `0x${"b2".repeat(20)}`, amount: "1" });
  return { app: { type: "Propose", domain: "cairnx:v1", uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 10_000n } as DryRunTx["app"], outputs: [] };
})();
const HOLDER = Object.keys(resolve(held(TIP), TIP).balances.CAIRN!)[0]!;

console.log("synced:");
{
  const r = await open({ source: nodeSource(), clock });
  const none = await r.snapshot();
  await r.advance();
  const a = await r.snapshot(), b = await r.snapshot();
  ok("before any step: NOT_SYNCED, nothing shown, no at", codes(none) === "NOT_SYNCED" && !none.verified && none.shown === null && none.at === null);
  ok(`verified at the tip ${TIP}: resolve()'s state of the events held, at depth 0, named by its block`,
    a.verified && a.value.height === TIP && stateHash(a.value.state) === stateHash(resolve(held(TIP), TIP)) && a.value.events.length === held(TIP).length &&
    a.at?.height === TIP && a.at.hash === hashAt(TIP) && a.at.depth === 0 && a.at.tipHeight === TIP);
  ok("the same state twice: one frozen object, the key naming its height", a.verified && b.verified && a.value === b.value && Object.isFrozen(a.value) &&
    Object.isFrozen(a.value.state) && Object.isFrozen(a.value.events) && a.value.key.startsWith(`${TIP}:`));
  const d = await r.dryRun(xfer, HOLDER);
  ok("dryRun synced: at is the tip, which is the cursor", d.verified && d.at?.height === TIP && d.at.hash === hashAt(TIP) && d.at.depth === 0);
  await r.close();
}

console.log("the tip above the cursor (BEHIND):");
{
  const r = await open({ source: nodeSource((t) => ({ ...t, height: t.height + 5, hash: synth(t.height + 5) })), clock });
  await r.advance();
  const a = await r.snapshot(), d = await r.dryRun(xfer, HOLDER);
  ok(`the view is the cursor's, ${TIP}, and at names it, 5 below the tip`, codes(a) === "BEHIND" && view(a)?.height === TIP && a.at?.height === TIP &&
    a.at.hash === hashAt(TIP) && a.at.depth === 5 && a.at.tipHeight === TIP + 5, JSON.stringify(a.at));
  ok("dryRun: at is the cursor it was tried above, not the tip", codes(d) === "BEHIND" && d.at?.height === TIP && d.at.hash === hashAt(TIP) && d.at.depth === 5, JSON.stringify(d.at));
  await r.close();
}

console.log("the tip below the cursor (BRANCH_UNRESOLVED):");
{
  const r = await open({ source: nodeSource((t) => ({ ...t, height: t.height - 5, hash: hashAt(t.height - 5) })), clock });
  await r.advance();
  const a = await r.snapshot(), d = await r.dryRun(xfer, HOLDER);
  ok(`the view is the tip's, ${TIP - 5}: resolve()'s state of the events held up to it`, codes(a) === "BRANCH_UNRESOLVED" && view(a)?.height === TIP - 5 &&
    a.at?.height === TIP - 5 && stateHash(view(a)!.state) === stateHash(resolve(held(TIP - 5), TIP - 5)) && view(a)!.events.every((e) => e.height <= TIP - 5));
  const c = r.status().cursor;
  ok("dryRun: at is the cursor it was tried above, above the tip, depth 0", codes(d) === "BRANCH_UNRESOLVED" && c !== null && c.height > TIP - 5 &&
    d.at?.height === c.height && d.at.hash === c.hash && d.at.depth === 0 && d.at.tipHeight === TIP - 5, JSON.stringify(d.at));
  await r.close();
}

console.log("events held above the view:");
{
  // The step commits to 30,300 with a record at 30,298 and reports a tip of 30,295: the view is the tip's, and the
  // record above it is in neither the view's state nor its events.
  const AL = `0x${"a1".repeat(20)}`, f = fixtures({ lower: true });
  const reg = f.prop({ v: 1, t: "name", name: "alice" }, { proposer: AL, height: 30_010, paidTo: { [TREASURY_ADDR]: String(nameRegFee("alice", 30_010)) } });
  const set = f.prop({ v: 1, t: "nset", name: "alice", addr: AL }, { proposer: AL, height: 30_298 });
  const tip = { height: 30_295, hash: synth(30_295), time: now / 1000 };
  const source: Source = { basis: OWN, floor: null, tip: async () => tip, async next(ctx): Promise<Step> {
    if (ctx.cursor !== null) return { kind: "idle", tip };
    return { kind: "blocks", blocks: [{ height: 30_010, hash: synth(30_010), events: [reg] }, { height: 30_298, hash: synth(30_298), events: [set] }], cursor: { height: 30_300, hash: synth(30_300) }, tip };
  } };
  const r = await open({ source, clock });
  await r.advance();
  const a = await r.snapshot(), v = view(a);
  ok("the view at 30,295 holds the registration and not the record at 30,298", codes(a) === "BRANCH_UNRESOLVED" && v?.height === 30_295 &&
    v.events.length === 1 && v.events[0]!.height === 30_010 && v.state.names.alice?.addr === undefined, JSON.stringify(v?.events.map((e) => e.height)));
  await r.close();
}

console.log("reads start advances at most once per READ_ADVANCE_MS:");
{
  let t = now, steps = 0;
  const inner = nodeSource(), source: Source = { ...inner, next: (ctx) => { steps++; return inner.next(ctx); } };
  const r = await open({ source, clock: () => t });
  let advances = 0;
  r.subscribe(() => { advances++; });
  await Promise.all(Array.from({ length: 20 }, () => r.snapshot()));
  await r.advance();
  ok("20 reads before any advance: one advance, which they join", advances === 1, `${advances}`);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((go) => setImmediate(go)); };
  for (let i = 0; i < 20; i++) { t += 500; await r.snapshot(); }
  await ticks(5);
  ok(`20 reads over the next ${(20 * 500) / 1000} s: no advance`, advances === 1, `${advances}`);
  t = now + READ_ADVANCE_MS + 1;
  await Promise.all(Array.from({ length: 20 }, () => r.snapshot()));
  await r.advance();
  const after = advances, stepsAfter = steps;
  for (let i = 0; i < 20; i++) { t += 100; await r.snapshot(); }
  await ticks(5);
  ok(`past ${READ_ADVANCE_MS} ms: one more advance for 20 reads, none for the 20 after it`, after === 2 && advances === 2 && steps === stepsAfter, `${after} ${advances}`);
  t = now - 60_000;
  await r.snapshot();
  await r.advance();
  ok("a clock set back counts as the interval passed: the read starts an advance", advances === 3, `${advances}`);
  const own = advances;
  await r.advance();
  ok("paired: advance() starts one whenever none runs", advances === own + 1);
  await r.close();
}

done("cairnx-replica snapshot");
