// local() and dryRun() over the recorded node (node-harness.ts). local() must give a verified replica of one's own
// node in memory; dryRun() must answer what cairnx-core's resolve() answers for the same transaction in the block above
// the cursor, change nothing the replica holds, and refuse a transaction the event rule does not take.
import { applyOrder, buildRecord, nameRegFee, resolve, stateHash, TREASURY_ADDR, eventOfTx, type CairnXState } from "@inversealtruism/cairnx-core";
import { local } from "../src/browser.js";
import { local as serverLocal } from "../src/server.js";
import { open, ReplicaConfigError, type DryRunTx } from "../src/index.js";
import { done, ok, thrown } from "./check.js";
import { corpus } from "./core-files.js";
import { cap, NODE, node } from "./node-harness.js";
import { timeAt } from "./reader-harness.js";

const TIP = cap.to, now = timeAt(TIP) * 1000 + 60_000, clock = () => now;
const held = corpus.events.filter((e) => e.height <= TIP).sort(applyOrder);
const truth: CairnXState = resolve(held, TIP), HOLDER = Object.keys(truth.balances.CAIRN!)[0]!, OTHER = `0x${"b2".repeat(20)}`;

console.log("local():");
const r = await open({ ...local({ node: NODE, fetch: node({ answers: cap.answers }).f }), clock });
const s = await r.advance();
ok("local({ node }) over one's own node: a memory store, verified at 30,300 with no witness", s.verified && s.cursor?.height === TIP && s.level === 3 && s.vouch.kind === "blocks");
ok("its state at the deep height is resolve()'s", stateHash(((await r.state()) as { value: CairnXState }).value) === stateHash(resolve(held.filter((e) => e.height <= TIP - 12), TIP - 12)));
ok("each entry keeps its address rule: a public address throws in ./browser and in ./server", thrown(() => local({ node: "http://203.0.113.9:8789" })) instanceof ReplicaConfigError &&
  thrown(() => serverLocal({ node: "http://203.0.113.9:8789" })) instanceof ReplicaConfigError && thrown(() => serverLocal({ node: "http://10.0.0.5:8789" })) === null);

console.log("dryRun():");
const app = (record: Parameters<typeof buildRecord>[0]): DryRunTx["app"] => {
  const b = buildRecord(record);
  return { type: "Propose", domain: "cairnx:v1", uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 10_000n } as DryRunTx["app"];
};
// What resolve() itself gives for the same transaction one block above the replica's cursor.
const direct = (tx: DryRunTx, author: string) => {
  const ev = eventOfTx({ pos: 1, txid: `0x${"f".repeat(64)}`, tx }, TIP + 1, author)!;
  const e = resolve([...held, ev], TIP + 1).events.find((x) => x.id === `0x${"f".repeat(64)}`)!;
  return { applied: e.ok, code: e.code ?? null, note: e.note ?? null };
};
const have = BigInt(truth.balances.CAIRN![HOLDER]!.available);
const send = (amount: bigint): DryRunTx => ({ app: app({ v: 1, t: "transfer", ticker: "CAIRN", to: OTHER, amount: String(amount) }), outputs: [] });
const okSend = await r.dryRun(send(1n), HOLDER), tooMuch = await r.dryRun(send(have + 1n), HOLDER);
ok("a transfer of 1 CAIRN by a holder: verified, applied, the answer resolve() gives", okSend.verified && okSend.value.applied &&
  JSON.stringify(okSend.value) === JSON.stringify(direct(send(1n), HOLDER)));
ok("its at is the tip it was tried above, at depth 0", okSend.at?.height === TIP && okSend.at.deepHeight === TIP && okSend.at.depth === 0 && okSend.at.tipHeight === TIP);
ok("one above the holder's balance: verified, not applied, resolve()'s code", tooMuch.verified && !tooMuch.value.applied && tooMuch.value.code !== null &&
  JSON.stringify(tooMuch.value) === JSON.stringify(direct(send(have + 1n), HOLDER)));
const name = (paid: boolean): DryRunTx => ({ app: app({ v: 1, t: "name", name: "zzdryrun" }),
  outputs: paid ? [{ scriptPubkey: TREASURY_ADDR, value: nameRegFee("zzdryrun", TIP + 1) }] : [] });
const paid = await r.dryRun(name(true), OTHER), unpaid = await r.dryRun(name(false), OTHER);
ok("a name registration with its fee paid to the treasury applies; without it, it does not (the outputs are read)", paid.verified && paid.value.applied &&
  unpaid.verified && !unpaid.value.applied && JSON.stringify(unpaid.value) === JSON.stringify(direct(name(false), OTHER)));
ok("nothing the replica holds changed", stateHash(((await r.state({ minDepth: 0 })) as { value: CairnXState }).value) === stateHash(truth) && r.status().cursor?.height === TIP);
const foreign = await r.dryRun({ app: { ...send(1n).app, domain: "other:v1" } as DryRunTx["app"], outputs: [] }, HOLDER);
const badAuthor = await r.dryRun(send(1n), "0x12");
ok("another domain's Propose and an author out of form: INPUT_INVALID alone", foreign.why.map((w) => w.code).join() === "INPUT_INVALID" &&
  badAuthor.why.map((w) => w.code).join() === "INPUT_INVALID" && !foreign.verified);
const fresh = await open({ ...local({ node: NODE, fetch: node({ answers: cap.answers }).f }), clock }), early = await fresh.dryRun(send(1n), HOLDER);
ok("before any step: NOT_SYNCED, nothing shown", early.why.map((w) => w.code).join() === "NOT_SYNCED" && !early.verified && early.shown === null);

await fresh.close();
await r.close();
done("cairnx-replica dryRun");
