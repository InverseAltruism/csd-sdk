// @inversealtruism/cairnx-replica: a CairnX replica over cairnx-core's resolve(). This entry does no I/O.
export type {
  AuthorScope, Basis, BlockEvents, BlockRow, BlocksBasis, BlocksSource, Boundary, BoundBlock, Commit, Cursor, HeaderRoot, Materializer, RecordProof, Source, SourceCode,
  Step, StepContext, Store, StoreMeta, TipView, VerifiedHeaders,
} from "./types.js";
export { NOT_VERIFIED_CODES, NOTE_CODES, type NoteCode, type NotVerifiedCode } from "./codes.js";
export { ReplicaConfigError, SourceError } from "./errors.js";
export { basisKey, checkBasis, levelOf, proofOf } from "./basis.js";
export { memoryStore } from "./memory-store.js";
export { readBlocks } from "./read-blocks.js";
export { fullReplay } from "./replay.js";
export { replicaLoop, type Loop, type LoopOpen, type LoopOptions, type LoopStatus } from "./loop.js";
export { open, openLog, type EventLog, type OpenOptions, type Reader } from "./reader.js";
export type { Answer, AnswerMeta, At, BalanceValue, Page, ReadOptions, ReplicaStatus, TransferCursor, Witness, WitnessTip } from "./answer.js";
