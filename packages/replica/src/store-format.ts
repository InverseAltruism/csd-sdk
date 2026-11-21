// The record both persistent stores keep beside their rows (disk-store.ts, idb-store.ts), and its checks at open: the
// store's tag and format, the StoreMeta's form and the chain over the boundaries; the header window's digest, checked
// where the window is read (headerWindow()). Every digest here is payloadHash, so the module runs in a browser and in
// Node alike.
import { HASH_RE, payloadHash } from "@inversealtruism/cairnx-core";
import { hx } from "@inversealtruism/csd-codec";
import { checkBasis } from "./basis.js";
import type { Boundary, Cursor, StoreMeta } from "./types.js";

/** The tag and format every stored record carries. */
export const TAG = "cairnx-replica", FORMAT = 1;

/** What a store read back does not hold together: the reader resets it and refills (open answers `corrupt`). */
export class Corrupt extends Error {}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const hash = (v: unknown): v is string => typeof v === "string" && HASH_RE.test(v);
const cursor = (v: unknown): v is Cursor => isObject(v) && count(v.height) && hash(v.hash);

/** The boundary chain before the first boundary: 32 zero bytes. */
export const BOUNDS_HASH_START = "0x" + "00".repeat(32);
/** The boundary chain after `b` from `prev`: payloadHash({ prev, boundary }). Boundaries follow in ascending height. */
export const boundsHashStep = (prev: string, b: Boundary): string => payloadHash({ prev, boundary: b });

// A boundary in form: canonicalJson writes NaN and Infinity as null, so a value the chain cannot see is refused here.
const boundaryOk = (b: unknown): boolean => isObject(b) && count(b.height) && hash(b.hash) && hash(b.eventsHash) && hash(b.rowsHash) &&
  (b.stateHash === null || hash(b.stateHash));

/** The chain after each of `bounds`, or Corrupt when a boundary is out of form or the last is not `want` (the
 *  record's boundsHash). */
export function checkedChain(bounds: readonly Boundary[], want: unknown): string[] {
  if (!bounds.every(boundaryOk)) throw new Corrupt("a boundary is out of form");
  let chain = BOUNDS_HASH_START, ends: string[];
  try { ends = bounds.map((b) => (chain = boundsHashStep(chain, b))); } catch { throw new Corrupt("a boundary is not JSON data"); }
  if (chain !== want) throw new Corrupt("the boundaries' chain is not the record's boundsHash");
  return ends;
}

/** The digest a record names a header window by. */
export const windowDigest = (w: Uint8Array): string => payloadHash(hx(w));

/** The StoreMeta of a record (`witnessed` null: it is not stored), or Corrupt when a field is out of form. */
export function metaOf(v: Record<string, unknown>): StoreMeta {
  const m = v.meta, ok = (cond: boolean) => { if (!cond) throw new Corrupt("the record's meta: a field is out of form"); };
  ok(isObject(m));
  const x = m as Record<string, unknown>, r = x.rule as Record<string, unknown>;
  ok(isObject(r) && typeof r.domain === "string" && count(r.activationHeight) && (x.cursor === null || cursor(x.cursor)) && hash(x.eventsHash) &&
    hash(x.rowsHash) && count(x.eventCount) && (x.work === null || typeof x.work === "string") &&
    (x.workRoot === null || cursor(x.workRoot)) && isObject(x.gates) && Object.values(x.gates).every(count));
  let basis: StoreMeta["basis"];
  try { basis = checkBasis(x.basis); } catch { throw new Corrupt("the record's basis is out of form"); }
  return {
    format: FORMAT, rule: { domain: r.domain as string, activationHeight: r.activationHeight as number }, basis, cursor: x.cursor as Cursor | null,
    eventsHash: x.eventsHash as string, rowsHash: x.rowsHash as string, eventCount: x.eventCount as number, witnessed: null,
    work: x.work as string | null, workRoot: x.workRoot as Cursor | null, gates: x.gates as Record<string, number>,
  };
}

/** The meta as a record stores it: without `witnessed`, which is earned again after every open. */
export const storedMeta = (meta: StoreMeta): Omit<StoreMeta, "witnessed"> => { const { witnessed: _, ...rest } = meta; return rest; };
