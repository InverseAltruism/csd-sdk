// @inversealtruism/cairnx-replica/browser: the root entry and the sources a page or an extension may run. It reads no
// environment and imports no Node built-in, so a node counts as one's own only at a loopback address.
import { loopbackNode } from "./node-address.js";
import { nodeBlocksAt, type NodeBlocksOptions } from "./node-blocks.js";
import type { BlocksSource } from "./types.js";

export * from "./index.js";
export type { HttpOptions } from "./http.js";
export type { NodeBlocksOptions };
export { hostedBlocks, type HostedBlocksOptions } from "./hosted-blocks.js";

/** Complete blocks from one's own node at localhost, 127.0.0.1 or [::1]; any other address throws ReplicaConfigError. */
export const nodeBlocks = (o: NodeBlocksOptions): BlocksSource => nodeBlocksAt(loopbackNode(o.node), o);
