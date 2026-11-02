// verifyfill.ts (v2.8, §31) - the SHARED client-side fill-SPV surface: the fail-closed FUND BOUNDARY
// for the open-lane fclaim buy. A bug here is pay-without-delivery. It is consumed identically by the
// site bundle (public/vendor/cairnx-core.js) and the wallet bundle (src/vendor/cairnx-spv.js), so it is
// PURE: no I/O, no clocks, no fetch. All chain access flows through an injected `FillSpvIo` seam modeled
// on cairn-wallet namespv.ts `SpvSource`, so the exact same code runs in both bundles and is test-injectable.
//
// The design principle mirrors preflight.ts: never trust a resolver boolean. A denied fclaim is an
// L0-VALID FILL TARGET (L0 stores every mined Propose; an Attest existence check only reads storage), and
// the D2 service alias deliberately asserts "granted" to carry stale wallets. So this surface re-derives
// the ENTIRE fclaim grant + hold outcome ITSELF with the authoritative resolver over PoW-buried,
// MERKLE-PROVEN offer + fclaim events (the SG-CONTENT-BIND-1 bind is structural here), and MUST NOT trust
// fclaim inclusion alone or any served "granted" flag. Every rejection is either L0-co-enforced-unreachable,
// attacker-authored, buyer-self-authored, or the deep-reorg finality residual every CSD payment carries.
import { payloadHash } from "@inversealtruism/csd-codec";
import {
  V28_HEIGHT, FILL_TIP_MARGIN, SCORE_FILL, MAX_ACTIVE_CLAIMS,
  V11_HEIGHT, V16_HEIGHT, FEE_BPS, FEE_BPS_V16, ADDR_RE,
  fclaimHoldEnd, isTokenWant,
  type OfferState, type ChainEvent, type ProposeEvent, type AttestEvent, type CairnXState, type CairnXRecord, type OfferRecord,
} from "./types.js";
import { resolve } from "./resolve.js";
import { requiredClaimDepth } from "./client.js";
import { hasLiveClaim, previewFill, requiredFillOutputs } from "./preflight.js";
import { parseRecord } from "./records.js";
import { fillHistory, type FillHistoryIo, type HistoryRefusalCode } from "./fillhistory.js";

// ── the SPV seam ──────────────────────────────────────────────────────────────────────────────────────
// A PoW-verified, MERKLE-PROVEN event: the tx body's RE-DERIVED txid IS the merkle leaf folded to the
// PoW-committed root (A1 / csd-light verifyTxInclusion), so `uri`/`payloadHash` are the ON-CHAIN commitment,
// never a resolver-served /proposal. `depth` = the PoW-verified burial (tip - height + 1). resolve() reads
// the ChainEvent fields; `depth` is the only extra the seam surfaces.
export type ProvenPropose = ProposeEvent & { depth: number };
export type ProvenAttest = AttestEvent & { depth: number };
export type ProvenEvent = ProvenPropose | ProvenAttest;

export interface FillSpvIo {
  // The PoW-VERIFIED tip height. Never a resolver-asserted tip (a forged tip would inflate burial depth).
  tip(): Promise<number>;
  // The event ids that bear on this offer's fill-safety, for the grant replay to run over. Each id is proven via
  // provenEvent, and every id returned must come back proven or the verdict fails closed. Completeness is a seam
  // obligation the pure layer cannot verify, and it is per range: the ids must be every lane event (the offer, its
  // fclaims, ocancels, attests on the offer or its fclaims) of a range of heights the seam read completely from
  // PoW-verified block bodies (the swapguard scan model), never a resolver hint list. Only inside such a range does
  // a real event move the replay toward the chain's state. A real event added alone (an fclaim proven without the
  // holds before it) can make the replay grant what the chain denied, and so can an fclaim in a range's lowest
  // GAP_NEEDED blocks (src/fillhistory.ts). A seam that declares its range through `history` gets exactly those
  // fclaims decided; one that does not is trusted to have read MAX_SCAN below the fclaim and no fclaim before it.
  // Omitting a real event is the attack: a withheld cancel, consuming fill or give-draining transfer replays the
  // offer as more open than it is, so the replay grants and returns safe:true where the resolver denied, a
  // pay-without-delivery burn. A cancel or consuming fill can be older than any bounded scan (a V22+ offer may be
  // weeks old); that withheld-history leg stays with the caller (the served status, the wallet's second source).
  offerEventIds(offerId: string, fclaimTxid: string): Promise<string[]>;
  // The PoW-VERIFIED, MERKLE-PROVEN event for `id`, or null when it cannot surface the proven artifact
  // (the caller fails CLOSED). It must NEVER surface a resolver-asserted "granted" flag or trust fclaim
  // inclusion alone; it yields only the merkle-proven record body bound to its on-chain payload_hash.
  provenEvent(id: string): Promise<ProvenEvent | null>;
  // Optional: the ranges the seam read and the reads that extend them (src/fillhistory.ts). With it, fclaims the
  // read ranges do not decide are branched over, and a refusal at the delivery gate reads the ranges the served
  // offer's listed fills need (opts.servedFills). Without it the verdict is the single-replay verdict.
  history?: FillHistoryIo;
}

// ── A1 structural bind: parseRecord re-derives canonicalJson(obj) === uri AND payloadHash(obj) === the
// event's payloadHash, and the seam guarantees `payloadHash` IS the merkle-proven committed app.payload_hash
// (bound to the re-derived txid). So a record that parses AND hashes to the proven payload_hash is bound to
// the ON-CHAIN commitment, not a served /proposal. Returns null (fail closed) on any mismatch. ──
function bindRecord(ev: ProvenPropose): CairnXRecord | null {
  const rec = parseRecord(ev.uri, ev.payloadHash);
  if (!rec) return null;
  if (payloadHash(rec).toLowerCase() !== String(ev.payloadHash).toLowerCase()) return null;
  return rec;
}

// ── replayLiveHold: the MANDATORY client-side GRANT REPLAY ─────────────────────────────────────────────
// Re-derive the ENTIRE fclaim grant + hold outcome from the merkle-proven events with the AUTHORITATIVE
// resolver (the same ladder `applyFclaim` in src/resolve/market.ts applies: offer open + CSD + !taker + ee bounds + no prior hold +
// cooldown + MAX_ACTIVE_CLAIMS, plus Correction 1/2, last-write-wins claimTxid, and cancels/expiry).
// Running resolve() over the proven set IS the strongest mirror of the ladder (zero drift), and NONE of it
// trusts a served "granted" flag. `granted` = the fclaim is materialized in state.fclaims (GRANTED, not
// DENIED); `routed` = the offer's live routing target IS this fclaim (last-write-wins); `heldByMe` = the
// offer is open AND the live hold is mine at `evalHeight`.
export interface HoldReplay {
  state: CairnXState;
  offer?: OfferState;
  granted: boolean;
  routed: boolean;
  heldByMe: boolean;
}
export function replayLiveHold(
  proven: ProvenEvent[],
  offerId: string,
  fclaimTxid: string,
  me: string,
  evalHeight: number,
): HoldReplay {
  const events: ChainEvent[] = proven.map(({ depth: _depth, ...e }) => e as ChainEvent);
  const state = resolve(events, evalHeight);
  const offer = state.offers[offerId.toLowerCase()] ?? state.offers[offerId];
  const granted = state.fclaims[fclaimTxid.toLowerCase()] !== undefined || state.fclaims[fclaimTxid] !== undefined;
  const routed = !!offer && offer.claimTxid !== undefined && offer.claimTxid.toLowerCase() === fclaimTxid.toLowerCase();
  // hasLiveClaim already binds claimedBy === me (case-insensitive) + the fclaim-aware grace-0 liveness, so
  // this is the resolver's own claimHeld && who === claimedBy, evaluated on the OPEN offer.
  const heldByMe = !!offer && offer.status === "open" && hasLiveClaim(offer, me, evalHeight);
  return { state, offer, granted, routed, heldByMe };
}

// ── the top-level fail-closed verdict ──────────────────────────────────────────────────────────────────
/** Why a fill was refused, for callers to act on (the reason text is for people). "not-buried", "not-held",
 *  "not-granted" and "hold-deadline" can change as the tip moves; "history-unread" is a read failure worth a retry. */
export type FillRefusalCode =
  | "tip-unverified" | "events-unenumerated" | "event-unproven" | "fclaim-pre-v28" | "record-unbound" | "not-csd-priced"
  | "not-buried" | "offer-unresolved" | "cap-unasserted" | "cap-reached" | "not-granted" | "not-held" | "invalid-pay"
  | "no-delivery" | "sums-unsizable" | "invalid-sums" | "sums-mismatch" | "hold-deadline" | HistoryRefusalCode;
export interface FillVerdict { safe: boolean; reason: string; code?: FillRefusalCode }

/**
 * The union verdict a client MUST clear before signing an open-lane fclaim fill: offer + fclaim
 * MERKLE-PROVEN and bound to their on-chain commitment (A1), both (and any earlier fill-basis) buried
 * `>= requiredClaimDepth`, the grant REPLAYED to a live hold that is mine and routes to THIS fclaim, the
 * fill delivering `>= 1` unit, and a FILL_TIP_MARGIN deadline cushion. Fails CLOSED on any unmet condition,
 * with a `code` on every refusal. Accepts every honest fill the read ranges decide (the holder, live hold,
 * buried, offer+fclaim proven, delivery >= 1); it refuses the doomed/forged cases (a denied fclaim a lying
 * resolver calls "granted", a cancelled/lapsed or not-mine hold, a below-depth signing, a zero-delivery fill, a
 * stranded past-deadline broadcast).
 *
 * `opts.myLiveHoldsAtGrant` (REQUIRED) is the buyer's count of OTHER live fclaim/legacy holds at the moment
 * THIS fclaim was granted, asserted by the authoring client (countOtherHoldsAtGrant computes it). The lane-scoped
 * replay cannot see the buyer's other-offer holds, and MAX_ACTIVE_CLAIMS is the one grant clause counted
 * across offers, so without this the surface would false-accept a cap-denied fclaim. `opts.pay` overrides the
 * payment (base units to want.payto) for a PARTIAL tail-fill; defaults to the offer's full want.value.
 *
 * `opts.sums` is caller data (the per-address outputs the caller is about to build), so it cannot default on:
 * without it there is nothing to bind. A caller that omits it keeps the overpay exposure described next.
 * `opts.sums` (OPT-IN, B6a / REBIND W3; default OFF = byte-identical verdicts for existing callers) binds the
 * caller's PLANNED per-address CSD payment sums to the PROVEN offer state: requiredFillOutputs is re-run over
 * the merkle-proven, replayed offer and the caller's map must match it EXACTLY, address for address. The
 * replayed `paid`/`delivered` are the chain's only where the read ranges decide them: the seam's window, and with
 * `io.history` the ranges read for the listed fills. A fill the served offer omits from below those ranges is
 * in neither, so a resolver that withholds it and serves a matching lower `paid` passes this bind (the withheld-fill
 * residual; on the wallet the second-source offer read bounds it). Inside the ranges it closes the W3 overpay: a
 * resolver serving `paid:"0"` for a 90%-filled partial made callers size the FULL want while the chain credits
 * only the remainder. Pass the SAME per-address sums you will build (the wallet's need-map shape: payto + treasury
 * fee + maker rebate, MERGED per address - `payto === seller` merges the rebate leg).
 * DELIBERATELY NOT the scalar `dp.pay !== pay` form: that refuses honest fills on both live callers (the
 * wallet's per-address sum includes the maker rebate when payto === seller; the site passes no pay at all).
 *
 * `opts.servedFills` (with `io.history` only) is the served offer's fill list (FillEntry txid and height). It is
 * read only when the replay refuses at the delivery gate: then the ranges those fills need are read
 * (planFillHistory), every listed fill must be on chain where listed, and the verdict is decided again over them.
 * A buy that passes without them reads nothing more.
 */
export async function verifyFillSpv(
  offerId: string,
  fclaimTxid: string,
  me: string,
  io: FillSpvIo,
  opts: {
    myLiveHoldsAtGrant: number; pay?: bigint | string | number; sums?: Record<string, bigint | string | number>;
    servedFills?: readonly { txid: string; height: number }[];
  },
): Promise<FillVerdict> {
  const no = (code: FillRefusalCode, reason: string): FillVerdict => ({ safe: false, reason, code });

  // 1. the PoW-VERIFIED tip (never a resolver-asserted tip: a forged tip would inflate burial depth).
  let tip: number;
  try { tip = Number(await io.tip()); } catch { return no("tip-unverified", "could not read a PoW-verified tip"); }
  if (!Number.isFinite(tip)) return no("tip-unverified", "no PoW-verified tip");
  // Clamp a seam-reported burial to the PoW-verified tip, so a seam over-reporting depth (a forged deeper
  // burial) can never satisfy the depth gate with fewer real confirmations than the PoW chain shows.
  const depthOf = (ev: ProvenEvent): number => Math.min(Number(ev.depth), tip - Number(ev.height) + 1);

  // 2. gather + MERKLE-PROVE the offer's event set. Every enumerated id must come back proven and under its own
  //    id: a dropped event (a cancel, a consuming fill, an earlier hold) replays the offer as more open than it is.
  let hintIds: string[];
  try { hintIds = await io.offerEventIds(offerId, fclaimTxid); } catch { return no("events-unenumerated", "could not enumerate the offer's events"); }
  const want = new Set<string>([offerId.toLowerCase(), fclaimTxid.toLowerCase(), ...(hintIds ?? []).map((x) => String(x).toLowerCase())]);
  const unproven = (wid: string): FillVerdict =>
    wid === offerId.toLowerCase() ? no("event-unproven", "offer not merkle-proven (no PoW-verified offer Propose)")
      : wid === fclaimTxid.toLowerCase() ? no("event-unproven", "fclaim not merkle-proven (no PoW-verified fclaim Propose)")
        : no("event-unproven", `an event on this offer could not be merkle-proven (${wid}) - refusing, the replay would miss it`);
  const proven: ProvenEvent[] = [];
  for (const wid of want) {
    let ev: ProvenEvent | null;
    try { ev = await io.provenEvent(wid); } catch { return unproven(wid); }
    if (!ev || (ev.kind === "propose" ? ev.id : ev.txid).toLowerCase() !== wid) return unproven(wid);
    proven.push(ev);
  }

  // 3. locate + STRUCTURALLY BIND (A1) the offer + fclaim Proposes. fail closed if either cannot be proven
  //    or does not bind to its on-chain committed payload_hash.
  const isProp = (e: ProvenEvent): e is ProvenPropose => e.kind === "propose";
  const offerEv = proven.find((e): e is ProvenPropose => isProp(e) && e.id.toLowerCase() === offerId.toLowerCase());
  const fclaimEv = proven.find((e): e is ProvenPropose => isProp(e) && e.id.toLowerCase() === fclaimTxid.toLowerCase());
  if (!offerEv) return no("event-unproven", "offer not merkle-proven (no PoW-verified offer Propose)");
  if (!fclaimEv) return no("event-unproven", "fclaim not merkle-proven (no PoW-verified fclaim Propose)");
  if (fclaimEv.height < V28_HEIGHT) return no("fclaim-pre-v28", "fclaim mined below the V28 gate (no fclaim lane there)");
  const offerRec = bindRecord(offerEv);
  const fclaimRec = bindRecord(fclaimEv);
  if (!offerRec || offerRec.t !== "offer") return no("record-unbound", "offer record does not bind to its on-chain commitment");
  if (!fclaimRec || fclaimRec.t !== "fclaim") return no("record-unbound", "fclaim record does not bind to its on-chain commitment");
  if (fclaimRec.offer.toLowerCase() !== offerId.toLowerCase()) return no("record-unbound", "fclaim does not reference this offer");
  if (isTokenWant(offerRec.want)) return no("not-csd-priced", "the fclaim lane is CSD-priced offers only");
  const wantValue = BigInt((offerRec.want as { value: string }).value);
  const E = Number(fclaimEv.expiresEpoch);

  // 4. DEPTH GATE (holdPolicy): the two-tx claim->fill reorg residual. The OFFER, the FCLAIM, AND every
  //    earlier proven FILL-BASIS attest (the partial tail-flip bound: a shallow earlier partial could flip a
  //    signed tail below-min) must be buried >= requiredClaimDepth(want.value, offerAnchorHeight).
  const need = requiredClaimDepth(wantValue, offerEv.height).depth;
  // NaN-fail-closed: `!(x >= need)` refuses when depthOf is NaN (an off-contract seam feeding a non-numeric
  // depth/height), where the plain `x < need` would slip through (NaN < need is false).
  if (!(depthOf(offerEv) >= need)) return no("not-buried", `offer not buried deep enough yet (${depthOf(offerEv)} < ${need}) - wait`);
  if (!(depthOf(fclaimEv) >= need)) return no("not-buried", `fclaim not buried deep enough yet (${depthOf(fclaimEv)} < ${need}) - wait`);
  const laneIds = new Set<string>([offerId.toLowerCase()]);
  for (const e of proven) {
    if (!isProp(e)) continue;
    const r = e.id.toLowerCase() === fclaimTxid.toLowerCase() ? fclaimRec : bindRecord(e);
    if (r && r.t === "fclaim" && r.offer.toLowerCase() === offerId.toLowerCase()) laneIds.add(e.id.toLowerCase());
  }
  for (const e of proven) {
    if (e.kind === "attest" && e.score === SCORE_FILL && laneIds.has(e.proposalId.toLowerCase()) && !(depthOf(e) >= need))
      return no("not-buried", `an earlier fill-basis event is not buried deep enough yet (${depthOf(e)} < ${need}) - wait`);
  }

  // 5. MANDATORY GRANT REPLAY over the merkle-proven events (NOT the served status / D2 "granted" alias). With a
  //    history seam the replay is the one every undecided fclaim status agrees on (src/fillhistory.ts).
  const replay = (evs: ProvenEvent[]) => replayLiveHold(evs, offerId, fclaimTxid, me, tip);
  const history = io.history
    ? fillHistory({ io: io.history, events: proven, offerId, fclaimTxid, offerHeight: offerEv.height, replay })
    : null;
  let r: HoldReplay;
  if (history) {
    const d = await history.decide();
    if (!d.ok) return no(d.code, d.reason);
    r = d.replay;
  } else r = replay(proven);

  const judge = (r: HoldReplay): FillVerdict => {
    if (!r.offer) return no("offer-unresolved", "the offer does not resolve from the proven events (unknown/rejected offer)");

    // GUARD (cross-offer MAX_ACTIVE_CLAIMS cap): the lane-scoped replay CANNOT see the buyer's OTHER-offer live
    // holds, and the cap is the one grant clause counted across offers, so the replay under-counts it and would
    // grant a cap-DENIED fclaim. The authoring client (which signed its own claims) MUST assert how many OTHER
    // live holds it had when THIS fclaim was granted; if that is >= MAX_ACTIVE_CLAIMS the real resolver denied
    // this fclaim on the cap and the fill would burn. (B5/B6 must ALSO refuse to CREATE a claim at the cap;
    // this is the fill-side backstop, and it fails CLOSED if the count is not asserted.)
    // Count what the resolver counts: for a grant at height >= V29_HEIGHT only holds on offers still OPEN at
    // that height (a hold on an offer this buyer already filled no longer occupies a slot); below V29, every
    // live hold. Over-counting refuses an honest fill; under-counting lets a cap-denied fill burn.
    if (!Number.isInteger(opts.myLiveHoldsAtGrant) || opts.myLiveHoldsAtGrant < 0)
      return no("cap-unasserted", "the caller must assert myLiveHoldsAtGrant (the buyer's concurrent other-offer live-hold count) for the cap check");
    if (opts.myLiveHoldsAtGrant >= MAX_ACTIVE_CLAIMS) return no("cap-reached", "you held the max active claims when this fclaim was granted - the resolver denied it on the cap, refusing (the payment would burn)"); // MUTATE_GUARD_CAP

    // GUARD (denied-fclaim): the live routing target must BE this fclaim AND it must be GRANTED in the
    // replayed state. A resolver-DENIED fclaim (a taken/expired/superseded offer) never routes here, so a
    // lying "granted" assertion cannot walk the payment onto an L0-valid but delivery-less target.
    if (!(r.routed && r.granted)) return no("not-granted", "this fclaim is not the live granted hold (denied or superseded) - refusing, the payment would burn"); // MUTATE_GUARD_R

    // GUARD (forged-cancel-holder): the offer must be OPEN and the live hold must be MINE. Catches a
    // cancelled/expired offer, a lapsed hold, and a hold held by someone else (me is not the holder).
    if (!r.heldByMe) return no("not-held", "no live claim by you on an open offer (cancelled, lapsed, or not your hold) - refusing"); // MUTATE_GUARD_H

    // 6. DELIVERY: the payment must move >= 1 unit of the asset (the C3 zero-delivery trap). Status-independent
    //    (Guard above owns the open check), computed with the resolver's own previewFill math on the terms.
    let pay: bigint;
    try { pay = opts.pay !== undefined ? BigInt(opts.pay) : wantValue; } catch { return no("invalid-pay", "invalid pay amount"); }
    const dp = previewFill({ ...r.offer, status: "open" } as OfferState, pay);
    if (!dp.deliverable || dp.got < 1n) return no("no-delivery", "this fill would deliver 0 units - refusing (the CSD would be lost)");

    // 6b. OPT-IN PAYMENT BIND (B6a / REBIND W3, default OFF): bind the caller's planned per-address CSD sums to
    //     the PROVEN fill progress. requiredFillOutputs over the replayed (merkle-proven) offer is the chain's
    //     own answer for what THIS pay must carry (partial clamp on the replayed `paid`, fee on the clamp, rebate
    //     merged per address); any divergence means the caller sized its payment from a lie (or would mis-route
    //     an output) and the surplus/misroute burns after resolve() clamps to truth. EXACT match, both ways: a
    //     missing/low leg is a doomed underpay, an extra/high leg is the W3 overpay or a smuggled output (N26).
    if (opts.sums !== undefined) {
      const req = requiredFillOutputs({ ...r.offer, status: "open" } as OfferState, pay);
      if (req === null) return no("sums-unsizable", "the proven offer state cannot size this payment - refusing");
      const proven = new Map<string, bigint>(req.map((o) => [o.to, o.value]));   // keys already lower-cased
      const planned = new Map<string, bigint>();
      try {
        for (const [a, v] of Object.entries(opts.sums)) { const k = String(a).toLowerCase(); planned.set(k, (planned.get(k) ?? 0n) + BigInt(v)); }
      } catch { return no("invalid-sums", "invalid sums (amounts must be base-unit integers)"); }
      const sumsKeys = new Set([...proven.keys(), ...planned.keys()]);
      for (const k of sumsKeys) if ((proven.get(k) ?? 0n) !== (planned.get(k) ?? 0n)) return no("sums-mismatch", `payment does not match the proven fill progress (${k}: planned ${(planned.get(k) ?? 0n).toString()}, proven state requires ${(proven.get(k) ?? 0n).toString()}) - refusing (an overpay past the real remainder is unrecoverable)`); // MUTATE_GUARD_SUMS
    }

    // 7. DEADLINE (client policy; never a fund risk, always fail-safe): refuse within FILL_TIP_MARGIN of
    //    holdEnd so the payment cannot strand as an L0-unminable no-op past the hold. Computed from the
    //    fclaim's ACTUAL confirmed expiry epoch, NOT epochOf(tip+45).
    const holdEnd = fclaimHoldEnd(E);
    if (holdEnd < tip + FILL_TIP_MARGIN) return no("hold-deadline", `too close to the hold deadline (holdEnd ${holdEnd}, tip ${tip}) - would strand`);

    return { safe: true, reason: "ok" };
  };

  const v = judge(r);
  // Earlier fills below the read ranges change only the replayed `paid` (and `delivered`, its pro-rata floor), so
  // they change a verdict only at the delivery gate: a refusal there, or an acceptance whose delivery depends on
  // `paid`. Only then are the served offer's listed fills read; every other verdict reads nothing more.
  if (!history || !opts.servedFills || opts.servedFills.length === 0) return v;
  if (v.code !== "no-delivery" && !(v.safe && deliveryDependsOnPaid(r.offer, opts.pay ?? wantValue))) return v; // MUTATE_LAZY_PLAN
  const more = await history.readListedFills(opts.servedFills);
  if (!more.ok) return no(more.code, more.reason);
  return more.read ? judge(more.replay) : v;
}

// Whether a partial fill paying `pay` delivers at least one unit whatever the offer's earlier fills: the resolver
// delivers floor(give * paid' / want) - floor(give * paid / want), which is at least floor(give * x / want) for any
// earlier `paid`, so only a payment worth less than one unit (a coarse give) can deliver over one replayed `paid`
// and nothing over the chain's.
function deliveryDependsOnPaid(offer: OfferState | undefined, pay: bigint | string | number): boolean {
  if (!offer || offer.min === undefined || isTokenWant(offer.want) || !("amount" in offer.give)) return false;
  const p = previewFill({ ...offer, status: "open" }, pay);
  return BigInt(offer.give.amount) * p.pay < BigInt(offer.want.value);
}

// ── the SHARED fill-boundary TERM bind (Plan 70 R2 Option B: single-source the R1 hand-copies) ──────────
// verifyFillSpv proves the grant/hold/DELIVERY over merkle-proven events but takes NO served offer, so the
// CALLER (wallet fillspv/wallet.ts, site swapguard.js, a diligent dApp) must bind the resolver-SERVED offer's
// fee/rebate-sizing fields to the merkle-proven ones before it sizes requiredFillOutputs. requiredFillOutputs
// sizes the treasury fee from offer.feeBps (= feeBpsAt(the on-chain creation height)), the maker rebate from
// offer.height/taker/bid, the payment from want.value, and pivots partial-vs-whole SOLELY on `offer.min !==
// undefined`; a lying resolver deflating/adding any of them makes the caller build a mis-sized fill that
// resolve() (using the proven values) rejects AFTER the payment leg moved = pay-without-delivery burn (theft
// if the attacker is the seller). Before R2 this predicate was hand-copied into three seams (wallet.ts
// provenTermsMismatch, swapguard.js verifyOfferContent amount-leg, and here-adjacent callers); they were
// already behaviourally identical (the R1.1 min bind), differing only in shape (a pre-built ProvenOfferTerms
// vs an inline record+height). Option B homes the ONE verdict here and vendors it into both bundles.

// The fee/rebate-relevant fields of an offer, derived from the MERKLE-PROVEN offer (never a resolver-served
// object). `min` is the ONLY on-chain partial-fill field (OFFER_KEYS in records.ts; copied verbatim onto
// OfferState at creation). `paid`/`delivered` are resolver-derived RUNNING fill state (init 0, accumulated per
// fill), NOT in the record and NOT merkle-provable, so they are deliberately ABSENT here (binding them would
// false-refuse every partially-filled offer). previewFill pivots partial-vs-whole SOLELY on `offer.min !==
// undefined`, so binding `min` pins the caller to the exact branch resolve() takes (F2 partial-fill leg).
//
// B6a (REBIND W2/W7) fields, populated by provenOfferTerms and compared by bindOfferTerms's give and wantType
// legs (on by default; a caller that opts out of both gets the pre-B6 verdict and these are ignored):
//   giveTicker/giveAmount/giveName - the offer's give, copied VERBATIM as strings (`applyOffer` in src/resolve/market.ts copies the
//     record's give verbatim at creation and tracks `delivered` separately, so a string compare against the
//     RECORD is exact and partial-fill-safe; a deep object compare against a served OfferState is NOT, and
//     must never be written here).
//   wantType - "token" iff the proven want is token-priced (want.ticker), else "csd". The type pivot every
//     payment path branches on; serving the opposite type re-routes the whole fill machinery (W1/W7 class).
//   wantTicker/wantAmount - a token want's price, verbatim strings; absent for a CSD want (`value` carries it).
export interface ProvenOfferTerms {
  height: number; feeBps: number; value?: string; taker?: string; bid?: string; min?: string;
  giveTicker?: string; giveAmount?: string; giveName?: string; wantType?: "csd" | "token";
  wantTicker?: string; wantAmount?: string;
}

// ── the ProvenOfferTerms BRAND (B6a rider, LTS amendment: the G6 "different-file hand copy" cure) ──────
// A type-level brand minted ONLY by provenOfferTerms (the sole in-module cast). The audit found FOUR
// hand-built ProvenOfferTerms producers and three interface re-declarations; B4 routed all of them through
// provenOfferTerms, and this brand makes a FIFTH hand copy a compile error wherever minted terms are
// required (bindOfferTerms with its default legs). Type-level only: the symbol does not exist at runtime
// and no byte of output changes; a plain ProvenOfferTerms is accepted only with both legs opted out.
declare const PROVEN_TERMS_MINT: unique symbol;
export type MintedProvenOfferTerms = ProvenOfferTerms & { readonly [PROVEN_TERMS_MINT]: "cairnx-core/provenOfferTerms" };
/** UNSAFE escape hatch, TESTS ONLY: brand a hand-built terms object. Production code must never call this -
 *  hand-built terms are exactly the W2 defect class the brand exists to make unrepresentable. */
export const unsafeMintProvenOfferTerms = (t: ProvenOfferTerms): MintedProvenOfferTerms => t as MintedProvenOfferTerms;

// The treasury fee rate the resolver STAMPS on an offer at its creation height (`applyOffer` in src/resolve/market.ts: v11 ? (v16 ?
// FEE_BPS_V16 : FEE_BPS) : 0). requiredFillOutputs sizes the treasury fee from offer.feeBps, so binding a
// served feeBps to feeBpsAt(the MERKLE-PROVEN creation height) stops a lying resolver deflating it. Single-
// sourced here so the wallet fillspv, the site swapguard and any dApp bind the SAME rate.
export const feeBpsAt = (height: number): number =>
  height >= V11_HEIGHT ? (height >= V16_HEIGHT ? FEE_BPS_V16 : FEE_BPS) : 0;

// Build the normalized ProvenOfferTerms from a MERKLE-PROVEN offer record + its proven creation height. The
// value/taker/bid/min are copied from the record (lower-cased for addr-like fields, string-coerced), feeBps is
// derived from the height. A caller feeds this the record it already merkle-bound (bindRecord / verifyTxInclusion).
// B6a: also carries the give legs + wantType (verbatim strings; see the interface note) and returns the
// BRANDED type - this function is the brand's sole minter. The pre-B6 fields are emitted bit-identically, so
// bindOfferTerms with both legs opted out returns the pre-B6 verdict over this output.
export function provenOfferTerms(offerRec: OfferRecord, provenHeight: number): MintedProvenOfferTerms {
  const w = offerRec.want as { value?: string; ticker?: string; amount?: string };
  const g = offerRec.give as { ticker?: string; amount?: string; name?: string };
  return {
    height: Number(provenHeight),
    feeBps: feeBpsAt(Number(provenHeight)),
    value: w.value !== undefined ? String(w.value) : undefined,
    taker: offerRec.taker !== undefined ? String(offerRec.taker).toLowerCase() : undefined,
    bid: offerRec.bid !== undefined ? String(offerRec.bid).toLowerCase() : undefined,
    min: offerRec.min !== undefined ? String(offerRec.min) : undefined,
    giveTicker: g.ticker !== undefined ? String(g.ticker) : undefined,
    giveAmount: g.amount !== undefined ? String(g.amount) : undefined,
    giveName: g.name !== undefined ? String(g.name) : undefined,
    wantType: isTokenWant(offerRec.want) ? "token" : "csd",
    wantTicker: isTokenWant(offerRec.want) ? String(w.ticker) : undefined,
    wantAmount: isTokenWant(offerRec.want) ? String(w.amount) : undefined,
  } as MintedProvenOfferTerms;
}

/**
 * The fill-boundary TERM-MISMATCH verdict: `true` iff any fee/rebate/partial-sizing field of the resolver-
 * SERVED offer diverges from the merkle-proven terms `t`. FAIL-CLOSED semantics (any divergence => true =>
 * the caller refuses). Byte-identical in behaviour to the wallet's old provenTermsMismatch and the site's
 * old inline amount-leg bind (they were reconciled to be one predicate here):
 *   - height    (offer.height     vs t.height)
 *   - feeBps    (offer.feeBps     vs t.feeBps = feeBpsAt(creation height))
 *   - value     (offer.want.value vs t.value, only when the proven offer is CSD-priced)
 *   - taker     (offer.taker      vs t.taker, case-insensitive, undefined/null == "")
 *   - bid       (offer.bid        vs t.bid,   same normalization)
 *   - min       presence AND value: an ADDED spurious min (whole->partial rebate-drop burn) OR a deflated min
 *               both mismatch. EXPLICIT presence (a served min="" must not slip past a proven-absent min).
 * `value` is bound only when `t.value` is defined so a token<->token offer (no CSD value) is not spuriously
 * refused; a caller that binds want.value separately (the site does) may still pass it here (redundant-safe).
 *
 * The give and wantType legs (REBIND W2 legs + W7) are ON by default. Their third-argument switches opt out
 * explicitly (`false`); omitted or `undefined` keeps a leg on. With a leg on the terms must be MINTED (the
 * brand), because a hand-built terms object leaves the give/wantType fields undefined and would refuse every
 * honest fill (the W2 trap this file documents). A plain ProvenOfferTerms is accepted only with both legs
 * off, which is the pre-B6 predicate exactly (`scripts/seal-differential.mjs` step 5).
 *   give     - bind give.ticker / give.amount / give.name: EXPLICIT PRESENCE (a served give growing or
 *              losing a field mismatches) AND verbatim string equality. Closes the W7 shortchange (a
 *              genuine offer served with give.amount inflated a millionfold passes every other leg).
 *   wantType - the SYMMETRIC want-type refusal: the served offer's want type (token iff want.ticker is
 *              a string, the isTokenWant pivot) must equal the proven type. The value leg already
 *              catches proven-CSD-served-as-token (String(undefined) mismatches t.value); this closes
 *              the reverse, proven-token-served-as-CSD. For a proven token want the served want.ticker
 *              and want.amount must also equal the proven price, verbatim.
 */
export interface BindTermsOpts { give?: boolean; wantType?: boolean }
/** Both legs off: the pre-B6 verdict, for callers that hold hand-built (unminted) terms. */
export type LegacyBindOpts = { give: false; wantType: false };
export function bindOfferTerms(servedOffer: unknown, t: MintedProvenOfferTerms, opts?: BindTermsOpts): boolean;
export function bindOfferTerms(servedOffer: unknown, t: ProvenOfferTerms, opts: LegacyBindOpts): boolean;
export function bindOfferTerms(servedOffer: unknown, t: ProvenOfferTerms, opts?: BindTermsOpts): boolean {
  const o = servedOffer as { height?: unknown; feeBps?: unknown; want?: { value?: unknown; ticker?: unknown; amount?: unknown }; taker?: unknown; bid?: unknown; min?: unknown; give?: { ticker?: unknown; amount?: unknown; name?: unknown } };
  const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v).toLowerCase());
  if (Number(o?.height) !== t.height) return true;
  if (Number(o?.feeBps) !== t.feeBps) return true;
  if (t.value !== undefined && String(o?.want?.value) !== t.value) return true;
  if (s(o?.taker) !== s(t.taker)) return true;
  if (s(o?.bid) !== s(t.bid)) return true;
  const om = o?.min;
  if ((om !== undefined && om !== null) !== (t.min !== undefined)) return true;
  if (t.min !== undefined && String(om) !== t.min) return true;
  if (opts?.wantType !== false) {
    // terms without a wantType (minted before B6) mismatch under this leg: fail closed.
    if (t.wantType === undefined) return true;
    // a proven token want: the served want carries the same ticker and amount; a proven CSD want: no ticker
    if (t.wantType === "token" ? String(o?.want?.ticker) !== t.wantTicker || String(o?.want?.amount) !== t.wantAmount : typeof o?.want?.ticker === "string") return true; // MUTATE_LEG_WANTTYPE
  }
  if (opts?.give !== false) {
    const g = o?.give;
    // per-field EXPLICIT presence + verbatim string equality (never a deep object compare: `applyOffer` copies
    // the record's give verbatim and partial fills track `delivered` separately - the RECORD is the truth).
    if ((g?.ticker !== undefined && g?.ticker !== null) !== (t.giveTicker !== undefined) || (t.giveTicker !== undefined && String(g?.ticker) !== t.giveTicker)) return true; // MUTATE_LEG_GIVETICKER
    if ((g?.amount !== undefined && g?.amount !== null) !== (t.giveAmount !== undefined) || (t.giveAmount !== undefined && String(g?.amount) !== t.giveAmount)) return true; // MUTATE_LEG_GIVEAMOUNT
    if ((g?.name !== undefined && g?.name !== null) !== (t.giveName !== undefined) || (t.giveName !== undefined && String(g?.name) !== t.giveName)) return true; // MUTATE_LEG_GIVENAME
  }
  return false;
}

// Derive the payment recipients + terms from a MERKLE-PROVEN offer Propose event (the "expose proven
// terms/author" surface). `seller` = the event's prevout-bound author (proposer, consensus hash160(input[0]));
// `payto` = the record's explicit want.payto (merkle-committed) or, absent, the seller; `terms` = the
// normalized ProvenOfferTerms. Returns null (fail closed) if the event does not bind to an offer record. The
// caller binds the resolver-served payto/seller to these and calls bindOfferTerms(servedOffer, result.terms).
export function bindProvenOffer(offerEv: ProvenPropose): { payto: string; seller: string; terms: MintedProvenOfferTerms } | null {
  const rec = bindRecord(offerEv);
  if (!rec || rec.t !== "offer") return null;
  const seller = String(offerEv.proposer).toLowerCase();
  const w = rec.want as { payto?: string };
  const payto = (w.payto && ADDR_RE.test(String(w.payto).toLowerCase())) ? String(w.payto).toLowerCase() : seller;
  return { payto, seller, terms: provenOfferTerms(rec, offerEv.height) };
}
