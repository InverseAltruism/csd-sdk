// The replica's value types. Each store holds one Basis, fixed at its creation, and every answer's level is a pure
// function of it (basis.ts). Interfaces marked internal are unstable and outside semver.
import type { CairnXState, ChainEvent, EventRule, EventsSoFar } from "@inversealtruism/cairnx-core";
import type { BlockHeader } from "@inversealtruism/csd-codec";
import type { BoundTx } from "@inversealtruism/csd-light";

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

/** Internal. A source's tip: height, hash and header time in seconds, all three of one header its root vouches for,
 *  so a depth counted from it is a depth of verified work. nodeBlocks: the block the node's /tip names, its time from
 *  that block's header (the node is the root). hostedBlocks under an anchor root: the highest header its window
 *  verified, never the server's /tip, which only says how far to try to read and travels as a blocks step's
 *  `reach`. hostedBlocks under a caller root: the tip the caller's `sync` returned, as the caller verified it. */
export interface TipView { readonly height: number; readonly hash: string; readonly time: number }

/** Internal. One block's events in the order of CONVENTION section 33.3; `hash` is null only at or below a pin, or
 *  from a feed. */
export interface BlockEvents { readonly height: number; readonly hash: string | null; readonly events: ChainEvent[] }

/** Internal. What the loop gives a source for one step; `sofar` holds the events below the cursor. `floor` is the lowest
 *  height a step may roll back to: the source's pin, or, when absent, the rule's activation height less one (floorOf). */
export interface StepContext {
  readonly rule: EventRule; readonly cursor: Cursor | null; readonly sofar: EventsSoFar; readonly floor?: number;
  hashAt(height: number): string | null; eventsHashAt(height: number): string | null;
  /** The state hash at `height`, replayed from the rows held; null above the cursor or when the loop holds no state.
   *  Absent in a context built outside the loop. */
  stateHashAt?(height: number): string | null;
  /** payloadHash of the events held at or below `height` (a pin's logSha256 when they are its log); null above the
   *  cursor. Absent in a context built outside the loop. */
  logSha256At?(height: number): string | null;
  readonly budget: { readonly deadlineAt: number; readonly maxRequests: number; readonly maxBlocks: number };
  readonly signal: AbortSignal; now(): number;
}

/** Internal. Why a source could not take a step. */
export type SourceCode = "SOURCE_UNAVAILABLE" | "SOURCE_RATE_LIMITED" | "SOURCE_MALFORMED" | "BODY_MISMATCH" | "AUTHOR_UNBOUND"
  | "HEADER_INVALID" | "LESS_WORK" | "BRANCH_MOVED" | "PIN_MISMATCH" | "PIN_OFF_CHAIN" | "BELOW_FLOOR" | "RULES_DIFFER";

/** Internal. One step of a source. A `blocks` cursor hash is null only at or below a pin. `reach`, when present, is how
 *  far the source expects to read on a server's unverified word: the loop may take more steps toward it, and it
 *  reaches no tip, status or depth. */
export type Step =
  | { readonly kind: "blocks"; readonly blocks: BlockEvents[]; readonly cursor: { readonly height: number; readonly hash: string | null };
      readonly tip: TipView; readonly reach?: number }
  | { readonly kind: "idle"; readonly tip: TipView }
  | { readonly kind: "reorg"; readonly to: Cursor; readonly tip: TipView }
  | { readonly kind: "cannot"; readonly code: SourceCode; readonly reason: string; readonly retryAfterMs: number | null };

/** A release's pin: the log of `rule`'s events at or below `height`, an epoch boundary, as the UTF-8
 *  canonical JSON of the event list in the order of CONVENTION section 33.3, whose sha256 is `logSha256`, with the
 *  block hash, events hash and state hash at `height`, the gate table cut at `height` and the cairnx-core version
 *  that cut it (information only). `log` gives the log's bytes. */
export interface Pin {
  readonly format: 1; readonly rule: EventRule; readonly height: number; readonly blockHash: string; readonly logSha256: string;
  readonly eventsHash: string; readonly stateHash: string; readonly gates: Readonly<Record<string, number>>; readonly core: string;
  log(): Promise<Uint8Array>;
}

/** Internal. The loop's contract with a source; `floor` is the pin, or null for the rule's activation height. `rule`,
 *  when present, is the rule of the records a source carries (a pin's); open() refuses another. `pin`, a pinned
 *  source's, is what the loop checks a store filled under an older pin against (keepsStore). A source over a
 *  self-verified root (the anchor root) has `windowAt`, the window to commit with the step it just returned, which ends
 *  at `cursor` (null: it holds none there, and the store keeps the one it has), and `restoreWindow`, the window a load
 *  found (null: none); it takes the latter only while it holds no window of its own (README, "What a store must keep"). */
export interface Source {
  readonly basis: Basis; readonly floor: Cursor | null; readonly rule?: EventRule; readonly pin?: Pin;
  next(ctx: StepContext): Promise<Step>; tip(signal: AbortSignal): Promise<TipView | null>;
  windowAt?(cursor: Cursor): HeldWindow | null;
  restoreWindow?(w: HeldWindow | null): void;
}

/** Internal. A self-verified root's header window as a store keeps it: the bytes (window.ts, encode), the work above
 *  `workRoot` at its top as a decimal integer, and `workRoot`. */
export interface HeldWindow { readonly bytes: Uint8Array; readonly work: string; readonly workRoot: Cursor }

/** A complete block bound to its header: every txid recomputed from its body and the set hashing to the header's
 *  merkle root; `authors` holds, by txid, the author bound to each transaction the read asked for. */
export interface BoundBlock {
  readonly height: number; readonly hash: string; readonly header: BlockHeader; readonly txs: readonly BoundTx[];
  readonly authors: ReadonlyMap<string, string>;
}

/** A caller's verified headers from `floor`, read at `origin`, synced by their owner: `sync` brings them to
 *  `toHeight` (null: the tip) and gives their tip, or null when the tip is unknown; `at` gives the header held at a
 *  height, or null; `offer`, when present, takes a range's headers to check like headers it read itself, and says
 *  whether it took them. hostedBlocks calls `sync` before each page and `offer` after it, each with the server's
 *  unverified tip height; it ignores what `offer` answers and binds each block to `at`, so `offer` saves the caller's
 *  own reads only when its `sync` skips what an earlier offer already gave it. */
export interface VerifiedHeaders {
  readonly floor: number; readonly origin: string;
  sync(toHeight: number | null, signal: AbortSignal): Promise<{ readonly height: number; readonly hash: string; readonly time: number } | null>;
  at(height: number): Promise<{ readonly hash: string; readonly merkle: string } | null>;
  offer?(tip: number, rows: readonly { readonly height: number; readonly header: BlockHeader }[]): Promise<boolean>;
}

/** Whose authors a block read binds: none; every transaction but the coinbase; or each that can be an event of the
 *  rule, a Propose in its domain or any Attest (whether an Attest is a member needs the events below the block). */
export type AuthorScope = "none" | "all" | "members";

/** A source of complete blocks bound to headers from its root. `block` is internal: one block, linked to `prev` when
 *  that is given, with the authors of `authors` bound; it throws SourceError. */
export interface BlocksSource extends Source {
  readonly basis: BlocksBasis;
  block(height: number, o: { readonly authors: AuthorScope; readonly rule: EventRule; readonly prev: string | null; readonly signal: AbortSignal }): Promise<BoundBlock>;
}

/** Internal. A store's meta. No resolved state is persisted. `eventsHash` and `rowsHash` are the last row's (rowshash.ts);
 *  `gates` is the gate table of the cairnx-core that wrote the rows and boundary state hashes (loop.ts checks it at open).
 *  `work` and `workRoot` are the stored header window's (HeldWindow), set by each commit that carries one and carried
 *  over by every other, null while none was committed. Each store binds the window by its own record's digest. */
export interface StoreMeta {
  readonly format: 1; readonly rule: EventRule; readonly basis: Basis; readonly cursor: Cursor | null; readonly eventsHash: string;
  readonly rowsHash: string; readonly eventCount: number; readonly witnessed: { readonly height: number; readonly hash: string; readonly by: string; readonly at: number } | null;
  readonly work: string | null; readonly workRoot: Cursor | null; readonly gates: Readonly<Record<string, number>>;
}

/** Internal. One block's events with the events hash and the rows hash after it. */
export interface BlockRow {
  readonly height: number; readonly hash: string | null; readonly events: ChainEvent[]; readonly eventsHash: string; readonly rowsHash: string;
}

/** Internal. An epoch boundary the store keeps, with the events hash and rows hash of the rows at or below it;
 *  `stateHash` is null when it was not replayed as it became deep (loop.ts). */
export interface Boundary {
  readonly height: number; readonly hash: string; readonly eventsHash: string; readonly rowsHash: string; readonly stateHash: string | null;
}

/** Internal. One commit: applied whole or not at all, and only when `expect` is the stored cursor. An extend appends
 *  rows and boundaries; a rollback drops what lies above `rollbackTo` and carries nothing else, so a store can make it
 *  by replacing its meta alone (disk-store.ts). */
export type Commit =
  | { readonly expect: Cursor | null; readonly rows: BlockRow[]; readonly boundaries: Boundary[]; readonly meta: StoreMeta; readonly headerWindow?: Uint8Array }
  | { readonly expect: Cursor | null; readonly rollbackTo: Cursor | null; readonly meta: StoreMeta };

/** Internal. What turns the rows a loop holds into a resolved state; nothing it holds is persisted. `height` is the
 *  loop's cursor: the rows given hold every event at or below it, and null means the loop holds nothing. */
export interface Materializer {
  load(rows: readonly BlockRow[], height: number | null): void;
  apply(rows: readonly BlockRow[], height: number): void;
  rollback(to: number): void;
  /** The state at `tip - depth` from every event at or below it, or null when that height is not held. Read-only: the
   *  object may be handed to later callers. */
  stateAt(tip: number, depth: number): CairnXState | null;
  /** How long the last replay took, in milliseconds; null before the first. */
  readonly replayMs: number | null;
}

/** Internal. Format, rule and basis key a store; `open` refuses any other and names the difference. `unconfirmed`: a
 *  browser store whose record the trusted slot does not name (idb-store.ts). */
export interface Store {
  open(expect: { readonly format: 1; readonly rule: EventRule; readonly basis: Basis }):
    Promise<{ ok: true; meta: StoreMeta | null } | { ok: false; reset: "format" | "rule" | "basis" | "corrupt" | "unconfirmed" | "unavailable" }>;
  rows(fromHeight: number): AsyncIterable<BlockRow>; boundaries(): Promise<Boundary[]>;
  /** The header window of the last commit that carried one; null when none, or when the bytes read are not the ones
   *  the record names. */
  headerWindow(): Promise<Uint8Array | null>;
  commit(c: Commit): Promise<{ ok: true } | { ok: false; code: "CURSOR_MOVED" | "STORE_FAILED" }>; reset(): Promise<void>; close(): void;
  /** Optional: a store that keeps a reader's settled view across a restart of its context, bound to the record it was
   *  kept with (idb-store.ts); null clears it. `kept` gives it after an open that confirmed that record, else null. */
  keep?(view: KeptView | null): Promise<void>;
  kept?(): KeptView | null;
}

/** Internal. What a reader had settled when it last advanced verified: the clock's reading then (`at`, ms), the tip of
 *  its last step, and the witness confirmation it held then with the hash of that tip. */
export interface KeptView {
  readonly at: number; readonly tip: TipView;
  readonly witnessed: { readonly height: number; readonly hash: string; readonly by: string; readonly at: number; readonly tip: string } | null;
}

/** A value only this program's trusted contexts can read and write and that a browser start clears: the wallet's is
 *  chrome.storage.session (sessionSlot). A browser store keeps the hashes of its record in it. */
export interface TrustedSlot { get(): Promise<string | null>; set(value: string): Promise<void> }
