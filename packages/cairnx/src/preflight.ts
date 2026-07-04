// preflight.ts — the shared "before you sign a value-bearing tx" surface (deep-review 2026-07-03 Tier 1).
//
// The substrate has NO escrow: a `paidTo` output is a real irreversible transfer the resolver only READS
// to decide validity, so any value tx consensus later REJECTS has already moved the money and it is lost.
// The whole value-handling correctness of the app layer is therefore "never broadcast a doomed value tx".
// Historically each client grew its own bespoke guard (or none), which is exactly how the C1/C2/C3/C4
// loss classes reached the wallet's own `fillOffer`, the SDK `buildFillTx`, and third-party dApps while
// the official website was protected. These pure functions are the ONE place that math lives, so every
// value-bearing builder inherits loss-safety by calling a helper instead of re-deriving a guard.
//
// EVERY function here is a deterministic function of the offer/name record fields (never of a resolver
// boolean), so even a resolver that returns a wrong `status`/`owner` to induce a loss cannot walk a caller
// into one — the caller recomputes the verdict from the record itself. They add NO new canonical state and
// change NO serialization, so replay is byte-identical (additive exports; no gate, no re-pin).
//
// The math mirrors resolve.ts EXACTLY (the partial-fill pro-rata floor at resolve.ts:640-668, the whole-fill
// value gate at :672-728, the open-CSD claim gate `openFillReject` at :166-171, and the freeze arithmetic
// behind registration finalize). The conformance vectors pin that they cannot drift (test/preflight.test.ts
// asserts previewFill == the resolver's own delivered `got` at the C3 boundary).
import {
  FEE_BPS, V13_HEIGHT, V16_HEIGHT, V17_HEIGHT,
  tradeFee, makerRebate, claimGraceOf, isNameGive, isTokenWant,
  type OfferState, type NameState,
} from "./types.js";

/** What a payment of `pay` (base units of CSD, the seller-paid amount to `want.payto`) would DELIVER
 *  against a CSD-priced offer, computed with the resolver's exact expressions. Returns the delivered
 *  token `got`, the treasury `fee`, and the maker `rebate` — plus a `deliverable` flag that is false
 *  exactly when the resolver would reject the fill AFTER the CSD moved (the C3 zero-delivery trap).
 *
 *  Only meaningful for CSD-priced token offers (a `want.value`). For a name give, `got` is 1 (a name is
 *  indivisible) when `pay >= want.value`. Token-for-token offers (`want.ticker`) return deliverable:false
 *  with reason "not-csd-priced" — their deliverability depends on the buyer's balance, out of scope here. */
export interface FillPreview {
  deliverable: boolean;
  reason?: "not-open" | "not-csd-priced" | "below-min" | "zero-delivery" | "ok";
  got: bigint;          // tokens delivered (or 1n for a name); 0n when not deliverable
  pay: bigint;          // the effective payment applied (overpayment clamped to the remainder)
  fee: bigint;          // treasury fee the SAME tx must also pay
  rebate: bigint;       // maker rebate the SAME tx must also pay (resting-liquidity lanes only)
}

/** Preview a fill of `offer` paying `payRaw` CSD base units to the seller. Pure; no I/O. */
export function previewFill(offer: OfferState, payRaw: bigint | string | number): FillPreview {
  const pay = BigInt(payRaw);
  const zero: FillPreview = { deliverable: false, got: 0n, pay: 0n, fee: 0n, rebate: 0n };
  if (offer.status !== "open") return { ...zero, reason: "not-open" };
  // token-for-token: deliverability is the buyer's want-token balance, not computable from the offer alone
  if (isTokenWant(offer.want)) return { ...zero, reason: "not-csd-priced" };
  const want = BigInt((offer.want as { value: string }).value);
  const feeBps = offer.feeBps || FEE_BPS;

  // ── partial CSD-priced token offer (resolve.ts:631-670) ──
  if (offer.min !== undefined && !isNameGive(offer.give)) {
    const paidSoFar = BigInt(offer.paid ?? "0");
    const remaining = want - paidSoFar;
    const minV = BigInt(offer.min);
    const effMin = remaining < minV ? remaining : minV;     // the tail is always buyable
    if (pay < effMin) return { ...zero, reason: "below-min" };
    const x = pay < remaining ? pay : remaining;            // overpayment clamped
    const fee = feeBps ? tradeFee(x, feeBps) : 0n;          // partials carry NO maker rebate
    const giveTotal = BigInt((offer.give as { amount: string }).amount);
    const newPaid = paidSoFar + x;
    const deliveredSoFar = BigInt(offer.delivered ?? "0");
    const out = (giveTotal * newPaid) / want - deliveredSoFar;   // cumulative pro-rata floor
    if (out === 0n) return { deliverable: false, reason: "zero-delivery", got: 0n, pay: x, fee, rebate: 0n };
    return { deliverable: true, reason: "ok", got: out, pay: x, fee, rebate: 0n };
  }

  // ── whole fill (name or token), resolve.ts:672-728 ──
  if (pay < want) return { deliverable: false, reason: "below-min", got: 0n, pay, fee: 0n, rebate: 0n };
  const fee = feeBps ? tradeFee(want, feeBps) : 0n;
  // maker rebate — RESTING-LIQUIDITY lanes only (a taker-bound bid answer, or a v1.7 open ask)
  const restingLiquidity = (offer.taker !== undefined && offer.bid !== undefined) || (offer.height >= V17_HEIGHT && offer.taker === undefined);
  const rebate = (offer.height >= V16_HEIGHT && restingLiquidity) ? makerRebate(want) : 0n;
  const got = isNameGive(offer.give) ? 1n : BigInt((offer.give as { amount: string }).amount);
  return { deliverable: true, reason: "ok", got, pay: want, fee, rebate };
}

/** Is the offer an OPEN (untaken) CSD-priced offer subject to the v1.7 claim-to-fill gate at `tip`?
 *  Such an offer may be filled ONLY by the holder of a LIVE claim (resolve.ts openFillReject:166-171). */
export function isOpenClaimLane(offer: OfferState, tip: number): boolean {
  return tip >= V13_HEIGHT && offer.taker === undefined && !isTokenWant(offer.want);
}

/** Does `me` currently hold a LIVE claim on `offer` at `tip`? Mirrors resolve.ts claimHeld + the
 *  who===claimedBy check (:160-169). For a pre-V17 open offer, open fills are banned entirely. */
export function hasLiveClaim(offer: OfferState, me: string, tip: number): boolean {
  if (tip < V17_HEIGHT) return false;
  if (offer.claimedBy === undefined || offer.claimUntilHeight === undefined) return false;
  if (offer.claimedBy.toLowerCase() !== me.toLowerCase()) return false;
  const grace = claimGraceOf(offer.claimUntilHeight);
  return tip < offer.claimUntilHeight + grace;
}

/** The union verdict a client must clear BEFORE signing a fill of `offer` paying `pay`, as `me`, at `tip`.
 *  Closes C2/C3/C4: status open, deliverability >= 1 token, live-claim holdership for the open-CSD lane,
 *  and taker match. `safe:true` ⇒ the fill is guaranteed to be accepted by the deterministic gates a
 *  payer can verify at signing time (the irreducible timing residual — CLAIM_FILL_GRACE_BLOCKS late mine
 *  — is documented, not closable by a preflight). Returns the preview so the caller can size outputs. */
export interface FillSafety { safe: boolean; reason: string; preview: FillPreview }
export function fillIsSafe(offer: OfferState, me: string, pay: bigint | string | number, tip: number): FillSafety {
  const preview = previewFill(offer, pay);
  if (offer.status !== "open") return { safe: false, reason: `offer is ${offer.status}`, preview };
  if (offer.taker !== undefined && offer.taker.toLowerCase() !== me.toLowerCase())
    return { safe: false, reason: "taker-bound offer — not bound to you", preview };
  // open CSD lane: only the live claimant may fill (else the full payment is lost, C2/C4)
  if (isOpenClaimLane(offer, tip) && !hasLiveClaim(offer, me, tip))
    return { safe: false, reason: "open CSD offer — claim it first and fill while your claim is live", preview };
  if (isTokenWant(offer.want)) return { safe: true, reason: "token-priced — deliverability is the buyer's balance", preview };
  if (!preview.deliverable) {
    if (preview.reason === "below-min") return { safe: false, reason: "payment is below the offer minimum", preview };
    return { safe: false, reason: "this payment would deliver 0 tokens — refusing (the CSD would be lost)", preview };
  }
  return { safe: true, reason: "ok", preview };
}

/** C1: may `me` safely sign the fee-bearing registration `nfinalize` for `nameState` committed at
 *  `commitHeight`? The reg fee rides nfinalize; a finalize on a reservation that was displaced or has
 *  expired is REJECTED after the fee moved (a burn). Sound by the freeze arithmetic: once a client waits
 *  for `tip > effectiveHeight + REG_COMMIT_MAX_BLOCKS` (which the UI's finalizeReady already enforces) no
 *  new displacer can appear, so a re-fetch showing "still my live pending reservation at my commit height"
 *  guarantees the finalize lands. Pass the AUTHORITATIVE (freshly re-fetched) name record — never a cached
 *  one — as `nameState` (undefined = the resolver returns 404 / unregistered, which is a definitive loss). */
export function finalizeWinnerCheck(
  nameState: NameState | null | undefined,
  me: string,
  commitHeight: number,
): { safe: boolean; reason: string } {
  const m = me.toLowerCase();
  if (!nameState) return { safe: false, reason: "no reservation on-chain (displaced, swept, or never accepted) — a finalize now would burn the fee" };
  if (nameState.owner?.toLowerCase() !== m) return { safe: false, reason: "an earlier committer won this name — you were outbid" };
  // already finalized to us: no second fee is needed (idempotent safety)
  if (nameState.pending !== true) return { safe: false, reason: "already registered to you — no second finalize fee is needed" };
  if (Number(nameState.effectiveHeight) !== Number(commitHeight))
    return { safe: false, reason: "your reservation was displaced (effective height changed) — a finalize now would burn the fee" };
  return { safe: true, reason: "ok" };
}
