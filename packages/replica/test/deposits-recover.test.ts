// The example's recover (examples/deposits.ts) stopped and run again, over the recorded node: both deposits credited on
// branch A, then the node on branch B, where the transfer to A_ONLY is gone. The recovery is stopped at each step it
// takes (a database call, a write inside its transaction, a read of the replica) and the server runs again; it is
// stopped by a failing alert, and by a throw at the credited read followed by a restart. Each run ends with the credit
// B no longer holds raised once, no credit lost or doubled, and the address reading verified. Then a deposit mined
// again above the deep height: raised as not yet that deep, offered again later and refused by the key.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { merkleRoot } from "@inversealtruism/csd-codec";
import { creditDeposits, NOT_DEEP, openReplica, recover, type CreditOptions, type Deposits } from "../examples/deposits.js";
import { derivePin } from "../src/derive-pin.js";
import type { Pin, Reader } from "../src/index.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { A_ONLY, BOTH, branchB, database, DROPPED, END, FORK, PINNED, remine } from "./deposits-harness.js";
import { blockAt, cap, NODE, node, type Answers } from "./node-harness.js";

const root = mkdtempSync(join(tmpdir(), "cairnx-replica-recover-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const f: BlockFixture = { ...fx, to: 30_000, toHash: blockAt(cap.answers, 30_000).hash, blocks: fx.blocks.filter((b) => b.height <= 30_000) }, d = await derivePin(f);
const P1: Pin = { ...d.pin, log: async () => d.log }, O: CreditOptions = { minDepth: 12, pinned: PINNED }, B = branchB();
type Db = ReturnType<typeof database>;
let dirs = 0;

// One server: a store directory, the node it reads and its clock.
function world() {
  const dir = join(root, `s${dirs++}`), served: { answers: Answers; tip: number } = { answers: cap.answers, tip: cap.to }, nn = node(served);
  let now = 0;
  async function serveAt(r: Reader, answers: Answers, tip: number) {
    served.answers = answers; served.tip = tip; now = (Number(blockAt(answers, tip).header.time) + 60) * 1000;
    for (let k = 0; k < 3 && (k === 0 || r.status().cursor?.hash !== blockAt(answers, tip).hash); k++) await r.advance();
  }
  async function start(answers: Answers, tip: number) {
    served.answers = answers; served.tip = tip;
    const r = await openReplica({ node: NODE, dir, pin: P1, fetch: nn.f }, () => now);
    await serveAt(r, answers, tip);
    return r;
  }
  return { serveAt, start };
}
// Both deposits credited on A (the first start at 30,290, then 30,300), then the node on `to`, where each stored cursor
// is refused.
async function creditedThenMoved(to: Answers, tip: number) {
  const w = world(), db = database(), r = await w.start(cap.answers, 30_290);
  await creditDeposits(r, db, BOTH, O); await creditDeposits(r, db, A_ONLY, O);
  await w.serveAt(r, cap.answers, cap.to);
  await creditDeposits(r, db, BOTH, O); await creditDeposits(r, db, A_ONLY, O);
  await w.serveAt(r, to, tip);
  const off = [await creditDeposits(r, db, BOTH, O), await creditDeposits(r, db, A_ONLY, O)];
  return { w, db, r, off };
}
const aOnlyKey = (db: Db) => [...db.credits.keys()].find((k) => db.credits.get(k)!.to === A_ONLY)!;
const raised = (db: Db) => db.alerts.filter((x) => x === `${A_ONLY} ${aOnlyKey(db)}: ${NOT_DEEP}`).length;
// The server's next run for `address`: read, recover when the cursor is refused, read again.
async function serverRun(r: Reader, db: Db, address: string) {
  const a = await creditDeposits(r, db, address, O);
  if (codes(a) === "CURSOR_OFF_BRANCH") await recover(r, db, address, O);
  return creditDeposits(r, db, address, O);
}
// The end every sequence must reach: A_ONLY's credit raised once, both credits held once, no credit's amount changed,
// the address reading verified.
const settled = (db: Db, last: { verified: boolean }) =>
  raised(db) === 1 && db.credits.size === 2 && !db.alerts.some((x) => x.includes(", now ")) && last.verified;

class Stop extends Error {}
/** `db` and `r` with every step recover takes counted, the `at`-th one throwing Stop. */
function stopping(db: Db, r: Reader, at: number) {
  let n = 0;
  const tick = (what: string) => { if (++n === at) throw new Stop(what); };
  const dd: Deposits = {
    cursor: (a) => { tick("cursor"); return db.cursor(a); },
    earlier: (a) => { tick("earlier"); return db.earlier(a); },
    creditedAfter: (a, c) => { tick("creditedAfter"); return db.creditedAfter(a, c); },
    transaction: (fn) => { tick("transaction"); return db.transaction((t) => fn({
      credit: (x) => { tick("credit"); return t.credit(x); }, setCursor: (a, c) => { tick("setCursor"); return t.setCursor(a, c); },
      alert: (a, w) => { tick("alert"); return t.alert(a, w); },
    })); },
  };
  const rr: Reader = { ...r, transfers: (...args) => { tick("transfers"); return r.transfers(...args); } };
  return { dd, rr, steps: () => n };
}

console.log("recover stopped at each of its steps, then the server's next run:");
const base = await creditedThenMoved(B, END);
ok("on B the stored cursors are refused, CURSOR_OFF_BRANCH, both credits held", base.off.every((a) => codes(a) === "CURSOR_OFF_BRANCH") && base.db.credits.size === 2);
for (const address of [A_ONLY, BOTH]) {
  const bad: string[] = [];
  let points = 0;
  for (let at = 1; ; at++) {
    const db = base.db.copy(), s = stopping(db, base.r, at);
    const out = await recover(s.rr, s.dd, address, O).then(() => "done", (e: unknown) => { if (e instanceof Stop) return e.message; throw e; });
    if (out === "done" && s.steps() < at) break;
    points++;
    const last = await serverRun(base.r, db, address), other = address === A_ONLY ? BOTH : A_ONLY;
    // The other address is still refused; its own run settles the database for the check.
    const end = await serverRun(base.r, db, other);
    if (!settled(db, last) || !end.verified) bad.push(`stop ${at} (${out}): raised=${raised(db)} credits=${db.credits.size} ${codes(last)} ${db.alerts.length}`);
  }
  ok(`${address === A_ONLY ? "A_ONLY" : "BOTH"}: stopped at each of its ${points} steps, every run ends with the credit B lacks raised once and both credits held once`,
    points >= 8 && bad.length === 0, bad.join("; "));
}

console.log("the reviewers' two sequences:");
{
  const db = base.db.copy();
  let fail = true;
  const failing: Deposits = { ...db, transaction: (fn) => db.transaction((t) => fn({ ...t, alert: (a, w) => { if (fail && w !== "CURSOR_OFF_BRANCH") { fail = false; throw new Error("the operator's channel is down"); } return t.alert(a, w); } })) };
  const first = await recover(base.r, failing, A_ONLY, O).then(() => "done", (e: Error) => e.message), cursorKept = codes(await base.r.transfers(A_ONLY, db.cursor(A_ONLY), { minDepth: 12 }));
  const last = await serverRun(base.r, db, A_ONLY);
  ok("the alert fails inside recover: nothing written, the cursor still refused; the next run raises it once and credits nothing twice",
    first === "the operator's channel is down" && cursorKept === "CURSOR_OFF_BRANCH" && raised(db) === 1 && db.credits.size === 2 && last.verified, `${first} ${cursorKept} ${raised(db)}`);
}
{
  const s = await creditedThenMoved(B, END);
  let die = true;
  const dying: Deposits = { ...s.db, creditedAfter: (a, c) => { if (die) { die = false; throw new Error("the process died here"); } return s.db.creditedAfter(a, c); } };
  const first = await recover(s.r, dying, A_ONLY, O).then(() => "done", (e: Error) => e.message);
  await s.r.close();
  const r = await s.w.start(B, END), last = await serverRun(r, s.db, A_ONLY);
  ok("a throw at the credited read, then a restart: the stored cursor still refused, so the restarted server recovers and raises it once",
    first === "the process died here" && raised(s.db) === 1 && s.db.credits.size === 2 && last.verified, `${first} raised=${raised(s.db)} ${codes(last)}`);
  await r.close();
}

console.log("a deposit mined again above the deep height:");
{
  const LATE = END - 5, moved = blockAt(cap.answers, DROPPED).txs.slice(1);
  const merkle = (b: { txs: { txid: string }[]; header: { merkle: string } }) => { b.header.merkle = merkleRoot(b.txs.map((t) => t.txid)); };
  const C1 = remine(cap.answers, FORK, END, cap.to, (b) => {
    if (b.height === DROPPED) { b.txs = b.txs.slice(0, 1); merkle(b); }
    if (b.height === LATE) { b.txs = [...b.txs, ...moved]; merkle(b); }
  });
  const s = await creditedThenMoved(C1, END), rec = await recover(s.r, s.db, A_ONLY, O), st = await s.r.state({ minDepth: 0 });
  const atTip = st.verified && st.value.events.some((e) => e.height === LATE && e.moves?.some((m) => m.to === A_ONLY));
  ok(`the transfer of ${DROPPED} mined again at ${LATE}, the deep height ${END - 12}: raised once as not at minDepth or deeper, while the tip view holds it`,
    rec !== null && raised(s.db) === 1 && atTip && NOT_DEEP.includes("mined again in a block not yet that deep"), s.db.alerts.join("; "));
  const offered = s.db.offered.length;
  await s.w.serveAt(s.r, remine(C1, END + 1, END + 12, END), END + 12);
  const later = await creditDeposits(s.r, s.db, A_ONLY, O);
  ok("12 blocks later it is offered again and the key refuses a second credit: one credit to A_ONLY, no new alert",
    later.verified && s.db.offered.length === offered + 1 && s.db.credits.size === 2 && raised(s.db) === 1, `${codes(later)} ${s.db.offered.length - offered}`);
  await s.r.close();
}

console.log("a recovery whose start is a cursor inside a read (a page with more):");
{
  // MINTER's three moves (29,868, 29,875, 30,281) credited one a page, so each cursor but the last names a page whose
  // answer was read at the deep height 30,288; branch D drops the mint at 30,281.
  const MINTER = "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec", MINT = "0x9d784b727f727d76b88fd95ba4f0b4bf50c8c47eb9ea770a4acec29603e0b3ac";
  const xe5 = await (async () => { const w0 = world(), r0 = await w0.start(cap.answers, cap.to), st = await r0.state(); await r0.close(); return st.verified ? st.value.tokens.XE5XNS!.deployId : ""; })();
  const OP: CreditOptions = { minDepth: 12, pinned: { ...PINNED, XE5XNS: xe5 }, limit: 1 };
  const D = remine(cap.answers, FORK, END, cap.to, (b) => { if (b.height === FORK) { b.txs = b.txs.filter((t) => t.txid !== MINT); b.header.merkle = merkleRoot(b.txs.map((t) => t.txid)); } });
  const w = world(), db = database(), r = await w.start(cap.answers, cap.to);
  await creditDeposits(r, db, MINTER, OP);
  const held = db.credits.size, pages = db.earlier(MINTER).length;
  await w.serveAt(r, D, END);
  const off = await creditDeposits(r, db, MINTER, OP), rec = await recover(r, db, MINTER, OP), last = await creditDeposits(r, db, MINTER, OP);
  const mintRaised = db.alerts.filter((x) => x === `${MINTER} ${MINT}:mint: ${NOT_DEEP}`).length;
  ok("on D the recovery starts at the cursor of 29,875 and raises the mint written after it once, though its height lies below the deep height its page was read at",
    held === 3 && pages >= 3 && codes(off) === "CURSOR_OFF_BRANCH" && rec?.from?.startsWith("29875:") === true && mintRaised === 1 && db.credits.size === 3 && last.verified,
    `held=${held} pages=${pages} ${codes(off)} from=${rec?.from?.slice(0, 8)} raised=${mintRaised} ${db.alerts.join("; ")}`);
  await r.close();
}
await base.r.close();

done("cairnx-replica the example's recovery");
