// Types of moves-check.mjs for the TypeScript tests (a declaration beside a .mjs is what the compiler reads, so the
// module itself stays plain JavaScript like the rest of conformance/).
import type { CairnXState, TokenMove } from "../packages/cairnx/src/index.js";

export interface MovesCheck {
  /** every failed check, one line each; empty when the moves pass */
  problems: string[];
  /** the moves checked, per leg */
  legs: Record<TokenMove["leg"], number>;
  /** the (ticker, address) pairs the identity was checked on */
  pairs: number;
  /** the log entries that carry moves */
  entries: number;
}

export declare function checkMoves(state: CairnXState, treasury: string): MovesCheck;
