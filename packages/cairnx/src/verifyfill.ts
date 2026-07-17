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
  V28_HEIGHT, FCLAIM_MAX_EPOCH_AHEAD, CLAIM_COOLDOWN_BLOCKS, EPOCH_LEN, FILL_TIP_MARGIN, SCORE_FILL, MAX_ACTIVE_CLAIMS,
  V11_HEIGHT, V16_HEIGHT, FEE_BPS, FEE_BPS_V16, ADDR_RE,
  fclaimHoldEnd, isTokenWant,
  type OfferState, type ChainEvent, type ProposeEvent, type AttestEvent, type CairnXState, type CairnXRecord, type OfferRecord,
} from "./types.js";
import { resolve } from "./resolve.js";
import { requiredClaimDepth } from "./client.js";
import { hasLiveClaim, previewFill } from "./preflight.js";
import { parseRecord } from "./records.js";

// ── GAP_NEEDED: the clean-start SPV scan bound (FUND-SAFETY, not latency) ──────────────────────────────
// To re-derive whether THIS fclaim was granted, the replay must include any PRIOR hold whose window +
// cooldown still bears on the grant (a live prior hold denies via `!claimHeld`; a just-lapsed same-holder
// hold denies via the cooldown). A grant at the FIRST block of an epoch with `ee = epochOf(h)+2` holds the
// LONGEST: claimUntilHeight = (ee+1)*EPOCH_LEN, so holdEnd = (ee+1)*EPOCH_LEN - 1 = h + EPOCH_LEN*3 - 1 =
// h + 89 (a 90-block half-open span; the "-1" is the inclusive last minable height). The cooldown then runs
// CLAIM_COOLDOWN_BLOCKS past claimUntilHeight, so the deepest prior grant that still denies a fclaim at h_fc
// sits at h_fc - (EPOCH_LEN*(FCLAIM_MAX_EPOCH_AHEAD+1) - 1 + CLAIM_COOLDOWN_BLOCKS). A one-block under-scan
// would MISS that prior grant and FALSE-ACCEPT a denied fclaim = a burn, so this is derived symbolically and
// rounded UP with a full-epoch cushion (never a round number that could drift under a constant change).
//   GAP_NEEDED = EPOCH_LEN*(FCLAIM_MAX_EPOCH_AHEAD + 1) - 1 + CLAIM_COOLDOWN_BLOCKS
//              = 30*(2 + 1) - 1 + 15 = 90 - 1 + 15 = 104   (with the current constants)
export const GAP_NEEDED = EPOCH_LEN * (FCLAIM_MAX_EPOCH_AHEAD + 1) - 1 + CLAIM_COOLDOWN_BLOCKS;
// The scan headroom: round GAP_NEEDED up with a full-epoch margin so a boundary off-by-one can never
// under-scan. A caller doing a clean-start scan syncs at least this many blocks back from the fclaim.
export const SCAN_MARGIN = EPOCH_LEN;
export const MAX_SCAN = GAP_NEEDED + SCAN_MARGIN;   // = 134 with the current constants

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
  // The event ids that bear on this offer's fill-safety, for the grant replay to run over. COMPLETENESS IS A
  // SEAM OBLIGATION THE PURE LAYER CANNOT VERIFY: each id is MERKLE-PROVEN via provenEvent (so a lie can only
  // ADD a real on-chain event, which only moves the replay toward truth), but OMITTING a real event is the
  // attack. A withheld cancel, a consuming prior fill, or a give-draining transfer makes the replay see the
  // offer as MORE open than it is, so the replay grants/routes/holds and returns safe:true while the
  // authoritative resolver DENIED = a pay-without-delivery burn. So this MUST be derived from PoW-verified
  // BLOCK BODIES (the swapguard scan model), NOT a bare resolver hint list, and MUST cover: [fclaimHeight -
  // MAX_SCAN, tip] for hold/cooldown evidence AND the offer's FULL lifecycle (anchor to tip, via a persistent
  // header/scan snapshot) for status events (cancel/expiry/consuming fill) + give-backing (deploy+mint, or the
  // name registration). Note the age asymmetry: hold/cooldown evidence is bounded by MAX_SCAN, but a cancel or
  // a consuming fill can be arbitrarily OLD (a V22+ offer may be weeks old), so the lifecycle scan is NOT
  // bounded by MAX_SCAN. B5/B6 own this contract (see the B5/B6 wiring notes in the plan).
  offerEventIds(offerId: string, fclaimTxid: string): Promise<string[]>;
  // The PoW-VERIFIED, MERKLE-PROVEN event for `id`, or null when it cannot surface the proven artifact
  // (the caller fails CLOSED). It must NEVER surface a resolver-asserted "granted" flag or trust fclaim
  // inclusion alone; it yields only the merkle-proven record body bound to its on-chain payload_hash.
  provenEvent(id: string): Promise<ProvenEvent | null>;
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
// resolver (the same ladder resolve.ts applies: offer open + CSD + !taker + ee bounds + no prior hold +
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
export interface FillVerdict { safe: boolean; reason: string }

/**
 * The union verdict a client MUST clear before signing an open-lane fclaim fill: offer + fclaim
 * MERKLE-PROVEN and bound to their on-chain commitment (A1), both (and any earlier fill-basis) buried
 * `>= requiredClaimDepth`, the grant REPLAYED to a live hold that is mine and routes to THIS fclaim, the
 * fill delivering `>= 1` unit, and a FILL_TIP_MARGIN deadline cushion. Fails CLOSED on any unmet condition.
 * Accepts every honest fill (the holder, live hold, buried, offer+fclaim proven, delivery >= 1); it only
 * refuses the doomed/forged cases (a denied fclaim a lying resolver calls "granted", a cancelled/lapsed or
 * not-mine hold, a below-depth signing, a zero-delivery fill, a stranded past-deadline broadcast).
 *
 * `opts.myLiveHoldsAtGrant` (REQUIRED) is the buyer's count of OTHER live fclaim/legacy holds at the moment
 * THIS fclaim was granted, asserted by the authoring client (which signed its own claims). The lane-scoped
 * replay cannot see the buyer's other-offer holds, and MAX_ACTIVE_CLAIMS is the one grant clause counted
 * across offers, so without this the surface would false-accept a cap-denied fclaim. `opts.pay` overrides the
 * payment (base units to want.payto) for a PARTIAL tail-fill; defaults to the offer's full want.value.
 */
export async function verifyFillSpv(
  offerId: string,
  fclaimTxid: string,
  me: string,
  io: FillSpvIo,
  opts: { myLiveHoldsAtGrant: number; pay?: bigint | string | number },
): Promise<FillVerdict> {
  const no = (reason: string): FillVerdict => ({ safe: false, reason });

  // 1. the PoW-VERIFIED tip (never a resolver-asserted tip: a forged tip would inflate burial depth).
  let tip: number;
  try { tip = Number(await io.tip()); } catch { return no("could not read a PoW-verified tip"); }
  if (!Number.isFinite(tip)) return no("no PoW-verified tip");
  // Clamp a seam-reported burial to the PoW-verified tip, so a seam over-reporting depth (a forged deeper
  // burial) can never satisfy the depth gate with fewer real confirmations than the PoW chain shows.
  const depthOf = (ev: ProvenEvent): number => Math.min(Number(ev.depth), tip - Number(ev.height) + 1);

  // 2. gather + MERKLE-PROVE the offer's event set; a missing/unprovable required event fails CLOSED.
  let hintIds: string[];
  try { hintIds = await io.offerEventIds(offerId, fclaimTxid); } catch { return no("could not enumerate the offer's events"); }
  const want = new Set<string>([offerId.toLowerCase(), fclaimTxid.toLowerCase(), ...(hintIds ?? []).map((x) => String(x).toLowerCase())]);
  const proven: ProvenEvent[] = [];
  for (const wid of want) {
    let ev: ProvenEvent | null;
    try { ev = await io.provenEvent(wid); } catch { ev = null; }
    // the seam MUST return the event for the id we asked for, so an off-contract id->event mapping cannot
    // smuggle a wrong event past the requested-id set (the merkle proof already ties the body to the chain).
    if (ev && (ev.kind === "propose" ? ev.id : ev.txid).toLowerCase() === wid) proven.push(ev);
  }

  // 3. locate + STRUCTURALLY BIND (A1) the offer + fclaim Proposes. fail closed if either cannot be proven
  //    or does not bind to its on-chain committed payload_hash.
  const isProp = (e: ProvenEvent): e is ProvenPropose => e.kind === "propose";
  const offerEv = proven.find((e): e is ProvenPropose => isProp(e) && e.id.toLowerCase() === offerId.toLowerCase());
  const fclaimEv = proven.find((e): e is ProvenPropose => isProp(e) && e.id.toLowerCase() === fclaimTxid.toLowerCase());
  if (!offerEv) return no("offer not merkle-proven (no PoW-verified offer Propose)");
  if (!fclaimEv) return no("fclaim not merkle-proven (no PoW-verified fclaim Propose)");
  if (fclaimEv.height < V28_HEIGHT) return no("fclaim mined below the V28 gate (no fclaim lane there)");
  const offerRec = bindRecord(offerEv);
  const fclaimRec = bindRecord(fclaimEv);
  if (!offerRec || offerRec.t !== "offer") return no("offer record does not bind to its on-chain commitment");
  if (!fclaimRec || fclaimRec.t !== "fclaim") return no("fclaim record does not bind to its on-chain commitment");
  if (fclaimRec.offer.toLowerCase() !== offerId.toLowerCase()) return no("fclaim does not reference this offer");
  if (isTokenWant(offerRec.want)) return no("the fclaim lane is CSD-priced offers only");
  const wantValue = BigInt((offerRec.want as { value: string }).value);
  const E = Number(fclaimEv.expiresEpoch);

  // 4. DEPTH GATE (holdPolicy): the two-tx claim->fill reorg residual. The OFFER, the FCLAIM, AND every
  //    earlier proven FILL-BASIS attest (the partial tail-flip bound: a shallow earlier partial could flip a
  //    signed tail below-min) must be buried >= requiredClaimDepth(want.value, offerAnchorHeight).
  const need = requiredClaimDepth(wantValue, offerEv.height).depth;
  // NaN-fail-closed: `!(x >= need)` refuses when depthOf is NaN (an off-contract seam feeding a non-numeric
  // depth/height), where the plain `x < need` would slip through (NaN < need is false).
  if (!(depthOf(offerEv) >= need)) return no(`offer not buried deep enough yet (${depthOf(offerEv)} < ${need}) - wait`);
  if (!(depthOf(fclaimEv) >= need)) return no(`fclaim not buried deep enough yet (${depthOf(fclaimEv)} < ${need}) - wait`);
  const laneIds = new Set<string>([offerId.toLowerCase()]);
  for (const e of proven) {
    if (!isProp(e)) continue;
    const r = e.id.toLowerCase() === fclaimTxid.toLowerCase() ? fclaimRec : bindRecord(e);
    if (r && r.t === "fclaim" && r.offer.toLowerCase() === offerId.toLowerCase()) laneIds.add(e.id.toLowerCase());
  }
  for (const e of proven) {
    if (e.kind === "attest" && e.score === SCORE_FILL && laneIds.has(e.proposalId.toLowerCase()) && !(depthOf(e) >= need))
      return no(`an earlier fill-basis event is not buried deep enough yet (${depthOf(e)} < ${need}) - wait`);
  }

  // 5. MANDATORY GRANT REPLAY over the merkle-proven events (NOT the served status / D2 "granted" alias).
  const r = replayLiveHold(proven, offerId, fclaimTxid, me, tip);
  if (!r.offer) return no("the offer does not resolve from the proven events (unknown/rejected offer)");

  // GUARD (cross-offer MAX_ACTIVE_CLAIMS cap): the lane-scoped replay CANNOT see the buyer's OTHER-offer live
  // holds, and the cap is the one grant clause counted across offers, so the replay under-counts it and would
  // grant a cap-DENIED fclaim. The authoring client (which signed its own claims) MUST assert how many OTHER
  // live holds it had when THIS fclaim was granted; if that is >= MAX_ACTIVE_CLAIMS the real resolver denied
  // this fclaim on the cap and the fill would burn. (B5/B6 must ALSO refuse to CREATE a claim at the cap;
  // this is the fill-side backstop, and it fails CLOSED if the count is not asserted.)
  if (!Number.isInteger(opts.myLiveHoldsAtGrant) || opts.myLiveHoldsAtGrant < 0)
    return no("the caller must assert myLiveHoldsAtGrant (the buyer's concurrent other-offer live-hold count) for the cap check");
  if (opts.myLiveHoldsAtGrant >= MAX_ACTIVE_CLAIMS) return no("you held the max active claims when this fclaim was granted - the resolver denied it on the cap, refusing (the payment would burn)"); // MUTATE_GUARD_CAP

  // GUARD (denied-fclaim): the live routing target must BE this fclaim AND it must be GRANTED in the
  // replayed state. A resolver-DENIED fclaim (a taken/expired/superseded offer) never routes here, so a
  // lying "granted" assertion cannot walk the payment onto an L0-valid but delivery-less target.
  if (!(r.routed && r.granted)) return no("this fclaim is not the live granted hold (denied or superseded) - refusing, the payment would burn"); // MUTATE_GUARD_R

  // GUARD (forged-cancel-holder): the offer must be OPEN and the live hold must be MINE. Catches a
  // cancelled/expired offer, a lapsed hold, and a hold held by someone else (me is not the holder).
  if (!r.heldByMe) return no("no live claim by you on an open offer (cancelled, lapsed, or not your hold) - refusing"); // MUTATE_GUARD_H

  // 6. DELIVERY: the payment must move >= 1 unit of the asset (the C3 zero-delivery trap). Status-independent
  //    (Guard above owns the open check), computed with the resolver's own previewFill math on the terms.
  let pay: bigint;
  try { pay = opts.pay !== undefined ? BigInt(opts.pay) : wantValue; } catch { return no("invalid pay amount"); }
  const dp = previewFill({ ...r.offer, status: "open" } as OfferState, pay);
  if (!dp.deliverable || dp.got < 1n) return no("this fill would deliver 0 units - refusing (the CSD would be lost)");

  // 7. DEADLINE (client policy; never a fund risk, always fail-safe): refuse within FILL_TIP_MARGIN of
  //    holdEnd so the payment cannot strand as an L0-unminable no-op past the hold. Computed from the
  //    fclaim's ACTUAL confirmed expiry epoch, NOT epochOf(tip+45).
  const holdEnd = fclaimHoldEnd(E);
  if (holdEnd < tip + FILL_TIP_MARGIN) return no(`too close to the hold deadline (holdEnd ${holdEnd}, tip ${tip}) - would strand`);

  return { safe: true, reason: "ok" };
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
export interface ProvenOfferTerms { height: number; feeBps: number; value?: string; taker?: string; bid?: string; min?: string }

// The treasury fee rate the resolver STAMPS on an offer at its creation height (resolve.ts: v11 ? (v16 ?
// FEE_BPS_V16 : FEE_BPS) : 0). requiredFillOutputs sizes the treasury fee from offer.feeBps, so binding a
// served feeBps to feeBpsAt(the MERKLE-PROVEN creation height) stops a lying resolver deflating it. Single-
// sourced here so the wallet fillspv, the site swapguard and any dApp bind the SAME rate.
export const feeBpsAt = (height: number): number =>
  height >= V11_HEIGHT ? (height >= V16_HEIGHT ? FEE_BPS_V16 : FEE_BPS) : 0;

// Build the normalized ProvenOfferTerms from a MERKLE-PROVEN offer record + its proven creation height. The
// value/taker/bid/min are copied from the record (lower-cased for addr-like fields, string-coerced), feeBps is
// derived from the height. A caller feeds this the record it already merkle-bound (bindRecord / verifyTxInclusion).
export function provenOfferTerms(offerRec: OfferRecord, provenHeight: number): ProvenOfferTerms {
  const w = offerRec.want as { value?: string };
  return {
    height: Number(provenHeight),
    feeBps: feeBpsAt(Number(provenHeight)),
    value: w.value !== undefined ? String(w.value) : undefined,
    taker: offerRec.taker !== undefined ? String(offerRec.taker).toLowerCase() : undefined,
    bid: offerRec.bid !== undefined ? String(offerRec.bid).toLowerCase() : undefined,
    min: offerRec.min !== undefined ? String(offerRec.min) : undefined,
  };
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
 */
export function bindOfferTerms(servedOffer: unknown, t: ProvenOfferTerms): boolean {
  const o = servedOffer as { height?: unknown; feeBps?: unknown; want?: { value?: unknown }; taker?: unknown; bid?: unknown; min?: unknown };
  const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v).toLowerCase());
  if (Number(o?.height) !== t.height) return true;
  if (Number(o?.feeBps) !== t.feeBps) return true;
  if (t.value !== undefined && String(o?.want?.value) !== t.value) return true;
  if (s(o?.taker) !== s(t.taker)) return true;
  if (s(o?.bid) !== s(t.bid)) return true;
  const om = o?.min;
  if ((om !== undefined && om !== null) !== (t.min !== undefined)) return true;
  if (t.min !== undefined && String(om) !== t.min) return true;
  return false;
}

// Derive the payment recipients + terms from a MERKLE-PROVEN offer Propose event (the "expose proven
// terms/author" surface). `seller` = the event's prevout-bound author (proposer, consensus hash160(input[0]));
// `payto` = the record's explicit want.payto (merkle-committed) or, absent, the seller; `terms` = the
// normalized ProvenOfferTerms. Returns null (fail closed) if the event does not bind to an offer record. The
// caller binds the resolver-served payto/seller to these and calls bindOfferTerms(servedOffer, result.terms).
export function bindProvenOffer(offerEv: ProvenPropose): { payto: string; seller: string; terms: ProvenOfferTerms } | null {
  const rec = bindRecord(offerEv);
  if (!rec || rec.t !== "offer") return null;
  const seller = String(offerEv.proposer).toLowerCase();
  const w = rec.want as { payto?: string };
  const payto = (w.payto && ADDR_RE.test(String(w.payto).toLowerCase())) ? String(w.payto).toLowerCase() : seller;
  return { payto, seller, terms: provenOfferTerms(rec, offerEv.height) };
}
