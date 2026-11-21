// hostedBlocks: complete blocks from our front door's /api/blocks, bound to headers from a root that does not trust
// that server (design section 2): an anchor, from which the source verifies the headers itself (anchor-root.ts), or
// the caller's VerifiedHeaders (roots.ts). A step reads the server's /api/rpc/tip, which only says how far to try
// to read, lets the root settle the cursor (a reorg, a refusal or how far to read), then reads pages from cursor + 1
// while the budget lasts (always one). A page is the route's whole aligned 64 when all of it lies at or below that
// height, so every reader asks the same URLs and an edge cache can serve them; the part below the cursor is
// dropped. With `maxBlocks` of 64 or more a step that spans pages ends on a page's last block, so no page is read
// twice; with fewer a page is read once per step that needs it. Each page's headers go to the root, then each block
// is bound and its events made as block-read.ts does it. A page the root or the binding refuses is read once more
// past caches (http.ts) from the first block not bound, since an edge may hold a page marked immutable that a
// deeper reorg replaced; only that second answer is refused. A failure after blocks are bound ends the step before
// the failing block, keeping them; blocks bound earlier in the step that the root no longer holds (it adopted a
// branch below them) are dropped, and a step they empty returns the root's rollback. A rollback the root is owed is
// returned before the server is read. The step's tip is the root's (types.ts, TipView); the server's height is `reach`.
// The root's header window, where it keeps one, goes to the loop and back through the source (types.ts, Source).
import { anchorRoot } from "./anchor-root.js";
import { checkBasis } from "./basis.js";
import { bindServed, eventsOf, headerOf, memberPick, pickOf, readHead, type Served } from "./block-read.js";
import { cannotOf, ReplicaConfigError, SourceError } from "./errors.js";
import { httpSessions, servedWrong, twice, type HttpOptions, type Session } from "./http.js";
import { serverBase } from "./node-address.js";
import { callerRoot, type Root } from "./roots.js";
import { stepSofar } from "./sofar.js";
import type { BlockEvents, BlocksBasis, BlocksSource, Cursor, StepContext, Step, VerifiedHeaders } from "./types.js";

/** `origin`: the front door's base URL. `root`: a release's anchor with the window of headers held above the 45 of
 *  LWMA context (default 720), or the caller's verified headers. */
export interface HostedBlocksOptions extends HttpOptions {
  readonly origin: string;
  readonly root: { readonly kind: "anchor"; readonly anchor: Cursor; readonly window?: number } | { readonly kind: "caller"; readonly headers: VerifiedHeaders };
}
const PAGE = 64;

function pageOf(from: number, count: number) {
  return (v: unknown): Served[] => {
    const blocks = (v as { ok?: unknown; blocks?: unknown } | null)?.blocks;
    if (!Array.isArray(blocks) || blocks.length !== count) throw new SourceError("SOURCE_MALFORMED", `the page from ${from} is not ${count} blocks`);
    return blocks.map((b, i) => headerOf(b, from + i, null));
  };
}

export function hostedBlocks(o: HostedBlocksOptions): BlocksSource {
  const origin = serverBase(o.origin, "origin"), session = httpSessions(origin, o, "/api/rpc"), depth = o.root.kind === "anchor" ? o.root.window ?? 720 : 1;
  if (!Number.isSafeInteger(depth) || depth < 1) throw new ReplicaConfigError(`window: ${depth} is not a positive integer`);
  const root: Root = o.root.kind === "anchor" ? anchorRoot(o.root.anchor, depth) : callerRoot(o.root.headers);
  const basis = checkBasis({ kind: "blocks", root: root.root, bodies: origin }) as BlocksBasis;

  async function step(s: Session, ctx: StepContext): Promise<Step> {
    const owed = root.owed(ctx);
    if (owed !== null) return owed;
    const server = await readHead(s, "the server"), go = await root.begin(s, ctx, server);
    if ("kind" in go) return go;
    const at = ctx.cursor, from = (at?.height ?? ctx.rule.activationHeight - 1) + 1, most = from + Math.max(1, ctx.budget.maxBlocks) - 1;
    const page0 = most - (most % PAGE), to = Math.min(go.to, most % PAGE !== PAGE - 1 && page0 > from ? page0 - 1 : most);
    const sofar = stepSofar(ctx.sofar), blocks: BlockEvents[] = [];
    // Drops the blocks bound in this step that the root no longer holds; true when it dropped any.
    const prune = async () => {
      const before = blocks.length;
      while (blocks.length > 0 && (await root.hashAt(blocks.at(-1)!.height)) !== blocks.at(-1)!.hash) blocks.pop();
      return blocks.length < before;
    };
    let prev = at?.hash ?? null, stop = false;
    for (let p = from; p <= to && !stop; ) {
      if (blocks.length > 0 && (s.requests() >= ctx.budget.maxRequests || ctx.now() >= ctx.budget.deadlineAt)) break;
      for (let fresh = false; ; fresh = true) {
        const a = p - (p % PAGE), whole = a + PAGE - 1 <= server.height, end = Math.min(a + PAGE - 1, to), lo = whole ? a : p, n = whole ? PAGE : end - p + 1;
        try {
          const rows = pageOf(lo, n)(await s.json(`/api/blocks/${lo}/${n}`, fresh)).filter((r) => r.height >= p && r.height <= end);
          const v = await root.check(s, ctx, server, rows, fresh), cut = await prune();
          if ("kind" in v || cut) {
            const back = "kind" in v ? v : root.owed(ctx);
            if (blocks.length === 0 && back !== null) return back;
            stop = true;
            break;
          }
          for (const r of rows.slice(0, v.verified)) {
            if (prev !== null && r.header.prev.toLowerCase() !== prev) throw new SourceError("BRANCH_MOVED", `block ${r.height} does not link to ${prev}`);
            const b = await bindServed(s, r, memberPick(r.height, sofar.view, ctx.rule)), events = eventsOf(b, sofar.view, ctx.rule);
            sofar.add(events);
            blocks.push({ height: b.height, hash: b.hash, events });
            prev = b.hash;
            p = b.height + 1;
          }
          if (v.error !== null) throw v.error;
          p = end + 1;
          break;
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          if (!fresh && servedWrong(e)) continue;
          if (blocks.length === 0) throw e;
          stop = true;
          break;
        }
      }
    }
    const last = blocks.at(-1), tip = root.tipView()!;
    return last === undefined ? { kind: "idle", tip } : { kind: "blocks", blocks, cursor: { height: last.height, hash: last.hash! }, tip, reach: go.to };
  }

  return {
    basis,
    floor: null,
    async next(ctx) {
      try {
        const st = await step(session(ctx.signal), ctx);
        ctx.signal.throwIfAborted();
        return st;
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return cannotOf(e);
      }
    },
    tip: (signal) => root.tip(signal),
    ...(root.windowAt === undefined || root.restoreWindow === undefined ? {} : { windowAt: root.windowAt, restoreWindow: root.restoreWindow }),
    async block(height, b) {
      const s = session(b.signal), hash = await root.hashAt(height);
      if (hash === null) throw new SourceError("SOURCE_UNAVAILABLE", `no verified header is held at ${height}`);
      return twice(s, `/api/blocks/${height}/1`, (v) => {
        const [x] = pageOf(height, 1)(v);
        if (x!.hash !== hash) throw new SourceError("HEADER_INVALID", `the block served at ${height} is not the verified one`);
        if (b.prev !== null && x!.header.prev.toLowerCase() !== b.prev) throw new SourceError("BRANCH_MOVED", `block ${height} does not link to ${b.prev}`);
        return bindServed(s, x!, pickOf(b.authors, b.rule));
      });
    },
  };
}
