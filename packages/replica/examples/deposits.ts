// The server example of the README ("Transfers"): a server credits the token moves to its deposit addresses from its
// own node, with the replica's store on disk, so a restart reads on from the stored cursor instead of the pin's log.
// test/deposits.test.ts runs it over the recorded node across a restart, a 20-block reorg while running and one while
// closed, and a change of pin; test/transfers-reorg.test.ts runs creditDeposits and recover over a memory store. A
// server imports these names from "@inversealtruism/cairnx-replica/server"; the example imports this package's source
// so that the suite runs what this tree builds.
import { open, ownNode, type Answer, type BoundCursor, type OwnNodeOptions, type Page, type Reader, type Transfer } from "../src/server.js";

type Awaitable<T> = T | Promise<T>;
/** One transaction of the server's database: a credit, refused when its key (txid, leg) is held, and an address's
 *  cursor, written together. */
export interface Credit { credit(x: Transfer): Awaitable<void>; setCursor(address: string, cursor: BoundCursor | null): Awaitable<void> }
/** The server's database: an address's cursor, its earlier cursors newest first, its credits above a height, what is
 *  raised to the operator, and transactions. */
export interface Deposits {
  cursor(address: string): Awaitable<BoundCursor | null>;
  earlier(address: string): Awaitable<readonly BoundCursor[]>;
  creditedAbove(address: string, height: number): Awaitable<readonly Transfer[]>;
  alert(address: string, what: string): Awaitable<void>;
  transaction(f: (t: Credit) => Awaitable<void>): Awaitable<void>;
}
/** `minDepth`: how deep a move must lie before it is credited, the server's choice for value; `pinned`: the deploy id
 *  credited for each ticker. */
export interface CreditOptions { readonly minDepth: number; readonly pinned: Readonly<Record<string, string>> }
type Moves = Answer<Page<Transfer, BoundCursor>>;
const keyOf = (x: Transfer): string => `${x.txid}:${x.leg}`;

/** The replica: one's own node, the store in `dir`, above `pin`, a witness when one is named. `clock` is the reader's
 *  (Date.now unless a test sets it). */
export const openReplica = (o: OwnNodeOptions, clock?: () => number): Promise<Reader> => open({ ...ownNode(o), ...(clock === undefined ? {} : { clock }) });

/** Credits each verified page of moves to `address` after its cursor, the cursor stored with the page's credits;
 *  returns the last answer. Nothing is credited from an answer that is not verified. `seen` collects the key of every
 *  move offered. */
export async function creditDeposits(replica: Reader, db: Deposits, address: string, o: CreditOptions, seen?: Set<string>): Promise<Moves> {
  for (;;) {
    const a = await replica.transfers(address, await db.cursor(address), { minDepth: o.minDepth });
    if (!a.verified) {
      // A retry answers CURSOR_OFF_BRANCH again: the address waits for recover(), and its operator is told.
      if (a.why.some((w) => w.code === "CURSOR_OFF_BRANCH")) await db.alert(address, "CURSOR_OFF_BRANCH");
      return a;                                      // nothing credited, the cursor stays
    }
    await db.transaction(async (t) => {
      for (const x of a.value.items) {
        seen?.add(keyOf(x));
        if (x.deployId === o.pinned[x.ticker]) await t.credit(x);   // (txid, leg) a unique key
      }
      await t.setCursor(address, a.value.next);
    });
    if (!a.value.more) return a;
  }
}

/** After CURSOR_OFF_BRANCH: the newest earlier cursor the read still accepts (null when none does) becomes the cursor,
 *  the pages after it are credited by the key, and each credit above it that they do not give again is raised as no
 *  longer on the chain. Null while the replica gives neither a verified answer nor CURSOR_OFF_BRANCH: call it
 *  again later. */
export async function recover(replica: Reader, db: Deposits, address: string, o: CreditOptions): Promise<{ readonly from: BoundCursor | null } | null> {
  let from: BoundCursor | null = null;
  for (const c of await db.earlier(address)) {
    const a = await replica.transfers(address, c, { minDepth: o.minDepth, limit: 1 });
    if (a.verified) { from = c; break; }
    if (!a.why.some((w) => w.code === "CURSOR_OFF_BRANCH")) return null;
  }
  // The height a cursor names is its first field (the type's form, height:pos:eventsHash).
  const seen = new Set<string>(), above = from === null ? -1 : Number(from.split(":")[0]);
  await db.transaction((t) => t.setCursor(address, from));
  if (!(await creditDeposits(replica, db, address, o, seen)).verified) return null;
  for (const x of await db.creditedAbove(address, above)) if (!seen.has(keyOf(x))) await db.alert(address, `${keyOf(x)}: credited, no longer on the chain`);
  return { from };
}
