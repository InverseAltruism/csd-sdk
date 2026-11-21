// @inversealtruism/cairnx-replica/server: the root entry and the sources a server may run. A server's own node may sit
// in another container or behind private DNS, so its operator can list its host names in CAIRNX_OWN_NODE_HOSTS
// (comma-separated, parsed strictly by parseHosts), read once from the process environment and from nowhere else.
import { parseHosts, serverNode } from "./node-address.js";
import { nodeBlocksAt, type NodeBlocksOptions } from "./node-blocks.js";
import { localOf } from "./presets.js";
import type { BlocksSource } from "./types.js";

export * from "./index.js";
export type { HttpOptions } from "./http.js";
export type { NodeBlocksOptions };
export { hostedBlocks, type HostedBlocksOptions } from "./hosted-blocks.js";
export { hostedWitness, nodeWitness } from "./http-witness.js";
export { hosted, type HostedOptions } from "./presets.js";
export { derivePin } from "./derive-pin.js";
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
