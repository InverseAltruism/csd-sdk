// The cursor of the two paged reads, events() and transfers(): `height:pos:eventsHash`. (height, pos) names the
// transaction of the last item a page handed out (positions are distinct in a block and a transaction is one event,
// CONVENTION section 34.2), or the whole height when pos is the largest safe integer. It is not a sort key: each read
// resumes after the named event in its own order. The events hash is the replica's at that height, over every event
// at or below it, so while it is the replica's, nothing a caller read before the cursor has left the branch and
// nothing unread lies at or below it.
import { applyOrder, type ChainEvent } from "@inversealtruism/cairnx-core";
import type { BoundCursor } from "./answer.js";
import type { BlockRow } from "./types.js";

/** The position of a cursor that names its whole height. */
export const WHOLE_HEIGHT = Number.MAX_SAFE_INTEGER;
export interface Bound { readonly height: number; readonly pos: number; readonly hash: string }
const BOUND = /^(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(0x[0-9a-f]{64})$/;
/** The position a cursor names: null for none, undefined for a cursor out of form. */
export function boundOf(c: unknown): Bound | null | undefined {
  if (c === null) return null;
  const m = typeof c === "string" ? BOUND.exec(c) : null;
  if (m === null) return undefined;
  const height = Number(m[1]), pos = Number(m[2]);
  return Number.isSafeInteger(height) && Number.isSafeInteger(pos) ? { height, pos, hash: m[3]! } : undefined;
}

/** What a cursor is checked against: the replica's cursor height, its events hashes and its held rows (Loop's). */
export interface HeldChain {
  readonly cursorHeight: number;
  eventsHashAt(height: number): string | null;
  /** The held rows at or above a height, ascending. */
  rows(fromHeight: number): readonly BlockRow[];
}
/** Where a page starts. `from`: after `since` (null for the first page), whose named event is `event` (null for a
 *  whole height). `above-tip`: the cursor lies above the replica's and cannot be compared yet. `off-branch`: its hash
 *  is not the replica's at its height. `invalid`: its position names no held event. */
export type Resume =
  | { readonly kind: "from"; readonly since: Bound | null; readonly event: ChainEvent | null }
  | { readonly kind: "above-tip"; readonly since: Bound } | { readonly kind: "off-branch" } | { readonly kind: "invalid" };

export function resumeOf(since: Bound | null, q: HeldChain): Resume {
  if (since === null) return { kind: "from", since, event: null };
  if (since.height > q.cursorHeight) return { kind: "above-tip", since };
  if (q.eventsHashAt(since.height) !== since.hash) return { kind: "off-branch" };
  if (since.pos === WHOLE_HEIGHT) return { kind: "from", since, event: null };
  // With the hash the replica's, a position that names no held event was not handed out by a read.
  const row = q.rows(since.height)[0], event = row?.height === since.height ? row.events.find((e) => e.pos === since.pos) : undefined;
  return event === undefined ? { kind: "invalid" } : { kind: "from", since, event };
}

/** Whether `e` lies after the cursor in the apply order of CONVENTION section 33.3 (events()'s order). */
export function afterInApplyOrder(e: ChainEvent, r: Extract<Resume, { kind: "from" }>): boolean {
  const s = r.since;
  return s === null || e.height > s.height || (e.height === s.height && r.event !== null && applyOrder(e, r.event) > 0);
}

const text = (b: Bound): BoundCursor => `${b.height}:${b.pos}:${b.hash}`;
function cursorAt(q: Pick<HeldChain, "eventsHashAt">, height: number, pos: number): BoundCursor {
  const hash = q.eventsHashAt(height);
  // Every height a cursor is made at lies at or below the deep height, which lies at or below the replica's cursor.
  if (hash === null) throw new Error(`cursor: no events hash held at ${height}`);
  return text({ height, pos, hash });
}
/** The cursor a page hands out: a cursor above the replica's, kept; its last item's position when more follow; else a
 *  `since` above the deep height, kept; else the deep height whole, so `next` does not pass the deep height. */
export function nextOf(q: Pick<HeldChain, "eventsHashAt">, deepHeight: number, r: Resume & { kind: "from" | "above-tip" }, last: { readonly height: number; readonly pos: number } | undefined, more: boolean): BoundCursor {
  if (r.kind === "above-tip") return text(r.since);
  if (more && last !== undefined) return cursorAt(q, last.height, last.pos);
  return r.since !== null && r.since.height > deepHeight ? text(r.since) : cursorAt(q, deepHeight, WHOLE_HEIGHT);
}
