/** A source, store or basis the replica refuses to run with: an error of the caller's code or configuration, never a
 *  fact about the chain. */
export class ReplicaConfigError extends Error {
  override readonly name = "ReplicaConfigError";
}
