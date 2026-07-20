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
//
// FETCH POSTURE (the caller's half of the contract, M-MKT-5): these helpers judge a record you HAND them,
// so what you do when the record cannot be fetched is part of the safety story. Before signing a fill,
// FAIL CLOSED unless the resolver POSITIVELY answers with a parseable open offer: a clean 404 (a valid L1
// proposal that is not a CairnX offer) and a 200 without a parseable `status` both mean the resolver will
// NOT settle the fill — the payment moves on L1 and burns. Refuse with retryable copy (a brand-new offer
// appears after the resolver's next scan, ~15s); never treat "no data" as "safe to proceed".
import {
  V13_HEIGHT, V16_HEIGHT, V17_HEIGHT, V18_HEIGHT, V24_HEIGHT, V28_HEIGHT, TREASURY_ADDR,
  REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, FINALIZE_TIP_MARGIN,
  CONF_TOKEN_FILL,
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
  // the offer's OWN stamped feeBps, verbatim: the resolver stamps 0 on pre-v1.1 offers and charges NO
  // fee on them (`o.feeBps ? tradeFee(...) : 0n`), so a fallback constant here would quote a fee the
  // chain does not require. The `feeBps ? … : 0n` guards below mirror the resolver's falsy-means-free.
  const feeBps = offer.feeBps;

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

/** The exact CSD outputs a fill of `offer` paying `payRaw` must carry to clear the resolver's value
 *  gate — the addr→sum map of resolve.ts:699-712 (whole: payto + treasury fee + maker rebate) and
 *  :643-649 (partial: clamped payment + fee on the clamped amount, NO rebate), as a build-ready output
 *  list. Amounts are ACCUMULATED per address (payto === seller is the common case; the resolver checks
 *  the per-address SUM, so two merged entries must merge here too), insertion order payto → treasury →
 *  seller, zero-value entries omitted (a 0 output is unbuildable and the resolver requires nothing).
 *
 *  Returns [] for a token-priced offer (a token⇄token fill carries NO CSD outputs) and null when the
 *  payment is undeliverable — gate with fillIsSafe FIRST; this sizes outputs, it does not re-judge
 *  claims/takers. Until 2026-07-06 this map was hand-mirrored in the wallet's fillOffer, the cairnx
 *  service txbuild, and TWICE in the cairn trade UI — four copies of fund-loss-class math with no
 *  cross-repo lock. This is now the only place it lives; test/preflight.test.ts pins it against the
 *  real resolver (outputs accepted; any single-unit per-address underpayment refused).
 *
 *  DOC CORRECTION (B6b / REBIND M1) — the `[]` vs `null` asymmetry is a live hazard, not a convenience:
 *  `[]` (token want) means "no CSD outputs are required", it does NOT mean "this fill is checked". Every
 *  caller whose safety loop is `for (const o of outs) ...` iterates ZERO times on a token fill and passes
 *  silently, while the undeliverable-CSD case (`null`) is explicitly refused. That asymmetry is the
 *  mechanical reason the token-fill hole (W1) propagated to every consumer. The token side of a fill is
 *  settled from the ATTESTER's token balance and carries the CONF_TOKEN_FILL confidence marker; nothing
 *  in this return value verifies any of that.
 *  @deprecated Use `fillOutputPlan` - it returns the same math behind a DISCRIMINATED result, so the
 *  token-want case cannot be silently conflated with "nothing to check". This function's behavior is
 *  FROZEN (published npm API; `[]` is load-bearing in downstream builders and tests) and it will keep
 *  working; new callers should not add to the need-map-loop hazard. */
export function requiredFillOutputs(
  offer: OfferState,
  payRaw: bigint | string | number,
): { to: string; value: bigint }[] | null {
  if (isTokenWant(offer.want)) return [];
  const p = previewFill(offer, payRaw);
  if (!p.deliverable) return null;
  const need = new Map<string, bigint>();
  const add = (a: string, v: bigint) => { if (v > 0n) { const k = a.toLowerCase(); need.set(k, (need.get(k) ?? 0n) + v); } };
  add((offer.want as { payto: string }).payto, p.pay);
  add(TREASURY_ADDR, p.fee);
  add(offer.seller, p.rebate);
  return [...need].map(([to, value]) => ({ to, value }));
}

/** B6b (REBIND M1): the DISCRIMINATED successor to requiredFillOutputs. Same math (it calls
 *  requiredFillOutputs - the addr->sum map still lives in exactly one place); the difference is that the
 *  three outcomes a caller must treat differently are now three distinct kinds instead of `[] | null`:
 *    "csd-outputs"   - build EXACTLY these CSD outputs (payto + treasury fee + maker rebate, merged per
 *                      address). The normal CSD-priced case.
 *    "token-settled" - a token-priced offer: there are NO CSD outputs to build, and that is NOT the same
 *                      as "checked". The fill debits the ATTESTER's want-token balance and the attest MUST
 *                      carry `confidence` (= CONF_TOKEN_FILL, resolve.ts requires the explicit marker).
 *                      Verify your token balance and terms yourself before signing.
 *    "undeliverable" - the resolver would reject this payment AFTER the CSD moved; do not sign.
 *  ADDITIVE and default-safe: requiredFillOutputs is unchanged in behavior (its `[]` is load-bearing in
 *  published consumers); this wrapper only makes the pivot impossible to fall through silently. */
export type FillOutputPlan =
  | { kind: "csd-outputs"; outputs: { to: string; value: bigint }[]; preview: FillPreview }
  | { kind: "token-settled"; outputs: []; confidence: number; preview: FillPreview }
  | { kind: "undeliverable"; reason: "not-open" | "not-csd-priced" | "below-min" | "zero-delivery"; preview: FillPreview };
export function fillOutputPlan(offer: OfferState, payRaw: bigint | string | number): FillOutputPlan {
  const preview = previewFill(offer, payRaw);
  if (isTokenWant(offer.want)) {
    // token-priced: previewFill deliberately reports not-csd-priced; the offer being non-open is still a
    // hard refusal (an attest on a closed offer delivers nothing), so surface that before the token verdict.
    if (offer.status !== "open") return { kind: "undeliverable", reason: "not-open", preview };
    return { kind: "token-settled", outputs: [], confidence: CONF_TOKEN_FILL, preview };
  }
  if (!preview.deliverable) return { kind: "undeliverable", reason: preview.reason === "not-open" || preview.reason === "below-min" ? preview.reason : "zero-delivery", preview }; // MUTATE_PLAN_UNDELIVERABLE
  const outputs = requiredFillOutputs(offer, payRaw);
  if (outputs === null) return { kind: "undeliverable", reason: "zero-delivery", preview };   // defensive; same math as preview
  return { kind: "csd-outputs", outputs, preview };
}

/** Name-fee build heuristic (app-side, NOT a resolver rule): a name-fee OUTPUT built just below a fee
 *  gate but mined at/after it underpays the new tier → resolver rejects → the treasury-fee UTXO is
 *  forfeit. Within FEE_GATE_MARGIN_BLOCKS below ANY upcoming fee gate, price the BUILD at that gate:
 *  overpay is always accepted (the resolver gate is strict `<`), so this only ever PREVENTS a forfeit,
 *  never causes one. Display paths must pass the SAME buildFeeHeight(tip) so the quoted price matches
 *  what gets signed. Owns the gate list: a future fee tier (V28+) is added HERE, once — the wallet and
 *  the trade UI import this (they each hand-carried a copy of this function + list until 2026-07-06). */
export const FEE_GATE_MARGIN_BLOCKS = 5;
const NAME_FEE_GATES = [V18_HEIGHT, V24_HEIGHT];   // ascending name-fee activation heights
export const buildFeeHeight = (tip: number): number => {
  const t = Number(tip);
  for (const g of NAME_FEE_GATES) if (t < g && t >= g - FEE_GATE_MARGIN_BLOCKS) return g;
  return t;
};

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
  // claimTxid-aware: an fclaim hold (V28+) has grace 0 (its L0 deadline IS holdEnd), so the client and the
  // resolver agree on hold liveness. Passing offer.claimTxid keeps this in lockstep with resolve.ts claimGrace.
  const grace = claimGraceOf(offer.claimUntilHeight, offer.claimTxid);
  return tip < offer.claimUntilHeight + grace;
}

/** v2.8 Correction 1 mirror (§31): the proposal txid a fill of `offer` MUST attest at `tip`. During a live
 *  fclaim hold (V28+) the payment must target the FCLAIM txid, not the offer id (an offer-txid fill is
 *  resolver-rejected while a hold is live, `openFillReject`). Below V28, or with no live fclaim hold, the
 *  target is the offer id (legacy). A client builds the fill against this id so it never signs a doomed
 *  offer-txid fill during a hold. */
export function fillTargetId(offer: OfferState, tip: number): string {
  if (tip >= V28_HEIGHT && offer.claimTxid !== undefined && offer.claimUntilHeight !== undefined && tip < offer.claimUntilHeight) return offer.claimTxid;
  return offer.id;
}

/** The union verdict a client must clear BEFORE signing a fill of `offer` paying `pay`, as `me`, at `tip`.
 *  Closes C2/C3/C4: status open, deliverability >= 1 token, live-claim holdership for the open-CSD lane,
 *  and taker match. Returns the preview so the caller can size outputs.
 *
 *  DOC CORRECTION (B6b / REBIND W10) — the historical claim that `safe:true` means "the fill is guaranteed
 *  to be accepted by the deterministic gates a payer can verify at signing time" OVER-STATES this predicate
 *  on two counts, both live:
 *    1. For a TOKEN-priced want it returns `safe:true` unconditionally ("deliverability is the buyer's
 *       balance"). That is an honest statement of what it cannot see, but as a boolean it reads as an
 *       ENDORSEMENT of the un-verifiable path - the never-over-claim rule this codebase holds elsewhere.
 *    2. It never receives the FILL TARGET id, so it cannot implement the v2.8 Correction-1 clause: during
 *       a live fclaim hold the chain rejects an attest on the OFFER txid (the payment must attest the
 *       FCLAIM txid), and this predicate says `safe:true` for exactly that doomed fill.
 *  @deprecated Use `fillEndorsement` - a discriminated verdict ("endorsed" / "refused" / "not-endorsable")
 *  plus the `fillTargetId` parameter that closes both gaps. This function's verdicts are FROZEN (published
 *  npm API; flipping them could hard-refuse honest fills in unknowable third-party dApps) and it keeps
 *  working; it must not be "hardened" in place. */
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

/** B6b (REBIND W10): the DISCRIMINATED successor to fillIsSafe. Three verdicts, and consuming them
 *  correctly is part of the contract:
 *    "endorsed"       - every deterministic gate a payer can verify at signing time passes (status, taker,
 *                       open-lane holdership, deliverability, and - NEW - the v2.8 fill-target routing).
 *    "refused"        - the chain WILL reject this fill after the payment moved. Do not sign.
 *    "not-endorsable" - a TOKEN-priced want: deliverability is the attester's token balance, which this
 *                       pure predicate cannot see. This is HONEST NON-ENDORSEMENT, not refusal: proceed
 *                       with your own token-balance and proven-terms checks (a consumer that treats this
 *                       as "refuse" hard-blocks every honest token fill - the named B7f trap).
 *
 *  `opts.fillTargetId` is the proposal txid your attest will actually target. Pass it whenever you have
 *  it (= `fillTargetId(offer, tip)` for an honest builder). The v2.8 Correction-1 clause (resolve.ts
 *  openFillReject): during a live fclaim hold an attest on the OFFER txid is rejected while the payment
 *  still moves - the exact doomed fill the deprecated fillIsSafe endorses. If the offer carries a live
 *  fclaim-hold routing and no target is supplied, the endorsement fails CLOSED with instructions rather
 *  than guessing what your builder will attest. */
export type FillEndorsement =
  | { verdict: "endorsed"; reason: "ok"; preview: FillPreview }
  | { verdict: "refused"; reason: string; preview: FillPreview }
  | { verdict: "not-endorsable"; reason: string; preview: FillPreview };
export function fillEndorsement(
  offer: OfferState,
  me: string,
  pay: bigint | string | number,
  tip: number,
  opts?: { fillTargetId?: string },
): FillEndorsement {
  const preview = previewFill(offer, pay);
  const refuse = (reason: string): FillEndorsement => ({ verdict: "refused", reason, preview });
  if (offer.status !== "open") return refuse(`offer is ${offer.status}`);
  if (offer.taker !== undefined && offer.taker.toLowerCase() !== me.toLowerCase())
    return refuse("taker-bound offer - not bound to you");
  if (isOpenClaimLane(offer, tip) && !hasLiveClaim(offer, me, tip))
    return refuse("open CSD offer - claim it first and fill while your claim is live");
  // v2.8 Correction-1 (the W10 gap): the attested target must be what the chain routes at `tip`.
  const expected = fillTargetId(offer, tip);
  const holdRouted = expected.toLowerCase() !== offer.id.toLowerCase();     // a live fclaim hold re-routes the target
  if (opts?.fillTargetId !== undefined) {
    if (String(opts.fillTargetId).toLowerCase() !== expected.toLowerCase()) return refuse(holdRouted ? "v2.8: a live fclaim hold routes this fill - the attest must target the fclaim txid, not the offer id (an offer-txid fill is chain-rejected after the payment moved)" : "the attested fill target does not match this offer's routing (attest the offer id)"); // MUTATE_END_TARGET_MISMATCH
  } else if (holdRouted) {
    return refuse("v2.8: a live fclaim hold routes this fill - pass opts.fillTargetId (use fillTargetId(offer, tip)) so the endorsement can verify what your attest targets"); // MUTATE_END_TARGET_REQUIRED
  }
  if (isTokenWant(offer.want))
    return { verdict: "not-endorsable", reason: "token-priced want - deliverability is the attester's token balance, which a pure record predicate cannot see; NOT an endorsement and NOT a refusal (verify your token balance + proven terms, then proceed)", preview };
  if (!preview.deliverable) {
    if (preview.reason === "below-min") return refuse("payment is below the offer minimum");
    return refuse("this payment would deliver 0 tokens - refusing (the CSD would be lost)");
  }
  return { verdict: "endorsed", reason: "ok", preview };
}

/** C1: may `me` safely sign the fee-bearing registration `nfinalize` for `nameState` committed at
 *  `commitHeight`? The reg fee rides nfinalize; a finalize on a reservation that was displaced, has
 *  expired, OR is raised before the displacement contest froze is REJECTED after the fee moved (a burn).
 *
 *  TRUST SCOPE (read before relying on this): this is a STALE-STATE and displacement-race guard under an
 *  HONEST resolver, NOT a Byzantine-resolver defense. Its safety rests on `commitHeight` coming from a
 *  source INDEPENDENT of `nameState` — then `effectiveHeight !== commitHeight` genuinely detects a
 *  displaced/forged reservation. A caller that passes `nameState.effectiveHeight` AS `commitHeight` makes
 *  that guard a tautology (`X !== X`), so `eff` becomes resolver-controlled and this helper gives
 *  window-SHAPE correctness only, not protection against a resolver that lies about `effectiveHeight`.
 *  No field arithmetic here can defeat a resolver that forges the whole record (owner/pending/eff at once);
 *  that closure is registration-state SPV (roadmapped), the same posture the fill path documents (a
 *  coherently lying resolver is the fill-SPV item, not this guard). Pass the AUTHORITATIVE (freshly
 *  re-fetched) name record — never a cached one — as `nameState` (undefined = 404 / unregistered = loss).
 *
 *  Pass `tip` to ALSO gate the finalize WINDOW, both sides, mirroring the resolver's authoritative checks
 *  (resolve.ts nfinalize rejects unless `ev.height > effHeight + REG_COMMIT_MAX_BLOCKS`, and rejects when
 *  `ev.height > finalizeBy`) with the client-side FINALIZE_TIP_MARGIN band the site's finalizeReady applies:
 *  the tx signs at `tip` but mines at tip+1 or later, so the margin keeps a boundary-signed finalize from
 *  mining outside the window (too early: rejected as unfrozen; too late: past the deadline — either way the
 *  fee burns). The window is derived purely from `eff` (never the resolver's `finalizeBy`), so a lying
 *  `finalizeBy` cannot widen it — but per the trust scope above, a lying `eff` still can for a caller that
 *  does not supply an independent `commitHeight`. `tip` is optional; without it the winner-only path runs. */
export function finalizeWinnerCheck(
  nameState: NameState | null | undefined,
  me: string,
  commitHeight: number,
  tip?: number | null,
): { safe: boolean; reason: string } {
  const m = me.toLowerCase();
  if (!nameState) return { safe: false, reason: "no reservation on-chain (displaced, swept, or never accepted) — a finalize now would burn the fee" };
  if (nameState.owner?.toLowerCase() !== m) return { safe: false, reason: "an earlier committer won this name — you were outbid" };
  // already finalized to us: no second fee is needed (idempotent safety)
  if (nameState.pending !== true) return { safe: false, reason: "already registered to you — no second finalize fee is needed" };
  if (Number(nameState.effectiveHeight) !== Number(commitHeight))
    return { safe: false, reason: "your reservation was displaced (effective height changed) — a finalize now would burn the fee" };
  // N-2: the finalize window, both sides. The window is derived PURELY from `eff` (= the caller's own
  // commitHeight, pinned by the effectiveHeight guard above), NOT from the resolver-supplied finalizeBy:
  // the true on-chain deadline is ALWAYS `eff + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS`
  // (resolve.ts:335/:300 construct it that way), so a hostile/buggy resolver returning an inflated
  // finalizeBy cannot widen the safe band and walk the caller into a fee burn — this keeps the module's
  // "a deterministic function of record fields, no resolver boolean can induce a loss" invariant (S1).
  // The boundaries are byte-identical to the site's regstage freezeEnd for an honest record.
  if (tip !== undefined && tip !== null && Number.isFinite(Number(tip))) {
    const t = Number(tip);
    const eff = Number(nameState.effectiveHeight);
    const freezeEnd = eff + REG_COMMIT_MAX_BLOCKS;
    const closeAt = eff + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS - FINALIZE_TIP_MARGIN;
    if (t <= freezeEnd + FINALIZE_TIP_MARGIN)
      return { safe: false, reason: `too early — the displacement contest is not frozen yet (finalizable after block ${freezeEnd + FINALIZE_TIP_MARGIN}, chain tip ${t}); the resolver would reject the finalize after the fee moved, burning it` };
    if (t > closeAt)
      return { safe: false, reason: `this reservation's finalize window has closed (safe until block ${closeAt}, chain tip ${t}); a finalize now would mine past the deadline and burn the fee` };
  }
  return { safe: true, reason: "ok" };
}
