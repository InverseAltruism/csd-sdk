// The server example's creditDeposits and recover (examples/deposits.ts) over local() (nodeBlocks over one's own node,
// a memory store), the recorded node capture and a 20-block reorg: branch A, the capture, and branch B, forking at
// 30,281 without the transfer at 30,286 (deposits-harness.ts). A server at minDepth 24 credits the deposit on both branches once,
// only once it is 24 deep on B, and never the one on A alone. A server at minDepth 12 credits both on A; after the
// reorg its cursor is refused (CURSOR_OFF_BRANCH) instead of passing the change silently, the example raises it, and
// the recovery of the README rereads from the newest earlier cursor still on B, credits nothing twice and names the
// credit B no longer holds. A reorg that keeps every event keeps every cursor.
import { creditDeposits as credit, recover as recoverFrom } from "../examples/deposits.js";
import type { Reader } from "../src/index.js";
import { local, open } from "../src/server.js";
import { done, ok } from "./check.js";
import { A_ONLY, BOTH, branchB, database, FORK, END, PINNED } from "./deposits-harness.js";
import { blockAt, branchFrom, cap, NODE, node, type Answers } from "./node-harness.js";

const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const B = branchB();
type Db = ReturnType<typeof database>;
// The example's two calls (examples/deposits.ts) at a test's minDepth, crediting CAIRN's deploy id.
const creditDeposits = (replica: Reader, db: Db, address: string, minDepth: number) => credit(replica, db, address, { minDepth, pinned: PINNED });
const recover = (replica: Reader, db: Db, address: string, minDepth: number) => recoverFrom(replica, db, address, { minDepth, pinned: PINNED });

let now = 0;
const served: { answers: Answers; tip: number } = { answers: cap.answers, tip: cap.to };
async function serveAt(r: Reader, answers: Answers, tip: number) {
  served.answers = answers; served.tip = tip;
  now = (Number(JSON.parse(answers[`/block/height/${tip}`]!).header.time) + 60) * 1000;
  for (let k = 0; k < 3 && r.status().cursor?.hash !== JSON.parse(answers[`/block/height/${tip}`]!).hash; k++) await r.advance();
}
const replica = async () => open({ ...local({ node: NODE, fetch: node(served).f }), clock: () => now });

console.log("a server at minDepth 24 over the 20-block reorg:");
const r = await replica(), db = database();
await serveAt(r, cap.answers, cap.to);
const a1 = await creditDeposits(r, db, BOTH, 24), a2 = await creditDeposits(r, db, A_ONLY, 24);
ok("on A at 30,300: both reads verified, nothing credited (30,284 and 30,286 are not 24 deep)", a1.verified && a2.verified && db.offered.length === 0);
await serveAt(r, B, 30_304);
const s = r.status(), b1 = await creditDeposits(r, db, BOTH, 24), b2 = await creditDeposits(r, db, A_ONLY, 24);
ok(`the node moves to B at 30,304: the replica rolls back below the fork (to ${s.lastReorg?.to.height}) and follows B; nothing credited yet`,
  s.lastReorg !== null && s.lastReorg.to.height < FORK && s.cursor?.height === 30_304 && s.verified && b1.verified && b2.verified && db.offered.length === 0);
await serveAt(r, B, 30_307);
await creditDeposits(r, db, BOTH, 24);
ok("at 30,307 the deposit at 30,284 is 23 deep: still not credited", db.offered.length === 0);
await serveAt(r, B, 30_308);
const c1 = await creditDeposits(r, db, BOTH, 24), c2 = await creditDeposits(r, db, A_ONLY, 24);
const credited = [...db.credits.values()];
ok("at 30,308 it is 24 deep: credited once, the transfer's amount and deploy id", c1.verified && c2.verified && db.offered.length === 1 && credited[0]?.height === 30_284 &&
  credited[0].to === BOTH && credited[0].leg === "xfer" && credited[0].amount === "500000000000000" && credited[0].deployId === PINNED.CAIRN);
await serveAt(r, B, END);
for (let k = 0; k < 3; k++) { await creditDeposits(r, db, BOTH, 24); await creditDeposits(r, db, A_ONLY, 24); }
ok(`on to 30,320, read three more times: nothing more offered, and the deposit of A alone never credited`, db.offered.length === 1 && ![...db.credits.values()].some((x) => x.to === A_ONLY));
await r.close();

console.log("a server at minDepth 12, shallower than the reorg:");
const r12 = await replica(), db12 = database();
await serveAt(r12, cap.answers, 30_290);
await creditDeposits(r12, db12, BOTH, 12); await creditDeposits(r12, db12, A_ONLY, 12);
await serveAt(r12, cap.answers, cap.to);
await creditDeposits(r12, db12, BOTH, 12); await creditDeposits(r12, db12, A_ONLY, 12);
ok("on A at 30,290 then 30,300 (deep 30,288): both deposits credited, one each", db12.offered.length === 2 && db12.credits.size === 2);
await serveAt(r12, B, END);
const o1 = await r12.transfers(A_ONLY, db12.cursor(A_ONLY), { minDepth: 12 }), o2 = await r12.transfers(BOTH, db12.cursor(BOTH), { minDepth: 12 });
ok("on B: each stored cursor is refused, CURSOR_OFF_BRANCH alone, nothing shown (the events below it changed)",
  codes(o1) === "CURSOR_OFF_BRANCH" && !o1.verified && o1.shown === null && codes(o2) === "CURSOR_OFF_BRANCH" && !o2.verified && o2.shown === null);
const stuck = [await creditDeposits(r12, db12, BOTH, 12), await creditDeposits(r12, db12, A_ONLY, 12), await creditDeposits(r12, db12, BOTH, 12)];
ok("the example raises CURSOR_OFF_BRANCH to its operator at each try and credits nothing: retrying does not clear it",
  stuck.every((a) => codes(a) === "CURSOR_OFF_BRANCH") && db12.alerts.length === 3 && db12.alerts.every((x) => x.endsWith(" CURSOR_OFF_BRANCH")) && db12.offered.length === 2);
const rec = [await recover(r12, db12, BOTH, 12), await recover(r12, db12, A_ONLY, 12)];
ok("the recovery rereads from the cursor of 30,290 (deep 30,278, below the fork), offers the deposit on both branches again and the key refuses it",
  rec.every((x) => x?.from?.startsWith("30278:") === true) && db12.offered.length === 3 && db12.credits.size === 2);
ok("it raises the credit of A alone as no longer on the chain, and nothing else", db12.alerts.length === 4 &&
  db12.alerts[3] === `${A_ONLY} ${[...db12.credits.keys()].find((k) => db12.credits.get(k)!.to === A_ONLY)}: credited, no longer on the chain`);
const after = [await creditDeposits(r12, db12, BOTH, 12), await creditDeposits(r12, db12, A_ONLY, 12)];
ok("after the recovery both addresses read verified again, nothing more offered", after.every((a) => a.verified) && db12.offered.length === 3 && db12.alerts.length === 4);
await r12.close();

console.log("a reorg that keeps every event:");
const same = branchFrom(FORK), rs = await replica(), dbs = database();
await serveAt(rs, cap.answers, cap.to);
await creditDeposits(rs, dbs, BOTH, 12); await creditDeposits(rs, dbs, A_ONLY, 12);
await serveAt(rs, same, cap.to);
const ss = rs.status(), k1 = await creditDeposits(rs, dbs, BOTH, 12), k2 = await creditDeposits(rs, dbs, A_ONLY, 12);
ok("the node re-mines 30,281 to 30,300 with the same transactions: the replica rolls back and follows, the stored cursors still verified, nothing offered twice or missed",
  ss.lastReorg !== null && ss.lastReorg.to.height < FORK && ss.cursor?.hash === blockAt(same, cap.to).hash && k1.verified && k2.verified && dbs.offered.length === 2 && dbs.credits.size === 2);
await rs.close();

done("cairnx-replica transfers over a reorg");
