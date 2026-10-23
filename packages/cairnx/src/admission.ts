// The admission check a client runs on a merkle-proven offer Propose before treating it as an offer: the proven
// tx's settlement domain, then every rule resolve() applies at the offer's creation without chain state
// (offerEnvelopeRefusal, shared with the resolver). The give's backing (a token balance, a name) is chain state
// and is not checked here.
import { DOMAIN, type OfferRecord } from "./types.js";
import { offerEnvelopeRefusal } from "./resolve/market.js";

/** Fields of the merkle-proven Propose: its app domain and expires_epoch, its inclusion height, and its author
 *  (csd-crypto authorOf). */
export interface ProvenOfferTx { domain: string; height: number; expiresEpoch: number | bigint; seller: string }

/** Why the proven offer Propose is not an offer the resolver admits (the resolver's own note for the record
 *  rules), or null when it passes. */
export function provenOfferRefusal(rec: OfferRecord, tx: ProvenOfferTx): string | null {
  if (tx.domain !== DOMAIN) return `not a ${DOMAIN} Propose (domain ${JSON.stringify(String(tx.domain))})`;
  // a bigint at or above 2^53 converts to an unsafe number, which the rule refuses as the resolver does
  const ee = typeof tx.expiresEpoch === "bigint" ? Number(tx.expiresEpoch) : tx.expiresEpoch;
  return offerEnvelopeRefusal(rec, String(tx.seller).toLowerCase(), tx.height, ee);
}
