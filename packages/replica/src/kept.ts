// The events a Scanner keeps from its accepted scans (M3-B1-03), so that its next scan reads only the rows after them
// from csd-indexer's chain-order feeds: the data and its pure helpers. src/scan.ts decides when they are kept, read on
// from, rolled back or dropped.
import type { AttestEvent, ChainEvent, ProposeEvent } from "@inversealtruism/cairnx-core";

/** A block by height and hash, as `/block-height/:h` reads it. */
export interface Block { h: number; hash: string }
/** A place in chain order (block height, position in the block): the keyset of csd-indexer's chain-order feeds. */
export interface ChainPos { height: number; pos: number }
const laterOf = (c: ChainPos | null, e: ChainPos): ChainPos =>
  (!c || e.height > c.height || (e.height === c.height && e.pos > c.pos) ? { height: e.height, pos: e.pos } : c);
const idOf = (e: ChainEvent): string => (e.kind === "propose" ? e.id : e.txid);
/** The order the full pull lists rows in: csd-indexer serves the proposals and each attestation list by (height,
 *  txid), and lowercase 0x-hex txids compare the same under every collation (queries.ts attestationsFor). */
export const fullPullOrder = (a: ChainEvent, b: ChainEvent): number =>
  a.height - b.height || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);

/** What one Scanner keeps: read on from by its next scan instead of every open proposal's whole attestation list. */
export interface Kept {
  /** Every cairnx:v1 proposal and attestation at or below this height is kept, and none above it. */
  upTo: number;
  /** A block at or above `upTo` of the chain the rows came from: while it is still on the chain, so are they. */
  anchor: Block;
  /** A lower block of that chain (the accepted scan's tip less FINALITY): a reorg above it rolls the rows back to it. */
  deep: Block | null;
  /** In the full pull's order: each proposal's event, then its attestations' events. */
  props: Map<string, { pe: ProposeEvent; atts: AttestEvent[] }>;
  /** Every kept event's id: a feed row that repeats one is a broken feed, read in full instead. */
  ids: Set<string>;
  /** The last kept row of each feed in chain order; the next read starts after it. */
  last: { p: ChainPos | null; a: ChainPos | null };
  /** How many accepted scans served these events, the full pull they were taken from counted as the first. */
  scans: number;
}
/** At most this many events are kept (the memory bound); past it every scan is the full pull, which drops nothing. */
export const MAX_KEPT_EVENTS = 200_000;
/** Once kept events have served this many accepted scans, the next scan pulls in full and its events replace them. The
 *  feed reads after the kept rows never revisit them; that full pull re-reads the proposal list and each open window's
 *  attestation list. So a proposal, or an attestation in an open window, that the chain does not have (read from
 *  another branch inside an accepted scan) is served for at most this many accepted scans: about 10 minutes at the
 *  resolver's default 15 s poll (src/config.ts DEFAULT_POLL_MS). A closed window's attestation list (the Scanner's
 *  attCache) and the tx cache are not re-read, so a row the chain does not have there outlives it
 *  (test/scan-kept-refresh.test.ts). */
export const KEPT_REFRESH_SCANS = 40;

/** The kept events of `events` (a full pull's, or kept ones rolled back, which keep their `scans`) at or below `upTo`,
 *  or null when there are more than `max` or an attestation's proposal is not kept with it (a feed that lies about row
 *  heights). */
export function keptFrom(events: ChainEvent[], upTo: number, anchor: Block, deep: Block | null, max: number, scans = 1): Kept | null {
  const props = new Map<string, { pe: ProposeEvent; atts: AttestEvent[] }>();
  const ids = new Set<string>();
  let p: ChainPos | null = null, a: ChainPos | null = null;
  for (const e of events) {
    if (e.height > upTo) continue;
    if (ids.size >= max) return null;
    ids.add(idOf(e));
    if (e.kind === "propose") {
      props.set(e.id, { pe: e, atts: [] });
      p = laterOf(p, e);
    } else {
      const entry = props.get(e.proposalId);
      if (!entry) return null;
      entry.atts.push(e);
      a = laterOf(a, e);
    }
  }
  return { upTo, anchor, deep, props, ids, last: { p, a }, scans };
}

/** The kept events in the full pull's order, each at or below `cut` when it is set (the final height with
 *  verifyInclusion on, which can sit below `upTo` once the verified tip moves back). */
export function eventsOf(k: Kept, cut: number | null): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const { pe, atts } of k.props.values()) {
    if (cut !== null && pe.height > cut) continue;
    out.push(pe);
    for (const a of atts) if (cut === null || a.height <= cut) out.push(a);
  }
  return out;
}
