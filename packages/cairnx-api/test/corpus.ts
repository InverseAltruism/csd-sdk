// cairnx-core's committed replay corpus (1,133 events to height 117,000), found through cairnx-core's resolved entry in
// the workspace, resolved once, with the v1 rows of each list derived as the row types define them (the unbounded
// arrays replaced by their counts). The handlers that build rows for answers are not in this package yet.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { resolve, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";
import type { BidRow, EventRow, HolderRow, OfferRow, RowOf } from "../src/index.js";

const core = join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..");
const corpus = JSON.parse(readFileSync(join(core, "test/vectors/replay-corpus.json"), "utf8")) as { tipHeight: number; events: ChainEvent[] };

/** The state, through a JSON round trip: what a client of an answer can see (an undefined field is absent). */
export const state = JSON.parse(JSON.stringify(resolve(corpus.events, corpus.tipHeight))) as CairnXState;
export const tipHeight = corpus.tipHeight;
/** The corpus records themselves, the input the state was resolved from. */
export const events: readonly ChainEvent[] = corpus.events;

// fillCount as OfferRow defines it: a partial offer's fills, else one whole fill, else none.
const offer = ({ fills, ...rest }: CairnXState["offers"][string]): OfferRow =>
  ({ ...rest, fillCount: fills !== undefined ? fills.length : rest.fill !== undefined ? 1 : 0 });
const bid = ({ offers, ...rest }: CairnXState["bids"][string]): BidRow => ({ ...rest, offerCount: offers.length });
const event = (e: CairnXState["events"][number]): EventRow =>
  ({ txid: e.id, height: e.height, pos: e.pos, kind: e.kind, applied: e.ok, code: e.code ?? null });
const holders: HolderRow[] = Object.values(state.balances).flatMap((m) => Object.entries(m).map(([address, b]) => ({ address, ...b })));

export const rows: { [R in keyof RowOf]: RowOf[R][] } = {
  names: Object.values(state.names),
  bids: Object.values(state.bids).map(bid),
  tokens: Object.values(state.tokens),
  events: state.events.map(event),
  holders,
  offers: Object.values(state.offers).map(offer),
};
