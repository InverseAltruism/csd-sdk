// Reverse / primary name (ENS-style addr→name), DERIVED from the existing nset round-trip with NO new
// record type: among names where owner === a AND addr === a (the on-chain "set as my primary" signal —
// only the owner can nset, and pointing at self costs an anchor, so it is sybil/grief-proof), not lapsed
// and not locked by an open offer, pick the unique winner by the resolver's own total order: lowest
// effectiveHeight, then ordinal (code-unit) comparison of claimId. Returns null if no name round-trips.
//
// This is the EXACT selection the V23 "unset" switches: an nset whose addr is the zero address clears
// n.addr (resolve.ts), so the cleared name fails the `addr === a` round-trip and drops out of this set —
// the next-oldest self-pointing name becomes primary.
//
// NOT part of canonicalState (a bug here cannot fork the chain; it only mis-derives the reverse-resolution
// display) — but every host MUST compute it identically or the wallet union (Granus vs clarvis / trade UI)
// false-disagrees on reverse resolution. Until 2026-07-06 it lived as hand-mirrors in the cairnx service
// (src/primary.ts) and the cairn trade UI (state.js primaryNameOf); both now import THIS. The query address
// is lowercased here (record fields are canonical lowercase on chain), killing the one documented nuance
// between the old copies. Golden vectors: cairnx/test/fixtures/primary-vectors.json (sibling repo), pinned
// by test/primary.test.ts in every consumer.
import type { NameState } from "./types.js";

/** The resolver's total order over primary-name candidates: does `a` outrank `b`?
 *  Lowest effectiveHeight wins; ties break by ordinal (code-unit) claimId. Exported separately because
 *  the trade UI's primary-SWITCH planner needs the comparator against a target, not the selection. */
export const primaryRankBefore = (a: NameState, b: NameState): boolean =>
  a.effectiveHeight < b.effectiveHeight ||
  (a.effectiveHeight === b.effectiveHeight && a.claimId < b.claimId);

/** The primary .csd name for address `a`, or null. Pure; no I/O. `a` may be any case. */
export function pickPrimaryName(names: Iterable<NameState>, a: string): string | null {
  const q = String(a).toLowerCase();
  let best: NameState | null = null;
  for (const n of names) {
    if (n.owner !== q || n.addr !== q) continue;     // round-trip: owns it AND points it at self
    if (n.expired === true || n.locked) continue;    // lapsed or locked by an open offer → not a candidate
    if (!best || primaryRankBefore(n, best)) best = n;
  }
  return best ? best.name : null;
}
