// The replay state one resolve() call threads through the record handlers: the ledger maps, the private expiry
// indexes and the helpers that mutate them. Internal to cairnx-core; resolve.ts owns the loop and the output.
import {
  AMOUNT_RE, MAX_OFFER_EPOCHS, V21_HEIGHT, V22_HEIGHT, V28_HEIGHT, claimGraceOf, epochOf, isNameGive,
  type AppliedEvent, type BidState, type ChainEvent, type OfferState, type TokenState,
} from "../types.js";

// Read an externally-supplied paidTo/pt amount, fail-closed to 0 on any non-canonical value (QA LOW: the
// raw BigInt(x)/int(x) reads accepted DISJOINT non-decimal forms across JS↔Python — BigInt("0x10")=16 vs
// int("0x10") throws — a latent cross-language fork the differential fuzz never reached. Gate through the
// SAME AMOUNT_RE that record amounts already use, in BOTH impls: byte-identical for every canonical value
// the scanner ever emits, and CONVERGES instead of value-vs-throw on any non-canonical input. Mirror in
// conformance/cairnx_ref.py:_pt.)
export function ptAmt(v: unknown): bigint { return typeof v === "string" && AMOUNT_RE.test(v) ? BigInt(v) : 0n; }

export interface Bal { available: bigint; locked: bigint }
export interface Tok { meta: TokenState; minted: bigint; supply: bigint; mintLimit: bigint | null }
export interface NameRec { owner: string; effHeight: number; pos: number; id: string; height: number; addr?: string; locked: boolean; viaFill?: boolean; paidThroughEpoch?: number; profile?: Record<string, string>; pending?: boolean; finalizeBy?: number }

// v2.1 ([V21,V22)): the EFFECTIVE expiry
// is capped at anchorEpoch + MAX_OFFER_EPOCHS, so a long-resting offer/bid expires at the cap (and existing
// over-cap inventory expires exactly when the sweep height first crosses V21). v2.2 (offer ANCHORED >= V22):
// the cap is REMOVED — the raw expiresEpoch binds (listing duration is a UI-only policy). Keyed on the
// offer's ANCHOR height (e.height), NOT the sweep height, so [V21,V22) and every pre-V21 hash stay
// byte-identical (an offer anchored < V22 keeps its V21-era effExpiry forever; only offers anchored >= V22
// are un-capped). Deterministic across replayers; pre-V21 byte-identical to the original behavior.
export const effExpiry = (e: { expiresEpoch: number; height: number }, height: number): number =>
  e.height >= V22_HEIGHT ? e.expiresEpoch
    : height >= V21_HEIGHT ? Math.min(e.expiresEpoch, epochOf(e.height) + MAX_OFFER_EPOCHS)
      : e.expiresEpoch;

// v1.7/v2.0: a claim grants the claimer an EXCLUSIVE HOLD of an open offer = a window (the exclusivity
// period) + a fill GRACE (v2.0/V20 only). Within the hold the claimer's fill is honored AND no other
// address may claim — both governed by the SAME interval — so a fill submitted in-window that mines
// slightly late still DELIVERS instead of burning the already-paid seller value (the late-fill fund loss),
// and there is NO displacement race (the holder is exclusive for the whole window+grace; below the grace a
// new claim is rejected). Below V20: window 15, grace 0 → byte-identical history (non-retroactive). The
// grace is derived from the claim's ERA so its inverse is UNAMBIGUOUS: a claim granted at ≥V20 has
// claimUntilHeight = grantHeight + CLAIM_WINDOW_BLOCKS_V20 ≥ V20+40; a pre-V20 claim has ≤ V20+14; the
// [V20+15, V20+40) range is unreachable, so `claimUntilHeight − 40 ≥ V20` ⟺ "this was a V20 claim".
// the fill GRACE for a stored claim (claimGraceOf, imported from types — derived from the claim's era,
// V20+ ⇒ CLAIM_FILL_GRACE_BLOCKS, else 0; undefined claimUntilHeight ⇒ 0). claimWindowAt is likewise the
// imported selector, so the resolver and the exported client helpers share one definition (cannot drift).
export const claimGrace = (o: OfferState): number =>
  o.claimUntilHeight !== undefined ? claimGraceOf(o.claimUntilHeight, o.claimTxid) : 0;
// is the offer still EXCLUSIVELY HELD (window + grace) at `height`? Lazy lapse — a past hold reads as
// "not held" (no mutation). Used for BOTH the fill gate (with who===claimedBy) and the new-claim block.
export const claimHeld = (o: OfferState, height: number): boolean =>
  o.claimedBy !== undefined && o.claimUntilHeight !== undefined && height < o.claimUntilHeight + claimGrace(o);

export type ResolveCtx = ReturnType<typeof createContext>;

export function createContext() {
  const tokens = new Map<string, Tok>();
  const balances = new Map<string, Map<string, Bal>>();       // ticker → addr → bal
  const names = new Map<string, NameRec>();                   // name → record
  const commits = new Map<string, number>();                  // commitHash → earliest height seen
  // v2.6 recapture reservations (INTERNAL, not materialized — like `commits`): name → the pending recapture
  // reservation. The LAPSED record stays in `names` untouched (premium basis preserved) until a finalize wins.
  const recaptures = new Map<string, { owner: string; effHeight: number; pos: number; id: string; height: number; finalizeBy: number }>();
  const offers = new Map<string, OfferState>();
  const offerLock = new Map<string, bigint>();                // token offers: id → locked amount
  const bids = new Map<string, BidState>();                   // v1.2 buy-side intents
  // Private indexes for expiry work. Closed offers and bids stay in the maps (canonical history)
  // but are not walked again on every event. Insertion order matches the maps, so a sweep still
  // expires the same open rows in the same order.
  const openOffers = new Set<string>();
  const openBids = new Set<string>();
  const pendingNames = new Set<string>();
  const setOfferStatus = (o: OfferState, status: OfferState["status"]) => {
    o.status = status;
    if (status === "open") openOffers.add(o.id); else openOffers.delete(o.id);
  };
  const setBidStatus = (b: BidState, status: BidState["status"]) => {
    b.status = status;
    if (status === "open") openBids.add(b.id); else openBids.delete(b.id);
  };
  const putName = (nm: string, n: NameRec) => {
    names.set(nm, n);
    if (n.pending) pendingNames.add(nm); else pendingNames.delete(nm);
  };
  // v2.8 fclaim (§31): fclaimTxid → the linked offer + grant outcome. Records BOTH granted and DENIED grants
  // (a denied fclaim is an L0-valid fill target, so the audit needs to see it). The GRANTED subset is
  // materialized into state.fclaims (diagnostic, excluded from canonicalState).
  const fclaims = new Map<string, { offer: string; proposer: string; expiresEpoch: number; height: number; granted: boolean }>();
  const log: AppliedEvent[] = [];

  const bal = (ticker: string, addr: string): Bal => {
    let m = balances.get(ticker);
    if (!m) { m = new Map(); balances.set(ticker, m); }
    let b = m.get(addr);
    if (!b) { b = { available: 0n, locked: 0n }; m.set(addr, b); }
    return b;
  };
  const note = (e: ChainEvent, id: string, kind: string, ok: boolean, why?: string) =>
    log.push({ height: e.height, pos: e.pos, id, kind, ok, ...(why ? { note: why } : {}) });

  // ── release the asset held by an offer (token amount unlock, or name unlock) ──
  const releaseGive = (o: OfferState) => {
    if (isNameGive(o.give)) { const n = names.get(o.give.name); if (n) n.locked = false; }
    else { const amt = offerLock.get(o.id) ?? 0n; const b = bal(o.give.ticker, o.seller); b.locked -= amt; b.available += amt; }
  };

  // lazily settle offers/bids whose window has ended before `height` (effExpiry above).
  const sweepExpired = (height: number) => {
    const ep = epochOf(height);
    for (const id of [...openOffers]) {
      const o = offers.get(id);
      if (!o || o.status !== "open") { openOffers.delete(id); continue; }
      if (ep > effExpiry(o, height)) { releaseGive(o); setOfferStatus(o, "expired"); }
    }
    for (const id of [...openBids]) {
      const b = bids.get(id);
      if (!b || b.status !== "open") { openBids.delete(id); continue; }
      if (ep > effExpiry(b, height)) setBidStatus(b, "expired");
    }
    // v2.5: an un-finalized reservation past its finalize window is abandoned — drop it so the name reopens and
    // canonical state does not accumulate dead reservations. Deterministic (keyed on the block height); below
    // V25 no name is ever `pending`, so this is a no-op and pre-V25 hashes are byte-identical.
    for (const nm of [...pendingNames]) {
      const n = names.get(nm);
      if (!n || !n.pending) { pendingNames.delete(nm); continue; }
      if (n.finalizeBy !== undefined && height > n.finalizeBy) { names.delete(nm); pendingNames.delete(nm); }
    }
    // v2.6: drop expired recapture reservations (the lapsed record in `names` is UNTOUCHED, so the name simply
    // stays recapturable). Internal map -> no canonical-state effect; below V26 it is always empty (no-op).
    for (const nm of [...recaptures.keys()]) { const r = recaptures.get(nm)!; if (height > r.finalizeBy) recaptures.delete(nm); }
  };

  // an offer responding to a bid, filled by the bidder ⇒ the bid is satisfied (informational)
  const markBidDone = (o: OfferState, buyer: string) => {
    if (!o.bid) return;
    const b = bids.get(o.bid);
    if (b && b.status === "open" && b.bidder === buyer) setBidStatus(b, "done");
  };
  // void every open offer that lists `name` (a displacement/reclaim/reservation-takeover cancels the
  // wrongful holder's listings; releaseGive keeps lock-handling uniform with the cancel/expiry paths).
  // Extracted verbatim from the four inline copies at the displacement/reservation/recapture sites.
  const voidOpenNameOffers = (name: string, height: number) => {
    for (const o of offers.values()) if (o.status === "open" && isNameGive(o.give) && o.give.name === name) {
      // v2.8: a name-offer carrying a live fclaim hold is FROZEN against a displacement/recapture void (the
      // lease-lapse-mid-hold safety: a lapsed name recaptured during a hold must not strand the buyer's
      // L0-minable fill). Same predicate as Correction 2, keyed on the voiding event's height.
      if (height >= V28_HEIGHT && o.claimTxid !== undefined && claimHeld(o, height)) continue;
      releaseGive(o); setOfferStatus(o, "cancelled");
    }
  };
  // release a token offer's locked give-amount in FULL to the buyer, consuming the lock so it can never
  // release twice. (The partial-fill path releases a sub-amount and keeps the lock — it does NOT use this.)
  const releaseGiveLock = (o: OfferState, who: string, amt: bigint) => {
    const t = (o.give as { ticker: string }).ticker;
    bal(t, o.seller).locked -= amt;
    bal(t, who).available += amt;
    offerLock.delete(o.id);
  };

  return {
    tokens, balances, names, commits, recaptures, offers, offerLock, bids, openOffers, openBids, pendingNames, fclaims, log,
    setOfferStatus, setBidStatus, putName, bal, note, releaseGive, sweepExpired, markBidDone, voidOpenNameOffers, releaseGiveLock,
    feesPaid: 0n,
    // v1.4 fill-before-cancel: at V14_HEIGHT+ a cancel/ocancel's EFFECT is deferred to the block
    // boundary, so any same-block fill wins — a seller can no longer snipe a buyer's in-flight
    // payment by front-running the fill with a cheap cancel (cancel applies first in consensus
    // order: proposals before attests, and a paid-up cancel attest can out-pos the fill). A fill
    // that lands = seller got paid = a completed sale; the late cancel then no-ops. Pre-v14 blocks
    // never populate pendingCancels, so all historical replay stays byte-identical.
    pendingCancels: [] as Array<() => void>,
  };
}
