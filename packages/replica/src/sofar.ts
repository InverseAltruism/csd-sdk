import type { ChainEvent, EventsSoFar } from "@inversealtruism/cairnx-core";

/** The two sets of CONVENTION section 33.2 inside one step: the loop's `base`, which holds the events below the
 *  cursor and grows only at a commit, and the events of the step's blocks read so far, added in height order. */
export function stepSofar(base: EventsSoFar): { view: EventsSoFar; add(events: readonly ChainEvent[]): void } {
  const ids = new Set<string>(), proposeIds = new Set<string>();
  return {
    view: {
      eventIds: { has: (id) => ids.has(id) || base.eventIds.has(id) },
      proposeIds: { has: (id) => proposeIds.has(id) || base.proposeIds.has(id) },
    },
    add(events) {
      for (const e of events) {
        if (e.kind === "propose") { ids.add(e.id); proposeIds.add(e.id); } else ids.add(e.txid);
      }
    },
  };
}
