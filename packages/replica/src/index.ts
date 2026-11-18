// @inversealtruism/cairnx-replica: a CairnX replica over cairnx-core's resolve(). This entry does no I/O.
export type {
  Basis, BlockEvents, BlockRow, BlocksBasis, Boundary, Commit, Cursor, HeaderRoot, RecordProof, Source, SourceCode, Step,
  StepContext, Store, StoreMeta, TipView,
} from "./types.js";
export { NOT_VERIFIED_CODES, NOTE_CODES, type NoteCode, type NotVerifiedCode } from "./codes.js";
export { ReplicaConfigError } from "./errors.js";
export { basisKey, checkBasis, levelOf, proofOf } from "./basis.js";
export { memoryStore } from "./memory-store.js";
