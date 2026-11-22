// No value a read returns shares a mutable object with the reader, its loop or its store: the basis every answer
// carries as `vouch` is frozen, `events()` pages and `status()`'s cursor, last reorg and last error are copies, every
// other value is built for its read. Each read's answer is walked: every object in it is frozen or not the object a
// second answer to the same read holds; and an answer scrambled in every object that is not frozen leaves the next
// answer as it was.
import { FINAL_DEPTH, buildRecord, resolve, stateHash, type CairnXState } from "@inversealtruism/cairnx-core";
import { open, type DryRunTx, type Reader } from "../src/index.js";
import { done, ok } from "./check.js";
import { corpus } from "./core-files.js";
import { cap } from "./node-harness.js";
import { callerReader, nodeSource, timeAt, witnessOn } from "./reader-harness.js";
import { all } from "./hosted-harness.js";

const TIP = cap.to, now = timeAt(TIP) * 1000 + 60_000, clock = () => now;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const truth = (h: number): CairnXState => resolve(corpus.events.filter((e) => e.height <= h), h);
const HOLDER = Object.keys(truth(TIP - FINAL_DEPTH).balances.CAIRN!)[0]!;

console.log("the review's two cases:");
const r = await open({ source: nodeSource(), clock });
await r.advance();
const page = await r.events(null, { limit: 1000, minDepth: 0 });
if (page.verified) for (const e of page.value.items) { if (e.kind === "propose") e.proposer = `0x${"0".repeat(40)}`; else e.attester = `0x${"0".repeat(40)}`; }
const st5 = await r.state({ minDepth: 5 }), b5 = await r.balance("CAIRN", HOLDER, { minDepth: 5 });
ok("events overwritten by the caller change no later answer: state and balance at depth 5 are resolve()'s", page.verified && st5.verified && b5.verified &&
  stateHash(st5.value) === stateHash(truth(TIP - 5)) && b5.value.available === truth(TIP - 5).balances.CAIRN![HOLDER]!.available);
const c = await callerReader(TIP, { clock });
await c.r.advance();
const a0 = await c.r.balance("CAIRN", HOLDER);
let threw = false;
try { (a0.vouch as { root: { kind: string } }).root.kind = "own-node"; } catch (e) { threw = e instanceof TypeError; }
const a1 = await c.r.balance("CAIRN", HOLDER);
ok("writing vouch.root.kind on an answer throws (frozen) and the next answer is still NOT_WITNESSED", threw && codes(a0) === "NOT_WITNESSED" && codes(a1) === "NOT_WITNESSED");

console.log("every read's answer, walked:");
type Node = Record<string, unknown> | unknown[];
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;
// Every object of `a` that is not frozen is not the object at the same place in `b`.
function separate(a: unknown, b: unknown, path: string, bad: string[]): void {
  if (!isNode(a)) return;
  if (!Object.isFrozen(a) && a === b) bad.push(path);
  for (const [k, v] of Object.entries(a)) separate(v, isNode(b) ? (b as Record<string, unknown>)[k] : undefined, `${path}.${k}`, bad);
}
// Every object of `a` that is not frozen has each of its own fields replaced.
function scramble(a: unknown): void {
  if (!isNode(a) || Object.isFrozen(a)) return;
  for (const [k, v] of Object.entries(a)) { scramble(v); (a as Record<string, unknown>)[k] = "scrambled"; }
}
const xfer = (() => { const b = buildRecord({ v: 1, t: "transfer", ticker: "CAIRN", to: `0x${"b2".repeat(20)}`, amount: "1" }); return { type: "Propose", domain: "cairnx:v1", uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 10_000n }; })();
const reads: [string, (x: Reader) => Promise<unknown> | unknown][] = [
  ["balance", (x) => x.balance("CAIRN", HOLDER, { minDepth: 0 })], ["primary", (x) => x.primary(HOLDER)], ["state", (x) => x.state()],
  ["events", (x) => x.events(null, { limit: 1000 })], ["dryRun", (x) => x.dryRun({ app: xfer as DryRunTx["app"], outputs: [] }, HOLDER)], ["snapshot", (x) => x.snapshot()], ["status", (x) => x.status()],
];
const w = witnessOn(all, TIP), cw = await callerReader(TIP, { witnesses: [w.witness], clock });
await cw.r.advance();
for (const [reader, x] of [["one's own node", r], ["a caller root with a witness", cw.r]] as const) {
  for (const [name, read] of reads) {
    const first = await read(x), second = await read(x), bad: string[] = [];
    separate(first, second, name, bad);
    const before = JSON.stringify(second, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    scramble(first);
    const third = await read(x), after = JSON.stringify(third, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    ok(`${reader}, ${name}: every object frozen or its own, and an answer scrambled leaves the next as it was`, bad.length === 0 && before === after, bad.slice(0, 3).join(" "));
  }
}
await r.close(); await c.r.close(); await cw.r.close();
done("cairnx-replica alias");
