// The apply order of CONVENTION section 33.3 (section 3): height, a block's Proposes before its Attests, position,
// then the ordinal order of the id. It is a copy of the sort inside cairnx-core's resolve(), which is consensus surface
// and exports no comparator; cairnx-core should export this one, and this module should then re-export it.
import type { ChainEvent } from "@inversealtruism/cairnx-core";

/** An event's id: a Propose's id, an Attest's transaction id. */
export const eventId = (e: ChainEvent): string => (e.kind === "propose" ? e.id : e.txid);
const ord = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Negative when `a` applies before `b`, zero when they are the same event. */
export const applyOrder = (a: ChainEvent, b: ChainEvent): number =>
  a.height - b.height || Number(a.kind === "attest") - Number(b.kind === "attest") || a.pos - b.pos || ord(eventId(a), eventId(b));
