// What every Store checks before it writes a commit, whatever holds its bytes: the key it was opened under, the
// stored cursor, and the commit's shape. memory-store.ts and disk-store.ts both import it.
import { EVENTS_HASH_START } from "@inversealtruism/cairnx-core";
import { sameBasis } from "./basis.js";
import { sameRule } from "./contract.js";
import { ROWS_HASH_START } from "./rowshash.js";
import type { BlockRow, Commit, Cursor, Store } from "./types.js";

export type StoreKey = Parameters<Store["open"]>[0];

export const sameCursor = (a: Cursor | null, b: Cursor | null): boolean =>
  a === b || (a !== null && b !== null && a.height === b.height && a.hash === b.hash);
export const heightOf = (c: Cursor | null): number => c?.height ?? -1;

/** The first of format, rule and basis on which `a` differs from `b`, or null. */
export const keyDifference = (a: StoreKey, b: StoreKey): "format" | "rule" | "basis" | null =>
  a.format !== b.format ? "format" : !sameRule(a.rule, b.rule) ? "rule" : !sameBasis(a.basis, b.basis) ? "basis" : null;

/** The height a commit keeps everything at or below: its rollback's, or every held height for an extend. */
export const keptHeight = (c: Commit): number => ("rollbackTo" in c ? heightOf(c.rollbackTo) : Number.POSITIVE_INFINITY);

/** The two running values of a row. */
export type Hashes = Pick<BlockRow, "eventsHash" | "rowsHash">;

const ascending = (hs: number[], above: number): boolean => hs.every((h, i) => h > (i === 0 ? above : hs[i - 1]!));

/** Whether a commit's shape holds against what the store keeps of it: `lastBoundary`, the height of the last boundary
 *  kept, and `lastKept`, the last row kept. A rollback goes down from the stored cursor and carries no rows, boundaries
 *  or window (a value that bypassed the types with any of them is refused); an extend's rows lie above the stored
 *  cursor in ascending height, its cursor at or above the last row and its boundaries above the last one kept. The
 *  meta's events hash and rows hash are those of the last row held after the commit, or the start values. */
export function commitShapeOk(c: Commit, lastBoundary: number, lastKept: Hashes | undefined): boolean {
  const loose = c as Partial<{ rows: BlockRow[]; boundaries: unknown[]; headerWindow: Uint8Array }>;
  let last: Hashes | undefined = lastKept;
  if ("rollbackTo" in c) {
    if ((loose.rows?.length ?? 0) > 0 || (loose.boundaries?.length ?? 0) > 0 || loose.headerWindow !== undefined) return false;
    if (!(heightOf(c.rollbackTo) <= heightOf(c.expect)) || !sameCursor(c.meta.cursor, c.rollbackTo)) return false;
  } else {
    const base = heightOf(c.expect), rows = c.rows.map((r) => r.height);
    last = c.rows.at(-1) ?? lastKept;
    if (!ascending(rows, base) || !(heightOf(c.meta.cursor) >= (rows.at(-1) ?? base)) || !ascending(c.boundaries.map((b) => b.height), lastBoundary)) return false;
  }
  return c.meta.eventsHash === (last?.eventsHash ?? EVENTS_HASH_START) && c.meta.rowsHash === (last?.rowsHash ?? ROWS_HASH_START);
}
