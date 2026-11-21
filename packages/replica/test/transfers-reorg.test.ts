// The server example of the README in its assembled form (local(): nodeBlocks over one's own node, a memory store)
// over the recorded node capture and a 20-block reorg. Branch A is the capture to 30,300, where 30,284 and 30,286 each
// hold a CAIRN transfer to a deposit address. Branch B forks at 30,281 (20 blocks replaced), is the same chain without
// the transfer at 30,286, and runs on to 30,320. A server at minDepth 24 credits the deposit on both branches once,
// only once it is 24 deep on B, and never the one on A alone. A server at minDepth 12 credits both on A; after the
// reorg its cursor is refused (CURSOR_OFF_BRANCH) instead of passing the change silently, the example raises it, and
// the recovery of the README rereads from the newest earlier cursor still on B, credits nothing twice and names the
// credit B no longer holds. A reorg that keeps every event keeps every cursor.
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

// A server's database: the credits and each address's cursors (the current one last), written together, and what it
// raised to its operator. `offered` counts every row the server tried to credit, so a row offered twice shows even
// though the unique key refuses it; a row offered again with another amount is raised.
type Credit = { credit(x: Transfer): void; setCursor(address: string, c: BoundCursor | null): void };
function database() {
  const credits = new Map<string, Transfer>(), cursors = new Map<string, (BoundCursor | null)[]>(), offered: string[] = [], alerts: string[] = [];
  const t: Credit = {
    credit(x) {
      const k = `${x.txid}:${x.leg}`, had = credits.get(k);
      offered.push(k);
      if (had === undefined) credits.set(k, x);
      else if (had.amount !== x.amount) alerts.push(`${x.to} ${k}: credited ${had.amount}, now ${x.amount}`);
    },
    setCursor: (a, c) => { cursors.set(a, [...(cursors.get(a) ?? []), c]); },
  };
  return {
    credits, offered, alerts,
    cursor: (address: string): BoundCursor | null => cursors.get(address)?.at(-1) ?? null,
    earlier: (address: string): BoundCursor[] => (cursors.get(address) ?? []).filter((c): c is BoundCursor => c !== null).reverse(),
    alert: (address: string, what: string) => { alerts.push(`${address} ${what}`); },
    transaction(f: (t: Credit) => void) { f(t); },
  };
}
type Db = ReturnType<typeof database>;

// The server example (README): each verified page credited once, the cursor stored with its credits.
async function creditDeposits(replica: Reader, db: Db, address: string, minDepth: number) {
  for (;;) {
    const a = await replica.transfers(address, db.cursor(address), { minDepth });
    if (!a.verified) {
      // A retry answers CURSOR_OFF_BRANCH again: the address waits for the recovery, and its operator is told.
      if (a.why.some((w) => w.code === "CURSOR_OFF_BRANCH")) db.alert(address, "CURSOR_OFF_BRANCH");
      return a;                                      // nothing credited, the cursor stays
    }
    db.transaction((t) => {
      for (const x of a.value.items) if (x.deployId === PINNED[x.ticker]) t.credit(x);   // (txid, leg) a unique key
      t.setCursor(address, a.value.next);
    });
    if (!a.value.more) return a;
  }
}

// The recovery the README describes: the newest earlier cursor the read still accepts (null when none does) becomes
// the cursor, the pages from it credit by the key, and a credit above it that they do not give again is raised.
async function recover(replica: Reader, db: Db, address: string, minDepth: number): Promise<{ from: BoundCursor | null } | null> {
  let from: BoundCursor | null = null;
  for (const c of db.earlier(address)) {
    const a = await replica.transfers(address, c, { minDepth, limit: 1 });
    if (a.verified) { from = c; break; }
    if (!a.why.some((w) => w.code === "CURSOR_OFF_BRANCH")) return null;   // not ready: retried later
  }
  const mark = db.offered.length, above = from === null ? -1 : Number(from.split(":")[0]);
  db.transaction((t) => t.setCursor(address, from));
  const end = await creditDeposits(replica, db, address, minDepth);
  if (!end.verified) return null;
  const again = new Set(db.offered.slice(mark));
  for (const [k, x] of db.credits) if (x.to === address && x.height > above && !again.has(k)) db.alert(address, `${k}: credited, no longer on the chain`);
  return { from };
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
