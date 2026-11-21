// The server example (examples/deposits.ts) as a server runs it: openReplica over ownNode, one store directory and one
// database across every start, the recorded node behind it. A first start under the pin at 30,000 to 30,290; a
// restart that reads on from the stored cursor, not the pin's log, and credits both deposits at minDepth 12; a 20-block
// reorg to branch B while running, which the example raises and recovers from; a 20-block reorg while closed that keeps
// every event, so every cursor; a newer pin (30,270) that keeps the store. Nothing is credited twice.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditDeposits, NOT_DEEP, openReplica, recover, type CreditOptions } from "../examples/deposits.js";
import { derivePin } from "../src/derive-pin.js";
import type { Pin, Reader } from "../src/index.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { A_ONLY, BOTH, branchB, database, END, FORK, PINNED, remine } from "./deposits-harness.js";
import { blockAt, cap, NODE, node, type Answers } from "./node-harness.js";

const root = mkdtempSync(join(tmpdir(), "cairnx-replica-deposits-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const dir = join(root, "replica"), codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const reads = new Map<number, number>();
async function pinAt(h: number): Promise<Pin> {
  const f: BlockFixture = { ...fx, to: h, toHash: blockAt(cap.answers, h).hash, blocks: fx.blocks.filter((b) => b.height <= h) }, d = await derivePin(f);
  return { ...d.pin, log: async () => { reads.set(h, (reads.get(h) ?? 0) + 1); return d.log; } };
}
const P1 = await pinAt(30_000), P2 = await pinAt(30_270), O: CreditOptions = { minDepth: 12, pinned: PINNED };
const B = branchB(), B2 = remine(B, END - 19, END + 1, END);   // B mined again from 30,301 (20 blocks), one block higher

// The node and the clock the server sees; `start` opens the example's replica over `dir` and reads to the node's tip.
let now = 0;
const served: { answers: Answers; tip: number } = { answers: cap.answers, tip: cap.to }, nn = node(served);
const tipOf = (a: Answers, tip: number) => blockAt(a, tip);
async function serveAt(r: Reader, answers: Answers, tip: number) {
  served.answers = answers; served.tip = tip;
  now = (Number(tipOf(answers, tip).header.time) + 60) * 1000;
  for (let k = 0; k < 3 && r.status().cursor?.hash !== tipOf(answers, tip).hash; k++) await r.advance();
}
async function start(pin: Pin, answers: Answers, tip: number) {
  served.answers = answers; served.tip = tip;
  const r = await openReplica({ node: NODE, dir, pin, fetch: nn.f }, () => now);
  await serveAt(r, answers, tip);
  return r;
}
const db = database(), both = async (r: Reader) => [await creditDeposits(r, db, BOTH, O), await creditDeposits(r, db, A_ONLY, O)];
const blockReads = (from: number, atOrBelow: number) => nn.log.slice(from).filter((l) => /^\/block\/height\/[0-9]+$/.test(l.path) && Number(l.path.split("/")[3]) <= atOrBelow).length;
const storedPin = () => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).meta.basis.pin.height as number;

console.log("a first start, then a restart:");
let r = await start(P1, cap.answers, 30_290);
const a1 = await both(r);
ok("first start under the pin at 30,000, the node at 30,290: both reads verified, nothing credited (30,284 and 30,286 are not 12 deep)",
  a1.every((a) => a.verified) && db.offered.length === 0 && reads.get(30_000) === 1, a1.map(codes).join(" / "));
await r.close();
const mark = nn.log.length;
r = await start(P1, cap.answers, cap.to);
const a2 = await both(r);
ok("restarted over the same directory, the node at 30,300: the pin's log not read again, no block at or below the stored cursor 30,290 read",
  reads.get(30_000) === 1 && blockReads(mark, 30_290) === 0 && r.status().cursor?.height === cap.to, `reads=${reads.get(30_000)} below=${blockReads(mark, 30_290)}`);
ok("both deposits credited once, from the stored cursors (deep 30,288)", a2.every((a) => a.verified) && db.offered.length === 2 && db.credits.size === 2);

console.log("a 20-block reorg while running:");
await serveAt(r, B, END);
const s3 = r.status(), a3 = await both(r);
ok(`the node moves to B: the replica rolls back below the fork (to ${s3.lastReorg?.to.height}) and follows B to 30,320; each stored cursor is refused, raised to the operator`,
  s3.lastReorg !== null && s3.lastReorg.to.height < FORK && s3.cursor?.height === END && a3.every((a) => codes(a) === "CURSOR_OFF_BRANCH") &&
  db.alerts.filter((x) => x.endsWith(" CURSOR_OFF_BRANCH")).length === 2 && db.offered.length === 2, a3.map(codes).join(" / "));
const rec = [await recover(r, db, BOTH, O), await recover(r, db, A_ONLY, O)];
ok("the recovery rereads from the first start's cursor (deep 30,278, below the fork): the deposit on both branches offered again and refused by the key",
  rec.every((x) => x?.from?.startsWith("30278:") === true) && db.offered.length === 3 && db.credits.size === 2);
ok("it raises the credit of A alone as not at minDepth on this branch, and nothing else",
  db.alerts.length === 3 && db.alerts[2] === `${A_ONLY} ${[...db.credits.keys()].find((k) => db.credits.get(k)!.to === A_ONLY)}: ${NOT_DEEP}`, db.alerts.join("; "));
await r.close();

console.log("a 20-block reorg while closed, keeping every event:");
r = await start(P1, B2, END + 1);
const s4 = r.status(), a4 = await both(r);
ok("reopened over B mined again from 30,301: the stored cursor rolled back below 30,301 and followed to 30,321; every stored cursor still verified, nothing offered again",
  s4.lastReorg !== null && s4.lastReorg.to.height <= END - 20 && s4.cursor?.hash === tipOf(B2, END + 1).hash && a4.every((a) => a.verified) &&
  db.offered.length === 3 && db.alerts.length === 3, `${a4.map(codes).join(" / ")} to=${s4.lastReorg?.to.height}`);
await r.close();

console.log("a newer pin:");
const B3 = remine(B2, END + 2, END + 2, END + 1);
r = await start(P2, B3, END + 2);
const a5 = await both(r), s5 = r.status();
ok("reopened under the pin at 30,270: the store kept (that log not read), verified under it, its next commit records it, nothing offered again",
  reads.get(30_270) === undefined && s5.verified && s5.vouch.kind === "pinned" && s5.vouch.pin.height === 30_270 && storedPin() === 30_270 &&
  a5.every((a) => a.verified) && db.offered.length === 3 && db.alerts.length === 3, `${codes(s5)} reads=${reads.get(30_270)}`);
await r.close();

done("cairnx-replica the server example");
