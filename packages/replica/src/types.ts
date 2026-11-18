// The replica's value types. Each store holds one Basis, fixed at its creation, and every answer's level is a pure
// function of it (basis.ts). Interfaces marked internal are unstable and outside semver.
import type { ChainEvent, EventRule, EventsSoFar } from "@inversealtruism/cairnx-core";

/** A block: its height and its hash, `0x` and 64 lowercase hex. */
export interface Cursor { readonly height: number; readonly hash: string }

/** Where the headers that bodies are bound to come from: one's own node, a release's anchor (under a pin, the pin
 *  itself), or a caller's verified headers from `floor`, read at `origin`. */
export type HeaderRoot =
  | { readonly kind: "own-node"; readonly node: string }
  | { readonly kind: "anchor"; readonly anchor: Cursor }
  | { readonly kind: "caller"; readonly floor: number; readonly origin: string };

/** Complete blocks bound to headers from `root`. `bodies` is where the bodies are read and carries no trust. */
export interface BlocksBasis { readonly kind: "blocks"; readonly root: HeaderRoot; readonly bodies: string }

/** What vouches that no record is missing (CONVENTION section 37). Only blocks sit above a pin, so a pin never lifts
 *  a feed or a display to level 3. */
export type Basis =
  | { readonly kind: "display"; readonly origin: string }
  | { readonly kind: "feed"; readonly feed: string; readonly inclusion: boolean }
  | BlocksBasis
  | { readonly kind: "pinned"; readonly pin: Cursor; readonly logSha256: string; readonly above: BlocksBasis };

/** What was checked of each record: as served; bound to a verified header's merkle root with its author bound to the
 *  spent coin; or inside a release's log. */
export type RecordProof = "served" | "inclusion" | "pinned";

/** Internal. A source's tip: height, hash and header time in seconds. */
export interface TipView { readonly height: number; readonly hash: string; readonly time: number }

/** Internal. One block's events in the order of CONVENTION section 33.3; `hash` is null only at or below a pin, or
 *  from a feed. */
export interface BlockEvents { readonly height: number; readonly hash: string | null; readonly events: ChainEvent[] }

/** Internal. What the loop gives a source for one step; `sofar` holds the events below the cursor. */
export interface StepContext {
  readonly rule: EventRule; readonly cursor: Cursor | null; readonly sofar: EventsSoFar;
  hashAt(height: number): string | null; eventsHashAt(height: number): string | null;
  readonly budget: { readonly deadlineAt: number; readonly maxRequests: number; readonly maxBlocks: number };
  readonly signal: AbortSignal; now(): number;
}

/** Internal. Why a source could not take a step. */
export type SourceCode = "SOURCE_UNAVAILABLE" | "SOURCE_RATE_LIMITED" | "SOURCE_MALFORMED" | "BODY_MISMATCH" | "AUTHOR_UNBOUND"
  | "HEADER_INVALID" | "LESS_WORK" | "BRANCH_MOVED" | "PIN_MISMATCH" | "PIN_OFF_CHAIN" | "BELOW_FLOOR";

/** Internal. One step of a source. A `blocks` cursor hash is null only at or below a pin. */
export type Step =
  | { readonly kind: "blocks"; readonly blocks: BlockEvents[]; readonly cursor: { readonly height: number; readonly hash: string | null };
      readonly tip: TipView }
  | { readonly kind: "idle"; readonly tip: TipView }
  | { readonly kind: "reorg"; readonly to: Cursor; readonly tip: TipView }
  | { readonly kind: "cannot"; readonly code: SourceCode; readonly reason: string; readonly retryAfterMs: number | null };

/** Internal. The loop's contract with a source; `floor` is the pin, or null for the rule's activation height. */
export interface Source {
  readonly basis: Basis; readonly floor: Cursor | null;
  next(ctx: StepContext): Promise<Step>; tip(signal: AbortSignal): Promise<TipView | null>;
}

/** Internal. A store's meta. No resolved state is persisted. */
export interface StoreMeta {
  readonly format: 1; readonly rule: EventRule; readonly basis: Basis; readonly cursor: Cursor | null; readonly eventsHash: string;
  readonly eventCount: number; readonly witnessed: { readonly height: number; readonly hash: string; readonly by: string; readonly at: number } | null;
  readonly windowSha256: string | null; readonly work: string | null; readonly workRoot: Cursor | null;
}

/** Internal. One block's events with the events hash after it. */
export interface BlockRow { readonly height: number; readonly hash: string | null; readonly events: ChainEvent[]; readonly eventsHash: string }

/** Internal. An epoch boundary the store keeps. */
export interface Boundary { readonly height: number; readonly hash: string; readonly eventsHash: string; readonly stateHash: string }

/** Internal. One commit: applied whole or not at all, and only when `expect` is the stored cursor. */
export interface Commit {
  readonly expect: Cursor | null; readonly rollbackTo?: Cursor | null; readonly rows: BlockRow[]; readonly boundaries: Boundary[];
  readonly meta: StoreMeta; readonly headerWindow?: Uint8Array;
}

/** Internal. Format, rule and basis key a store; `open` refuses any other and names the difference. */
export interface Store {
  open(expect: { readonly format: 1; readonly rule: EventRule; readonly basis: Basis }):
    Promise<{ ok: true; meta: StoreMeta | null } | { ok: false; reset: "format" | "rule" | "basis" | "corrupt" | "unavailable" }>;
  rows(fromHeight: number): AsyncIterable<BlockRow>; boundaries(): Promise<Boundary[]>; headerWindow(): Promise<Uint8Array | null>;
  commit(c: Commit): Promise<{ ok: true } | { ok: false; code: "CURSOR_MOVED" | "STORE_FAILED" }>; reset(): Promise<void>; close(): void;
}
