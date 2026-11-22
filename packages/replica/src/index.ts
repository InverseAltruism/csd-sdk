// @inversealtruism/cairnx-replica: a CairnX replica over cairnx-core's resolve(). This entry does no I/O.
export type {
  AuthorScope, Basis, BlockEvents, BlockRow, BlocksBasis, BlocksSource, Boundary, BoundBlock, Commit, Cursor, HeaderRoot, HeldWindow, Materializer, RecordProof, Source, SourceCode,
  KeptView, Pin, Step, StepContext, Store, StoreMeta, TipView, TrustedSlot, VerifiedHeaders,
} from "./types.js";
export { NOT_VERIFIED_CODES, NOTE_CODES, type NoteCode, type NotVerifiedCode } from "./codes.js";
export { ReplicaConfigError, SourceError } from "./errors.js";
export { basisKey, checkBasis, checkPin, levelOf, proofOf } from "./basis.js";
export { pinned } from "./pinned.js";
export { memoryStore } from "./memory-store.js";
export { readBlocks } from "./read-blocks.js";
export { fullReplay } from "./replay.js";
export { replicaLoop, type Loop, type LoopOpen, type LoopOptions, type LoopStatus } from "./loop.js";
export { open, openLog, type DryRunTx, type EventLog, type OpenOptions, type Reader } from "./reader.js";
export { REBUILDS, STREAK, type CompareKind, type CompareReport, type TupleReference } from "./compare.js";
export type { Tuple } from "./tuple.js";
export { appliedIds, nameHistory, type NameEventKind, type NameHistEntry, type NameHistory, type NameHistoryCheck } from "./namehist.js";
export { readName, readNameHistory, readProfile, readResolve, readState, type ReadAnswer, type ReadSnapshot } from "./handlers.js";
export { leaseInfo, nameDetailsOf } from "./nameview.js";
export type {
  Answer, AnswerMeta, At, BalanceValue, BoundCursor, NameValue, Page, ReadOptions, ReplicaStatus, Snapshot, Transfer, Witness, WitnessTip,
} from "./answer.js";
