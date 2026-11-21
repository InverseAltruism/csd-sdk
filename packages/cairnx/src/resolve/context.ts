// The replay state one resolve() call threads through the record handlers: the token ledger, the commits, the fclaim
// grants and the log, the store of offers, bids and names (store.ts, which keeps the private indexes), and the
// helpers that mutate them. Internal to cairnx-core; resolve.ts owns the loop and the output.
import type { AppliedCode, ReasonCode, RefusalCode } from "../codes.js";
import {
  AMOUNT_RE, MAX_OFFER_EPOCHS, V21_HEIGHT, V22_HEIGHT, claimGraceOf, epochOf, isNameGive,
  type AppliedEvent, type ChainEvent, type OfferState, type TokenMove, type TokenState,
} from "../types.js";
import type { OfferRec, Store } from "./store.js";

// Read an externally-supplied paidTo/pt amount, fail-closed to 0 on any non-canonical value (QA LOW: the
// raw BigInt(x)/int(x) reads accepted DISJOINT non-decimal forms across JS↔Python — BigInt("0x10")=16 vs
// int("0x10") throws — a latent cross-language fork the differential fuzz never reached. Gate through the
// SAME AMOUNT_RE that record amounts already use, in BOTH impls: byte-identical for every canonical value
// the scanner ever emits, and CONVERGES instead of value-vs-throw on any non-canonical input. Mirror in
// conformance/cairnx_ref.py:_pt.)
export function ptAmt(v: unknown): bigint { return typeof v === "string" && AMOUNT_RE.test(v) ? BigInt(v) : 0n; }

/** The move of `amount` (the bigint the balance line applied) in the log's form (CONVENTION §41). */
export const tokenMove = (leg: TokenMove["leg"], ticker: string, from: string | null, to: string, amount: bigint): TokenMove =>
  ({ leg, ticker, from, to, amount: amount.toString() });

export interface Bal { available: bigint; locked: bigint }
export interface Tok { meta: TokenState; minted: bigint; supply: bigint; mintLimit: bigint | null }
export type { BidRec, NameRec, OfferRec, Recapture } from "./store.js";

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

export function createContext(store: Store) {
  const tokens = new Map<string, Tok>();
  const balances = new Map<string, Map<string, Bal>>();       // ticker → addr → bal
  const commits = new Map<string, number>();                  // commitHash → earliest height seen
  const offerLock = new Map<string, bigint>();                // token offers: id → locked amount
  // name → record; v2.6 recapture reservations (INTERNAL, not materialized, like `commits`), whose LAPSED record stays
  // in `names` untouched (premium basis preserved) until a finalize wins; offers; v1.2 buy-side intents.
  const { names, recaptures, offers, bids, setOfferStatus, setBidStatus, putName } = store;
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

  // ── release the asset held by an offer (token amount unlock, or name unlock) ──
  const releaseGive = (o: OfferRec) => {
    if (isNameGive(o.give)) { const n = names.get(o.give.name); if (n) n.locked = false; }
    else { const amt = offerLock.get(o.id) ?? 0n; const b = bal(o.give.ticker, o.seller); b.locked -= amt; b.available += amt; }
  };

  // lazily settle what has ended before `height`: offers and bids past effExpiry (above) release their give; a v2.5
  // reservation past its finalize window is deleted so the name reopens (below V25 none is ever pending); a v2.6
  // recapture reservation past it is dropped (the lapsed record in `names` is untouched, so the name stays recapturable).
  const sweepExpired = (height: number) => store.sweep(height, releaseGive);

  // an offer responding to a bid, filled by the bidder ⇒ the bid is satisfied (informational)
  const markBidDone = (o: OfferRec, buyer: string) => {
    if (!o.bid) return;
    const b = bids.get(o.bid);
    if (b && b.status === "open" && b.bidder === buyer) setBidStatus(b, "done");
  };
  // void every open offer that lists `name` (a displacement/reclaim/reservation-takeover cancels the
  // wrongful holder's listings; releaseGive keeps lock-handling uniform with the cancel/expiry paths).
  // Extracted verbatim from the four inline copies at the displacement/reservation/recapture sites.
  // v2.8: a name-offer carrying a live fclaim hold is FROZEN against a displacement/recapture void (the
  // lease-lapse-mid-hold safety: a lapsed name recaptured during a hold must not strand the buyer's
  // L0-minable fill). Same predicate as Correction 2, keyed on the voiding event's height (store.ts, voidTargets).
  const voidOpenNameOffers = (name: string, height: number) => {
    for (const o of store.voidTargets(name, height)) { releaseGive(o); setOfferStatus(o, "cancelled"); }
  };
  // release a token offer's locked give-amount in FULL to the buyer, consuming the lock so it can never
  // release twice, and return its fill move. (The partial-fill path releases a sub-amount and keeps the lock: it does NOT use this.)
  const releaseGiveLock = (o: OfferRec, who: string, amt: bigint): TokenMove => {
    const t = (o.give as { ticker: string }).ticker;
    bal(t, o.seller).locked -= amt;
    bal(t, who).available += amt;
    offerLock.delete(o.id);
    return tokenMove("fill", t, o.seller, who, amt);
  };
  // An applied-log entry. `ok` follows from which of the two writes it, and the code types keep each code on its side.
  // Only `applied` passes moves. A zero amount moves nothing and is not written; `moves` is left out when none is, and
  // comes last, so an entry without it is byte for byte the entry of a core that writes no moves.
  const entry = (e: ChainEvent, id: string, kind: string, ok: boolean, code: ReasonCode, why?: string, moves?: TokenMove[]) => {
    const written = moves?.filter((m) => m.amount !== "0") ?? [];
    log.push({ height: e.height, pos: e.pos, id, kind, ok, code, ...(why ? { note: why } : {}), ...(written.length ? { moves: written } : {}) });
  };
  const applied = (e: ChainEvent, id: string, kind: string, code: AppliedCode, why?: string, moves?: TokenMove[]) => entry(e, id, kind, true, code, why, moves);
  const refused = (e: ChainEvent, id: string, kind: string, code: RefusalCode, why?: string) => entry(e, id, kind, false, code, why);

  return {
    tokens, balances, names, commits, recaptures, offers, offerLock, bids, fclaims, log, store,
    setOfferStatus, setBidStatus, putName, bal, applied, refused, releaseGive, sweepExpired, markBidDone, voidOpenNameOffers, releaseGiveLock,
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
