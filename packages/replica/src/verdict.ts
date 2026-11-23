// The verified rule (design section 4), before a read's own conditions (its input and SHALLOW, reader.ts). Each
// condition that fails adds its code, in this order; an answer is verified only when none does. The tip is the one
// the loop's last step reported (LoopStatus.tip), never Source.tip(), which under a caller root names the caller's
// tip whatever the store holds.
import { FINAL_DEPTH } from "@inversealtruism/cairnx-core";
import { TARGET_BLOCK_SECS } from "@inversealtruism/csd-codec";
import type { NotVerifiedCode } from "./codes.js";
import type { Cursor, TipView } from "./types.js";

/** How old a tip header or a witness's confirmation may be: 30 minutes. A source that serves final blocks only
 *  (`finalOnly`) reports a tip FINAL_DEPTH blocks below the chain's, so its tip may be older by that many target block
 *  times. */
export const FRESH_MS = 30 * 60_000;
/** How old a tip header may be before a replica's server withholds its answers (the note TIP_STALE_LONG): 6 hours, 180
 *  target block times, long against a drought between blocks and short against a source that is syncing or stopped. */
export const STALE_MAX_MS = 6 * 60 * 60_000;
/** How long a replica's steps may fail, with none settled, before its server withholds its answers (the note
 *  SOURCE_FAILING): FRESH_MS, from the first failed step. The loop's backoff doubles from 1 s to 300 s, so a count of
 *  failures would fire within a host's restart (five in 31 s), and a drought does not reach it, since steps settle idle
 *  there. */
export const FAILING_MS = FRESH_MS;
/** Whether a loop's steps have failed for more than FAILING_MS at `now` (ms): `since` is the first failed step after
 *  the last that settled (LoopStatus.failingSince), null when none has failed since. */
export const failing = (now: number, since: number | null): boolean => since !== null && now - since > FAILING_MS;
const FINAL_AGE_S = FINAL_DEPTH * TARGET_BLOCK_SECS;
/** Whether a tip of header time `tipTime` (seconds) is older than `ms` at `now` (ms), with a final-only source's
 *  allowance. */
export const olderThan = (now: number, tipTime: number, ms: number, finalOnly: boolean): boolean =>
  now / 1000 - tipTime > ms / 1000 + (finalOnly ? FINAL_AGE_S : 0);
/** Whether a witness's tip `lead` blocks above the replica's is far ahead (the note PEER_FAR_AHEAD): more than
 *  FINAL_DEPTH, with a final-only source's allowance of FINAL_DEPTH more, the depth its tip sits under the chain tip. */
export const farAhead = (lead: number, finalOnly: boolean): boolean => lead > FINAL_DEPTH + (finalOnly ? FINAL_DEPTH : 0);

export interface VerdictInput {
  readonly level: 1 | 2 | 3; readonly feed: boolean;
  /** Whether the source's tip is its final height, FINAL_DEPTH below the chain tip it read (a feed with inclusion). */
  readonly finalOnly?: boolean;
  /** The store open with a cursor and a step's tip, else null. */
  readonly synced: { readonly cursor: Cursor; readonly tip: TipView } | null;
  readonly now: number;
  /** Whether a gate table held differs from the loaded core's when cut at `tip`. */
  rulesDiffer(tip: number): boolean;
  /** Whether a witness's last answer is a plausible higher tip than `tip`. */
  peerAhead(tip: TipView): boolean;
  /** Null when the root needs no witness (one's own node, a feed); else the time of the confirmation held, or null. */
  readonly witness: { readonly at: number | null } | null;
  /** Whether the store was reset as unconfirmed and is being refilled (LoopStatus.unconfirmed). */
  readonly unconfirmed: boolean;
  /** Under a pinned basis, the source's refusal of its pin (pinned.ts), which it repeats at every later step; else null. */
  readonly refused: "PIN_MISMATCH" | "PIN_OFF_CHAIN" | "RULES_DIFFER" | null;
  /** Whether a reference holds the pin's block with another events hash at the pin's height (compare.ts). */
  readonly disputed?: boolean;
}

/** The level condition, the first of the rule: null at level 3, else a feed's LEVEL_FEED or a display's LEVEL_DISPLAY.
 *  `./display` states its answers' level with it. */
export const levelCode = (level: 1 | 2 | 3, feed: boolean): NotVerifiedCode | null => (level === 3 ? null : feed ? "LEVEL_FEED" : "LEVEL_DISPLAY");

export function verdict(v: VerdictInput): NotVerifiedCode[] {
  const why: NotVerifiedCode[] = [], lv = levelCode(v.level, v.feed);
  if (lv !== null) why.push(lv);
  if (v.rulesDiffer(v.synced?.tip.height ?? Number.POSITIVE_INFINITY) || v.refused === "RULES_DIFFER") why.push("RULES_DIFFER");
  if (v.refused === "PIN_MISMATCH" || v.refused === "PIN_OFF_CHAIN") why.push(v.refused);
  if (v.disputed === true) why.push("PIN_DISPUTED");
  const s = v.synced;
  if (s === null) why.push("NOT_SYNCED");
  else {
    if (s.cursor.height < s.tip.height) why.push("BEHIND");
    if (s.cursor.height > s.tip.height) why.push("BRANCH_UNRESOLVED");
    if (olderThan(v.now, s.tip.time, FRESH_MS, v.finalOnly === true)) why.push("TIP_STALE");
    if (v.peerAhead(s.tip)) why.push("TIP_BEHIND_PEER");
  }
  if (v.unconfirmed) why.push("STORE_UNCONFIRMED");
  if (v.witness !== null) {
    if (v.witness.at === null) why.push("NOT_WITNESSED");
    else if (v.now - v.witness.at > FRESH_MS) why.push("WITNESS_SILENT");
  }
  return why;
}
