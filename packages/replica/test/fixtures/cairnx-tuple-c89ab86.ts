// Test-only reference, not part of the package: the CairnX resolver's src/tuple.ts at cairnx c89ab86, sha256
// 348a645493240c12876229a9ef4fd5d54de7e508576bca288828032e6ac87d71 of the original file. Comments naming private plans or
// files were reworded and four import specifiers rewritten; the code is the original's: sha256
// 11cb05433eb532d548716658e9a3408d532f56d07af1b4e29d0f86009aa52e6e over its tokens without comments or whitespace, with
// the four specifiers read back, which test/tuple-differential.test.ts checks.
// The hash tuple of cairnx-core CONVENTION §34, (height, blockHash, eventsHash, stateHash), at each epoch boundary once
// it is Scanner.FINALITY blocks deep: what two replicas compare (§34.3). The service's scan loop advances
// the book once per accepted scan; the reads (tupleRead) only look a kept tuple up and never replay.
import { createHash } from "node:crypto";
import { eventLine } from "./cairnx-tuple-deps.js";
import { replay } from "./cairnx-tuple-deps.js";
import { Scanner } from "../../src/scanner.js";
import { EPOCH_LEN, EVENTS_HASH_START, eventsHashStep, stateHash, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";

export interface Tuple { height: number; blockHash: string; eventsHash: string; stateHash: string }
/** Boundaries kept in memory: 720 epochs, about 30 days of 120 s blocks. */
export const MAX_TUPLES = 720;
/** Boundaries one scan computes at most, so a catch-up after a stall, a deep reorg or a changed feed spreads its
 *  replays over scans. */
export const TUPLES_PER_SCAN = 4;

/** The newest epoch boundary at least FINALITY blocks below `tip`, or null below the first. */
export function finalBoundary(tip: number): number | null {
  const h = Math.floor((tip - Scanner.FINALITY) / EPOCH_LEN) * EPOCH_LEN;
  return h >= 0 ? h : null;
}

/** A kept tuple and the content digest of the events it was computed from (not served). */
interface Kept { tuple: Tuple; content: string }

/** `events` in (height, position) order, and at each epoch boundary in [from, to] (`from` a boundary) a sha256 over
 *  every field of every event at or below it (each event's JSON and a newline). The events hash reads only (height, position, id,
 *  author) of an event, and a later scan can serve another value of a field resolve() also reads for an event it
 *  already returned (the refresh's full pull re-reads the rows), so a changed prefix is detected on this digest. */
function prefixes(events: readonly ChainEvent[], from: number, to: number): { sorted: ChainEvent[]; content: Map<number, string> } {
  const sorted = [...events].sort((a, b) => a.height - b.height || a.pos - b.pos);
  const content = new Map<number, string>();
  const h = createHash("sha256");
  let i = 0;
  for (let b = from; b <= to; b += EPOCH_LEN) {
    for (; i < sorted.length && sorted[i]!.height <= b; i++) h.update(eventLine(sorted[i]!));
    content.set(b, h.copy().digest("hex"));
  }
  return { sorted, content };
}

/** The events hash after the blocks of `sorted` in (above, to], from `prev`, the value at or below `above`. */
function eventsHashOver(sorted: readonly ChainEvent[], prev: string, above: number, to: number): string {
  let i = sorted.findIndex((e) => e.height > above);
  if (i < 0) return prev;
  while (i < sorted.length && sorted[i]!.height <= to) {
    let j = i + 1;
    while (j < sorted.length && sorted[j]!.height === sorted[i]!.height) j++;
    prev = eventsHashStep(prev, sorted[i]!.height, sorted.slice(i, j));
    i = j;
  }
  return prev;
}

export interface AdvanceInput {
  tip: number;                                       // the published snapshot's tip height
  tipHash: string;                                   // the block hash its scan read there before and after the pull
  events: readonly ChainEvent[];                     // the published snapshot's events, at or below `tip`
  reorgEpoch: number;                                // Scanner.reorgEpoch after that scan
  hashAt: (height: number) => Promise<string | null>; // the indexer's block hash at a height, lowercase; null unread
}

/** The lowest of `kept` (ascending) whose block hash moved, null when none did, undefined when a read failed. A block
 *  hash commits its parent, so a block replaced at one height was replaced at every height above it as well. */
async function firstMoved(kept: Tuple[], hashAt: AdvanceInput["hashAt"]): Promise<number | null | undefined> {
  const moved = async (t: Tuple) => { const h = await hashAt(t.height); return h === null ? undefined : h !== t.blockHash; };
  const top = await moved(kept[kept.length - 1]!);
  if (top !== true) return top === undefined ? undefined : null;
  let lo = 0, hi = kept.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = await moved(kept[mid]!);
    if (m === undefined) return undefined;
    if (m) hi = mid; else lo = mid + 1;
  }
  return kept[lo]!.height;
}

export class TupleBook {
  private kept = new Map<number, Kept>();      // ascending height: entries are only ever added above the highest
  private lowest: number | null = null;        // the first boundary this process computed
  private verified: number | null = null;      // the reorg epoch of the scan whose pass last verified the kept; null: withheld
  private seen: number | null = null;          // the reorg epoch of the latest advance
  private held: { height: number; content: string; state: CairnXState } | null = null;
  private readonly epochNow: () => number | null;

  /** `epoch` is the scanner's reorg epoch now (the service passes Scanner.reorgEpoch), so a reorg the scanner detects
   *  withholds the kept tuples at once, even in a scan the service refuses; without it, the epoch of the latest
   *  advance. */
  constructor(epoch?: () => number) {
    this.epochNow = epoch ?? (() => this.seen);
  }

  /** Kept tuples are served only while the last accepted scan's pass verified them and the scanner's reorg epoch has
   *  not moved since. */
  private served(): boolean { return this.verified !== null && this.verified === this.epochNow(); }
  get(height: number): Tuple | undefined { return this.served() ? this.kept.get(height)?.tuple : undefined; }
  /** Every kept boundary, served or withheld. */
  heights(): number[] { return [...this.kept.keys()]; }
  newest(): Tuple | null {
    if (!this.served()) return null;
    let t: Tuple | null = null;
    for (const k of this.kept.values()) t = k.tuple;
    return t;
  }

  /** Every kept tuple stops being served until an accepted scan's pass verifies it again. The only place verification
   *  is cleared: the service calls it at the end of every poll that does not end in an accepted scan whose pass
   *  completed. */
  withhold(): void { this.verified = null; }

  private dropFrom(height: number): void {
    for (const h of this.kept.keys()) if (h >= height) this.kept.delete(h);
  }

  /** A published snapshot resolved at `tip` from `events`: when `tip` is a boundary it is held, and reused when that
   *  boundary is final if every field of the events up to it is unchanged by then. */
  hold(tip: number, events: readonly ChainEvent[], state: CairnXState): void {
    if (tip % EPOCH_LEN === 0) this.held = { height: tip, content: prefixes(events, tip, tip).content.get(tip)!, state };
  }

  /** After an accepted scan; true when the pass completed, which is the only place the kept tuples become verified.
   *  Withdrawals take effect before the first read and stay whatever the reads do: a boundary no longer final, or below
   *  the retention window, is dropped; a kept boundary whose events changed since it was computed is dropped with every
   *  one above it. When the kept tuples are not verified at this scan's reorg epoch (the epoch moved, or a poll since
   *  the last pass did not end accepted), the pass reads the chain's block hash at them again, which drops each one the
   *  chain replaced. Then the boundaries that are final and not kept are computed, oldest first, from this scan's events
   *  alone, up to the first block hash it cannot read. False, with nothing added, when a read the pass needs fails or
   *  the scan's tip block is gone by the end; with the epoch unchanged and no read, the kept tuples stay verified,
   *  because an accepted scan whose reorg check found the previous tip block in place reads a chain that holds them. */
  async advance(p: AdvanceInput): Promise<boolean> {
    this.seen = p.reorgEpoch;
    const newest = finalBoundary(p.tip);
    const window = newest === null ? 0 : Math.max(0, newest - (MAX_TUPLES - 1) * EPOCH_LEN);
    for (const h of this.kept.keys()) if (newest === null || h > newest || h < window) this.kept.delete(h);
    if (newest === null) return false;
    let pre: ReturnType<typeof prefixes>;
    try { pre = prefixes(p.events, Math.max(window, this.lowest ?? newest), newest); }
    catch (e) { this.kept.clear(); throw e; }
    for (const [h, k] of this.kept) if (k.content !== pre.content.get(h)) { this.dropFrom(h); break; }

    const verify = this.verified !== p.reorgEpoch && this.kept.size > 0;
    if (verify) {
      const from = await firstMoved([...this.kept.values()].map((k) => k.tuple), p.hashAt);
      if (from === undefined) return false;
      if (from !== null) this.dropFrom(from);
    }
    let below: Kept | null = null;
    for (const k of this.kept.values()) below = k;
    let next = Math.max(below ? below.tuple.height + EPOCH_LEN : (this.lowest ?? newest), window);
    // the events hash runs on from the highest kept boundary, whose events this scan's match (its content digest)
    let eh = below ? below.tuple.eventsHash : EVENTS_HASH_START, ehAt = below ? below.tuple.height : -1;
    const fresh: Kept[] = [];
    for (; next <= newest && fresh.length < TUPLES_PER_SCAN; next += EPOCH_LEN) {
      const blockHash = await p.hashAt(next);
      if (blockHash === null) break;
      const content = pre.content.get(next)!;
      eh = eventsHashOver(pre.sorted, eh, ehAt, next);
      ehAt = next;
      const at = next;
      const state = this.held?.height === at && this.held.content === content ? this.held.state : replay(pre.sorted.filter((e) => e.height <= at), at);
      fresh.push({ tuple: { height: at, blockHash, eventsHash: eh, stateHash: stateHash(state) }, content });
    }
    // only a pass that read a block hash needs its scan's tip block confirmed: an idle poll costs no request
    if ((verify || fresh.length > 0) && (await p.hashAt(p.tip)) !== p.tipHash.toLowerCase()) return false;
    for (const k of fresh) this.kept.set(k.tuple.height, k);
    this.lowest ??= newest;
    this.verified = p.reorgEpoch;
    if (this.held && this.held.height < next) this.held = null;
    return true;
  }
}

export type TupleAnswer = { status: 200 | 404; body: { ok: boolean } & Record<string, unknown> };
/** Both reads' cache policy. A tuple is this host's derivation from the feed it read, and the same height and block hash
 *  can name another body later (a feed that was incomplete, then recovered), so no cache may keep one. */
export const TUPLE_CACHE = "no-store";

/** GET /cairnx/tuple/<height>[:<blockHash>]: the kept tuple while it is served. With the block hash it answers only for
 *  this host's block at that height, so a caller can tell another branch from a missing boundary. */
export function tupleRead(book: Pick<TupleBook, "get">, height: number, blockHash: string | null): TupleAnswer {
  const t = book.get(height);
  if (!t) return { status: 404, body: { ok: false, error: "not a kept boundary", height } };
  if (blockHash !== null && blockHash !== t.blockHash) return { status: 404, body: { ok: false, error: "not this host's block at that height", height } };
  return { status: 200, body: { ok: true, ...t } };
}
