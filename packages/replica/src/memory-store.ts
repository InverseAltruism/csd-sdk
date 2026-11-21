// A Store held in memory for as long as its object lives. A commit is checked whole before any part of it is written,
// so a refused commit leaves every part as it was; what goes in and comes out is copied, never shared with the caller.
import { checkBasis } from "./basis.js";
import { commitShapeOk, keptHeight, keyDifference, sameCursor, type StoreKey } from "./store-rules.js";
import type { BlockRow, Boundary, Store, StoreMeta } from "./types.js";

/** A store in memory. Pages use it, since a page has no trusted slot to confirm a stored copy with. */
export function memoryStore(): Store {
  let meta: StoreMeta | null = null, rows: BlockRow[] = [], bounds: Boundary[] = [], window: Uint8Array | null = null;
  let opened: StoreKey | null = null;
  return {
    async open(expect) {
      opened = null;
      checkBasis(expect.basis);
      const reset = meta === null ? null : keyDifference(meta, expect);
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
      if (opened === null || keyDifference(c.meta, opened) !== null) return { ok: false, code: "STORE_FAILED" };
      if (!sameCursor(c.expect, meta?.cursor ?? null)) return { ok: false, code: "CURSOR_MOVED" };
      const keep = keptHeight(c), kept = bounds.filter((b) => b.height <= keep);
      if (!commitShapeOk(c, kept.at(-1)?.height ?? -1, rows.filter((r) => r.height <= keep).at(-1))) return { ok: false, code: "STORE_FAILED" };
      const copy = structuredClone(c);
      rows = rows.filter((r) => r.height <= keep);
      bounds = kept;
      if (!("rollbackTo" in copy)) {
        rows.push(...copy.rows);
        bounds.push(...copy.boundaries);
        if (copy.headerWindow !== undefined) window = copy.headerWindow;
      }
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
