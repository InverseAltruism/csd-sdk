// The error codes of a v1 refusal, each with its one HTTP status and the side that answers it. From 1.0.0 the codes and
// their statuses are promised (test/errors.test.ts holds the table), and codes may be added; a client treats a code it
// does not know by its status. The contract's retirement rule (README, "The 1.0 contract"): a route or a field (of a row
// or of the envelope) is removed only after it has been marked deprecated, with the date, in CHANGELOG.md and the
// documentation, and served unchanged for six months from that date; a change of meaning is a new API version,
// /api/cairnx/v2/.

type Side = "service" | "proxy" | "both";
const entry = <S extends number, F extends Side>(status: S, from: F) => Object.freeze({ status, from });

export const ERRORS = Object.freeze({
  INVALID_QUERY: entry(400, "service"),
  INVALID_PATH: entry(400, "proxy"),
  NOT_FOUND: entry(404, "both"),
  METHOD_NOT_ALLOWED: entry(405, "both"),
  SNAPSHOT_NOT_HELD: entry(409, "service"),
  RATE_LIMITED: entry(429, "proxy"),
  INTERNAL: entry(500, "service"),
  UPSTREAM_UNAVAILABLE: entry(502, "proxy"),
  RESPONSE_TOO_LARGE: entry(502, "proxy"),
  NOT_READY: entry(503, "service"),
});

/** A code this release defines. */
export type ErrorCode = keyof typeof ERRORS;
/** Every code, in table order. */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(Object.keys(ERRORS) as ErrorCode[]);
/** The HTTP status a refusal with `code` is answered with. */
export const statusOf = (code: ErrorCode): number => ERRORS[code].status;
