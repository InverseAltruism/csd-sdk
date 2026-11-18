import type { SourceCode } from "./types.js";

/** A source, store or basis the replica refuses to run with: an error of the caller's code or configuration, never a
 *  fact about the chain. */
export class ReplicaConfigError extends Error {
  override readonly name = "ReplicaConfigError";
}

/** What a source refuses, with the code a step reports and the wait a Retry-After asked for. `readBlocks` throws it. */
export class SourceError extends Error {
  override readonly name = "SourceError";
  constructor(readonly code: SourceCode, reason: string, readonly retryAfterMs: number | null = null) { super(reason); }
}

/** The longest wait the loop backs off for, a Retry-After included. */
export const BACKOFF_MAX_MS = 300_000;

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
