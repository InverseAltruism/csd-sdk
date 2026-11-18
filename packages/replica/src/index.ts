// @inversealtruism/cairnx-replica: a CairnX replica over cairnx-core's resolve(). This entry does no I/O.
export type {
  Basis, BlockEvents, BlockRow, BlocksBasis, Boundary, Commit, Cursor, HeaderRoot, Materializer, RecordProof, Source, SourceCode,
  Step, StepContext, Store, StoreMeta, TipView,
} from "./types.js";
export { NOT_VERIFIED_CODES, NOTE_CODES, type NoteCode, type NotVerifiedCode } from "./codes.js";
export { ReplicaConfigError } from "./errors.js";
export { basisKey, checkBasis, levelOf, proofOf } from "./basis.js";
export { memoryStore } from "./memory-store.js";
export { fullReplay } from "./replay.js";
export { replicaLoop, type Loop, type LoopOpen, type LoopOptions, type LoopStatus } from "./loop.js";
