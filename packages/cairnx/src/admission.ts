// The admission check a client runs on a merkle-proven offer Propose before treating it as an offer: the proven
// tx's settlement domain, the activation height below which resolve() skips every event (beforeActivation), then
// the offer rules resolve() applies at creation without chain state (offerEnvelopeRefusal). Both are the
// resolver's own functions. The give's backing (a token balance, a name) is chain state and is not checked here.
import { ACTIVATION_HEIGHT, DOMAIN, beforeActivation, type OfferRecord } from "./types.js";
import { offerEnvelopeRefusal } from "./resolve/market.js";

/** Fields of the merkle-proven Propose: its app domain and expires_epoch, its inclusion height, and its author
 *  (csd-crypto authorOf). */
export interface ProvenOfferTx { domain: string; height: number; expiresEpoch: number | bigint; seller: string }

/** Why the proven offer Propose is not an offer the resolver admits (the resolver's own note for the record
 *  rules; the resolver writes no note below activation), or null when it passes. */
export function provenOfferRefusal(rec: OfferRecord, tx: ProvenOfferTx): string | null {
  if (tx.domain !== DOMAIN) return `not a ${DOMAIN} Propose (domain ${JSON.stringify(String(tx.domain))})`;
  if (beforeActivation(tx.height)) return `anchored before CairnX activation (block ${ACTIVATION_HEIGHT})`;
  // a bigint at or above 2^53 converts to an unsafe number, which the rule refuses as the resolver does
  const ee = typeof tx.expiresEpoch === "bigint" ? Number(tx.expiresEpoch) : tx.expiresEpoch;
  return offerEnvelopeRefusal(rec, String(tx.seller).toLowerCase(), tx.height, ee);
}
