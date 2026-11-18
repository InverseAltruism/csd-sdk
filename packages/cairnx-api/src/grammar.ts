// The value grammars the parameters and cursors share. Names, tickers, addresses, hashes and amounts use cairnx-core's
// patterns; hex is lowercase only, and nothing is normalised.
import { AMOUNT_RE, MAX_AMOUNT } from "@inversealtruism/cairnx-core";

/** A `rev`: 16 lowercase hex digits. Internal: the form of `rev` is not part of the contract. */
export const REV_RE = /^[0-9a-f]{16}$/;

/** At most 15 digits: the front door's HEIGHT bound, below 10^15 and so within the safe integers. */
const HEIGHT_DIGITS = 15;
const MAX_AMOUNT_DIGITS = MAX_AMOUNT.toString().length;

/** A height, a position or a limit: a non-negative integer in its one decimal spelling (AMOUNT_RE: no sign, no
 *  leading zero) of at most 15 digits, else null. */
export function decimal(s: string): number | null {
  return s.length <= HEIGHT_DIGITS && AMOUNT_RE.test(s) ? Number(s) : null;
}

/** An amount in its one decimal spelling, at most MAX_AMOUNT, else null. A string longer than MAX_AMOUNT's digits is
 *  refused before BigInt sees it. */
export function amount(s: string): bigint | null {
  if (s.length > MAX_AMOUNT_DIGITS || !AMOUNT_RE.test(s)) return null;
  const n = BigInt(s);
  return n <= MAX_AMOUNT ? n : null;
}

/** `a:b` split at its one colon, else null. */
export function pair(s: string): [string, string] | null {
  const parts = s.split(":");
  return parts.length === 2 ? [parts[0] as string, parts[1] as string] : null;
}
