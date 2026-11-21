// What a reader answers (design section 5). `value` is null unless the answer is verified; the unverified value is in
// `shown`. Every answer carries its level, the proof of its records and the basis that vouches for them.
import type { NameView } from "@inversealtruism/cairnx-core";
import type { BlockHeader } from "@inversealtruism/csd-codec";
import type { NoteCode, NotVerifiedCode } from "./codes.js";
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
/** A position in the event order, height and transaction position, exclusive when it starts a page. */
export type TransferCursor = `${number}:${number}`;
export interface Page<T> { readonly items: readonly T[]; readonly next: TransferCursor; readonly more: boolean }

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

/** The replica's state with the verdict an answer read now would carry before its read's own conditions. */
export interface ReplicaStatus extends AnswerMeta {
  readonly verified: boolean; readonly source: string; readonly cursor: Cursor | null;
  readonly witnessed: { readonly height: number; readonly at: number } | null;
  readonly lastReorg: { readonly from: Cursor; readonly to: Cursor; readonly at: number } | null;
  readonly lastError: { readonly code: string; readonly reason: string; readonly at: number } | null;
  readonly tuple: null; readonly compare: null; readonly replayMs: number | null;
}
