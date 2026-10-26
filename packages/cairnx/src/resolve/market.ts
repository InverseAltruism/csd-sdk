// Market Propose records: offers, bids, the v1.2 bulk cancel (ocancel) and the v2.8 fclaim hold grant.
// The attest side (fills, cancels, legacy claims) is in attest.ts.
import { parseAmount } from "../records.js";
import {
  CLAIM_COOLDOWN_BLOCKS, COMMIT_MAX_BLOCKS, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, FEE_BPS, FEE_BPS_V16, MAX_ACTIVE_CLAIMS,
  MAX_OFFER_EPOCHS, REG_COMMIT_MAX_BLOCKS, TREASURY_ADDR, V11_HEIGHT, V12_HEIGHT, V13_HEIGHT, V14_HEIGHT, V15_HEIGHT,
  V16_HEIGHT, V17_HEIGHT, V21_HEIGHT, V22_HEIGHT, V27_HEIGHT, V28_HEIGHT, epochOf, isNameGive, isTokenWant,
  type BidRecord, type FclaimRecord, type Give, type OfferCancelAllRecord, type OfferRecord, type OfferState, type ProposeEvent,
} from "../types.js";
import { claimGrace, claimHeld, effExpiry, type ResolveCtx } from "./context.js";
import { paidThrough } from "./names.js";

export function applyOffer(c: ResolveCtx, ev: ProposeEvent, rec: OfferRecord, who: string): void {
  const { tokens, names, offers, offerLock, openOffers, bids, bal, note } = c;
  const v11 = ev.height >= V11_HEIGHT;
  const v15 = ev.height >= V15_HEIGHT;
  const v16 = ev.height >= V16_HEIGHT;
  const wantIsToken = isTokenWant(rec.want);
  const refusal = offerEnvelopeRefusal(rec, who, ev.height, ev.expiresEpoch);
  if (refusal !== null) { note(ev, ev.id, "offer", false, refusal); return; }
  const payto = (rec.want.payto ?? who).toLowerCase();
  const give: Give = rec.give;
  if (isNameGive(give)) {
    const n = names.get(give.name);
    if (!n || n.owner !== who) { note(ev, ev.id, "offer", false, "you don't own this name"); return; }
    if (n.pending) { note(ev, ev.id, "offer", false, "name reservation not yet finalized"); return; }
    if (n.locked) { note(ev, ev.id, "offer", false, "name already locked by another offer"); return; }
    // v1.3: a claim-based name may not be offered until its anchor out-ages the reveal
    // window — every lurking commit's reveal deadline passes BEFORE a sale can exist, so
    // viaFill immunity (below) can never shield a front-run squatter's quick flip.
    // v2.7 (>= V27): the embargo shrinks from COMMIT_MAX_BLOCKS (~8h) to REG_COMMIT_MAX_BLOCKS
    // (~16 min). Under the V25 sealed model a name is offerable only once non-pending (finalized,
    // checked above), and finalize requires ev.height > effHeight + REG_COMMIT_MAX_BLOCKS, so by
    // the time any sale can exist the freeze has passed and every window-valid displacer's reveal
    // deadline (regWindow = REG_COMMIT_MAX_BLOCKS, keyed on reveal height) is closed; the shorter
    // embargo is exactly sufficient. Below V27 the 240-block rule is unchanged (byte-identical).
    // V27 is only 80 blocks past V25, so a pre-V25 name could in principle meet V27 inside the
    // 240-block bar; on the chain none did (youngest effective height 46,062; test/vectors.test.ts).
    const saleEmbargo = ev.height >= V27_HEIGHT ? REG_COMMIT_MAX_BLOCKS : COMMIT_MAX_BLOCKS;
    if (ev.height >= V13_HEIGHT && !n.viaFill && ev.height - n.effHeight <= saleEmbargo) {
      note(ev, ev.id, "offer", false, "name too young to sell (must out-age the reveal window)"); return;
    }
    // v1.5: the lease must outlive the offer window — so a fill can NEVER hit a lapsed
    // name (a no-op'd CSD fill would still have paid the seller; make it unrepresentable)
    if (v15 && paidThrough(n) < ev.expiresEpoch) {
      note(ev, ev.id, "offer", false, "v1.5: lease ends inside the offer window (renew first)"); return;
    }
    n.locked = true;
  } else {
    if (!tokens.has(give.ticker)) { note(ev, ev.id, "offer", false, "unknown ticker"); return; }
    const amt = parseAmount(give.amount)!;
    const s = bal(give.ticker, who);
    if (s.available < amt) { note(ev, ev.id, "offer", false, "insufficient available balance"); return; }
    s.available -= amt; s.locked += amt; offerLock.set(ev.id, amt);
  }
  const o: OfferState = {
    id: ev.id, seller: who, give,
    want: wantIsToken
      ? { ticker: (rec.want as { ticker: string; amount: string }).ticker, amount: (rec.want as { ticker: string; amount: string }).amount, payto }
      : { value: (rec.want as { value: string }).value, payto },
    ...(rec.taker ? { taker: rec.taker.toLowerCase() } : {}),
    ...(rec.min !== undefined ? { min: rec.min, paid: "0", delivered: "0", fills: [] } : {}),
    ...(rec.bid !== undefined ? { bid: rec.bid } : {}),
    status: "open", expiresEpoch: ev.expiresEpoch, height: ev.height, feeBps: v11 ? (v16 ? FEE_BPS_V16 : FEE_BPS) : 0,
  };
  offers.set(ev.id, o);
  openOffers.add(ev.id);
  const linked = rec.bid !== undefined ? bids.get(rec.bid) : undefined;
  if (linked) linked.offers.push(ev.id);
  note(ev, ev.id, "offer", true);
}

export function applyBid(c: ResolveCtx, ev: ProposeEvent, rec: BidRecord, who: string): void {
  const { bids, openBids, note } = c;
  const v12 = ev.height >= V12_HEIGHT;
  if (!v12) { note(ev, ev.id, "bid", false, "bids need v1.2"); return; }
  if (!Number.isSafeInteger(ev.expiresEpoch)) { note(ev, ev.id, "bid", false, "expiresEpoch out of safe-integer range"); return; }
  if (epochOf(ev.height) > ev.expiresEpoch) { note(ev, ev.id, "bid", false, "already expired at anchor"); return; }
  // v2.1 duration cap — gated to the [V21,V22) era only; v2.2 (anchor >= V22) removes it (UI-only policy).
  if (ev.height >= V21_HEIGHT && ev.height < V22_HEIGHT && ev.expiresEpoch - epochOf(ev.height) > MAX_OFFER_EPOCHS) { note(ev, ev.id, "bid", false, "v2.1: bid duration exceeds the max"); return; }
  bids.set(ev.id, {
    id: ev.id, bidder: who, want: rec.want, give: rec.give,
    status: "open", expiresEpoch: ev.expiresEpoch, height: ev.height, offers: [],
  });
  openBids.add(ev.id);
  note(ev, ev.id, "bid", true);
}

export function applyOcancel(c: ResolveCtx, ev: ProposeEvent, rec: OfferCancelAllRecord, who: string): void {
  const { offers, note, releaseGive, setOfferStatus } = c;
  const v12 = ev.height >= V12_HEIGHT;
  if (!v12) { note(ev, ev.id, "ocancel", false, "ocancel needs v1.2"); return; }
  // cancel all the proposer's open offers anchored strictly earlier in apply order
  // (snapshotting at apply-time is correct: higher-pos same-block offers aren't applied yet)
  const targets: OfferState[] = [];
  for (const o of offers.values()) {
    if (o.status !== "open" || o.seller !== who) continue;
    if (o.taker !== undefined && o.height >= V28_HEIGHT) continue; // v2.8 Lane B: a taker-bound V28+ offer is a firm quote (uncancellable)
    if (rec.ticker !== undefined && !(!isNameGive(o.give) && o.give.ticker === rec.ticker)) continue;
    if (rec.name !== undefined && !(isNameGive(o.give) && o.give.name === rec.name)) continue;
    targets.push(o);
  }
  if (ev.height >= V14_HEIGHT) {
    // v1.4: defer the effect to the block boundary — same-block fills win (anti-snipe)
    c.pendingCancels.push(() => {
      let n = 0;
      for (const o of targets) {
        // v2.8 Correction 2: freeze a live fclaim hold, keyed on the CANCEL's OWN block (ev.height) and
        // evaluated LIVE on the offer object (a same-block higher-pos grant mutated it after the snapshot).
        if (ev.height >= V28_HEIGHT && o.claimTxid !== undefined && claimHeld(o, ev.height)) continue;
        if (o.status === "open") { releaseGive(o); setOfferStatus(o, "cancelled"); n++; }
      }
      note(ev, ev.id, "ocancel", true, `${n} cancelled (deferred past same-block fills)`);
    });
  } else {
    for (const o of targets) { releaseGive(o); setOfferStatus(o, "cancelled"); }
    note(ev, ev.id, "ocancel", true, `${targets.length} cancelled`);
  }
}

export function applyFclaim(c: ResolveCtx, ev: ProposeEvent, rec: FclaimRecord, who: string): void {
  const { offers, fclaims, note, liveHoldCount } = c;
  // ── v2.8 (§31) open-lane claim GRANT: reserve an OPEN, CSD-priced, untaken offer with a short-expiry
  // Propose. The fill attests THIS txid, so L0's attest-existence + attest-after-expiry rules enforce the
  // hold deadline. On grant, claimedBy/claimUntilHeight/claimTxid are set LAST-WRITE-WINS (a later grant on
  // the same offer re-assigns all three; claimTxid is never left stale and never cleared). ──
  if (ev.height < V28_HEIGHT) { note(ev, ev.id, "fclaim", false, "fclaim needs v2.8"); return; }
  // PARITY with the sibling offer/bid Propose guards (same guard, same phrasing): expiresEpoch
  // is an unbounded on-chain u64; at or above 2^53 it has no exact JS representation (the
  // offer-branch rationale applies verbatim). For every chain-derivable stream this is
  // replay-identical: an unsafe E can never reach the grant, because E > effExpiry below always
  // denies it (a stored offer's own expiresEpoch is safe-integer-gated at creation). It also
  // closes a JS-API-only hazard: a non-finite E (unrepresentable in JSON, so never from the
  // chain) previously slid past every comparison leg and GRANTED a hold with claimUntilHeight
  // NaN, which canonicalState serializes as null. Reject-more, ungated.
  const target = offers.get(rec.offer);
  const E = ev.expiresEpoch;
  const deny = (why: string) => { fclaims.set(ev.id, { offer: rec.offer, proposer: who, expiresEpoch: E, height: ev.height, granted: false }); note(ev, ev.id, "fclaim", false, why); };
  // P75-4 REG-1: this MUST use deny(), not a bare note()+return. Every other rung of this ladder
  // records a DENIED fclaim in the map, and applyAttest reads fclaims.has(proposalId) to flag a paid
  // SCORE_FILL on a denied fclaim as a pay-without-delivery burn for money-safety.mjs. An
  // expires_epoch at or above 2^53 is a MINEABLE u64, so unlike NaN that class is on-chain
  // reachable: skipping the map entry would silence the burn note for the one shape that can
  // actually happen. Canonical cost is zero, because fclaimsOut in resolve.ts filters on `granted`.
  if (!Number.isSafeInteger(E)) { deny("expiresEpoch out of safe-integer range"); return; }
  if (!target) { deny("unknown offer"); return; }
  if (target.status !== "open") { deny(`offer ${target.status}`); return; }
  if (target.taker) { deny("taker-bound offer needs no claim"); return; }
  if (isTokenWant(target.want)) { deny("claims are for CSD-priced offers"); return; }
  if (E > effExpiry(target, ev.height)) { deny("hold would outlive the offer expiry"); return; }
  if (E > epochOf(ev.height) + FCLAIM_MAX_EPOCH_AHEAD) { deny("hold too far ahead (anti-squat)"); return; }
  if (epochOf(ev.height) > E) { deny("expiry already in the past"); return; }
  if (claimHeld(target, ev.height)) { deny("offer already claimed (hold live)"); return; }
  // cooldown runs from the END of the prior hold (window + its era grace, 0 for a prior fclaim hold):
  if (target.claimedBy === who && target.claimUntilHeight !== undefined && ev.height < target.claimUntilHeight + claimGrace(target) + CLAIM_COOLDOWN_BLOCKS) { deny("claim cooldown (you just held this offer)"); return; }
  // per-address concurrent-hold cap (liveHoldCount, context.ts; v2.9 counts open holds only from V29).
  if (liveHoldCount(who, ev.height) >= MAX_ACTIVE_CLAIMS) { deny(`max ${MAX_ACTIVE_CLAIMS} live claims per address`); return; }
  target.claimedBy = who; target.claimUntilHeight = (E + 1) * EPOCH_LEN; target.claimTxid = ev.id;
  fclaims.set(ev.id, { offer: rec.offer, proposer: who, expiresEpoch: E, height: ev.height, granted: true });
  note(ev, ev.id, "fclaim", true);
}

// The offer rules that read only the record, its proposer, its inclusion height and the Propose's expires_epoch,
// in applyOffer's order: the first refusal note, or null. Shared with the proven-offer client check
// (provenOfferRefusal in src/admission.ts), so a client refuses exactly what this refuses.
export function offerEnvelopeRefusal(rec: OfferRecord, who: string, height: number, expiresEpoch: number): string | null {
  const wantIsToken = isTokenWant(rec.want);
  // v1.2 shapes (token-priced want, partial-fill min, bid link) are non-retroactive
  if ((wantIsToken || rec.min !== undefined || rec.bid !== undefined) && height < V12_HEIGHT) return "v1.2 offer shape before activation";
  // v1.3: an open (non-taker-bound) CSD-priced offer is structurally unsafe: a lost
  // same-block fill race forfeits the loser's ENTIRE payment (no escrow on the substrate).
  // CSD buys go bid → taker-bound answer → race-free fill. Token⇄token stays open (no-op-safe).
  // v1.3 banned open CSD offers (the lost-fill-race forfeits a payment); v1.7 RE-ALLOWS them, made
  // race-safe by claim-to-fill (the fill is gated on a live claim), so the ban applies only
  // in [V13, V17). Below V17 this is byte-identical to the original gate.
  if (height >= V13_HEIGHT && height < V17_HEIGHT && !wantIsToken && rec.taker === undefined) return "v1.3: CSD-priced offers must be taker-bound (use bid/RFQ)";
  if ((rec.want.payto ?? who).toLowerCase() === TREASURY_ADDR) return "payto cannot be the protocol treasury";
  // expiresEpoch is an unbounded on-chain u64; one ≥ 2^53 is stored verbatim into the OPEN
  // offer's canonical state and serializes as the JS-specific "1e+21"/loses precision,
  // forking sha256(canonicalState) vs a u64/decimal resolver (audit M1). No live offer is
  // anywhere near 2^53 (max ~1e5), so rejecting the unrepresentable range is replay-identical.
  if (!Number.isSafeInteger(expiresEpoch)) return "expiresEpoch out of safe-integer range";
  if (epochOf(height) > expiresEpoch) return "already expired at anchor";
  // v2.1 duration cap, gated to the [V21,V22) era only; v2.2 (anchor >= V22) removes it (UI-only policy).
  if (height >= V21_HEIGHT && height < V22_HEIGHT && expiresEpoch - epochOf(height) > MAX_OFFER_EPOCHS) return "v2.1: offer duration exceeds the max";
  if (isNameGive(rec.give) && height < V11_HEIGHT) return "name offers need v1.1";
  return null;
}
