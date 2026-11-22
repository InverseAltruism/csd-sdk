// A held replay context: the fold of resolve() kept between tips, fed whole blocks in order and answering in place at
// the last height it was given (CONVENTION section 5). Over the events it takes, its answer at t is what resolve()
// returns over the same events at t. It takes an event whose height is a safe integer (isChainHeight), whose position
// is a safe integer >= 0 and whose id is a string: outside the first the fold's sweeps would depend on where answers
// ran, outside the other two applyOrder is no consistent order, so a sort of one block alone could order it differently
// from resolve()'s sort of the whole stream. It refuses the rest, and the caller replays with resolve().
import { isIndex } from "./events.js";
import { applyOrder, createFold, eventId } from "./resolve.js";
import { isChainHeight, type BidState, type CairnXState, type ChainEvent, type OfferState } from "./types.js";

export type ReplayContextRefusalCode = "domain" | "order" | "tip" | "broken" | "sloppy";

/** A call the context does not take, thrown before it writes anything. "domain": a target height or an event height
 *  outside isChainHeight, an event position that is not a safe integer >= 0, or an event id (a Propose's id, an
 *  Attest's txid) that is not a string; "order": a target below the context's height, or an event at or below it or
 *  above the target (a negative height, for a new context); "tip": an answer asked off the context's height;
 *  "broken": any call after the replay threw inside advance or stateAt; "sloppy": a context started where a write to a
 *  frozen object does not throw. */
export class ReplayContextRefusal extends Error {
  readonly code: ReplayContextRefusalCode;
  constructor(code: ReplayContextRefusalCode, message: string) {
    super(message);
    this.name = "ReplayContextRefusal";
    this.code = code;
  }
}

export interface ReplayContext {
  /** Every event at or below this height has been given; -1, below the chain's first block, for a new context. */
  readonly height: number;
  /** Applies all events of the blocks in (height, toHeight], in apply order, and moves the height to toHeight. Reads
   *  `events` once and keeps a copy of each event's own fields, so a later write into a fed event changes no later
   *  answer. The copy is one level deep: `paidTo` stays the caller's object, read only during this call. */
  advance(toHeight: number, events: readonly ChainEvent[]): void;
  /** resolve() over the events given so far at tipHeight, which must equal the context's height. The result shares
   *  nothing a later advance writes; what it shares is frozen. */
  stateAt(tipHeight: number): CairnXState;
}

// A function called without a receiver sees `this` undefined only in strict code. The answers share frozen parts with
// the fold, and a write the fold makes to one of them must throw (and break the context), not be dropped silently.
const strictCode = (function (this: unknown) { return this === undefined; })();

export function newReplayContext(): ReplayContext {
  if (!strictCode) throw new ReplayContextRefusal("sloppy", "this build runs cairnx-core in sloppy mode, where a write to a frozen object is ignored");
  const fold = createFold();
  let height = -1;
  let broken = false;
  const live = () => { if (broken) throw new ReplayContextRefusal("broken", "the replay threw inside advance or stateAt; replay with resolve()"); };
  return {
    get height() { return height; },
    advance(toHeight, events) {
      live();
      if (!isChainHeight(toHeight)) throw new ReplayContextRefusal("domain", `target height ${String(toHeight)} is not a safe integer`);
      // Copied: a block's deferred cancels read their event again at the next flush (its height, position and id).
      const batch = [...events].map((e) => ({ ...e }));
      for (const e of batch) {
        if (!isChainHeight(e.height)) throw new ReplayContextRefusal("domain", `event height ${String(e.height)} is not a safe integer`);
        if (!isIndex(e.pos)) throw new ReplayContextRefusal("domain", `event position ${String(e.pos)} is not a safe integer >= 0`);
        if (typeof eventId(e) !== "string") throw new ReplayContextRefusal("domain", `an event id of type ${typeof eventId(e)}`);
      }
      if (toHeight < height) throw new ReplayContextRefusal("order", `target ${toHeight} is below the context's height ${height}`);
      for (const e of batch) {
        if (e.height <= height || e.height > toHeight) throw new ReplayContextRefusal("order", `event height ${e.height} is outside (${height}, ${toHeight}]`);
      }
      batch.sort(applyOrder);
      try {
        for (const e of batch) fold.apply(e);
      } catch (err) {
        broken = true;
        throw err;
      }
      height = toHeight;
    },
    stateAt(tipHeight) {
      live();
      if (tipHeight !== height) throw new ReplayContextRefusal("tip", `an answer at ${String(tipHeight)} from a context at ${height}`);
      try {
        return detach(fold.finish(tipHeight));
      } catch (err) {
        broken = true;
        throw err;
      }
    },
  };
}

// Stops at a frozen object, taking its parts as frozen: this function froze them with it. That holds for plain values
// as JSON carries them. The values an event carries into the state are its height, position, id, author and expiry,
// each a number or a string where the context or the fold takes the event.
const freezeDeep = (v: unknown): void => {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return;
  Object.freeze(v);
  for (const x of Object.values(v)) freezeDeep(x);
};

// A record a later advance may write, one level deep: its own fields copied, each array copied, every element and
// nested object frozen and shared.
const copyRecord = <T extends object>(r: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) { for (const x of v) freezeDeep(x); out[k] = [...v]; } else { freezeDeep(v); out[k] = v; }
  }
  return out as T;
};

// The fold's result shares live objects with the fold: the offers, the bids and the log. A later advance writes an open
// offer (status, paid, delivered, fills, the fill, claims) and every bid (an offer that answers a bid is pushed onto its
// offers, closed or not), and appends to the log. Tokens, balances, names, recaptures and fclaims are built fresh per
// answer, a name's profile excepted.
function detach(st: CairnXState): CairnXState {
  const offers: Record<string, OfferState> = {};
  for (const [id, o] of Object.entries(st.offers)) {
    if (o.status === "open") offers[id] = copyRecord(o);
    else { freezeDeep(o); offers[id] = o; }
  }
  const bids: Record<string, BidState> = {};
  for (const [id, b] of Object.entries(st.bids)) bids[id] = copyRecord(b);
  for (const n of Object.values(st.names)) freezeDeep(n.profile);
  const events = st.events.slice();
  for (const e of events) freezeDeep(e);
  return { ...st, offers, bids, events };
}
