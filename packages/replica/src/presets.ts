// The presets of ./browser and ./server (design section 5): what open() takes for a replica of one's own node, with
// or without a pin, and for a page reading our hosted blocks above a pin. Each holds its store in memory.
import { checkPin } from "./basis.js";
import { hostedBlocks } from "./hosted-blocks.js";
import type { HttpOptions } from "./http.js";
import { memoryStore } from "./memory-store.js";
import type { NodeBlocksOptions } from "./node-blocks.js";
import { pinned } from "./pinned.js";
import type { OpenOptions } from "./reader.js";
import type { Witness } from "./answer.js";
import type { BlocksSource, Pin } from "./types.js";

/** `local` over an entry's own `nodeBlocks`: one's own node, above `pin` when one is given. */
export const localOf = (nodeBlocks: (o: NodeBlocksOptions) => BlocksSource) => (o: NodeBlocksOptions & { readonly pin?: Pin }): OpenOptions => {
  const { pin, ...rest } = o, blocks = nodeBlocks(rest);
  return { source: pin === undefined ? blocks : pinned({ pin, then: blocks }), store: memoryStore() };
};

/** `origin`: the front door whose /api/blocks are read (required); `witness`: a source on another origin that confirms
 *  the branch, without which no answer is verified; `window`: hostedBlocks's window above the pin. */
export interface HostedOptions extends HttpOptions { readonly pin: Pin; readonly origin: string; readonly witness?: Witness; readonly window?: number }

/** `pin`'s log, then complete blocks from `origin` bound to headers verified from the pin as the anchor. */
export function hosted(o: HostedOptions): OpenOptions {
  const { pin: p, origin, witness, window, ...http } = o, pin = checkPin(p);
  const anchor = { height: pin.height, hash: pin.blockHash };
  const then = hostedBlocks({ origin, root: { kind: "anchor", anchor, ...(window === undefined ? {} : { window }) }, ...http });
  return { source: pinned({ pin, then }), store: memoryStore(), witnesses: witness === undefined ? [] : [witness] };
}
