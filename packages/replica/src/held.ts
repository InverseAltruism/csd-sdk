// The rows a loop holds and the two sets of CONVENTION section 33.2 derived from them. Rows read back from a store are
// checked before anything is replayed: they keep the contract a step keeps (contract.ts); the events hash stepped
// again from the start equals each row's, the meta's and each boundary's; and the rows hash stepped again equals each
// row's and the meta's. The rows hash covers every field of every event and each row's height and block hash
// (rowshash.ts), so a row changed in any field, dropped, added or moved makes the store corrupt.
import { EVENTS_HASH_START, type EventRule } from "@inversealtruism/cairnx-core";
import { checkBlocks } from "./contract.js";
import { eventId } from "./order.js";
import { ROWS_HASH_START } from "./rowshash.js";
import type { BlockRow, Boundary, StoreMeta } from "./types.js";

export class Held {
  rows: BlockRow[] = [];
  readonly eventIds = new Set<string>();
  readonly proposeIds = new Set<string>();
  count = 0;

  get eventsHash(): string { return this.rows.at(-1)?.eventsHash ?? EVENTS_HASH_START; }
  get rowsHash(): string { return this.rows.at(-1)?.rowsHash ?? ROWS_HASH_START; }

  /** Appends rows that lie above every held row. */
  add(rows: readonly BlockRow[]): void {
    for (const r of rows) {
      this.rows.push(r);
      for (const e of r.events) {
        this.count++;
        this.eventIds.add(eventId(e));
        if (e.kind === "propose") this.proposeIds.add(e.id);
      }
    }
  }

  /** Drops the rows above `height` and derives the sets again from the rows kept. */
  truncate(height: number): void {
    const keep = this.rows.filter((r) => r.height <= height);
    this.rows = [];
    this.eventIds.clear(); this.proposeIds.clear(); this.count = 0;
    this.add(keep);
  }

  // The index of the last row at or below `height`, or -1.
  private below(height: number): number {
    let lo = 0, hi = this.rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.rows[mid]!.height <= height) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
  eventsHashAt(height: number): string { return this.rows[this.below(height)]?.eventsHash ?? EVENTS_HASH_START; }
  hashAt(height: number): string | null {
    const r = this.rows[this.below(height)];
    return r?.height === height ? r.hash : null;
  }
}

/** The rows of a store as a Held, or null when they do not match the store's meta and boundaries. */
export function verifyRows(rows: readonly BlockRow[], boundaries: readonly Boundary[], meta: StoreMeta | null, rule: EventRule): Held | null {
  if (meta === null) return rows.length === 0 && boundaries.length === 0 ? new Held() : null;
  let c: ReturnType<typeof checkBlocks>;
  try {
    c = checkBlocks(rows, { after: rule.activationHeight - 1, eventsHash: EVENTS_HASH_START, rowsHash: ROWS_HASH_START, sofar: new Held(), rule });
  } catch {
    return null;   // a row either hash refuses: the store does not hold what the loop committed
  }
  const same = (r: BlockRow, i: number) => r.eventsHash === rows[i]!.eventsHash && r.rowsHash === rows[i]!.rowsHash;
  if (!c.ok || c.rows.length !== rows.length || !c.rows.every(same) || c.rowsHash !== meta.rowsHash) return null;
  const held = new Held();
  held.add(rows);
  const top = meta.cursor?.height ?? -1;
  const fits = (b: Boundary) => b.height <= top && b.eventsHash === held.eventsHashAt(b.height) && (held.hashAt(b.height) ?? b.hash) === b.hash;
  return c.eventsHash === meta.eventsHash && held.count === meta.eventCount && (rows.at(-1)?.height ?? -1) <= top && boundaries.every(fits)
    ? held : null;
}
