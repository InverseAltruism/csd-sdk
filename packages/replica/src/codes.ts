// The codes an answer carries. A code is stable: never renamed, reused or removed.

/** Why an answer is not verified. */
export const NOT_VERIFIED_CODES = Object.freeze([
  "LEVEL_DISPLAY", "LEVEL_FEED", "NOT_SYNCED", "BEHIND", "SHALLOW", "TIP_STALE", "TIP_BEHIND_PEER", "NOT_WITNESSED",
  "WITNESS_SILENT", "STORE_UNCONFIRMED", "BRANCH_UNRESOLVED", "SOURCE_UNAVAILABLE", "PIN_MISMATCH", "PIN_OFF_CHAIN",
  "PIN_DISPUTED", "RULES_DIFFER", "INPUT_INVALID", "UNSUPPORTED", "CURSOR_OFF_BRANCH",
] as const);
export type NotVerifiedCode = (typeof NOT_VERIFIED_CODES)[number];

/** What an answer notes without changing whether it is verified. */
export const NOTE_CODES = Object.freeze([
  "SOURCES_DISAGREE", "TUPLE_BRANCH", "TUPLE_RECORDS", "TUPLE_RULES", "DIVERGENCE_CONFIRMED", "STORE_UNAVAILABLE",
  "REPLAY_SLOW", "CURSOR_ABOVE_TIP", "TWO_CORES", "WITNESS_MALFORMED", "FINAL_VIEW", "PEER_FAR_AHEAD", "TIP_STALE_LONG",
  "SOURCE_FAILING",
] as const);
export type NoteCode = (typeof NOTE_CODES)[number];
