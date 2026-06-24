// CairnX client-side reorg-safety helpers.
//
// These are NOT resolver rules — the resolver does not enforce confirmation depth — but they are part of
// the convention's SAFE-USAGE contract. A claim→fill on an open V17 offer is TWO transactions (a
// payment-free claim, then a separate payment-bearing fill), so unlike a single-tx atomic fill a reorg can
// drop the claim while the payment lands → the buyer forfeits. A client MUST therefore let the claim BURY
// before paying. Exported from cairnx-core so the browser UI, the wallet, and swapguard all gate on the
// SAME math instead of each re-deriving it (a divergence here would let one surface pay too early).
import { blockReward, INITIAL_REWARD } from "@inversealtruism/csd-codec";
import { claimWindowAt } from "./types.js";

export const CLAIM_ATTACKER_Q = 0.2;      // assumed external attacker hashrate share (the trusted pool is excluded)
export const CLAIM_MIN_DEPTH = 3;         // floor for any value — clears natural 1–2 block reorgs (~1.6% reversal at q=0.20)
export const COMMIT_REVEAL_MIN_DEPTH = 3; // a name commit must bury this deep before the reveal pays the fee (same reorg logic)

/**
 * Confirmations the CLAIM must have before a payment-bearing fill on an open V17 offer worth `valueSats`
 * (anchored at `height`) is reorg-safe. Returns `{ depth, reversalPct, capped }`; `capped=true` ⇒ the value
 * exceeds what one claim window can safely settle (the buyer should split the trade).
 *
 * A MINORITY attacker (the dominant pool is trusted; a majority means the chain is already lost) only profits
 * if `P(reverse D)·V > the honest reward it forgoes`, with `P(reverse D) ≈ (q/(1−q))^D` (gambler's ruin,
 * Nakamoto §11). That is logarithmic in value → ~3 conf for nearly every trade, 4 for a whale. Everything is
 * in CSD (block reward), so no USD price is needed. The required depth is capped at `claimWindow − 5` so a
 * capped/whale value stays fillable for a usable multi-block span rather than a 1-block knife-edge (only
 * absurd > total-supply values ever reach the cap).
 */
export function requiredClaimDepth(
  valueSats: number | bigint,
  height: number,
): { depth: number; reversalPct: number; capped: boolean } {
  const r = CLAIM_ATTACKER_Q / (1 - CLAIM_ATTACKER_Q); // 0.25 at q=0.20
  const V = Number(valueSats);
  const R = blockReward(height) || INITIAL_REWARD;
  const max = claimWindowAt(height) - 5; // 10 (<V20) / 35 (≥V20, window 40)
  for (let D = CLAIM_MIN_DEPTH; D <= max; D++) {
    if (Math.pow(r, D) * V <= D * R) return { depth: D, reversalPct: Math.pow(r, D) * 100, capped: false };
  }
  return { depth: max, reversalPct: Math.pow(r, max) * 100, capped: true };
}
