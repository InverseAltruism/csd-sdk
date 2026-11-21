// indexerFeed: the replica source over the resolver's Scanner, which reads a csd-indexer. Its basis is a feed, level 1,
// or 2 with verifyInclusion, whose bodies, heights and authors are bound as the Scanner binds them. Each step is one
// scan. Its events at or below the cursor are checked against the store: where their events hash first differs, the
// step is a reorg to the last event block that agrees (CONVENTION section 34.3). Its events above the cursor are the
// step's blocks, grouped by height in the order of section 33.3, with a row and its hash at each epoch boundary. The
// cursor is the last block the scan answered for whole: the tip, or with verifyInclusion the final height (the Scanner
// emits nothing above it), or the last boundary the request budget reached, the tip then being the step's reach.
import { DOMAIN, EPOCH_LEN, EVENTS_HASH_START, HASH_RE, eventsHashStep, type ChainEvent } from "@inversealtruism/cairnx-core";
import { floorOf } from "./contract.js";
import { SourceError, cannotOf } from "./errors.js";
import { httpSessions, type Session } from "./http.js";
import { applyOrder } from "./order.js";
import { Scanner, branchRefusal, type ScanOptions } from "./scanner.js";
import type { BlockEvents, Cursor, Source, Step, StepContext, TipView } from "./types.js";

/** A block hash as csd-indexer's /block-height answers it, 0x and lowercase; anything else is SOURCE_MALFORMED. */
function blockHash(v: unknown, height: number): string {
  const h = typeof v === "string" ? (v.startsWith("0x") ? v : `0x${v}`).toLowerCase() : "";
  if (!HASH_RE.test(h)) throw new SourceError("SOURCE_MALFORMED", `the indexer's block hash at ${height} is not 64 hex`);
  return h;
}

/** The events of a scan by height, ascending, each block in the order of CONVENTION section 33.3. */
function byHeight(events: readonly ChainEvent[]): Map<number, ChainEvent[]> {
  const out = new Map<number, ChainEvent[]>();
  for (const e of [...events].sort(applyOrder)) {
    const list = out.get(e.height);
    if (list) list.push(e); else out.set(e.height, [e]);
  }
  return out;
}

/** The highest height at or below `at` where the scan's events hash equals the store's: `at` when they agree there,
 *  else the last event block of the scan that agrees, else `floor`. Equal running hashes mean equal event lists up to
 *  that height, so agreement holds at every candidate below one that agrees. */
function lastAgreeing(blocks: Map<number, ChainEvent[]>, at: number, floor: number, held: (h: number) => string | null): number {
  let hash = EVENTS_HASH_START, best = floor;
  for (const [h, events] of blocks) {
    if (h > at) break;
    hash = eventsHashStep(hash, h, events);
    if (held(h) === hash) best = h;
  }
  return held(at) === hash ? at : best;
}

/** `indexerUrl` and the rest of the Scanner's options (ScanOptions): one Scanner serves every step, so its caches and
 *  kept events carry over. `fetch` and `timeoutMs` also serve the block-hash reads. */
export function indexerFeed(o: ScanOptions): Source {
  const scanner = new Scanner(o);
  const base = o.indexerUrl.replace(/\/$/, "");
  const session = httpSessions(base, { ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) });
  const hashOf = async (s: Session, h: number) => blockHash(await s.json(`/block-height/${h}`, false), h);

  async function step(s: Session, ctx: StepContext): Promise<Step> {
    if (ctx.rule.domain !== DOMAIN) throw new SourceError("RULES_DIFFER", `the Scanner reads ${DOMAIN}, not ${ctx.rule.domain}`);
    const r = await scanner.scan();
    const moved = branchRefusal(r.anchor);
    if (moved !== null) throw new SourceError("BRANCH_MOVED", moved);
    const tip: TipView = { height: r.tipHeight, hash: blockHash(r.anchor.hashAfter, r.tipHeight), time: 0 };
    const top = Math.min(r.tipHeight, scanner.finalHeight ?? r.tipHeight);
    const floor = floorOf(ctx), blocks = byHeight(r.events.filter((e) => e.height >= ctx.rule.activationHeight));
    if (ctx.cursor !== null) {
      const to = lastAgreeing(blocks, ctx.cursor.height, floor, ctx.eventsHashAt);
      if (to !== ctx.cursor.height) return { kind: "reorg", to: { height: to, hash: await hashOf(s, to) }, tip };
    }
    const after = ctx.cursor?.height ?? floor;
    if (top <= after) return { kind: "idle", tip };
    const heights = new Set<number>();
    for (const h of blocks.keys()) if (h > after && h <= top) heights.add(h);
    for (let b = (Math.floor(after / EPOCH_LEN) + 1) * EPOCH_LEN; b <= top; b += EPOCH_LEN) heights.add(b);
    // Every boundary row carries its hash; once the budget's requests or blocks are spent the step ends at the last
    // boundary it read, whose hash the cursor needs.
    const reads = Math.max(1, ctx.budget.maxRequests - 1), most = Math.max(1, ctx.budget.maxBlocks), out: BlockEvents[] = [];
    let cursor: Cursor | null = null;
    for (const h of [...heights].sort((a, b) => a - b)) {
      let hash: string | null = null;
      if (h % EPOCH_LEN === 0) {
        if (cursor !== null && (s.requests() >= reads || out.length >= most)) break;
        hash = await hashOf(s, h);
        cursor = { height: h, hash };
      }
      out.push({ height: h, hash, events: blocks.get(h) ?? [] });
    }
    if (cursor !== null && out.length < heights.size) {
      return { kind: "blocks", blocks: out.filter((b) => b.height <= cursor!.height), cursor, tip, reach: top };
    }
    const end = cursor?.height === top ? cursor : { height: top, hash: top === tip.height ? tip.hash : await hashOf(s, top) };
    return { kind: "blocks", blocks: out, cursor: end, tip };
  }

  return {
    basis: { kind: "feed", feed: base, inclusion: o.verifyInclusion === true },
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
      const s = session(signal), height = await s.json("/blocks/tip/height", false);
      if (!Number.isSafeInteger(height)) throw new SourceError("SOURCE_MALFORMED", "the indexer's tip height is not an integer");
      return { height: height as number, hash: await hashOf(s, height as number), time: 0 };
    },
  };
}
