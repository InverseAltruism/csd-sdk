import type { ErrorCode } from "./errors.js";
import type { Open } from "./rows.js";

/** The block whose state an answer describes, and with `rev` the state itself. `rev` is opaque: never parsed, ordered
 *  or compared across servers. */
export interface At { height: number; hash: string; rev: string }

/** A page of a list. `level` is the reader's position, 1 for every answer over HTTP, not a claim of the server. A walk
 *  ends on `next === null` and on nothing else; `total`, when present, never ends a walk. */
export interface Page<R> { ok: true; level: 1; at: At; rows: R[]; next: string | null; total?: number }

export interface RefusalError {
  code: Open<ErrorCode>;
  message: string;
  /** The parameter refused, on INVALID_QUERY. */
  param?: string;
  /** Seconds, on RATE_LIMITED; equal to the Retry-After header. */
  retryAfter?: number;
}
/** Every refusal, from the service and the proxy. On SNAPSHOT_NOT_HELD `at` is the newest snapshot the server holds. */
export interface Refusal { ok: false; error: RefusalError; at?: At }

export type Answer<R> = Page<R> | Refusal;
