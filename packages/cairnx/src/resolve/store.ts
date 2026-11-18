// The keyed state of one replay that the indexes read (offers, bids, names, recapture reservations), the indexes,
// and the only writes to the fields they key on. An index holds a superset of what the plain walk over its map would
// match, and a read evaluates the walk's own predicate over the index's candidates, so a read equals the walk as long
// as every write to an indexed field goes through here; the types below make those fields readonly everywhere else.
// Internal to cairnx-core: nothing here reaches the resolved state or the package exports.
import { V21_HEIGHT, V22_HEIGHT, epochOf, type BidState, type OfferState } from "../types.js";
import { effExpiry } from "./context.js";
import { MinQueue } from "./minqueue.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type OfferKeyed = "id" | "seller" | "give" | "taker" | "status" | "expiresEpoch" | "height";
type BidKeyed = "id" | "status" | "expiresEpoch" | "height";
/** An offer as the replay holds it; the fields an index keys on are written only in this module. */
export type OfferRec = Omit<OfferState, OfferKeyed> & Readonly<Pick<OfferState, OfferKeyed>>;
/** A bid as the replay holds it; the fields an index keys on are written only in this module. */
export type BidRec = Omit<BidState, BidKeyed> & Readonly<Pick<BidState, BidKeyed>>;
export interface NameRec { readonly owner: string; effHeight: number; pos: number; id: string; height: number; addr?: string; locked: boolean; viaFill?: boolean; paidThroughEpoch?: number; profile?: Record<string, string>; readonly pending?: boolean; readonly finalizeBy?: number }
/** A v2.6 recapture reservation (internal, not in canonical state). */
export interface Recapture { readonly owner: string; readonly effHeight: number; readonly pos: number; readonly id: string; readonly height: number; readonly finalizeBy: number }

/** Entries one replay visited: queue entries popped, candidates read, and the elements of a plain walk. */
export interface ReplayStats { visits: number }
export interface StoreOptions {
  /** Run the plain walks beside every indexed read and assert the index invariants (tests and the seal only). */
  check?: boolean;
  /** In check mode, assert the invariants after every n-th event (default 1); the walks run at every read. */
  checkEvery?: number;
  stats?: ReplayStats;
}
export type Store = ReturnType<typeof createStore>;

export function createStore(opts: StoreOptions = {}) {
  const check = opts.check === true;
  const checkEvery = Math.max(1, Math.floor(opts.checkEvery ?? 1));
  const stats = opts.stats ?? { visits: 0 };
  const offers = new Map<string, OfferRec>();
  const bids = new Map<string, BidRec>();
  const names = new Map<string, NameRec>();
  const recaptures = new Map<string, Recapture>();
  // The collections the plain sweep walks; membership is part of what it may expire, so they stay as they were.
  const openOffers = new Set<string>();
  const openBids = new Set<string>();
  const pendingNames = new Set<string>();
  // An id's stamp at its last insertion into the collection a walk iterates (a re-add of a present member keeps its
  // place, as Set and Map do), so a batch applies in the walk's order.
  let stamp = 0;
  const openOfferAt = new Map<string, number>(), openBidAt = new Map<string, number>();
  const pendingAt = new Map<string, number>(), recaptureAt = new Map<string, number>();
  // Offers and bids by effective expiry epoch, reservations and recaptures by finalizeBy.
  const offerQ = new MinQueue(), bidQ = new MinQueue(), nameQ = new MinQueue(), recaptureQ = new MinQueue();
  // The highest height swept through the queues. A sweep at a height that is not at least this (NaN included) walks:
  // the queues may drop an entry that is not yet due only when heights rise.
  let maxSweep = -Infinity;
  // Per-owner candidates for the two reservation caps.
  const pendingBy = new Map<string, Set<string>>(), recaptureBy = new Map<string, Set<string>>();
  const addTo = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k);
    if (!s) { s = new Set(); m.set(k, s); }
    s.add(v);
  };
  // effExpiry reads its height only to ask whether it is at least V21; the queues hold the key of the next sweep.
  const regimeHeight = (): number => (maxSweep >= V21_HEIGHT ? V21_HEIGHT : V21_HEIGHT - 1);

  // ── writes ──
  const addOffer = (o: OfferRec) => {
    offers.set(o.id, o);
    if (!openOffers.has(o.id)) { openOffers.add(o.id); openOfferAt.set(o.id, ++stamp); }
    offerQ.push(effExpiry(o, regimeHeight()), o.id);
  };
  // Nothing reopens an offer or a bid, so membership of the open sets begins only at addOffer and addBid.
  const setOfferStatus = (o: OfferRec, status: Exclude<OfferState["status"], "open">) => {
    (o as Mutable<OfferRec>).status = status;
    openOffers.delete(o.id);
  };
  const addBid = (b: BidRec) => {
    bids.set(b.id, b);
    if (!openBids.has(b.id)) { openBids.add(b.id); openBidAt.set(b.id, ++stamp); }
    bidQ.push(effExpiry(b, regimeHeight()), b.id);
  };
  const setBidStatus = (b: BidRec, status: Exclude<BidState["status"], "open">) => {
    (b as Mutable<BidRec>).status = status;
    openBids.delete(b.id);
  };
  const putName = (nm: string, n: NameRec) => {
    names.set(nm, n);
    if (n.pending) {
      if (!pendingNames.has(nm)) { pendingNames.add(nm); pendingAt.set(nm, ++stamp); }
      if (n.finalizeBy !== undefined) nameQ.push(n.finalizeBy, nm);
      addTo(pendingBy, n.owner, nm);
    } else pendingNames.delete(nm);
  };
  const setNameOwner = (nm: string, n: NameRec, owner: string) => {
    (n as Mutable<NameRec>).owner = owner;
    if (n.pending) addTo(pendingBy, owner, nm);
  };
  // a finalized reservation: `delete`, not undefined, so the keys are absent as in the Python mirror's `.pop()`
  const finalizeName = (nm: string, n: NameRec) => {
    delete (n as Mutable<NameRec>).pending;
    delete (n as Mutable<NameRec>).finalizeBy;
    pendingNames.delete(nm);
  };
  const putRecapture = (nm: string, r: Recapture) => {
    if (!recaptures.has(nm)) recaptureAt.set(nm, ++stamp);
    recaptures.set(nm, r);
    recaptureQ.push(r.finalizeBy, nm);
    addTo(recaptureBy, r.owner, nm);
  };
  const deleteRecapture = (nm: string) => { recaptures.delete(nm); };

  // ── the plain walks of cairnx-core 0.2.4: the path for a lower height, and check mode's reference ──
  const walkSweep = (height: number, expireOffer: (o: OfferRec) => void) => {
    const ep = epochOf(height);
    stats.visits += openOffers.size + openBids.size + pendingNames.size + recaptures.size;
    for (const id of [...openOffers]) {
      const o = offers.get(id);
      if (!o || o.status !== "open") { openOffers.delete(id); continue; }
      if (ep > effExpiry(o, height)) { expireOffer(o); setOfferStatus(o, "expired"); }
    }
    for (const id of [...openBids]) {
      const b = bids.get(id);
      if (!b || b.status !== "open") { openBids.delete(id); continue; }
      if (ep > effExpiry(b, height)) setBidStatus(b, "expired");
    }
    for (const nm of [...pendingNames]) {
      const n = names.get(nm);
      if (!n || !n.pending) { pendingNames.delete(nm); continue; }
      if (n.finalizeBy !== undefined && height > n.finalizeBy) { names.delete(nm); pendingNames.delete(nm); }
    }
    for (const nm of [...recaptures.keys()]) { const r = recaptures.get(nm)!; if (height > r.finalizeBy) recaptures.delete(nm); }
  };
  const offerDue = (o: OfferRec | undefined, height: number): o is OfferRec => !!o && o.status === "open" && epochOf(height) > effExpiry(o, height);
  const bidDue = (b: BidRec | undefined, height: number): b is BidRec => !!b && b.status === "open" && epochOf(height) > effExpiry(b, height);
  const nameDue = (n: NameRec | undefined, height: number): boolean => !!n && !!n.pending && n.finalizeBy !== undefined && height > n.finalizeBy;
  const walkDue = (height: number) => ({
    offers: [...openOffers].filter((id) => offerDue(offers.get(id), height)),
    bids: [...openBids].filter((id) => bidDue(bids.get(id), height)),
    names: [...pendingNames].filter((nm) => nameDue(names.get(nm), height)),
    recaptures: [...recaptures].filter(([, r]) => height > r.finalizeBy).map(([nm]) => nm),
  });
  const walkPending = (who: string, except: string, height: number): number => {
    let k = 0;
    for (const [nm, n] of names) if (n.pending && n.owner === who && nm !== except && n.finalizeBy !== undefined && height <= n.finalizeBy) k++;
    return k;
  };
  const walkRecaptures = (who: string, except: string, height: number): number => {
    let k = 0;
    for (const [nm, r] of recaptures) if (r.owner === who && nm !== except && height <= r.finalizeBy) k++;
    return k;
  };
  const same = (what: string, index: unknown, walk: unknown) => {
    if (JSON.stringify(index) !== JSON.stringify(walk)) throw new Error(`replay index check: ${what}: index ${JSON.stringify(index)}, walk ${JSON.stringify(walk)}`);
  };

  // ── indexed reads ──
  const popDue = (q: MinQueue, limit: number, at: ReadonlyMap<string, number>, isDue: (id: string) => boolean): string[] => {
    const popped: string[] = [];
    q.popBelow(limit, popped);
    stats.visits += popped.length;
    return [...new Set(popped)].filter(isDue).sort((a, b) => at.get(a)! - at.get(b)!);
  };
  /** Expires what the plain sweep at `height` would: offers and bids past their effective expiry, reservations and
   *  recaptures past finalizeBy, in that order and each batch in the walk's order. */
  const sweep = (height: number, expireOffer: (o: OfferRec) => void) => {
    if (!(height >= maxSweep)) { walkSweep(height, expireOffer); return; }
    if (!(maxSweep >= V21_HEIGHT) && height >= V21_HEIGHT) {
      // the first sweep at V21 or above: offers and bids anchored below V22 now expire at their capped epoch
      stats.visits += openOffers.size + openBids.size;
      for (const id of openOffers) { const o = offers.get(id); if (o && o.status === "open" && !(o.height >= V22_HEIGHT)) offerQ.push(effExpiry(o, V21_HEIGHT), id); }
      for (const id of openBids) { const b = bids.get(id); if (b && b.status === "open" && !(b.height >= V22_HEIGHT)) bidQ.push(effExpiry(b, V21_HEIGHT), id); }
    }
    maxSweep = height;
    const ep = epochOf(height);
    const want = check ? walkDue(height) : undefined;
    const dueOffers = popDue(offerQ, ep, openOfferAt, (id) => openOffers.has(id) && offerDue(offers.get(id), height));
    const dueBids = popDue(bidQ, ep, openBidAt, (id) => openBids.has(id) && bidDue(bids.get(id), height));
    const dueNames = popDue(nameQ, height, pendingAt, (nm) => pendingNames.has(nm) && nameDue(names.get(nm), height));
    const dueRecaptures = popDue(recaptureQ, height, recaptureAt, (nm) => { const r = recaptures.get(nm); return !!r && height > r.finalizeBy; });
    if (want) {
      same(`expired offers at ${height}`, dueOffers, want.offers);
      same(`expired bids at ${height}`, dueBids, want.bids);
      same(`expired reservations at ${height}`, dueNames, want.names);
      same(`expired recaptures at ${height}`, dueRecaptures, want.recaptures);
    }
    for (const id of dueOffers) { const o = offers.get(id)!; expireOffer(o); setOfferStatus(o, "expired"); }
    for (const id of dueBids) setBidStatus(bids.get(id)!, "expired");
    for (const nm of dueNames) { names.delete(nm); pendingNames.delete(nm); }
    for (const nm of dueRecaptures) recaptures.delete(nm);
  };
  /** The owner's live reservations other than `except` (the walk of names.ts's cap, over the owner's candidates). */
  const pendingCount = (who: string, except: string, height: number): number => {
    let k = 0;
    const set = pendingBy.get(who);
    if (set) for (const nm of set) {
      stats.visits++;
      const n = names.get(nm);
      if (!n || !n.pending || n.owner !== who) { set.delete(nm); continue; }   // undone only by putName or setNameOwner
      if (nm !== except && n.finalizeBy !== undefined && height <= n.finalizeBy) k++;
    }
    if (check) same(`reservations of ${who} at ${height}`, k, walkPending(who, except, height));
    return k;
  };
  /** The owner's live recapture reservations other than `except`. */
  const recaptureCount = (who: string, except: string, height: number): number => {
    let k = 0;
    const set = recaptureBy.get(who);
    if (set) for (const nm of set) {
      stats.visits++;
      const r = recaptures.get(nm);
      if (!r || r.owner !== who) { set.delete(nm); continue; }   // undone only by putRecapture
      if (nm !== except && height <= r.finalizeBy) k++;
    }
    if (check) same(`recaptures of ${who} at ${height}`, k, walkRecaptures(who, except, height));
    return k;
  };

  // Check mode: after events, every index holds what its read could match and the walked sets name live items.
  let checked = 0;
  const verify = (force = false) => {
    if (!check || (!force && ++checked % checkEvery !== 0)) return;
    const fail = (what: string) => { throw new Error(`replay index check: ${what}`); };
    const queued = (q: MinQueue) => new Set([...q.entries()].map(([k, id]) => `${k}\u0000${id}`));
    const oq = queued(offerQ), bq = queued(bidQ), nq = queued(nameQ), rq = queued(recaptureQ);
    for (const id of openOffers) {
      const o = offers.get(id);
      if (!o || o.status !== "open") fail(`openOffers names ${id}, which is not open`);
      const k = effExpiry(o!, regimeHeight());
      if (k === k && !oq.has(`${k}\u0000${id}`)) fail(`open offer ${id} has no queue entry at ${k}`);
    }
    for (const id of openBids) {
      const b = bids.get(id);
      if (!b || b.status !== "open") fail(`openBids names ${id}, which is not open`);
      const k = effExpiry(b!, regimeHeight());
      if (k === k && !bq.has(`${k}\u0000${id}`)) fail(`open bid ${id} has no queue entry at ${k}`);
    }
    for (const nm of pendingNames) { const n = names.get(nm); if (!n || !n.pending) fail(`pendingNames names ${nm}, which is not pending`); }
    for (const [nm, n] of names) {
      if (!n.pending) continue;
      if (!pendingNames.has(nm)) fail(`pending ${nm} is not in pendingNames`);
      if (!pendingBy.get(n.owner)?.has(nm)) fail(`pending ${nm} is not a candidate of its owner ${n.owner}`);
      if (n.finalizeBy !== undefined && !nq.has(`${n.finalizeBy}\u0000${nm}`)) fail(`pending ${nm} has no queue entry at ${n.finalizeBy}`);
    }
    for (const [nm, r] of recaptures) {
      if (!recaptureBy.get(r.owner)?.has(nm)) fail(`recapture ${nm} is not a candidate of its owner ${r.owner}`);
      if (!rq.has(`${r.finalizeBy}\u0000${nm}`)) fail(`recapture ${nm} has no queue entry at ${r.finalizeBy}`);
    }
  };

  return {
    offers: offers as ReadonlyMap<string, OfferRec>,
    bids: bids as ReadonlyMap<string, BidRec>,
    names: names as ReadonlyMap<string, NameRec>,
    recaptures: recaptures as ReadonlyMap<string, Recapture>,
    addOffer, setOfferStatus, addBid, setBidStatus, putName, setNameOwner, finalizeName, putRecapture, deleteRecapture,
    sweep, pendingCount, recaptureCount, verify, stats,
  };
}
