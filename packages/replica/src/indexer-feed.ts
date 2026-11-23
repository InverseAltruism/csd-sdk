// indexerFeed: the replica source over the resolver's Scanner, which reads a csd-indexer. Its basis is a feed, level 1,
// or 2 with verifyInclusion, whose bodies, heights and authors are bound as the Scanner binds them. Each step is one
// scan. The events of the rule are those at or above its activation, Attests only on a Propose among them (CONVENTION
// section 33.1). Up to the lower of the cursor and the scan's top they are checked against the store by their events
// hash (section 34.3); a step whose events differ there is a reorg to the last event block that agrees. The chain the
// feed follows is the indexer's, or with verifyInclusion the caller's verified headers (indexerFeed below). A cursor
// whose block is not on it (above what the indexer serves on it, or another block at its height) is also a reorg, to
// the lower of that and the last held boundary on it, never below the floor. Its events above the cursor are the
// step's blocks, grouped by height in the order of section 33.3, with a row and its hash at each epoch boundary. The
// cursor is the last block the scan answered for whole: the highest the indexer serves on the chain, or the last
// boundary the request budget reached, the scan's top then being the step's reach.
import { DOMAIN, EPOCH_LEN, EVENTS_HASH_START, HASH_RE, eventsHashStep, type ChainEvent } from "@inversealtruism/cairnx-core";
import { MAX_FUTURE_DRIFT_SECS } from "@inversealtruism/csd-codec";
import { floorOf } from "./contract.js";
import { ReplicaConfigError, SourceError, cannotOf } from "./errors.js";
import { RETRY_WAIT_MAX_MS, httpSessions, type Session } from "./http.js";
import { applyOrder } from "./order.js";
import { Scanner, branchRefusal, type ScanAnchor, type ScanOptions } from "./scanner.js";
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

/** Of the boundary rows the store holds above `floor` and at or below `at`, other than the cursor's, walked down from
 *  the top, the first whose block hash the indexer gives there; `floor` when none does. A block hash commits its
 *  parent, so every block below one that agrees is the indexer's too. */
async function lastHashAgreeing(ctx: StepContext, at: number, floor: number, now: (h: number) => Promise<string>): Promise<number> {
  const c = ctx.cursor!;
  for (let b = Math.floor(at / EPOCH_LEN) * EPOCH_LEN; b > floor; b -= EPOCH_LEN) {
    const held = b === c.height ? null : ctx.hashAt(b);
    if (held !== null && (await now(b)) === held) return b;
  }
  return floor;
}

/** The events of `rule` among a scan's: at or above its activation, and an Attest only on a Propose kept (an Attest on
 *  a Propose mined before activation is no event). */
function ruleEvents(events: readonly ChainEvent[], activationHeight: number): ChainEvent[] {
  const kept = events.filter((e) => e.height >= activationHeight);
  const proposes = new Set(kept.flatMap((e) => (e.kind === "propose" ? [e.id] : [])));
  return kept.filter((e) => e.kind === "propose" || proposes.has(e.proposalId));
}

/** The time, in seconds, of the block `hash` at `height` as csd-indexer's /block/<hash> answers it: an answer that does
 *  not name that block (in any form blockHash takes) at that height with a whole number of seconds is SOURCE_MALFORMED. */
async function timeOf(s: Session, height: number, hash: string): Promise<number> {
  const b = await s.json(`/block/${hash}`, false) as { hash?: unknown; height?: unknown; time?: unknown } | null;
  const named = typeof b === "object" && b !== null && b.height === height && blockHash(b.hash, height) === hash;
  if (!named || !Number.isSafeInteger(b.time) || (b.time as number) < 0) throw new SourceError("SOURCE_MALFORMED", `the indexer's block ${hash} is not the block at ${height} with a time`);
  return b.time as number;
}

/** The Scanner's options (ScanOptions) and, with verifyInclusion, `headerAt`: the hash and header time (seconds) of
 *  the block at a height on the caller's verified headers, the source headerMerkleAt and verifiedTipHeight read. It
 *  is asked only at or below the final height, or for genesis while the final height is below it. */
export interface IndexerFeedOptions extends ScanOptions {
  readonly headerAt?: (height: number) => Promise<{ readonly hash: string; readonly time: number }>;
}

/** `indexerUrl` and the rest of the Scanner's options: one Scanner serves every step, so its caches and kept events carry
 *  over. `fetch`, `timeoutMs` and `waitMaxMs` (default RETRY_WAIT_MAX_MS here) also serve the block-hash and block-time
 *  reads. A step's scan takes the step's signal, and stops at the first Retry-After wait after the step's deadline,
 *  kept for the next step to resume; a step that ends short of its scan's top (a budget, the deadline) hands that scan
 *  to the next step while the indexer still gives its tip hash. Without verifyInclusion the chain is the
 *  indexer's: a step's tip is its tip with the time its /block/<hash> gives, and block hashes are its /block-height.
 *  With verifyInclusion the chain is the caller's verified headers: the tip is the final height with `headerAt`'s hash
 *  and time, every block hash held is `headerAt`'s, the indexer serves up to the highest height at or below the lower
 *  of its tip and the final height where it gives the verified hash, and the reader's BEHIND counts from the final
 *  height; every answer carries the note FINAL_VIEW. Throws ReplicaConfigError for verifyInclusion without `headerAt`:
 *  a feed that checks inclusion names its tip from verified headers or not at all. Source.tip() gives the indexer's tip
 *  without verifyInclusion and the last step's tip with it (null before the first step). */
export function indexerFeed(o: IndexerFeedOptions): Source {
  const inclusion = o.verifyInclusion === true, headerAt = o.headerAt;
  if (inclusion && headerAt === undefined) throw new ReplicaConfigError("indexerFeed: verifyInclusion needs headerAt, the verified header at a height, to name its tip");
  const waitMaxMs = o.waitMaxMs ?? RETRY_WAIT_MAX_MS, scanner = new Scanner({ ...o, waitMaxMs });
  const base = o.indexerUrl.replace(/\/$/, "");
  const session = httpSessions(base, { ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }), waitMaxMs });
  const hashOf = async (s: Session, h: number) => blockHash(await s.json(`/block-height/${h}`, false), h);
  // The tip's hash is the one the scan read before and after its pull: a later read of that height may name another.
  const hashIn = (s: Session, tip: { height: number; hash: string }) => (h: number) => (h === tip.height ? Promise.resolve(tip.hash) : hashOf(s, h));
  let last: TipView | null = null;
  // The scan of a step that ended short of its top, and the cursor that step returned: the next step reads on from it.
  type Scan = { readonly events: ChainEvent[]; readonly tipHeight: number; readonly anchor: ScanAnchor };
  let carried: { r: Scan; final: number; cursor: Cursor } | null = null;

  /** The verified header at `h`, read once a step: a hash in a form blockHash takes and a whole number of seconds at
   *  most MAX_FUTURE_DRIFT_SECS after the clock, the chain's own bound (a time in milliseconds is far above it), else
   *  SOURCE_MALFORMED. */
  function verifiedHeaders(now: () => number) {
    const seen = new Map<number, Promise<{ hash: string; time: number }>>();
    const at = (h: number) => {
      let p = seen.get(h);
      if (p === undefined) {
        p = headerAt!(h).then((v: unknown) => {
          const x = (typeof v === "object" && v !== null ? v : {}) as { hash?: unknown; time?: unknown };
          if (!Number.isSafeInteger(x.time) || (x.time as number) < 0) throw new SourceError("SOURCE_MALFORMED", `the verified header at ${h} has no time in whole seconds`);
          if ((x.time as number) > Math.floor(now() / 1000) + MAX_FUTURE_DRIFT_SECS) throw new SourceError("SOURCE_MALFORMED", `the verified header at ${h} is timed more than ${MAX_FUTURE_DRIFT_SECS} s after this clock`);
          return { hash: blockHash(x.hash, h), time: x.time as number };
        });
        seen.set(h, p);
      }
      return p;
    };
    return { at, reads: () => seen.size };
  }

  /** The scan a step reads: the one carried, when the store's cursor is the one its step returned and the indexer still
   *  gives its tip hash (so every block under it is the scan's), else a new one. */
  async function scanFor(s: Session, ctx: StepContext): Promise<{ r: Scan; final: number }> {
    const c = carried, at = ctx.cursor;
    carried = null;
    if (c !== null && at !== null && at.height === c.cursor.height && at.hash === c.cursor.hash) {
      const tip = blockHash(c.r.anchor.hashAfter, c.r.tipHeight);
      if (blockHash(await s.json(`/block-height/${c.r.tipHeight}`, false), c.r.tipHeight) === tip) return c;
    }
    const r = await scanner.scan({ signal: ctx.signal, due: () => ctx.now() >= ctx.budget.deadlineAt });
    const moved = branchRefusal(r.anchor);
    if (moved !== null) throw new SourceError("BRANCH_MOVED", moved);
    return { r, final: inclusion ? scanner.finalHeight! : r.tipHeight };
  }

  async function step(s: Session, ctx: StepContext): Promise<Step> {
    if (ctx.rule.domain !== DOMAIN) throw new SourceError("RULES_DIFFER", `the Scanner reads ${DOMAIN}, not ${ctx.rule.domain}`);
    const { r, final } = await scanFor(s, ctx);
    const floor = floorOf(ctx), blocks = byHeight(ruleEvents(r.events, ctx.rule.activationHeight));
    const indexer = hashIn(s, { height: r.tipHeight, hash: blockHash(r.anchor.hashAfter, r.tipHeight) }), v = verifiedHeaders(ctx.now);
    // `chain`: the block hash at a height on the chain this feed follows. `serve`: the highest height the indexer gives on
    // it, at most the final height. `top`: the highest the step reads, the same.
    const chain = inclusion ? async (h: number) => (await v.at(h)).hash : indexer;
    const serve = inclusion ? await agreed(Math.min(r.tipHeight, final)) : r.tipHeight, top = serve;
    // Under inclusion, the highest height at or below `h` where the indexer gives the verified hash: `h`, else the last
    // epoch boundary that agrees, else the floor; a height below the floor is taken as it is.
    async function agreed(h: number): Promise<number> {
      if (h < floor) return h;
      if ((await indexer(h)) === (await v.at(h)).hash) return h;
      for (let b = Math.floor((h - 1) / EPOCH_LEN) * EPOCH_LEN; b > floor; b -= EPOCH_LEN) if ((await indexer(b)) === (await v.at(b)).hash) return b;
      return floor;
    }
    // Read last, so the step's budget goes to the blocks first; `known` is the hash at the top when the step read it. A
    // final height below genesis (a header source syncing from it again) reports genesis.
    const tipOf = async (known?: string): Promise<TipView> => {
      const height = Math.max(0, final);
      if (inclusion) { const h = await v.at(height); return { height, hash: h.hash, time: h.time }; }
      const hash = known ?? (await indexer(height));
      return { height, hash, time: await timeOf(s, height, hash) };
    };
    if (ctx.cursor !== null) {
      // The cursor's block is off the chain when the indexer cannot serve it (above `serve`, while that is what limits
      // the step rather than a final height that moved back) or another block is at its height: the store rolls back to
      // the last held boundary on the chain and the last event block that agrees. A final height below the cursor with
      // the cursor's block still the indexer's moves nothing. Above `top` the Scanner emitted nothing, so events are
      // compared only up to it. Without a hash the rollback could end on (the indexer's tip under the floor, or the
      // final height under it with inclusion), the step is idle with its tip, below the cursor.
      const c = ctx.cursor, at = Math.min(c.height, top), mine = c.height <= final;
      const served = c.height <= serve || (!mine && serve === Math.min(r.tipHeight, final) && c.height <= r.tipHeight);
      const off = !served || (await (mine ? chain(c.height) : indexer(c.height))) !== c.hash;
      if (off && (inclusion ? final : r.tipHeight) < floor) return { kind: "idle", tip: await tipOf() };
      const eventsTo = lastAgreeing(blocks, at, floor, ctx.eventsHashAt);
      const to = off ? Math.max(floor, Math.min(eventsTo, await lastHashAgreeing(ctx, at, floor, chain))) : eventsTo;
      if ((off || to !== at) && to < c.height) return { kind: "reorg", to: { height: to, hash: await chain(to) }, tip: await tipOf() };
    }
    const after = ctx.cursor?.height ?? floor;
    if (top <= after) return { kind: "idle", tip: await tipOf(top === ctx.cursor?.height ? ctx.cursor.hash : undefined) };
    const heights = new Set<number>();
    for (const h of blocks.keys()) if (h > after && h <= top) heights.add(h);
    for (let b = (Math.floor(after / EPOCH_LEN) + 1) * EPOCH_LEN; b <= top; b += EPOCH_LEN) heights.add(b);
    // Every boundary row carries its hash; once the budget's requests (the indexer's and the verified headers'), its
    // blocks or its time are spent the step ends at the last boundary it read, whose hash the cursor needs.
    const reads = Math.max(1, ctx.budget.maxRequests - 1), most = Math.max(1, ctx.budget.maxBlocks), out: BlockEvents[] = [];
    let cursor: Cursor | null = null;
    for (const h of [...heights].sort((a, b) => a - b)) {
      let hash: string | null = null;
      if (h % EPOCH_LEN === 0) {
        if (cursor !== null && (s.requests() + v.reads() >= reads || out.length >= most || ctx.now() >= ctx.budget.deadlineAt)) break;
        hash = await chain(h);
        cursor = { height: h, hash };
      }
      out.push({ height: h, hash, events: blocks.get(h) ?? [] });
    }
    if (cursor !== null && out.length < heights.size) {
      const short: Step = { kind: "blocks", blocks: out.filter((b) => b.height <= cursor!.height), cursor, tip: await tipOf(), reach: top };
      carried = { r, final, cursor };
      return short;
    }
    const end = cursor?.height === top ? cursor : { height: top, hash: await chain(top) };
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
