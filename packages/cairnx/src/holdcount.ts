// The buyer's other fclaim holds at the grant of one fclaim: the `myLiveHoldsAtGrant` count verifyFillSpv takes
// for the MAX_ACTIVE_CLAIMS clause, which its lane-scoped replay cannot see. Not consensus: resolve() reads none
// of it. The resolver counts at the grant (liveHoldCount in src/resolve/context.ts), over holds granted before it
// in apply order, so an fclaim mined after the target, in a later block or later in the same block, is never part
// of the count.
import { parseRecord } from "./records.js";
import { fclaimHoldEnd } from "./types.js";

/** An fclaim Propose the buyer may hold, read from a merkle-bound block. `proposer` is the prevout-bound author,
 *  or the buyer when it cannot be bound (over-counting only refuses a fill; under-counting can burn one). */
export interface HoldCandidate { id: string; height: number; pos: number; proposer: string; uri: string; payloadHash: string; expiresEpoch: number }

/** The fclaim being filled: its id, its proven block height and position, and the offer it reserves. */
export interface HoldTarget { id: string; height: number; pos: number; offer: string }

/**
 * An upper bound of the buyer's live holds on other offers when `target` was granted: distinct other offers with
 * an fclaim by `me` applied before the target (height, then position in the block) whose hold is still live at the
 * target's height. `closed` names fclaims whose offer the buyer's own proven fill closed (myProvenFillClosedOffer);
 * they are skipped. An earlier fclaim the resolver denied is still counted: its denial is not visible here.
 */
export function countOtherHoldsAtGrant(
  candidates: readonly HoldCandidate[], target: HoldTarget, me: string, closed: ReadonlySet<string> = new Set(),
): number {
  const meL = String(me).toLowerCase(), tid = String(target.id).toLowerCase(), toffer = String(target.offer).toLowerCase();
  const offers = new Set<string>();
  for (const c of candidates) {
    const cid = String(c.id).toLowerCase();
    if (cid === tid || closed.has(cid) || String(c.proposer).toLowerCase() !== meL) continue;
    if (!(c.height < target.height || (c.height === target.height && c.pos < target.pos))) continue;
    if (!(fclaimHoldEnd(Number(c.expiresEpoch)) >= target.height)) continue;   // lapsed before the grant
    const rec = parseRecord(String(c.uri), String(c.payloadHash));
    if (!rec || rec.t !== "fclaim") continue;
    const offer = String(rec.offer).toLowerCase();
    // at most one live hold per offer: a second fclaim on an offer held live is denied
    if (offer !== toffer) offers.add(offer);
  }
  return offers.size;
}
