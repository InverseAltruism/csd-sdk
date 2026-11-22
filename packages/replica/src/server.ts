// @inversealtruism/cairnx-replica/server: the root entry and the sources a server may run. A server's own node may sit
// in another container or behind private DNS, so its operator can list its host names in CAIRNX_OWN_NODE_HOSTS
// (comma-separated, parsed strictly by parseHosts), read once from the process environment and from nowhere else.
import type { Witness } from "./answer.js";
import { diskStore } from "./disk-store.js";
import { ReplicaConfigError } from "./errors.js";
import { parseHosts, serverNode } from "./node-address.js";
import { nodeBlocksAt, type NodeBlocksOptions } from "./node-blocks.js";
import { localOf } from "./presets.js";
import { openWith, type OpenOptions, type Reader } from "./reader.js";
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
export { READ_HEADERS, WITHHELD, replicaReads, withheldBy, type ReadResponse } from "./read-routes.js";
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

/** open() with `recount`, a block source of the server's: when a reference's difference has started at one boundary
 *  for STREAK new boundaries, a separate loop over it in memory reads to its source's tip (RECOUNT_MS at most) and
 *  takes that boundary. Equal to the replica's own tuple, the difference is confirmed (the note DIVERGENCE_CONFIRMED)
 *  and the replica keeps answering; equal to the reference's, the store is rebuilt (STORE_UNCONFIRMED while it
 *  refills), up to REBUILDS times with no equal comparison between, then kept with STORE_UNCONFIRMED and the note
 *  SOURCES_DISAGREE. Without `recount` a difference is only reported. A `recount` whose basis is not complete blocks bound to
 *  headers throws ReplicaConfigError: a feed's word cannot settle a difference that leads to a rebuild. */
export function open(o: OpenOptions & { readonly recount?: BlocksSource }): Promise<Reader> {
  const { recount, ...rest } = o;
  if (recount !== undefined && (recount as { basis?: { kind?: unknown } }).basis?.kind !== "blocks") {
    return Promise.reject(new ReplicaConfigError(`open: recount must be a block source, not a ${String((recount as { basis?: { kind?: unknown } }).basis?.kind)} source`));
  }
  return openWith(rest, recount ?? null);
}
