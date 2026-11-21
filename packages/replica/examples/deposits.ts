// The server example of the README ("Transfers"): a server credits the token moves to its deposit addresses from its
// own node, with the replica's store on disk, so a restart reads on from the stored cursor instead of the pin's log.
// test/deposits.test.ts runs it over the recorded node across a restart, a 20-block reorg while running and one while
// closed, and a change of pin; test/transfers-reorg.test.ts runs creditDeposits and recover over a memory store. A
// server imports these names from "@inversealtruism/cairnx-replica/server"; the example imports this package's source
// so that the suite runs what this tree builds.
import { open, ownNode, type Answer, type BoundCursor, type OwnNodeOptions, type Page, type Reader, type Transfer } from "../src/server.js";

type Awaitable<T> = T | Promise<T>;
/** One transaction of the server's database: a credit, refused when its key (txid, leg) is held; an address's cursor;
 *  an alert to the operator; all written together or not at all. A memo is the sender's text and can hold U+0000: a
 *  database that refuses it in a text column stores it as bytes or escaped, so that no transfer stops an address. */
export interface Credit {
  credit(x: Transfer): Awaitable<void>; setCursor(address: string, cursor: BoundCursor | null): Awaitable<void>; alert(address: string, what: string): Awaitable<void>;
}
/** The server's database: an address's cursor, its earlier cursors newest first, the credits to it written in the
 *  transactions after the last one that stored `cursor` (every credit to it for null), and transactions. */
export interface Deposits {
  cursor(address: string): Awaitable<BoundCursor | null>;
  earlier(address: string): Awaitable<readonly BoundCursor[]>;
  creditedAfter(address: string, cursor: BoundCursor | null): Awaitable<readonly Transfer[]>;
  transaction(f: (t: Credit) => Awaitable<void>): Awaitable<void>;
}
/** `minDepth`: how deep a move must lie before it is credited, the server's choice for value; `pinned`: the deploy id
 *  credited for each ticker; `limit`: the rows a page holds (the read's default, 100, when absent). */
export interface CreditOptions { readonly minDepth: number; readonly pinned: Readonly<Record<string, string>>; readonly limit?: number }
type Moves = Answer<Page<Transfer, BoundCursor>>;
const keyOf = (x: Transfer): string => `${x.txid}:${x.leg}`;
const offBranch = (a: Moves): boolean => a.why.some((w) => w.code === "CURSOR_OFF_BRANCH");
/** What `recover` raises for a credit the pages after its cursor do not give. */
export const NOT_DEEP = "credited, not at minDepth or deeper on the branch the replica holds: gone, or mined again in a block not yet that deep, " +
  "which a later page then offers again (the key refuses a second credit)";

/** The replica: one's own node, the store in `dir`, above `pin`, a witness when one is named. `clock` is the reader's
 *  (Date.now unless a test sets it). */
export const openReplica = (o: OwnNodeOptions, clock?: () => number): Promise<Reader> => open({ ...ownNode(o), ...(clock === undefined ? {} : { clock }) });

/** Credits each verified page of moves to `address` after its cursor, the cursor stored with the page's credits;
 *  returns the last answer. Nothing is credited from an answer that is not verified. */
export async function creditDeposits(replica: Reader, db: Deposits, address: string, o: CreditOptions): Promise<Moves> {
  for (;;) {
    const a = await replica.transfers(address, await db.cursor(address), { minDepth: o.minDepth, ...(o.limit === undefined ? {} : { limit: o.limit }) });
    if (!a.verified) {
      // A retry answers CURSOR_OFF_BRANCH again: the address waits for recover(), and its operator is told.
      if (offBranch(a)) await db.transaction((t) => t.alert(address, "CURSOR_OFF_BRANCH"));
      return a;                                      // nothing credited, the cursor stays
    }
    await db.transaction(async (t) => {
      for (const x of a.value.items) if (x.deployId === o.pinned[x.ticker]) await t.credit(x);   // (txid, leg) a unique key
      await t.setCursor(address, a.value.next);
    });
    if (!a.value.more) return a;
  }
}

/** After CURSOR_OFF_BRANCH: the newest earlier cursor the read still accepts (null when none does) is where the
 *  recovery starts. It reads the pages after it without writing, then raises each credit written after that cursor
 *  that the pages do not give, and stores the cursor, in one transaction; then it credits from there by the key. Until
 *  that transaction the stored cursors are as they were, so a recovery stopped at any point runs again over the same
 *  range, and once it lands no alert is lost. Null while the replica gives neither a verified answer nor
 *  CURSOR_OFF_BRANCH: call it again later. */
export async function recover(replica: Reader, db: Deposits, address: string, o: CreditOptions): Promise<{ readonly from: BoundCursor | null } | null> {
  let from: BoundCursor | null = null;
  for (const c of await db.earlier(address)) {
    const a = await replica.transfers(address, c, { minDepth: o.minDepth, limit: 1 });
    if (a.verified) { from = c; break; }
    if (!offBranch(a)) return null;
  }
  const seen = new Set<string>();
  for (let at = from; ;) {
    const a = await replica.transfers(address, at, { minDepth: o.minDepth, ...(o.limit === undefined ? {} : { limit: o.limit }) });
    if (!a.verified) return null;
    for (const x of a.value.items) seen.add(keyOf(x));
    if (!a.value.more) break;
    at = a.value.next;
  }
  const gone = (await db.creditedAfter(address, from)).filter((x) => !seen.has(keyOf(x)));
  await db.transaction(async (t) => {
    for (const x of gone) await t.alert(address, `${keyOf(x)}: ${NOT_DEEP}`);
    await t.setCursor(address, from);
  });
  if (!(await creditDeposits(replica, db, address, o)).verified) return null;
  return { from };
}
