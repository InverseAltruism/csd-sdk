// The gate table: every activation height this core exports, by its exported name (ACTIVATION_HEIGHT, then V11 to
// V29). Built from the constants of types.ts, the one home of each height, so a reader that compares tables (two cores
// in one process, a replica and a witness) reads them without a copy of its own.
import {
  ACTIVATION_HEIGHT, V11_HEIGHT, V12_HEIGHT, V13_HEIGHT, V14_HEIGHT, V15_HEIGHT, V16_HEIGHT, V17_HEIGHT, V18_HEIGHT,
  V19_HEIGHT, V20_HEIGHT, V21_HEIGHT, V22_HEIGHT, V23_HEIGHT, V24_HEIGHT, V25_HEIGHT, V26_HEIGHT, V27_HEIGHT, V28_HEIGHT,
  V29_HEIGHT,
} from "./types.js";

/** Gate name to height: `ACTIVATION_HEIGHT` and each `V<n>_HEIGHT`, frozen. test/gates.test.ts keeps it equal to the
 *  individual exports and complete. It leaves out the one other exported height, `LEGACY_HOLD_SUNSET_HEIGHT`, which is
 *  derived from `V28_HEIGHT` and the claim window and grace, and which no replay rule reads. Two equal tables show
 *  equal gate heights, not equal rules: no fee, window or reserved-name constant is in the table. */
export const GATE_HEIGHTS = Object.freeze({
  ACTIVATION_HEIGHT, V11_HEIGHT, V12_HEIGHT, V13_HEIGHT, V14_HEIGHT, V15_HEIGHT, V16_HEIGHT, V17_HEIGHT, V18_HEIGHT,
  V19_HEIGHT, V20_HEIGHT, V21_HEIGHT, V22_HEIGHT, V23_HEIGHT, V24_HEIGHT, V25_HEIGHT, V26_HEIGHT, V27_HEIGHT, V28_HEIGHT,
  V29_HEIGHT,
});

export type GateName = keyof typeof GATE_HEIGHTS;
