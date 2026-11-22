// The hash tuple of CONVENTION section 34 at an epoch boundary: (height, block hash, events hash, state hash), what two
// replicas compare (section 34.3). The book is the loop's boundaries (loop.ts): each is added once it is FINAL_DEPTH
// deep, dropped by a rollback below it, withheld while a rollback leaves it shallower than FINAL_DEPTH under the cursor,
// and kept by the store; a refused step commits none.
import type { Boundary } from "./types.js";

export interface Tuple { readonly height: number; readonly blockHash: string; readonly eventsHash: string; readonly stateHash: string }

/** The tuple of a boundary whose state hash is known, else null. */
export const tupleOf = (b: Boundary | null): Tuple | null =>
  b === null || b.stateHash === null ? null : { height: b.height, blockHash: b.hash, eventsHash: b.eventsHash, stateHash: b.stateHash };
