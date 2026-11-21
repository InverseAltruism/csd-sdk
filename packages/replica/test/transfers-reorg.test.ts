// The server example of the README in its assembled form (local(): nodeBlocks over one's own node, a memory store)
// over the recorded node capture and a 20-block reorg. Branch A is the capture to 30,300, where 30,284 and 30,286 each
// hold a CAIRN transfer to a deposit address. Branch B forks at 30,281 (20 blocks replaced), is the same chain without
// the transfer at 30,286, and runs on to 30,320. A server at minDepth 24 credits the deposit on both branches once,
// only once it is 24 deep on B, and never the one on A alone. A server at minDepth 12 credits both on A; after the
// reorg its cursor is refused (CURSOR_OFF_BRANCH) instead of passing the change silently, and a read from null with
// (txid, leg) as the unique key credits nothing twice. A reorg that keeps every event keeps every cursor.
import { resolve } from "@inversealtruism/cairnx-core";
import { rpcHeaderToHeader } from "@inversealtruism/csd-client";
import { headerHash, merkleRoot } from "@inversealtruism/csd-codec";
import type { BoundCursor, Reader, Transfer } from "../src/index.js";
import { local, open } from "../src/server.js";
import { done, ok } from "./check.js";
import { corpus } from "./core-files.js";
import { blockAt, branchFrom, cap, NODE, node, type Answers } from "./node-harness.js";

const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const FORK = 30_281, DROPPED = 30_286, END = 30_320, BOTH = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016", A_ONLY = "0x9d9305de03a77efd7f69720baff8e3e461cfe010";
const PINNED: Record<string, string> = { CAIRN: resolve(corpus.events.filter((e) => e.height <= cap.to), cap.to).tokens.CAIRN!.deployId };

/** Branch B: every block from FORK mined again on the one below, the block at DROPPED without its transfer, and blocks
 *  holding only 30,300's coinbase from 30,301 to END, two minutes apart. */
function branchB(): Answers {
  const out: Answers = { ...cap.answers }, last = blockAt(cap.answers, cap.to);
  for (let h = FORK, prev = blockAt(cap.answers, FORK - 1).hash; h <= END; h++) {
    const b = structuredClone(blockAt(cap.answers, Math.min(h, cap.to)));
    b.height = h;
    b.header.nonce += 1;
    if (h > cap.to) b.header.time = Number(last.header.time) + 120 * (h - cap.to);
    if (h === DROPPED) { b.txs = b.txs.slice(0, 1); b.header.merkle = merkleRoot(b.txs.map((t) => t.txid)); }
    b.header.prev = prev;
    prev = b.hash = headerHash(rpcHeaderToHeader(b.header as never));
    out[`/block/height/${h}`] = JSON.stringify(b);
  }
  return out;
}
const B = branchB();

// A server's database: the credits and each address's cursor, written together. `offered` counts every row the
// server tried to credit, so a row offered twice shows even though the unique key would refuse it.
function database() {
  const credits = new Map<string, Transfer>(), cursors = new Map<string, BoundCursor>(), offered: string[] = [];
  return {
    credits, offered,
    cursor: (address: string): BoundCursor | null => cursors.get(address) ?? null,
    forget: (address: string) => { cursors.delete(address); },
    transaction(f: (t: { credit(x: Transfer): void; setCursor(address: string, c: BoundCursor): void }) => void) {
      f({ credit: (x) => { const k = `${x.txid}:${x.leg}`; offered.push(k); if (!credits.has(k)) credits.set(k, x); }, setCursor: (a, c) => cursors.set(a, c) });
    },
  };
}
type Db = ReturnType<typeof database>;

// The server example (README): each verified page credited once, the cursor stored with its credits.
async function creditDeposits(replica: Reader, db: Db, address: string, minDepth: number) {
  for (;;) {
    const a = await replica.transfers(address, db.cursor(address), { minDepth });
    if (!a.verified) return a;                       // nothing credited, the cursor stays; retried later
    db.transaction((t) => {
      for (const x of a.value.items) if (x.deployId === PINNED[x.ticker]) t.credit(x);   // (txid, leg) a unique key
      t.setCursor(address, a.value.next);
    });
    if (!a.value.more) return a;
  }
}

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
await serveAt(r12, cap.answers, cap.to);
await creditDeposits(r12, db12, BOTH, 12); await creditDeposits(r12, db12, A_ONLY, 12);
ok("on A at 30,300 (deep 30,288): both deposits credited, one each", db12.offered.length === 2 && db12.credits.size === 2);
await serveAt(r12, B, END);
const o1 = await r12.transfers(A_ONLY, db12.cursor(A_ONLY), { minDepth: 12 }), o2 = await r12.transfers(BOTH, db12.cursor(BOTH), { minDepth: 12 });
ok("on B: each stored cursor is refused, CURSOR_OFF_BRANCH alone, nothing shown (the events below it changed)",
  codes(o1) === "CURSOR_OFF_BRANCH" && !o1.verified && o1.shown === null && codes(o2) === "CURSOR_OFF_BRANCH" && !o2.verified && o2.shown === null);
for (const a of [BOTH, A_ONLY]) { db12.forget(a); await creditDeposits(r12, db12, a, 12); }
const again = await r12.transfers(A_ONLY, null, { minDepth: 12 });
ok("read again from null: the deposit on both branches offered again and refused by its key, nothing new credited; A's alone is not on B",
  db12.offered.length === 3 && db12.credits.size === 2 && again.verified && again.value.items.length === 0);
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
