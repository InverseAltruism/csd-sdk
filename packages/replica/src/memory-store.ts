// A Store held in memory for as long as its object lives. A commit is checked whole before any part of it is written,
// so a refused commit leaves every part as it was; what goes in and comes out is copied, never shared with the caller.
import type { EventRule } from "@inversealtruism/cairnx-core";
import { checkBasis, sameBasis } from "./basis.js";
import type { BlockRow, Boundary, Commit, Cursor, Store, StoreMeta } from "./types.js";

type Key = Parameters<Store["open"]>[0];
const sameRule = (a: EventRule, b: EventRule): boolean => a.domain === b.domain && a.activationHeight === b.activationHeight;
const sameCursor = (a: Cursor | null, b: Cursor | null): boolean =>
  a === b || (a !== null && b !== null && a.height === b.height && a.hash === b.hash);
const heightOf = (c: Cursor | null): number => c?.height ?? -1;
// The first of format, rule and basis on which `a` differs from `b`, or null.
const difference = (a: Key, b: Key): "format" | "rule" | "basis" | null =>
  a.format !== b.format ? "format" : !sameRule(a.rule, b.rule) ? "rule" : !sameBasis(a.basis, b.basis) ? "basis" : null;
const ascending = (hs: number[], above: number): boolean => hs.every((h, i) => h > (i === 0 ? above : hs[i - 1]!));

// A rollback goes down from the stored cursor; new rows lie above what is kept, in ascending height, so no block is
// held twice; the new cursor is at or above the last row; boundaries ascend above the last one kept.
function shapeOk(c: Commit, lastBoundary: number): boolean {
  const base = c.rollbackTo === undefined ? heightOf(c.expect) : heightOf(c.rollbackTo);
  const rows = c.rows.map((r) => r.height);
  return base <= heightOf(c.expect) && ascending(rows, base) && heightOf(c.meta.cursor) >= (rows.at(-1) ?? base) &&
    ascending(c.boundaries.map((b) => b.height), lastBoundary);
}

/** A store in memory. Pages use it, since a page has no trusted slot to confirm a stored copy with. */
export function memoryStore(): Store {
  let meta: StoreMeta | null = null, rows: BlockRow[] = [], bounds: Boundary[] = [], window: Uint8Array | null = null;
  let opened: Key | null = null;
  return {
    async open(expect) {
      opened = null;
      checkBasis(expect.basis);
      const reset = meta === null ? null : difference(meta, expect);
      if (reset !== null) return { ok: false, reset };
      opened = structuredClone(expect);
      return { ok: true, meta: structuredClone(meta) };
    },
    async *rows(fromHeight) {
      for (const r of rows) if (r.height >= fromHeight) yield structuredClone(r);
    },
    boundaries: async () => structuredClone(bounds),
    headerWindow: async () => window && window.slice(),
    async commit(c) {
      if (opened === null || difference(c.meta, opened) !== null) return { ok: false, code: "STORE_FAILED" };
      if (!sameCursor(c.expect, meta?.cursor ?? null)) return { ok: false, code: "CURSOR_MOVED" };
      const keep = c.rollbackTo === undefined ? Number.POSITIVE_INFINITY : heightOf(c.rollbackTo);
      const kept = bounds.filter((b) => b.height <= keep);
      if (!shapeOk(c, kept.at(-1)?.height ?? -1)) return { ok: false, code: "STORE_FAILED" };
      const copy = structuredClone(c);
      rows = [...rows.filter((r) => r.height <= keep), ...copy.rows];
      bounds = [...kept, ...copy.boundaries];
      if (copy.headerWindow !== undefined) window = copy.headerWindow;
      meta = copy.meta;
      return { ok: true };
    },
    async reset() {
      meta = null; rows = []; bounds = []; window = null; opened = null;
    },
    close() {
      opened = null;
    },
  };
}
