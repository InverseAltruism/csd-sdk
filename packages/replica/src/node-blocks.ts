// nodeBlocks: complete blocks from a CSD node's /block/height/:h with the node itself as the header root (design
// section 2), level 3 on the word of whoever runs that node; node-address.ts decides which addresses count as one's
// own. A step reads the node's tip, then each block from cursor + 1 while the budget lasts (always one), bound as
// block-read.ts binds it, its events made by cairnx-core's blockMembers and blockEvents with the step's two sets. A
// failure after blocks are bound ends the step before the failing block, keeping them; the next step meets it first.
// When the node's chain no longer holds the cursor's block, fork.ts finds the highest held block it does hold.
import { eventsOf, memberPick, pickOf, readBound, readHead, type Pick } from "./block-read.js";
import { cannotOf, SourceError } from "./errors.js";
import { forkSearch, type Head } from "./fork.js";
import { httpSessions, type HttpOptions, type Session } from "./http.js";
import { stepSofar } from "./sofar.js";
import type { BlockEvents, BlocksSource, BoundBlock, StepContext, Step, TipView } from "./types.js";

/** `node`: the node's base URL, which the entry's address rule must accept. */
export interface NodeBlocksOptions extends HttpOptions { readonly node: string }
const none: Pick = () => [];
const isLink = (e: unknown) => e instanceof SourceError && e.code === "BRANCH_MOVED";

/** The source over `node`, an address the caller's entry accepted. */
export function nodeBlocksAt(node: string, o: HttpOptions): BlocksSource {
  const session = httpSessions(node, o);
  let known: TipView | null = null;

  const head = (s: Session): Promise<Head> => readHead(s, "the node");
  // The tip's header time, from the last block read when that is the tip, else from a read of the tip's block.
  async function tipView(s: Session, h: Head, last: BoundBlock | null): Promise<TipView> {
    if (known?.hash === h.hash && last?.hash !== h.hash) return known;
    const b = last?.hash === h.hash ? last : await readBound(s, h.height, none, null);
    return (known = { height: b.height, hash: b.hash, time: Number(b.header.time) });
  }
  const fork = forkSearch({
    probe: async (s, height) => { const b = await readBound(s, height, none, null); return { hash: b.hash, prev: String(b.header.prev).toLowerCase() }; },
    tipView: (s, h) => tipView(s, h, null),
  });

  async function step(s: Session, ctx: StepContext): Promise<Step> {
    const h = await head(s), at = ctx.cursor, b = ctx.budget;
    const moved = fork.pending(at) ?? (at !== null && (at.height > h.height || (at.height === h.height && at.hash !== h.hash)) ? "tip" : null);
    if (moved !== null && at !== null) return fork.run(s, ctx, at, h, moved);
    const sofar = stepSofar(ctx.sofar), blocks: BlockEvents[] = [];
    let last: BoundBlock | null = null, failed: unknown = null;
    for (let height = (at?.height ?? ctx.rule.activationHeight - 1) + 1; height <= h.height; height++) {
      if (blocks.length > 0 && (blocks.length >= b.maxBlocks || s.requests() >= b.maxRequests || ctx.now() >= b.deadlineAt)) break;
      try {
        const r = await readBound(s, height, memberPick(height, sofar.view, ctx.rule), last?.hash ?? at?.hash ?? null);
        if (height === h.height && r.hash !== h.hash) throw new SourceError("SOURCE_MALFORMED", `the node serves ${r.hash} at ${height}, not the ${h.hash} its /tip names`);
        const events = eventsOf(r, sofar.view, ctx.rule);
        sofar.add(events);
        blocks.push({ height, hash: r.hash, events });
        last = r;
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        if (last === null) {
          if (isLink(e) && at !== null) return fork.run(s, ctx, at, h, "link");
          throw e;
        }
        failed = e;
        break;
      }
    }
    if (last === null) return { kind: "idle", tip: await tipView(s, h, null) };
    let tip: TipView;
    try {
      tip = await tipView(s, h, last);
    } catch (e) {
      throw failed !== null && !ctx.signal.aborted ? failed : e;
    }
    return { kind: "blocks", blocks, cursor: { height: last.height, hash: last.hash }, tip };
  }

  return {
    basis: { kind: "blocks", root: { kind: "own-node", node }, bodies: node },
    floor: null,
    async next(ctx) {
      try {
        const s = await step(session(ctx.signal), ctx);
        ctx.signal.throwIfAborted();
        return s;
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return cannotOf(e);
      }
    },
    async tip(signal) {
      const s = session(signal);
      return tipView(s, await head(s), null);
    },
    block: (height, b) => readBound(session(b.signal), height, pickOf(b.authors, b.rule), b.prev),
  };
}
