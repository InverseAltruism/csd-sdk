// The header roots of hostedBlocks, which does not trust the server it reads blocks from (design section 2): what a
// root does before a step's pages and with each page's headers. The caller root is here; the anchor root is
// anchor-root.ts. A caller root's headers are the caller's: each step syncs them to the server's tip and asks them
// for the cursor's hash. Another hash means the caller reorganised, and fork.ts searches the held blocks with `at`
// for the highest still on the caller's chain (`at` reads the caller's own store, so the search takes no request
// and ends within the step: at most 2 * ceil(log2(n + 1)) probes of two reads of `at` each for n held blocks). No
// header at the cursor while the caller's tip is at or above it (a store that keeps a floor and a suffix) is a
// refusal, never a rollback: a rollback needs another hash. Inside the search a null is "not held": the fork is
// placed only where the caller answered another hash (fork.ts). A caller whose tip is below the cursor on the chain
// the store holds rolls nothing back.
import { floorBreak } from "./basis.js";
import { SourceError } from "./errors.js";
import { forkSearch, type Head } from "./fork.js";
import type { Session } from "./http.js";
import type { HeaderRoot, StepContext, Step, TipView, VerifiedHeaders } from "./types.js";
import type { HeaderRow } from "./window.js";

/** Internal. How many leading rows of a page are verified, and the error that ends them, if any. */
export type Checked = { readonly verified: number; readonly error: SourceError | null };

/** Internal. `begin` runs before the pages: the step to return instead (a reorg, idle or cannot), or how far to try
 *  to read (the server's unverified claim, never a tip). `check` takes a page's rows from the first unread height: a
 *  step (a reorg below the store's cursor), or how many leading rows are verified and the error to throw once they
 *  are bound; with `final` false a row that differs from the root throws BRANCH_MOVED, so the page is read again
 *  past caches before a refusal. `hashAt` is the verified hash at a height, or null. `tipView` is the tip the root
 *  vouches for (types.ts, TipView), null before it has one; `tip` may read the root for it. `owed` is a rollback the
 *  store still owes the root, returned before anything is read: while one is owed no tip above its target is
 *  reported and no step ends otherwise. Each throws SourceError. */
export interface Root {
  readonly root: HeaderRoot;
  begin(s: Session, ctx: StepContext, server: Head): Promise<Step | { readonly to: number }>;
  check(s: Session, ctx: StepContext, server: Head, rows: readonly HeaderRow[], final: boolean): Promise<Step | Checked>;
  hashAt(height: number): Promise<string | null>;
  tipView(): TipView | null;
  tip(signal: AbortSignal): Promise<TipView | null>;
  owed(ctx: StepContext): Step | null;
}

export function callerRoot(h: VerifiedHeaders): Root {
  let tip: TipView | null = null;
  const hashAt = async (height: number) => (await h.at(height))?.hash.toLowerCase() ?? null;
  const viewOf = (v: { height: number; hash: string; time: number }): TipView => ({ height: v.height, hash: v.hash.toLowerCase(), time: v.time });
  const fork = forkSearch({ probe: async (_s, height) => ({ hash: (await hashAt(height)) ?? "", prev: (await hashAt(height - 1)) ?? "" }), tipView: async () => tip!,
    holds: async (height) => (await hashAt(height)) !== null, who: "the caller" });
  return {
    root: { kind: "caller", floor: h.floor, origin: h.origin },
    hashAt,
    tipView: () => tip,
    owed: () => null,
    async tip(signal) { const v = await h.sync(null, signal); return v === null ? null : (tip = viewOf(v)); },
    async begin(s, ctx, server) {
      const at = ctx.cursor;
      const low = floorBreak({ kind: "caller", floor: h.floor, origin: h.origin }, null, ctx.rule);
      if (low !== null) throw new SourceError("BELOW_FLOOR", low);
      const v = await h.sync(server.height, ctx.signal);
      if (v === null) throw new SourceError("SOURCE_UNAVAILABLE", "the caller's headers do not know the tip");
      tip = viewOf(v);
      if (at !== null && fork.pending(at) !== null) return fork.run(s, ctx, at, tip, "resume");
      const mine = at === null ? null : await hashAt(at.height);
      if (at !== null && mine === null && v.height >= at.height) {
        throw new SourceError("SOURCE_UNAVAILABLE", `the caller's headers hold no header at the cursor ${at.height}, below their tip ${v.height}`);
      }
      if (at !== null && mine !== at.hash) return fork.run(s, ctx, at, tip, "tip");
      return { to: Math.min(v.height, server.height) };
    },
    async check(_s, _ctx, server, rows, final) {
      await h.offer?.(server.height, rows.map((r) => ({ height: r.height, header: r.header })));
      for (const [i, r] of rows.entries()) {
        if ((await hashAt(r.height)) === r.hash) continue;
        const e = new SourceError(final ? "HEADER_INVALID" : "BRANCH_MOVED", `the block served at ${r.height} is not the one the caller's headers hold`);
        if (!final) throw e;
        return { verified: i, error: e };
      }
      return { verified: rows.length, error: null };
    },
  };
}
