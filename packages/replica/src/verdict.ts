// The verified rule (design section 4), before a read's own conditions (its input and SHALLOW, reader.ts). Each
// condition that fails adds its code, in this order; an answer is verified only when none does. The tip is the one
// the loop's last step reported (LoopStatus.tip), never Source.tip(), which under a caller root names the caller's
// tip whatever the store holds.
import type { NotVerifiedCode } from "./codes.js";
import type { Cursor, TipView } from "./types.js";

/** How old a tip header or a witness's confirmation may be: 30 minutes. */
export const FRESH_MS = 30 * 60_000;

export interface VerdictInput {
  readonly level: 1 | 2 | 3; readonly feed: boolean;
  /** The store open with a cursor and a step's tip, else null. */
  readonly synced: { readonly cursor: Cursor; readonly tip: TipView } | null;
  readonly now: number;
  /** Whether a gate table held differs from the loaded core's when cut at `tip`. */
  rulesDiffer(tip: number): boolean;
  /** Whether a witness's last answer is a plausible higher tip than `tip`. */
  peerAhead(tip: TipView): boolean;
  /** Null when the root needs no witness (one's own node, a feed); else the time of the confirmation held, or null. */
  readonly witness: { readonly at: number | null } | null;
  /** Under a pinned basis, the source's refusal of its pin (pinned.ts), which it repeats at every later step; else null. */
  readonly refused: "PIN_MISMATCH" | "PIN_OFF_CHAIN" | "RULES_DIFFER" | null;
}

/** The level condition, the first of the rule: null at level 3, else a feed's LEVEL_FEED or a display's LEVEL_DISPLAY.
 *  `./display` states its answers' level with it. */
export const levelCode = (level: 1 | 2 | 3, feed: boolean): NotVerifiedCode | null => (level === 3 ? null : feed ? "LEVEL_FEED" : "LEVEL_DISPLAY");

export function verdict(v: VerdictInput): NotVerifiedCode[] {
  const why: NotVerifiedCode[] = [], lv = levelCode(v.level, v.feed);
  if (lv !== null) why.push(lv);
  if (v.rulesDiffer(v.synced?.tip.height ?? Number.POSITIVE_INFINITY) || v.refused === "RULES_DIFFER") why.push("RULES_DIFFER");
  if (v.refused === "PIN_MISMATCH" || v.refused === "PIN_OFF_CHAIN") why.push(v.refused);
  const s = v.synced;
  if (s === null) why.push("NOT_SYNCED");
  else {
    if (s.cursor.height < s.tip.height) why.push("BEHIND");
    if (s.cursor.height > s.tip.height) why.push("BRANCH_UNRESOLVED");
    if (v.now / 1000 - s.tip.time > FRESH_MS / 1000) why.push("TIP_STALE");
    if (v.peerAhead(s.tip)) why.push("TIP_BEHIND_PEER");
  }
  if (v.witness !== null) {
    if (v.witness.at === null) why.push("NOT_WITNESSED");
    else if (v.now - v.witness.at > FRESH_MS) why.push("WITNESS_SILENT");
  }
  return why;
}
