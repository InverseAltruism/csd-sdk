// What the tests of the server example (examples/deposits.ts) share: the server's database, branches mined again from
// the recorded node capture, and the two deposit addresses. Branch A is the capture to 30,300, where 30,284 and 30,286
// each hold a CAIRN transfer to a deposit address; branch B forks at 30,281, is A without the transfer at 30,286, and
// runs on to 30,320.
import { resolve } from "@inversealtruism/cairnx-core";
import { rpcHeaderToHeader } from "@inversealtruism/csd-client";
import { headerHash, merkleRoot } from "@inversealtruism/csd-codec";
import type { BoundCursor, Transfer } from "../src/index.js";
import type { Credit, Deposits } from "../examples/deposits.js";
import { corpus } from "./core-files.js";
import { blockAt, cap, type Answers, type Block } from "./node-harness.js";

export const FORK = 30_281, DROPPED = 30_286, END = 30_320;
export const BOTH = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016", A_ONLY = "0x9d9305de03a77efd7f69720baff8e3e461cfe010";
export const PINNED: Record<string, string> = { CAIRN: resolve(corpus.events.filter((e) => e.height <= cap.to), cap.to).tokens.CAIRN!.deployId };

/** `base` with every block from `fork` to `end` mined again on the one below (another nonce, so another hash), each a
 *  copy of `base`'s block at that height or, above `top`, of its block at `top` two minutes after it; `edit` changes a
 *  block before it is hashed. */
export function remine(base: Answers, fork: number, end: number, top: number, edit: (b: Block) => void = () => undefined): Answers {
  const out: Answers = { ...base }, last = blockAt(base, top);
  for (let h = fork, prev = blockAt(base, fork - 1).hash; h <= end; h++) {
    const b = structuredClone(blockAt(base, Math.min(h, top)));
    b.height = h;
    b.header.nonce += 1;
    if (h > top) b.header.time = Number(last.header.time) + 120 * (h - top);
    edit(b);
    b.header.prev = prev;
    prev = b.hash = headerHash(rpcHeaderToHeader(b.header as never));
    out[`/block/height/${h}`] = JSON.stringify(b);
  }
  return out;
}
/** Branch B: the block at DROPPED without its transfer. */
export const branchB = (): Answers => remine(cap.answers, FORK, END, cap.to, (b) => {
  if (b.height === DROPPED) { b.txs = b.txs.slice(0, 1); b.header.merkle = merkleRoot(b.txs.map((t) => t.txid)); }
});

/** The server's database, held in memory: credits by (txid, leg), each address's cursors (the current one last) and
 *  what it raised to its operator, each written in a transaction that applies whole or not at all. `offered` counts
 *  every row the server tried to credit, so a row offered twice shows though the key refuses it; a row offered again
 *  with another amount is raised. `copy()` is a second database holding the same state. */
export function database(from?: { credits: [string, Transfer & { seq: number }][]; cursors: [string, { c: BoundCursor | null; seq: number }[]][]; offered: string[]; alerts: string[]; seq: number }) {
  const credits = new Map(from?.credits ?? []), cursors = new Map(from?.cursors.map(([a, l]) => [a, [...l]]) ?? []);
  const offered = [...(from?.offered ?? [])], alerts = [...(from?.alerts ?? [])];
  let seq = from?.seq ?? 0;
  const db = {
    cursor: (address: string): BoundCursor | null => cursors.get(address)?.at(-1)?.c ?? null,
    earlier: (address: string): BoundCursor[] => (cursors.get(address) ?? []).map((x) => x.c).filter((c): c is BoundCursor => c !== null).reverse(),
    creditedAfter(address: string, cursor: BoundCursor | null): Transfer[] {
      const stored = (cursors.get(address) ?? []).filter((x) => x.c === cursor).at(-1)?.seq ?? 0;
      return [...credits.values()].filter((x) => x.to === address && x.seq > stored).map(({ seq: _, ...x }) => x);
    },
    async transaction(f: (t: Credit) => void | Promise<void>) {
      const ops: (() => void)[] = [], n = seq + 1;
      await f({
        credit: (x) => { ops.push(() => {
          const k = `${x.txid}:${x.leg}`, had = credits.get(k);
          offered.push(k);
          if (had === undefined) credits.set(k, { ...x, seq: n });
          else if (had.amount !== x.amount) alerts.push(`${x.to} ${k}: credited ${had.amount}, now ${x.amount}`);
        }); },
        setCursor: (a, c) => { ops.push(() => { cursors.set(a, [...(cursors.get(a) ?? []), { c, seq: n }]); }); },
        alert: (a, what) => { ops.push(() => { alerts.push(`${a} ${what}`); }); },
      });
      seq = n;
      for (const op of ops) op();
    },
  } satisfies Deposits;
  const copy = () => database({ credits: [...credits], cursors: [...cursors], offered, alerts, seq });
  return { ...db, credits, offered, alerts, copy };
}
