// What a reader answers (design section 5). `value` is null unless the answer is verified; the unverified value is in
// `shown`. Every answer carries its level, the proof of its records and the basis that vouches for them.
import type { CairnXState, ChainEvent, NameView, TokenMove } from "@inversealtruism/cairnx-core";
import type { BlockHeader } from "@inversealtruism/csd-codec";
import type { NoteCode, NotVerifiedCode } from "./codes.js";
import type { CompareReport } from "./compare.js";
import type { Tuple } from "./tuple.js";
import type { StoreReason } from "./loop.js";
import type { Basis, Cursor, RecordProof, TipView } from "./types.js";

/** Where an answer was read: `height` is the height of its value (`deepHeight` for a deep view), `hash` the block hash
 *  the replica holds there or null, `depth` the blocks above it to the tip. */
export interface At {
  readonly height: number; readonly hash: string | null; readonly deepHeight: number; readonly depth: number;
  readonly tipHeight: number; readonly tipTime: number | null;
}
export interface AnswerMeta {
  readonly level: 1 | 2 | 3;
  readonly why: readonly { readonly code: NotVerifiedCode; readonly detail?: string }[];
  readonly notes: readonly { readonly code: NoteCode; readonly detail?: string }[];
  readonly at: At | null; readonly proof: RecordProof; readonly vouch: Basis;
}
export type Answer<T> = AnswerMeta & ({ readonly verified: true; readonly value: T } | { readonly verified: false; readonly value: null; readonly shown: T | null });

/** `waitMs`: how long a read waits for the step it starts (default 0: it answers from what is held). `minDepth`: the
 *  depth of the deep view (default cairnx-core's FINAL_DEPTH, 12), the depth replicas compare at, not a depth safe
 *  for value. */
export interface ReadOptions { readonly waitMs?: number; readonly minDepth?: number; readonly signal?: AbortSignal }

/** A balance at the deep view, with `atTip` when the tip view differs. `deployId` is null when no token of that
 *  ticker exists at the deep view. Amounts are base units as decimal strings. */
export interface BalanceValue {
  readonly ticker: string; readonly deployId: string | null; readonly address: string; readonly available: string; readonly locked: string;
  readonly atTip?: { readonly available: string; readonly locked: string };
}
/** A name as a reader shows it: cairnx-core's NameView (CONVENTION section 35.4). `state` is `held`, `pending`, `lapsed`,
 *  `free` (absent) or `reserved`; `addr` and `profile` are a held name's only. */
export type NameValue = NameView;
/** The tip view and the events held up to it, from one commit (Reader.snapshot): `height` is the view's height,
 *  `key` names that state (two snapshots with one key are one object, frozen), `events` are in the rows' order. */
export interface Snapshot {
  readonly key: string; readonly height: number; readonly state: CairnXState; readonly events: readonly ChainEvent[];
}
/** The cursor of `events` and `transfers`, opaque to a caller: the height and transaction position of a page's last
 *  item, exclusive when it starts a page, with the replica's events hash at that height (CONVENTION section 34.2), which
 *  covers every event at or below it (cursor.ts). */
export type BoundCursor = `${number}:${number}:${string}`;
export interface Page<T, C extends string = BoundCursor> { readonly items: readonly T[]; readonly next: C; readonly more: boolean }
/** One token move of an applied entry (CONVENTION section 41): `amount` base units of `ticker` from `from` (null for a
 *  mint) to `to`, written by `txid` at `height` and `pos`. `deployId` is the state's `tokens[ticker].deployId`; `memo`
 *  is the memo of the entry's own record, null when it has none (a fill is an Attest, which carries no record). A
 *  refused record moves nothing, so every row is of an applied one, with its applied code. */
export interface Transfer {
  readonly txid: string; readonly height: number; readonly pos: number; readonly leg: TokenMove["leg"]; readonly ticker: string;
  readonly deployId: string; readonly from: string | null; readonly to: string; readonly amount: string; readonly memo: string | null;
  readonly applied: true; readonly code: string | null;
}

/** A tip a witness names, with its header. */
export type WitnessTip = TipView & { readonly header: BlockHeader };
/** Another origin than the header source, asked for its tip and for the hash of a block. `rules`, when present,
 *  gives the gate table it runs (the names cairnx-core exports, `ACTIVATION_HEIGHT` and `V<n>_HEIGHT`). */
export interface Witness {
  readonly id: string; readonly origin: string;
  tip(signal: AbortSignal): Promise<WitnessTip | null>;
  hashAt(height: number, signal: AbortSignal): Promise<string | null>;
  rules?(signal: AbortSignal): Promise<{ readonly gates: Readonly<Record<string, number>> } | null>;
}

/** The replica's state with the verdict an answer read now would carry before its read's own conditions.
 *  `storeReason` and `storeError` are why the store's last load did not open it and what it threw, paths included,
 *  null when the store is fine: for the server's own logs, not for a page. `keepError` is what the store threw when the
 *  last advance kept or cleared its view for the next start (the view is then treated as absent), else null. */
export interface ReplicaStatus extends AnswerMeta {
  readonly storeReason: StoreReason | null; readonly storeError: string | null; readonly keepError: string | null;
  readonly verified: boolean; readonly source: string; readonly cursor: Cursor | null;
  readonly witnessed: { readonly height: number; readonly at: number } | null;
  readonly lastReorg: { readonly from: Cursor; readonly to: Cursor; readonly at: number } | null;
  readonly lastError: { readonly code: string; readonly reason: string; readonly at: number } | null;
  readonly tuple: Tuple | null; readonly compare: CompareReport | null; readonly replayMs: number | null;
}
