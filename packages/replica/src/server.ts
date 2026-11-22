// @inversealtruism/cairnx-replica/server: the root entry and the sources a server may run. A server's own node may sit
// in another container or behind private DNS, so its operator can list its host names in CAIRNX_OWN_NODE_HOSTS
// (comma-separated, parsed strictly by parseHosts), read once from the process environment and from nowhere else.
import type { Witness } from "./answer.js";
import { diskStore } from "./disk-store.js";
import { parseHosts, serverNode } from "./node-address.js";
import { nodeBlocksAt, type NodeBlocksOptions } from "./node-blocks.js";
import { localOf } from "./presets.js";
import type { OpenOptions } from "./reader.js";
import type { BlocksSource, Pin } from "./types.js";

export * from "./index.js";
export type { HttpOptions } from "./http.js";
export type { NodeBlocksOptions };
export { hostedBlocks, type HostedBlocksOptions } from "./hosted-blocks.js";
export { hostedWitness, nodeWitness } from "./http-witness.js";
export { hosted, type HostedOptions } from "./presets.js";
export { derivePin } from "./derive-pin.js";
export { diskStore } from "./disk-store.js";
/** The resolver's indexer Scanner, served from this entry only: test/bundle.test.ts checks `.` and `./browser` carry none of it. */
export { Scanner, branchRefusal, type ScanAnchor, type ScanOptions } from "./scanner.js";
export { indexerFeed } from "./indexer-feed.js";
/** Internal, for the pin generator: the gate table this package was built against, and the compare open() makes. */
export { BUILT_GATES, gatesDiffer, gatesOf } from "./gates.js";

// The outcome of the one read, a list or the configuration error it threw, is kept for every later call.
let listed: { hosts: ReadonlySet<string> } | { error: unknown } | undefined;
function hosts(): ReadonlySet<string> {
  if (listed === undefined) {
    try { listed = { hosts: parseHosts(process.env.CAIRNX_OWN_NODE_HOSTS) }; } catch (error) { listed = { error }; }
  }
  if ("error" in listed) throw listed.error;
  return listed.hosts;
}

/** Complete blocks from one's own node: loopback, a private range, or a host in CAIRNX_OWN_NODE_HOSTS; any other
 *  address throws ReplicaConfigError. */
export const nodeBlocks = (o: NodeBlocksOptions): BlocksSource => nodeBlocksAt(serverNode(o.node, hosts()), o);

/** What open() takes for a replica of one's own node held in memory: nodeBlocks at `node`, above `pin` when one is
 *  given, and memoryStore(). */
export const local = localOf(nodeBlocks);

/** `dir`: the store's directory, an absolute path (diskStore); `witness`: a source on another origin asked with each
 *  advance, none by default. */
export interface OwnNodeOptions extends NodeBlocksOptions { readonly dir: string; readonly pin?: Pin; readonly witness?: Witness }
/** A step over a disk store reads up to 512 blocks with 600 requests: each commit costs its syncs, and the loop's
 *  default of 10 requests reads about 9 blocks a step (test/own-node.test.ts counts the steps). */
const OWN_NODE_STEP = { maxBlocks: 512, maxRequests: 600 } as const;

/** What open() takes for a server's replica of its own node kept on disk: `local`'s source (nodeBlocks at `node` under
 *  the server's address rule, above `pin` when one is given), diskStore({ dir }), the witness when one is given and
 *  the step budget above. Throws ReplicaConfigError for a node outside the rule or a relative `dir`; open() throws it
 *  for a `dir` that is not a directory or cannot be created. */
export function ownNode(o: OwnNodeOptions): OpenOptions {
  const { dir, witness, ...rest } = o;
  return { source: local(rest).source, store: diskStore({ dir }), witnesses: witness === undefined ? [] : [witness], step: OWN_NODE_STEP };
}
