// The prepared view of one published state: every list's rows in each of its orders, their key indexes and counts,
// and the `at` triple. Built once per publish; nothing is built on a request or keyed on object identity.
import { HASH_RE, type CairnXState } from "@inversealtruism/cairnx-core";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { At } from "../envelope.js";
import { deepFreeze } from "../freeze.js";
import { decimal } from "../grammar.js";
import { CAIRNX_API_VERSION } from "../version.js";
import { LISTS } from "./lists.js";

/** What the host knows of the state it publishes. `input` is its identity of the event list (the service's replay
 *  fingerprint, a replica's events hash), `core` the cairnx-core version the process loaded. */
export interface ViewSource { height: number; hash: string; input: string; core: string }

export interface View {
  readonly at: Readonly<At>;
  readonly lists: { readonly [R in keyof typeof LISTS]: ReturnType<(typeof LISTS)[R]["build"]> };
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The first 16 hex digits of sha256 over the event-list identity, the core version and this package's version, joined
 *  by newlines. Neither part may hold a newline, so the join is one to one. */
export function revOf(input: string, core: string, api: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${input}\n${core}\n${api}`))).slice(0, 16);
}

/** The view of `state` at the block `height`:`hash`. The state is read during the call only, never written, and the
 *  view shares no object with it; the view is frozen at every depth. Throws a TypeError on a malformed source. */
export function prepareView(state: CairnXState, source: ViewSource): View {
  const { height, hash, input, core } = source;
  if (decimal(String(height)) !== height || state.tipHeight !== height) throw new TypeError("prepareView: height is not the state's tip height");
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new TypeError("prepareView: hash is not a block hash");
  if (typeof input !== "string" || input === "" || input.includes("\n")) throw new TypeError("prepareView: input is empty or holds a newline");
  if (typeof core !== "string" || !VERSION_RE.test(core)) throw new TypeError("prepareView: core is not a version");
  return deepFreeze({
    at: { height, hash, rev: revOf(input, core, CAIRNX_API_VERSION) },
    lists: {
      names: LISTS.names.build(state), bids: LISTS.bids.build(state), tokens: LISTS.tokens.build(state),
      events: LISTS.events.build(state), holders: LISTS.holders.build(state), offers: LISTS.offers.build(state),
    },
  });
}
