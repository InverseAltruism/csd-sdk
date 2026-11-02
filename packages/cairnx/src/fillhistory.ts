// What a replay over part of the chain decides about an offer's fclaim lane, and the reads that settle the rest.
// verifyFillSpv's replay sees only the events its seam proved. An fclaim's grant depends on the holds before it (a
// hold still live at its height denies it, and so does the same address's hold that ended less than
// CLAIM_COOLDOWN_BLOCKS before it) and on its proposer's live holds on other offers (MAX_ACTIVE_CLAIMS). So a range of
// heights read completely decides an fclaim only when it reaches far enough below it; an fclaim nearer the range's low
// end, or one whose proposer may hold the cap elsewhere, is undecided, and the replay runs once for each status those
// fclaims could have had. Pure: every read goes through the caller's FillHistoryIo. Not consensus: resolve() reads none
// of it.
import { parseRecord } from "./records.js";
import { CLAIM_COOLDOWN_BLOCKS, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, MAX_ACTIVE_CLAIMS, SCORE_FILL } from "./types.js";
import { countOtherHoldsAtGrant, type HoldCandidate } from "./holdcount.js";
import type { HoldReplay, ProvenAttest, ProvenEvent } from "./verifyfill.js";

// The longest fclaim hold: a grant at an epoch's first block asking epochOf(h) + FCLAIM_MAX_EPOCH_AHEAD holds through
// h + 89, the last height a fill on it can be mined.
export const FCLAIM_MAX_HOLD_SPAN = EPOCH_LEN * (FCLAIM_MAX_EPOCH_AHEAD + 1) - 1;
// The deepest earlier grant that can still deny an fclaim at h sits at h - GAP_NEEDED (its hold ends at most 89 blocks
// later and the cooldown runs CLAIM_COOLDOWN_BLOCKS past that). A range read completely decides the grant at h only
// if it covers [h - GAP_NEEDED, h) and every fclaim in that span is itself decided; the fclaims in a range's lowest
// GAP_NEEDED blocks are not, because their own deciding holds lie below it. So a window that starts GAP_NEEDED below
// an fclaim does not by itself decide it.
export const GAP_NEEDED = FCLAIM_MAX_HOLD_SPAN + CLAIM_COOLDOWN_BLOCKS;
// The site's reservation scan reaches this far below the fclaim it fills: GAP_NEEDED with a full-epoch margin.
export const SCAN_MARGIN = EPOCH_LEN;
export const MAX_SCAN = GAP_NEEDED + SCAN_MARGIN;
// How far below a listed fill a range must reach: its fclaim is at most FCLAIM_MAX_HOLD_SPAN below it, and that fclaim
// is decided with MAX_SCAN below it.
export const FILL_HISTORY_SPAN = MAX_SCAN + FCLAIM_MAX_HOLD_SPAN;
// Extra heights one verdict may read beyond the seam's own window. Site and wallet together stay under the
// 1,536-heights-a-minute block budget of cairn's /api/blocks: 144 + 512 + 224 + 512.
export const FILL_HISTORY_CAP = 512;
// More undecided fclaims than this are not branched (2^10 replays); the range is extended instead.
const MAX_UNDECIDED = 10;

/** An inclusive range of block heights. */
export interface HeightRange { lo: number; hi: number }
/** An fclaim on another offer, read from a merkle-bound block; its author is not bound yet. */
export type OtherFclaim = Omit<HoldCandidate, "proposer">;
/** What a complete read of a range yields. */
export interface HistoryRead {
  /** Every event on this offer's lane in the range, merkle-proven with its prevout-bound author (as provenEvent
   *  yields them): the offer, its fclaims, ocancels, and attests on the offer or on its fclaims. Also every attest
   *  the seam read earlier, at any height, that targets an fclaim on this offer found in this range. */
  events: ProvenEvent[];
  /** Every fclaim in the range on another offer: the cap candidates. */
  otherFclaims: OtherFclaim[];
}
/**
 * The history seam of a fill verifier (FillSpvIo.history). The window is the range the seam's own scan read
 * completely; offerEventIds returns its lane events (and may add events proven outside it, such as the offer).
 * Reads are the caller's; nothing here touches the network.
 */
export interface FillHistoryIo {
  /** The lowest height the seam can read (the site's light-client checkpoint, for example). */
  readonly floor: number;
  /** The heights the seam's scan read completely. */
  readonly window: HeightRange;
  /** The fclaims on other offers the scan found in the window. */
  readonly windowOtherFclaims: readonly OtherFclaim[];
  /** Read every height of the range (see HistoryRead); throw when a block cannot be read or bound. */
  readRange(range: HeightRange): Promise<HistoryRead>;
  /** The prevout-bound author (csd-crypto authorOf) of an fclaim on another offer, or null when it cannot be bound. */
  proposerOf(id: string): Promise<string | null>;
}

export type HistoryRefusalCode = "history-past-cap" | "history-below-floor" | "history-undecidable" | "history-unread" | "listed-fill-unproven";
export interface HistoryRefusal { ok: false; code: HistoryRefusalCode; reason: string }
const refuse = (code: HistoryRefusalCode, reason: string): HistoryRefusal => ({ ok: false, code, reason });

/** Sorted, disjoint ranges; ranges that touch merge. */
export function mergeRanges(ranges: readonly HeightRange[]): HeightRange[] {
  const out: HeightRange[] = [];
  for (const r of ranges.filter((x) => x.lo <= x.hi).map((x) => ({ lo: x.lo, hi: x.hi })).sort((a, b) => a.lo - b.lo)) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi);
    else out.push(r);
  }
  return out;
}
// the parts of `want` outside `have` (both merged)
function subtract(want: readonly HeightRange[], have: readonly HeightRange[]): HeightRange[] {
  const out: HeightRange[] = [];
  for (const w of want) {
    let lo = w.lo;
    for (const h of have) {
      if (h.hi < lo || h.lo > w.hi) continue;
      if (h.lo > lo) out.push({ lo, hi: h.lo - 1 });
      lo = Math.max(lo, h.hi + 1);
    }
    if (lo <= w.hi) out.push({ lo, hi: w.hi });
  }
  return out;
}
const heightsIn = (rs: readonly HeightRange[]): number => rs.reduce((n, r) => n + r.hi - r.lo + 1, 0);

/** The lowest height a complete read must reach, contiguously, for the grant of an fclaim at `h` on an offer anchored
 *  at `offerHeight` to be decided: GAP_NEEDED below it, or the offer's anchor (no hold on the offer predates it), and
 *  in any case FCLAIM_MAX_HOLD_SPAN below it, where the proposer's holds on other offers live at `h` were granted. */
export const fclaimDecidedFrom = (h: number, offerHeight: number): number =>
  Math.min(Math.max(h - GAP_NEEDED, offerHeight), h - FCLAIM_MAX_HOLD_SPAN);

export type FillHistoryPlan = { ok: true; ranges: HeightRange[]; heights: number } | HistoryRefusal;
/**
 * The ranges a verifier reads so that each listed fill, and the fclaim it attests, is decided: [h - FILL_HISTORY_SPAN,
 * h] per fill (nothing below FCLAIM_MAX_HOLD_SPAN under the offer's anchor), merged, minus `covered`. Served data only
 * selects what to read. Refuses when a range falls below `floor` or the reads, with the `spent` already made, pass
 * FILL_HISTORY_CAP. A caller that has not read yet (the site before a reservation) passes the window it will read.
 */
export function planFillHistory(
  fills: readonly { height: number }[], covered: readonly HeightRange[], offerHeight: number,
  opts: { floor?: number; spent?: number } = {},
): FillHistoryPlan {
  const want: HeightRange[] = [];
  for (const f of fills) {
    const h = Number(f.height);
    if (!Number.isSafeInteger(h)) return refuse("listed-fill-unproven", `the offer lists a fill with no block height (${String(f.height)})`);
    want.push({ lo: Math.max(h - FILL_HISTORY_SPAN, offerHeight - FCLAIM_MAX_HOLD_SPAN), hi: h });
  }
  const ranges = subtract(mergeRanges(want), mergeRanges(covered));
  const floor = opts.floor ?? 0;
  if (ranges.some((r) => r.lo < floor))
    return refuse("history-below-floor", `this offer's earlier fills reach below block ${floor}, the lowest this verifier can read`);
  const heights = heightsIn(ranges);
  if ((opts.spent ?? 0) + heights > FILL_HISTORY_CAP)
    return refuse("history-past-cap", `checking this offer's earlier fills needs more than ${FILL_HISTORY_CAP} more blocks`);
  return { ok: true, ranges, heights };
}

/**
 * Each fill a served offer lists, proven: a SCORE_FILL attest with the listed txid at exactly the listed height.
 * `prove` yields the merkle-proven, author-bound event, or null. The list is served data; a listed fill that does not
 * prove refuses. Proving listed fills sparsely is sound only where no grant decides delivery (a taker-bound offer,
 * which only the taker fills); on the fclaim lane verifyFillSpv reads whole ranges instead and checks the list here.
 */
export async function proveListedFills(
  fills: readonly { txid: string; height: number }[],
  prove: (txid: string, height: number) => Promise<ProvenEvent | null>,
): Promise<{ ok: true; events: ProvenAttest[] } | HistoryRefusal> {
  const unique = [...new Map(fills.map((f) => [String(f.txid).toLowerCase(), Number(f.height)])).entries()];
  const got = await Promise.all(unique.map(async ([id, h]) => {
    if (!Number.isSafeInteger(h)) return null;
    try { return await prove(id, h); } catch { return null; }
  }));
  const events: ProvenAttest[] = [];
  for (const [i, [id, h]] of unique.entries()) {
    const ev = got[i];
    if (!ev || ev.kind !== "attest" || ev.txid.toLowerCase() !== id || ev.height !== h || ev.score !== SCORE_FILL)
      return refuse("listed-fill-unproven", `the offer lists a fill (${id} at block ${h}) that is not on chain there - refusing`);
    events.push(ev);
  }
  return { ok: true, events };
}

const idOf = (e: ProvenEvent): string => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
// what must agree across branches: the buyer's grant, route and hold, and the offer state the fill applies to
const summaryOf = (r: HoldReplay): string =>
  JSON.stringify([r.granted, r.routed, r.heldByMe, r.offer?.status ?? null, r.offer?.paid ?? null, r.offer?.delivered ?? null]);

export interface FillHistoryInput {
  io: FillHistoryIo;
  /** The events verifyFillSpv proved through offerEventIds and provenEvent. */
  events: readonly ProvenEvent[];
  offerId: string;
  fclaimTxid: string;
  offerHeight: number;
  replay: (events: ProvenEvent[]) => HoldReplay;
}
export type Decided = { ok: true; replay: HoldReplay } | HistoryRefusal;

/** The lane's history as verifyFillSpv sees it: the ranges read, their events, and the decision over them. */
export function fillHistory(input: FillHistoryInput) {
  const { io, offerId, fclaimTxid, offerHeight, replay } = input;
  const oid = offerId.toLowerCase(), fc = fclaimTxid.toLowerCase();
  const events = new Map<string, ProvenEvent>();
  const others = new Map<string, OtherFclaim>();
  const add = (evs: readonly ProvenEvent[], oth: readonly OtherFclaim[]) => {
    for (const e of evs) if (!events.has(idOf(e))) events.set(idOf(e), e);
    for (const c of oth) others.set(String(c.id).toLowerCase(), c);
  };
  add(input.events, io.windowOtherFclaims);
  let covered = mergeRanges([io.window]);
  let spent = 0;
  const authors = new Map<string, Promise<string | null>>();
  const authorOf = (id: string) => {
    if (!authors.has(id)) authors.set(id, io.proposerOf(id).catch(() => null));
    return authors.get(id)!;
  };

  const around = (h: number) => covered.find((r) => r.lo <= h && h <= r.hi);
  const decidedByHeight = (h: number) => { const r = around(h); return !!r && fclaimDecidedFrom(h, offerHeight) >= r.lo; };
  const lane = () => [...events.values()].filter((e): e is ProvenEvent & { kind: "propose" } => {
    if (e.kind !== "propose") return false;
    const rec = parseRecord(e.uri, e.payloadHash);
    return !!rec && rec.t === "fclaim" && rec.offer.toLowerCase() === oid;
  });
  // Whether the fclaim's proposer held fewer than MAX_ACTIVE_CLAIMS on other offers at its grant. Without `attribute`
  // every candidate counts as the proposer's (no read); with it, only candidates counted that way are read.
  const belowCap = async (f: ProvenEvent & { kind: "propose" }, attribute: boolean): Promise<boolean> => {
    const target = { id: f.id, height: f.height, pos: f.pos, offer: oid };
    const who = f.proposer.toLowerCase();
    const asTheirs = (c: OtherFclaim): HoldCandidate => ({ ...c, proposer: who });
    let n = countOtherHoldsAtGrant([...others.values()].map(asTheirs), target, who);
    if (!n.ok) return false;
    if (n.count < MAX_ACTIVE_CLAIMS) return true;
    if (!attribute) return false;
    const counted = [...others.values()].filter((c) => { const one = countOtherHoldsAtGrant([asTheirs(c)], target, who); return one.ok && one.count === 1; });
    const cands = await Promise.all(counted.map(async (c) => ({ ...c, proposer: (await authorOf(String(c.id).toLowerCase())) ?? who })));
    n = countOtherHoldsAtGrant(cands, target, who);
    return n.ok && n.count < MAX_ACTIVE_CLAIMS;
  };
  // The replay if every status assignment of `undecided` (each kept, or removed: a denial changes no offer field)
  // gives the same summary, else null. Assignment 0 keeps them all: with none undecided this is the plain replay.
  const branches = (undecided: readonly string[]): HoldReplay | null => {
    if (undecided.length > MAX_UNDECIDED) return null;
    const all = [...events.values()];
    let first: HoldReplay | undefined;
    for (let mask = 0; mask < 1 << undecided.length; mask++) {
      const drop = new Set(undecided.filter((_, i) => mask & (1 << i)));
      const r = replay(all.filter((e) => !drop.has(idOf(e))));
      if (first === undefined) first = r;
      else if (summaryOf(r) !== summaryOf(first)) return null;
    }
    return first!;
  };
  const read = async (ranges: readonly HeightRange[]): Promise<HistoryRefusal | null> => {
    let got: HistoryRead[];
    try { got = await Promise.all(ranges.map((r) => io.readRange({ lo: r.lo, hi: r.hi }))); }
    catch (e) { return refuse("history-unread", `couldn't read this offer's earlier blocks (${(e as Error)?.message ?? e}) - retry`); }
    for (const g of got) {
      const evs = Array.isArray(g?.events) ? g.events : null;
      if (!evs || !evs.every((e) => e && (e.kind === "propose" ? typeof e.id === "string" : e.kind === "attest" && typeof e.txid === "string")))
        return refuse("history-unread", "a read of this offer's earlier blocks returned a malformed event - retry");
      add(evs, Array.isArray(g.otherFclaims) ? g.otherFclaims : []);
    }
    covered = mergeRanges([...covered, ...ranges]);
    spent += heightsIn(ranges);
    return null;
  };

  // Decide the replay over what has been read: branch over the undecided fclaims; when the branches differ, read the
  // proposers of cap suspects, then extend each range holding a height-undecided fclaim by MAX_SCAN.
  async function decide(): Promise<Decided> {
    let attributed = false;
    for (;;) {
      const fclaims = lane();
      const byHeight = fclaims.filter((f) => !decidedByHeight(f.height));
      const suspects: string[] = [];
      for (const f of fclaims)
        if (idOf(f) !== fc && decidedByHeight(f.height) && !(await belowCap(f, attributed))) suspects.push(idOf(f));
      const agreed = branches([...byHeight.map(idOf), ...suspects]);
      if (agreed) return { ok: true, replay: agreed };
      if (suspects.length > 0 && !attributed) { attributed = true; continue; }
      if (byHeight.length === 0)
        return refuse("history-undecidable", "an earlier reservation on this offer may have been denied on another offer's account, and the result depends on it - refusing");
      const ext = mergeRanges(byHeight.map((f) => {
        const r = around(f.height);
        return r ? { lo: Math.max(io.floor, r.lo - MAX_SCAN), hi: r.lo - 1 } : { lo: Math.max(io.floor, fclaimDecidedFrom(f.height, offerHeight)), hi: f.height };
      }));
      const need = subtract(ext, covered);
      if (need.length === 0)
        return refuse("history-below-floor", `deciding this offer's earlier reservations needs blocks below ${io.floor}, the lowest this verifier can read`);
      if (spent + heightsIn(need) > FILL_HISTORY_CAP)
        return refuse("history-past-cap", `deciding this offer's earlier reservations needs more than ${FILL_HISTORY_CAP} more blocks`);
      const failed = await read(need);
      if (failed) return failed;
      attributed = false;
    }
  }

  // Read the ranges the listed fills not yet proven need (planFillHistory), check every listed fill is on chain where
  // listed, and decide again. `read: false` when every listed fill is already among the proven events.
  async function readListedFills(fills: readonly { txid: string; height: number }[]): Promise<{ ok: true; read: false } | { ok: true; read: true; replay: HoldReplay } | HistoryRefusal> {
    const at = async (txid: string, h: number) => { const e = events.get(String(txid).toLowerCase()); return e && e.height === h ? e : null; };
    const missing = fills.filter((f) => { const e = events.get(String(f.txid).toLowerCase()); return !(e && e.kind === "attest" && e.height === Number(f.height)); });
    if (missing.length === 0) return { ok: true, read: false };
    const plan = planFillHistory(missing, covered, offerHeight, { floor: io.floor, spent });
    if (!plan.ok) return plan;
    if (plan.ranges.length > 0) {
      const failed = await read(plan.ranges);
      if (failed) return failed;
    }
    const listed = await proveListedFills(fills, at);
    if (!listed.ok) return listed;
    const d = await decide();
    return d.ok ? { ok: true, read: true, replay: d.replay } : d;
  }

  return { decide, readListedFills, covered: () => covered, spent: () => spent };
}
