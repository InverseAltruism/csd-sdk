// Reader.snapshot() and dryRun()'s `at` over the recorded node (reader-harness.ts): a synced snapshot is resolve()'s
// state of the events held at the tip, named by its block, one frozen object while the state is the same; behind the
// tip it is the cursor's view and `at` names the cursor; with the tip below the cursor it is the tip's view. dryRun's
// `at` is the cursor it was tried above, whatever the tip. A snapshot during a commit is commit.test.ts's.
import { applyOrder, buildRecord, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { open, type Answer, type DryRunTx, type Snapshot } from "../src/index.js";
import { done, ok } from "./check.js";
import { corpus } from "./core-files.js";
import { cap } from "./node-harness.js";
import { hashAt, nodeSource, synth, timeAt } from "./reader-harness.js";

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

done("cairnx-replica snapshot");
