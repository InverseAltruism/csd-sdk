// indexerFeed: the replica source over the resolver's Scanner, which reads a csd-indexer. Its basis is a feed, level 1,
// or 2 with verifyInclusion, whose bodies, heights and authors are bound as the Scanner binds them. Each step is one
// scan. The events of the rule are those at or above its activation, Attests only on a Propose among them (CONVENTION
// section 33.1). Up to the lower of the cursor and the scan's top they are checked against the store, and so are the
// block hashes it holds there (the cursor's and its boundary rows'): the step is a reorg to the lower of the last event
// block whose events hash agrees (section 34.3) and the last held block hash the indexer still gives; a cursor above the
// indexer's tip is a block it does not give. Its events above
// the cursor are the step's blocks, grouped by height in the order of section 33.3, with a row and its hash at each
// epoch boundary. The cursor is the last block the scan answered for whole: the tip, or with verifyInclusion the final
// height (the Scanner emits nothing above it), or the last boundary the request budget reached, the tip then being the
// step's reach.
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

/** Of the cursor (when at or below `at`) and the boundary rows the store holds at or below `at`, walked down from the
 *  top, the first whose block hash the indexer still gives: null when that is the first one walked or none is held, so
 *  no held hash moved; `floor` when none agrees. A cursor above `indexerTip` is a block the indexer's chain does not
 *  have, so it counts as moved and the first boundary that agrees is returned. A cursor above `at` but not above the
 *  indexer's tip (a final height that moved back) moved nothing. A block hash commits its parent, so every block below
 *  one that agrees is the indexer's too, and the walk reads one hash while nothing moved. */
async function lastHashAgreeing(ctx: StepContext, at: number, floor: number, now: (h: number) => Promise<string>, indexerTip: number): Promise<number | null> {
  const c = ctx.cursor!, heights = c.height <= at ? [c.height] : [];
  for (let b = Math.floor(at / EPOCH_LEN) * EPOCH_LEN; b > floor; b -= EPOCH_LEN) if (b !== c.height) heights.push(b);
  let first = c.height <= indexerTip;
  for (const h of heights) {
    const held = h === c.height ? c.hash : ctx.hashAt(h);
    if (held === null) continue;
    if ((await now(h)) === held) return first ? null : h;
    first = false;
  }
  return first ? null : floor;
}

/** The events of `rule` among a scan's: at or above its activation, and an Attest only on a Propose kept (an Attest on
 *  a Propose mined before activation is no event). */
function ruleEvents(events: readonly ChainEvent[], activationHeight: number): ChainEvent[] {
  const kept = events.filter((e) => e.height >= activationHeight);
  const proposes = new Set(kept.flatMap((e) => (e.kind === "propose" ? [e.id] : [])));
  return kept.filter((e) => e.kind === "propose" || proposes.has(e.proposalId));
}

/** The time, in seconds, of the block `hash` at `height` as csd-indexer's /block/<hash> answers it: an answer that does
 *  not name that block at that height with a whole number of seconds is SOURCE_MALFORMED. */
async function timeOf(s: Session, height: number, hash: string): Promise<number> {
  const b = await s.json(`/block/${hash}`, false) as { hash?: unknown; height?: unknown; time?: unknown } | null;
  const named = typeof b === "object" && b !== null && b.height === height && typeof b.hash === "string" && b.hash.toLowerCase() === hash;
  if (!named || !Number.isSafeInteger(b.time) || (b.time as number) < 0) throw new SourceError("SOURCE_MALFORMED", `the indexer's block ${hash} is not the block at ${height} with a time`);
  return b.time as number;
}

/** `indexerUrl` and the rest of the Scanner's options (ScanOptions): one Scanner serves every step, so its caches and
 *  kept events carry over. `fetch` and `timeoutMs` also serve the block-hash and block-time reads. The tip a step
 *  reports is the block at the scan's top with its time: the indexer's tip, or with verifyInclusion the final height,
 *  the highest block the Scanner emits for, so the reader's BEHIND counts from what this source can serve and its
 *  answers carry the note FINAL_VIEW. Source.tip() gives the indexer's tip without verifyInclusion and the last step's
 *  tip with it (null before the first step). */
export function indexerFeed(o: ScanOptions): Source {
  const scanner = new Scanner(o);
  const base = o.indexerUrl.replace(/\/$/, ""), inclusion = o.verifyInclusion === true;
  const session = httpSessions(base, { ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) });
  const hashOf = async (s: Session, h: number) => blockHash(await s.json(`/block-height/${h}`, false), h);
  // The tip's hash is the one the scan read before and after its pull: a later read of that height may name another.
  const hashIn = (s: Session, tip: { height: number; hash: string }) => (h: number) => (h === tip.height ? Promise.resolve(tip.hash) : hashOf(s, h));
  let last: TipView | null = null;

  async function step(s: Session, ctx: StepContext): Promise<Step> {
    if (ctx.rule.domain !== DOMAIN) throw new SourceError("RULES_DIFFER", `the Scanner reads ${DOMAIN}, not ${ctx.rule.domain}`);
    const r = await scanner.scan();
    const moved = branchRefusal(r.anchor);
    if (moved !== null) throw new SourceError("BRANCH_MOVED", moved);
    const top = Math.min(r.tipHeight, scanner.finalHeight ?? r.tipHeight);
    const floor = floorOf(ctx), blocks = byHeight(ruleEvents(r.events, ctx.rule.activationHeight));
    const now = hashIn(s, { height: r.tipHeight, hash: blockHash(r.anchor.hashAfter, r.tipHeight) });
    // Read last, so the step's budget goes to the blocks first; `known` is the hash at the top when the step read it. A
    // final height below genesis (a header source syncing from it again) reports genesis.
    const tipOf = async (known?: string): Promise<TipView> => {
      const height = Math.max(0, top), hash = known ?? (await now(height));
      return { height, hash, time: await timeOf(s, height, hash) };
    };
    if (ctx.cursor !== null) {
      // Above the scan's top the Scanner emitted nothing, so the store is compared only up to it.
      const at = Math.min(ctx.cursor.height, top);
      const to = Math.min(lastAgreeing(blocks, at, floor, ctx.eventsHashAt), (await lastHashAgreeing(ctx, at, floor, now, r.tipHeight)) ?? at);
      if (to !== at) return { kind: "reorg", to: { height: to, hash: await now(to) }, tip: await tipOf() };
    }
    const after = ctx.cursor?.height ?? floor;
    if (top <= after) return { kind: "idle", tip: await tipOf(top === ctx.cursor?.height ? ctx.cursor.hash : undefined) };
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
        hash = await now(h);
        cursor = { height: h, hash };
      }
      out.push({ height: h, hash, events: blocks.get(h) ?? [] });
    }
    if (cursor !== null && out.length < heights.size) {
      return { kind: "blocks", blocks: out.filter((b) => b.height <= cursor!.height), cursor, tip: await tipOf(), reach: top };
    }
    const end = cursor?.height === top ? cursor : { height: top, hash: await now(top) };
    return { kind: "blocks", blocks: out, cursor: end, tip: await tipOf(end.hash) };
  }

  return {
    basis: { kind: "feed", feed: base, inclusion },
    floor: null,
    async next(ctx) {
      try {
        const s = await step(session(ctx.signal), ctx);
        ctx.signal.throwIfAborted();
        if (s.kind !== "cannot") last = s.tip;
        return s;
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return cannotOf(e);
      }
    },
    async tip(signal) {
      if (inclusion) return last;
      const s = session(signal), height = await s.json("/blocks/tip/height", false);
      if (!Number.isSafeInteger(height)) throw new SourceError("SOURCE_MALFORMED", "the indexer's tip height is not an integer");
      const hash = await hashOf(s, height as number);
      return { height: height as number, hash, time: await timeOf(s, height as number, hash) };
    },
  };
}
