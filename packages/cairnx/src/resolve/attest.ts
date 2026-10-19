// Attest events on a CairnX offer or bid: cancel (score 0), the three fill paths (score 100) and the
// v1.7 legacy claim (score 50), plus the v2.8 routing of a fill that attests an fclaim txid.
import {
  CLAIM_COOLDOWN_BLOCKS, CONF_TOKEN_FILL, MAX_ACTIVE_CLAIMS, SCORE_CANCEL, SCORE_CLAIM, SCORE_FILL, TREASURY_ADDR,
  V13_HEIGHT, V14_HEIGHT, V16_HEIGHT, V17_HEIGHT, V28_HEIGHT, V29_HEIGHT, claimWindowAt, isNameGive, isTokenWant,
  makerRebate, tradeFee,
  type AttestEvent, type OfferState,
} from "../types.js";
import { claimGrace, claimHeld, ptAmt, type NameRec, type ResolveCtx } from "./context.js";

type TokenWantOffer = OfferState & { want: { ticker: string; amount: string; payto: string } };
type PartialFillOffer = OfferState & { give: { ticker: string; amount: string }; min: string };

// ── shared SCORE_FILL helpers (dedup of the three fill paths — behaviour-preserving) ──
// v1.7 open-fill gate: an untaken CSD offer (≥V13) is fillable only by the holder of a live claim;
// in [V13,V17) open CSD fills stay banned. Returns the rejection reason, or undefined if allowed.
const openFillReject = (o: OfferState, height: number, who: string, targetId: string): string | undefined => {
  if (!(height >= V13_HEIGHT && !o.taker)) return undefined;
  if (height < V17_HEIGHT) return "v1.3: open CSD-quoted fills disabled (offer must be taker-bound)";
  // v2.8 Correction 1 (§31): during an fclaim hold the payment MUST attest the FCLAIM txid, not the offer id
  // (whose L0 deadline is the offer's far-off expiry). An offer-txid fill (targetId === o.id) is rejected; an
  // fclaim fill routes here with targetId === o.claimTxid !== o.id, so it is admitted by the hold check below.
  if (height >= V28_HEIGHT && o.claimTxid !== undefined && targetId === o.id) return "v2.8: fill the fclaim txid, not the offer";
  if (!(claimHeld(o, height) && who === o.claimedBy)) return "v1.7: open offer — claim it first (no live claim by you)";
  return undefined;
};
// a name sale (CSD or token fill) transfers ownership to the buyer, clears addr+profile, and — v1.3+ —
// re-stamps the anchor to the fill itself with displacement-immune viaFill (red-team H3).
const deliverNameToBuyer = (n: NameRec, who: string, ev: { height: number; pos: number; txid: string }) => {
  n.owner = who; n.locked = false; n.addr = undefined; n.profile = undefined; // sale clears the profile (doc 36)
  if (ev.height >= V13_HEIGHT) { n.effHeight = ev.height; n.pos = ev.pos; n.id = ev.txid; n.height = ev.height; n.viaFill = true; }
};

// ── attest: fill (score=100) / cancel (score=0) on a CairnX offer or bid ──
export function applyAttest(c: ResolveCtx, ev: AttestEvent): void {
  const { offers, fclaims, bids, note, setBidStatus } = c;
  const who = ev.attester.toLowerCase();
  let o = offers.get(ev.proposalId);
  // v2.8 fclaim fill routing (§31): a SCORE_FILL on a GRANTED fclaim txid targets the fclaim's linked offer
  // (the fclaim txid is not in `offers`). Resolving `o` to the linked offer routes the payment through the
  // SAME §4/§19 machinery; openFillReject sees targetId === o.claimTxid !== o.id, so Correction 1 ADMITS this
  // path while still blocking an offer-txid fill during the hold.
  if (!o && ev.height >= V28_HEIGHT && ev.score === SCORE_FILL) {
    const fc = fclaims.get(ev.proposalId);
    if (fc && fc.granted) {
      const linked = offers.get(fc.offer);
      if (linked && linked.claimTxid === ev.proposalId) o = linked;
    }
  }
  if (!o) {
    // v2.8: a SCORE_FILL on a KNOWN but DENIED/ungranted fclaim mines on L0 yet delivers nothing (a burn);
    // note it so the money-safety audit flags the pay-without-delivery. (An unrelated attest is a no-op.)
    if (ev.height >= V28_HEIGHT && ev.score === SCORE_FILL && fclaims.has(ev.proposalId)) {
      note(ev, ev.txid, "fill", false, "fclaim not current (denied or superseded): no delivery, denied-fclaim fill");
      return;
    }
    // v1.2: bids are proposals too — the bidder cancels with score=0
    const b = bids.get(ev.proposalId);
    if (b && ev.score === SCORE_CANCEL) {
      if (who !== b.bidder) { note(ev, ev.txid, "bidcancel", false, "only bidder may cancel"); return; }
      if (b.status !== "open") { note(ev, ev.txid, "bidcancel", false, `bid ${b.status}`); return; }
      setBidStatus(b, "cancelled");
      note(ev, ev.txid, "bidcancel", true);
    }
    return; // attest on a non-CairnX proposal — not our event
  }

  if (ev.score === SCORE_CANCEL) applyCancel(c, ev, o, who);
  else if (ev.score === SCORE_FILL && isTokenWant(o.want)) applyTokenFill(c, ev, o as TokenWantOffer, who);
  else if (ev.score === SCORE_FILL && o.min !== undefined && !isNameGive(o.give)) applyPartialFill(c, ev, o as PartialFillOffer, who);
  else if (ev.score === SCORE_FILL) applyFill(c, ev, o, who);
  else if (ev.height >= V17_HEIGHT && ev.score === SCORE_CLAIM) applyLegacyClaim(c, ev, o, who);
  // other scores: reserved → no-op
}

function applyCancel(c: ResolveCtx, ev: AttestEvent, o: OfferState, who: string): void {
  const { note, releaseGive, setOfferStatus } = c;
  if (who !== o.seller) { note(ev, ev.txid, "cancel", false, "only seller may cancel"); return; }
  if (o.status !== "open") { note(ev, ev.txid, "cancel", false, `offer ${o.status}`); return; }
  if (o.taker !== undefined && o.height >= V28_HEIGHT) { note(ev, ev.txid, "cancel", false, "v2.8: taker-bound offers are firm quotes (uncancellable)"); return; } // Lane B
  if (ev.height >= V14_HEIGHT) {
    // v1.4: defer the effect to the block boundary — a same-block fill wins (anti-snipe)
    c.pendingCancels.push(() => {
      // v2.8 Correction 2: freeze a live fclaim hold (keyed on the cancel's own ev.height, live-read on o).
      if (ev.height >= V28_HEIGHT && o.claimTxid !== undefined && claimHeld(o, ev.height)) { note(ev, ev.txid, "cancel", false, "v2.8: frozen (fclaim hold live)"); return; }
      if (o.status === "open") { releaseGive(o); setOfferStatus(o, "cancelled"); note(ev, ev.txid, "cancel", true); }
      else note(ev, ev.txid, "cancel", false, "superseded by same-block fill (v1.4)");
    });
  } else {
    releaseGive(o); setOfferStatus(o, "cancelled");
    note(ev, ev.txid, "cancel", true);
  }
}

function applyTokenFill(c: ResolveCtx, ev: AttestEvent, o: TokenWantOffer, who: string): void {
  const { tokens, names, offerLock, bal, note, setOfferStatus, markBidDone, releaseGiveLock } = c;
  // ── v1.2 token-priced fill: the attester's want-tokens pay for the give ──
  if (o.status !== "open") { note(ev, ev.txid, "fill", false, `offer ${o.status}`); return; }
  if (o.taker && who !== o.taker) { note(ev, ev.txid, "fill", false, "taker-bound offer"); return; }
  // explicit opt-in marker: a plain signaling attest must never spend the attester's tokens
  if (ev.confidence !== CONF_TOKEN_FILL) { note(ev, ev.txid, "fill", false, "token fill requires confidence marker"); return; }
  if (!tokens.has(o.want.ticker)) { note(ev, ev.txid, "fill", false, "want ticker does not exist"); return; }
  const amt = BigInt(o.want.amount);
  const fee = o.feeBps ? tradeFee(amt, o.feeBps) : 0n; // in kind, debited convention-side (1.5% for v1.6 offers)
  const buyer = bal(o.want.ticker, who);
  if (buyer.available < amt + fee) { note(ev, ev.txid, "fill", false, "insufficient want-token balance"); return; }
  // validate the give side BEFORE any mutation (check-then-act: a defensive no-op here
  // must not leave the buyer debited with nothing delivered)
  const giveName = isNameGive(o.give) ? names.get(o.give.name) : undefined;
  if (isNameGive(o.give) && !giveName) { note(ev, ev.txid, "fill", false, "name vanished (consensus violation)"); return; }
  const giveLock = isNameGive(o.give) ? undefined : offerLock.get(o.id);
  if (!isNameGive(o.give) && giveLock === undefined) { note(ev, ev.txid, "fill", false, "offer lock missing"); return; }
  // atomic swap: debit buyer, credit payto + treasury, deliver give to buyer
  buyer.available -= amt + fee;
  bal(o.want.ticker, o.want.payto).available += amt;
  if (fee > 0n) bal(o.want.ticker, TREASURY_ADDR).available += fee;
  if (isNameGive(o.give)) deliverNameToBuyer(giveName!, who, ev);
  else releaseGiveLock(o, who, giveLock!);
  setOfferStatus(o, "filled");
  o.fill = { buyer: who, txid: ev.txid, height: ev.height, paid: amt.toString(), fee: fee.toString() };
  markBidDone(o, who);
  note(ev, ev.txid, "fill", true);
}

function applyPartialFill(c: ResolveCtx, ev: AttestEvent, o: PartialFillOffer, who: string): void {
  const { offerLock, bal, note, setOfferStatus, markBidDone } = c;
  // ── v1.2 partial fill (CSD-priced token offer): payment X buys pro-rata, maker-favoring ──
  if (o.status !== "open") { note(ev, ev.txid, "fill", false, `offer ${o.status}`); return; }
  if (o.taker && who !== o.taker) { note(ev, ev.txid, "fill", false, "taker-bound offer"); return; }
  // v1.7: an open (non-taker) offer is fillable — but ONLY by the holder of a LIVE claim (the
  // claim-to-fill race-safety). In [V13, V17) open CSD fills stay banned (byte-identical to v1.3).
  const blk = openFillReject(o, ev.height, who, ev.proposalId);
  if (blk) { note(ev, ev.txid, "fill", false, blk); return; }
  const pt = ev.paidTo ?? {};
  const want = BigInt((o.want as { value: string }).value);
  const paidSoFar = BigInt(o.paid ?? "0");
  const remaining = want - paidSoFar;
  const X = ptAmt(pt[o.want.payto]);
  const minV = BigInt(o.min);
  const effMin = remaining < minV ? remaining : minV;   // the tail is always buyable
  if (X < effMin) { note(ev, ev.txid, "fill", false, "payment below offer min"); return; }
  const x = X < remaining ? X : remaining;              // overpayment is clamped
  const fee = o.feeBps ? tradeFee(x, o.feeBps) : 0n;    // 1.5% for v1.6 offers (partial fills carry NO maker rebate in v1.6)
  if (ptAmt(pt[TREASURY_ADDR]) < fee) { note(ev, ev.txid, "fill", false, "protocol fee unpaid"); return; }
  const giveTotal = BigInt((o.give as { amount: string }).amount);
  const newPaid = paidSoFar + x;
  const deliveredSoFar = BigInt(o.delivered ?? "0");
  // cumulative pro-rata floor: never oversells, and the final fill delivers the exact remainder
  const newDelivered = (giveTotal * newPaid) / want;
  const out = newDelivered - deliveredSoFar;
  if (out === 0n) { note(ev, ev.txid, "fill", false, "fill too small to deliver any tokens"); return; }
  const lock = offerLock.get(o.id);
  if (lock === undefined) { note(ev, ev.txid, "fill", false, "offer lock missing"); return; }
  bal(o.give.ticker, o.seller).locked -= out;
  bal(o.give.ticker, who).available += out;
  offerLock.set(o.id, lock - out);
  o.paid = newPaid.toString(); o.delivered = newDelivered.toString();
  const entry = { buyer: who, txid: ev.txid, height: ev.height, paid: x.toString(), fee: fee.toString(), got: out.toString() };
  (o.fills ??= []).push(entry);
  c.feesPaid += fee;
  if (newPaid === want) {
    setOfferStatus(o, "filled"); o.fill = entry; offerLock.delete(o.id);
    markBidDone(o, who);
  }
  note(ev, ev.txid, "fill", true, `partial ${x}/${want}`);
}

function applyFill(c: ResolveCtx, ev: AttestEvent, o: OfferState, who: string): void {
  const { names, offerLock, note, setOfferStatus, markBidDone, releaseGiveLock } = c;
  if (o.status !== "open") { note(ev, ev.txid, "fill", false, `offer ${o.status}`); return; }
  if (o.taker && who !== o.taker) { note(ev, ev.txid, "fill", false, "taker-bound offer"); return; }
  // v1.7: an open (non-taker) offer is fillable — but ONLY by the holder of a LIVE claim (the
  // claim-to-fill race-safety). In [V13, V17) open CSD fills stay banned (byte-identical to v1.3).
  const blk = openFillReject(o, ev.height, who, ev.proposalId);
  if (blk) { note(ev, ev.txid, "fill", false, blk); return; }
  const pt = ev.paidTo ?? {};
  const want = BigInt((o.want as { value: string }).value);
  const fee = o.feeBps ? tradeFee(want, o.feeBps) : 0n;
  // v1.6 maker rebate on a BID-ANSWERED whole fill (the RFQ/MM lane): the taker pays the maker
  // o.seller a flat 0.25 CSD + 0.5%, reimbursing the maker's posting (propose) cost. DERIVED from
  // the offer's creation height + bid link — NO new stored field, so every pre-v1.6 offer's
  // canonical state is byte-identical. (Partial fills + token⇄token carry no rebate in v1.6.)
  // maker rebate — RESTING-LIQUIDITY lanes only: a TAKER-BOUND answer to a bid (the v1.6 RFQ/MM
  // lane) OR a v1.7 OPEN ask (claim-to-fill, no taker). Closes a red-team finding (MED-2): keying
  // on `bid` alone let a maker self-attach an unanchored bid to an OPEN offer and self-mint a rebate.
  // Now an open offer earns it via the open-ask lane regardless of `bid`, and a bid-answer rebate
  // requires a real consenting taker (self-dealing is net-negative). Replay-identical in [V16,V17):
  // every bid-answered CSD offer there was taker-bound (the v1.3 ban), so `taker && bid` == `bid`.
  const restingLiquidity = (o.taker !== undefined && o.bid !== undefined) || (o.height >= V17_HEIGHT && o.taker === undefined);
  const rebate = (o.height >= V16_HEIGHT && restingLiquidity) ? makerRebate(want) : 0n;
  // combined same-tx output gate: SUM the required amount per recipient, so payto==o.seller (the
  // common case — a maker's payto defaults to itself) is correct: paidTo is an addr→sum map, so
  // the price and the rebate landing on the same address must be checked against their SUM, never
  // satisfied by max(). (payto can never be the treasury — rejected at offer creation — so those
  // two never collide.) For a pre-v1.6 offer (rebate=0n) this reduces to the old two checks exactly.
  const need = new Map<string, bigint>();
  const addNeed = (a: string, v: bigint) => need.set(a, (need.get(a) ?? 0n) + v);
  addNeed(o.want.payto, want);            // seller payment
  addNeed(TREASURY_ADDR, fee);            // treasury fee
  if (rebate > 0n) addNeed(o.seller, rebate); // v1.6 maker rebate
  // ACCUMULATE (not a Map literal): if any two recipients ever coincide (e.g. payto==seller, the
  // common case; or a hypothetical payto==treasury) the required amounts SUM — a literal would
  // silently overwrite and drop one, letting a fill underpay. Defense-in-depth on the value gate.
  let unpaid: string | undefined;
  for (const [addr, amt] of need) if (ptAmt(pt[addr]) < amt) {
    unpaid = addr === TREASURY_ADDR ? "protocol fee unpaid" : (rebate > 0n && addr === o.seller) ? "maker rebate unpaid (v1.6)" : "payment below want.value";
    break;
  }
  if (unpaid) { note(ev, ev.txid, "fill", false, unpaid); return; }
  const paid = ptAmt(pt[o.want.payto]);
  // deliver the asset to the buyer
  if (isNameGive(o.give)) {
    const n = names.get(o.give.name);
    if (!n) { note(ev, ev.txid, "fill", false, "name vanished (consensus violation)"); return; }
    deliverNameToBuyer(n, who, ev);
  } else {
    const amt = offerLock.get(o.id);
    if (amt === undefined) { note(ev, ev.txid, "fill", false, "offer lock missing"); return; }
    releaseGiveLock(o, who, amt);
  }
  c.feesPaid += fee;
  setOfferStatus(o, "filled");
  o.fill = { buyer: who, txid: ev.txid, height: ev.height, paid: paid.toString(), fee: fee.toString() };
  markBidDone(o, who);
  note(ev, ev.txid, "fill", true);
}

function applyLegacyClaim(c: ResolveCtx, ev: AttestEvent, o: OfferState, who: string): void {
  const { offers, note } = c;
  // v2.8 (§31): at V28+ the legacy claim attest is REJECTED (claims are fclaim proposals now) so a stale
  // wallet's claim is diagnosable. A pre-V28 live hold still honors legacy fills until it lapses (the
  // sunset); this only stops NEW legacy claims. No height literal is needed in the fill predicate.
  if (ev.height >= V28_HEIGHT) { note(ev, ev.txid, "claim", false, "v2.8: claims are fclaim proposals now"); return; }
  // ── v1.7 claim-to-fill: reserve an OPEN CSD offer for the FIRST claimer (consensus order) for
  // CLAIM_WINDOW_BLOCKS. Payment-free → a losing same-block claimer forfeits only the attest fee,
  // never a payment. Only the live claimer may fill (enforced in the fill paths above). ──
  if (o.status !== "open") { note(ev, ev.txid, "claim", false, `offer ${o.status}`); return; }
  if (o.taker) { note(ev, ev.txid, "claim", false, "taker-bound offer needs no claim"); return; }
  if (isTokenWant(o.want)) { note(ev, ev.txid, "claim", false, "claims are for CSD-priced offers (token offers are no-op-safe)"); return; }
  if (claimHeld(o, ev.height)) { note(ev, ev.txid, "claim", false, "offer already claimed (hold live)"); return; }
  // anti-recycle: the JUST-LAPSED claimer cannot immediately re-grab the SAME offer (anyone else can).
  // KNOWN BOUND (intentional — identical in cairnx_ref.py, so NOT a cross-impl fork): the cooldown keys
  // on being the LAST claimer (o.claimedBy === who), so an intervening claim by a 2nd address resets it
  // and a colluding A→B→A pair can recycle one offer. Bounded by MAX_ACTIVE_CLAIMS + the claim being
  // payment-free → a griefing/liveness nuisance on a SINGLE offer, never value loss. Revisit (key the
  // cooldown on the offer, not the last claimer) if the open lane re-opens with a monopoly concern.
  // cooldown runs from the END of the hold (window + grace), so the grace can't be used to dodge it.
  if (o.claimedBy === who && o.claimUntilHeight !== undefined && ev.height < o.claimUntilHeight + claimGrace(o) + CLAIM_COOLDOWN_BLOCKS) {
    note(ev, ev.txid, "claim", false, "claim cooldown (you just held this offer)"); return;
  }
  // per-address concurrent-claim cap (anti-squat): count offers this attester still HOLDS (window+grace),
  // so the V20 grace can't expand an address's effective concurrent reach past the cap.
  // v2.9 (§32, V29 / REBIND M5): the SAME open-holds-only correction as the fclaim cap loop (market.ts), kept
  // symmetric so the two identical loops stay identical. NOTE it is INERT on this legacy-claim path: a
  // SCORE_CLAIM at ev.height >= V28 is already rejected above (the §31 sunset), and V29 > V28, so `ev.height
  // >= V29_HEIGHT` can NEVER be true here -> the added clause always reduces to the pre-V29 count. Kept for
  // symmetry + defense-in-depth (a future un-sunset of legacy claims would inherit the fix, not the bug).
  let liveN = 0; for (const x of offers.values()) if (x.claimedBy === who && claimHeld(x, ev.height) && (ev.height < V29_HEIGHT || x.status === "open")) liveN++;
  if (liveN >= MAX_ACTIVE_CLAIMS) { note(ev, ev.txid, "claim", false, `max ${MAX_ACTIVE_CLAIMS} live claims per address`); return; }
  // grant. No expiry-clamp needed: a claim past the offer's expiry is moot (sweepExpired sets the
  // offer expired and a fill on a non-open offer is rejected) — the expiry always beats the claim.
  o.claimedBy = who; o.claimUntilHeight = ev.height + claimWindowAt(ev.height);
  note(ev, ev.txid, "claim", true);
}
