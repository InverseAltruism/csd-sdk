// CairnX record validation + builders (pure; no I/O).
import { canonicalJson, payloadHash, isWellFormedUtf16 } from "@inversealtruism/csd-codec";
import type { RecordCode } from "./codes.js";
import {
  ADDR_RE, AMOUNT_RE, HASH_RE, SALT_RE, MAX_AMOUNT, MAX_RECORD_BYTES, MAX_TOKEN_DECIMALS, NAME_RE, PKEY, PROFILE_MAX_KEYS, PROFILE_MAX_VALUE_BYTES, RESERVED_NAMES, TICKER_RE,
  type BidRecord, type CairnXRecord, type DeployRecord, type MintRecord, type NameCommitRecord,
  type NameFinalizeRecord, type NameProfileRecord, type NameRecord, type NameSetRecord, type NameRenewRecord, type TokenMetaRecord, type NameXferRecord, type OfferCancelAllRecord,
  type OfferRecord, type TransferRecord, type FclaimRecord,
} from "./types.js";

export interface BuiltRecord { record: CairnXRecord; uri: string; payloadHash: string }

// The amount rule: a canonical decimal string below 2^96, and not 0 unless zero is allowed. parseAmount and the record
// checks below both read it, so the value and the code of a refusal come from one place.
function amountOrCode(s: unknown, allowZero: boolean): bigint | RecordCode {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) return "RECORD_BAD_AMOUNT";
  const v = BigInt(s);
  if (v > MAX_AMOUNT) return "RECORD_AMOUNT_TOO_LARGE";
  if (v === 0n && !allowZero) return "RECORD_AMOUNT_ZERO";
  return v;
}
export function parseAmount(s: unknown, opts: { allowZero?: boolean } = {}): bigint | null {
  const v = amountOrCode(s, Boolean(opts.allowZero));
  return typeof v === "bigint" ? v : null;
}
const amountFault = (s: unknown, allowZero = false): RecordCode | null => {
  const v = amountOrCode(s, allowZero);
  return typeof v === "bigint" ? null : v;
};

const isAddr = (a: unknown): a is string => typeof a === "string" && ADDR_RE.test(a);
const isTicker = (t: unknown): t is string => typeof t === "string" && TICKER_RE.test(t);
const isHash = (h: unknown): h is string => typeof h === "string" && HASH_RE.test(h);
const nameFault = (n: unknown): RecordCode | null =>
  typeof n !== "string" || !NAME_RE.test(n) ? "RECORD_BAD_NAME" : RESERVED_NAMES.has(n) ? "RECORD_NAME_RESERVED" : null;
/** A claimable name: lowercase-ASCII, 1–32, no leading/trailing hyphen, not reserved. */
export const isName = (n: unknown): n is string => nameFault(n) === null;

/** Deterministic commit hash for front-run-proof name registration (commit-reveal). */
export function nameCommit(name: string, salt: string, owner: string): string {
  return payloadHash({ t: "cairnx:name:commit:v1", name, salt, owner: owner.toLowerCase() });
}

// A lone surrogate has NO valid UTF-8 encoding, so per CONVENTION A1 ("raw UTF-8, never escaped") its
// canonical form is UNDEFINABLE: V8's JSON.stringify escapes it to ASCII `\uXXXX` and accepts, while a
// raw-UTF-8 resolver (Rust serde_json / Python / Go) rejects or mangles it to U+FFFD: a cross-language fork.
/** Recursively reject any non-well-formed UTF-16 string anywhere in a decoded record (keys + values). */
function isWellFormedDeep(v: unknown): boolean {
  if (typeof v === "string") return isWellFormedUtf16(v);
  if (Array.isArray(v)) return v.every(isWellFormedDeep);
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (!isWellFormedUtf16(k)) return false;
      if (!isWellFormedDeep(val)) return false;
    }
  }
  return true;
}

/**
 * True iff `r` has NO key outside `allowed`. The value-bearing records (deploy/mint/transfer/
 * offer/bid) historically validated only the keys they READ, silently ignoring any extra key —
 * which let a decoy object key ride along on a value-bearing record. A decoy key in the astral
 * range (e.g. U+10000) sorts BEFORE a BMP key under JS UTF-16 `Array.sort` but AFTER it under a
 * Rust/Go/Python UTF-8-byte/codepoint sort, so the SAME object canonicalizes to different bytes
 * and two honest resolvers disagree on whether the record applied — a cross-language consensus
 * fork (audit M1). An exact-key allowlist makes such decoy keys an invalid no-op everywhere.
 * (ncommit/nxfer/nset/nrenew/tmeta/ocancel already enforce this via Object.keys length.)
 */
const onlyKeys = (r: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(r).every((k) => allowed.has(k));
// Exported so consumers (the wallet's record-decode / clear-sign path) import the SAME decoy-key
// allowlists instead of re-typing them — a re-typed allowlist that drops a key would re-open the M1
// cross-language canonicalization fork on the consumer side.
export const DEPLOY_KEYS = new Set(["v", "t", "ticker", "name", "decimals", "supply", "mint", "mintLimit"]);
export const MINT_KEYS = new Set(["v", "t", "ticker", "amount"]);
export const TRANSFER_KEYS = new Set(["v", "t", "ticker", "to", "amount", "memo", "ts"]);
export const OFFER_KEYS = new Set(["v", "t", "give", "want", "min", "bid", "taker", "memo", "ts"]);
export const BID_KEYS = new Set(["v", "t", "want", "give", "memo", "ts"]);
export const NAME_KEYS = new Set(["v", "t", "name", "salt"]);
export const NFINALIZE_KEYS = new Set(["v", "t", "name", "salt"]);
export const NPROFILE_KEYS = new Set(["v", "t", "name", "p"]);
export const FCLAIM_KEYS = new Set(["v", "t", "offer"]);

/**
 * Parse + validate a record from an anchored `uri`. Returns null for anything invalid —
 * per CONVENTION §3, invalid is a no-op, never an error that poisons the replay.
 * Requirements enforced here: uri is canonical JSON of the record, ≤512 bytes,
 * payload_hash commits to it, schema rules of §4. explainRecord says which rule refused it.
 */
export function parseRecord(uri: string, payloadHashHex: string): CairnXRecord | null {
  const r = recordOrCode(uri, payloadHashHex);
  return typeof r === "string" ? null : r;
}

/** parseRecord with its reason: the record, or the code of the first rule it breaks in parseRecord's order (CONVENTION
 *  §40). parseRecord answers null exactly when this answers ok: false: both read one implementation. */
export function explainRecord(uri: string, payloadHashHex: string): { ok: true; record: CairnXRecord } | { ok: false; code: RecordCode } {
  const r = recordOrCode(uri, payloadHashHex);
  return typeof r === "string" ? { ok: false, code: r } : { ok: true, record: r };
}

// The rules of parseRecord, each refusal returning its code. `fault` holds the code of a check that names its own
// (an amount, a name).
function recordOrCode(uri: string, payloadHashHex: string): CairnXRecord | RecordCode {
  if (new TextEncoder().encode(uri).length > MAX_RECORD_BYTES) return "RECORD_TOO_LARGE";
  let obj: unknown;
  try { obj = JSON.parse(uri); } catch { return "RECORD_NOT_OBJECT"; }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return "RECORD_NOT_OBJECT";
  // canonical form + hash commitment (sha256(uri) == payload_hash ⇔ uri === canonicalJson(obj)); a throw from
  // either check is that check's refusal
  try { if (canonicalJson(obj) !== uri) return "RECORD_NOT_CANONICAL"; } catch { return "RECORD_NOT_CANONICAL"; }
  try { if (payloadHash(obj).toLowerCase() !== payloadHashHex.toLowerCase()) return "RECORD_HASH_MISMATCH"; } catch { return "RECORD_HASH_MISMATCH"; }
  // Determinism gate (CONVENTION A1/A5): a record carrying any non-well-formed UTF-16 string (lone
  // surrogate) is canonically UNDEFINABLE across languages, so it is an INVALID no-op everywhere —
  // never an ASCII-escaped record that one resolver credits and another rejects. Must run AFTER the
  // canonical gate (the uri itself is pure-ASCII `\uXXXX`; the surrogate only exists in `obj`).
  if (!isWellFormedDeep(obj)) return "RECORD_LONE_SURROGATE";

  const r = obj as Record<string, unknown>;
  if (r.v !== 1 || typeof r.t !== "string") return "RECORD_NOT_V1";
  let fault: RecordCode | null;

  switch (r.t) {
    case "deploy": {
      if (!onlyKeys(r, DEPLOY_KEYS)) return "RECORD_EXTRA_KEY";
      if (!isTicker(r.ticker)) return "RECORD_BAD_TICKER";
      // `.length` = UTF-16 code units IS the consensus unit (CONVENTION A6): an astral codepoint is 2
      // units, so a port counting codepoints/bytes would fork at the 32-unit boundary. Keep `.length`.
      if (r.name !== undefined && (typeof r.name !== "string" || r.name.length > 32)) return "RECORD_BAD_TEXT";
      if (typeof r.decimals !== "number" || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > MAX_TOKEN_DECIMALS) return "RECORD_BAD_DECIMALS";
      if ((fault = amountFault(r.supply))) return fault;
      if (r.mint !== "open" && r.mint !== "issuer") return "RECORD_BAD_MINT_MODE";
      if (r.mint === "open" && (fault = amountFault(r.mintLimit))) return fault;
      if (r.mint === "issuer" && r.mintLimit !== undefined) return "RECORD_BAD_SHAPE";
      return r as unknown as DeployRecord;
    }
    case "mint": {
      if (!onlyKeys(r, MINT_KEYS)) return "RECORD_EXTRA_KEY";
      if (!isTicker(r.ticker)) return "RECORD_BAD_TICKER";
      if (r.amount !== undefined && (fault = amountFault(r.amount))) return fault;
      return r as unknown as MintRecord;
    }
    case "transfer": {
      if (!onlyKeys(r, TRANSFER_KEYS)) return "RECORD_EXTRA_KEY";
      if (!isTicker(r.ticker)) return "RECORD_BAD_TICKER";
      if (!isAddr(r.to)) return "RECORD_BAD_ADDRESS";
      if ((fault = amountFault(r.amount))) return fault;
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return "RECORD_BAD_TEXT";
      // Number.isSafeInteger (not just isInteger): a `ts` ≥ 2^53 (or 1e21, which IS an integer)
      // serializes as the JS-specific "1e+21" / loses precision, forking the canonical bytes vs a
      // u64/decimal porter (audit M1). Bounding to the safe range makes every honest impl agree.
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return "RECORD_BAD_TS";
      return r as unknown as TransferRecord;
    }
    case "offer": {
      if (!onlyKeys(r, OFFER_KEYS)) return "RECORD_EXTRA_KEY";
      const g = r.give as Record<string, unknown> | undefined;
      const w = r.want as Record<string, unknown> | undefined;
      if (!g || !w || typeof g !== "object" || Array.isArray(g) || typeof w !== "object" || Array.isArray(w)) return "RECORD_BAD_SHAPE";
      // give is EITHER {ticker,amount} OR {name} — exactly one shape, no extra keys mixing them
      const gKeys = Object.keys(g).sort().join(",");
      if (gKeys === "amount,ticker") {
        if (!isTicker(g.ticker)) return "RECORD_BAD_TICKER";
        if ((fault = amountFault(g.amount))) return fault;
      } else if (gKeys === "name") { if ((fault = nameFault(g.name))) return fault; }
      else return "RECORD_BAD_SHAPE";
      // want is EITHER {value[,payto]} (CSD) OR {ticker,amount[,payto]} (v1.2 token-priced)
      const wKeys = Object.keys(w).filter((k) => k !== "payto").sort().join(",");
      if (wKeys === "value") {
        if ((fault = amountFault(w.value, true))) return fault;
      } else if (wKeys === "amount,ticker") {
        if (!isTicker(w.ticker)) return "RECORD_BAD_TICKER";
        if ((fault = amountFault(w.amount, true))) return fault;
        if (gKeys === "amount,ticker" && w.ticker === g.ticker) return "RECORD_SAME_TOKEN"; // give≠want token
        if (r.min !== undefined) return "RECORD_BAD_SHAPE";                                 // whole-fill only
      } else return "RECORD_BAD_SHAPE";
      if (w.payto !== undefined && !isAddr(w.payto)) return "RECORD_BAD_ADDRESS";
      // v1.2 partial fills: min only on CSD-priced TOKEN offers, 1 ≤ min ≤ want.value
      if (r.min !== undefined) {
        if (gKeys !== "amount,ticker" || wKeys !== "value") return "RECORD_BAD_SHAPE";
        if ((fault = amountFault(r.min))) return fault;
        if (parseAmount(r.min)! > parseAmount(w.value, { allowZero: true })!) return "RECORD_MIN_ABOVE_WANT";
      }
      if (r.bid !== undefined && !isHash(r.bid)) return "RECORD_BAD_HASH";
      if (r.taker !== undefined && !isAddr(r.taker)) return "RECORD_BAD_ADDRESS";
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return "RECORD_BAD_TEXT";
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return "RECORD_BAD_TS";
      return r as unknown as OfferRecord;
    }
    case "ocancel": {
      // at most one give-filter; bare {v,t} = cancel ALL my earlier open offers
      if (r.ticker !== undefined && r.name !== undefined) return "RECORD_BAD_SHAPE";
      if (r.ticker !== undefined && !isTicker(r.ticker)) return "RECORD_BAD_TICKER";
      if (r.name !== undefined && (fault = nameFault(r.name))) return fault;
      const n = Object.keys(r).length;
      if (n !== 2 + (r.ticker !== undefined ? 1 : 0) + (r.name !== undefined ? 1 : 0)) return "RECORD_EXTRA_KEY";
      return r as unknown as OfferCancelAllRecord;
    }
    case "bid": {
      if (!onlyKeys(r, BID_KEYS)) return "RECORD_EXTRA_KEY";
      const w = r.want as Record<string, unknown> | undefined;
      const g = r.give as Record<string, unknown> | undefined;
      if (!w || !g || typeof w !== "object" || Array.isArray(w) || typeof g !== "object" || Array.isArray(g)) return "RECORD_BAD_SHAPE";
      const wKeys = Object.keys(w).sort().join(",");
      if (wKeys === "amount,ticker") {
        if (!isTicker(w.ticker)) return "RECORD_BAD_TICKER";
        if ((fault = amountFault(w.amount))) return fault;
      } else if (wKeys === "name") { if ((fault = nameFault(w.name))) return fault; }
      else return "RECORD_BAD_SHAPE";
      if (Object.keys(g).sort().join(",") !== "value") return "RECORD_BAD_SHAPE";
      if ((fault = amountFault(g.value))) return fault; // CSD > 0
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return "RECORD_BAD_TEXT";
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return "RECORD_BAD_TS";
      return r as unknown as BidRecord;
    }
    // ── names (v1.1) ──
    case "ncommit": {
      if (!isHash(r.commit)) return "RECORD_BAD_HASH";
      if (Object.keys(r).length !== 3) return "RECORD_EXTRA_KEY"; // v,t,commit only
      return r as unknown as NameCommitRecord;
    }
    case "name": {
      // onlyKeys closes the DECOY-KEY cross-language determinism fork (audit M1 / cairn-redteam FORK-1):
      // `name` is a value-bearing record (claims ownership + pays the reg fee), so a decoy astral-codepoint
      // key would canonicalize differently under UTF-16 vs codepoint/byte sort and fork two honest resolvers.
      // (The separate trailing-control-char fork class — audit C1 — is closed by the anchored ^…$ regexes +
      // the Python `.fullmatch` parity, guarded by conformance/crosscheck-regex.mjs; not by onlyKeys.)
      if (!onlyKeys(r, NAME_KEYS)) return "RECORD_EXTRA_KEY";
      if ((fault = nameFault(r.name))) return fault;
      if (r.salt !== undefined && (typeof r.salt !== "string" || !SALT_RE.test(r.salt))) return "RECORD_BAD_SALT";
      return r as unknown as NameRecord;
    }
    case "nfinalize": {
      // v2.5 winner-only register finalize (carries the reg fee). Same decoy-key allowlist as `name`; salt is
      // MANDATORY here (self-contained re-derivation of the deep commit binds the finalize to the reservation).
      // Parse is height-agnostic; the resolve handler is V25-gated, so below V25 this is a no-op in both impls.
      if (!onlyKeys(r, NFINALIZE_KEYS)) return "RECORD_EXTRA_KEY";
      if ((fault = nameFault(r.name))) return fault;
      if (typeof r.salt !== "string" || !SALT_RE.test(r.salt)) return "RECORD_BAD_SALT";
      return r as unknown as NameFinalizeRecord;
    }
    case "nxfer": {
      if ((fault = nameFault(r.name))) return fault;
      if (!isAddr(r.to)) return "RECORD_BAD_ADDRESS";
      if (Object.keys(r).length !== 4) return "RECORD_EXTRA_KEY";
      return r as unknown as NameXferRecord;
    }
    case "nset": {
      if ((fault = nameFault(r.name))) return fault;
      if (!isAddr(r.addr)) return "RECORD_BAD_ADDRESS";
      if (Object.keys(r).length !== 4) return "RECORD_EXTRA_KEY";
      return r as unknown as NameSetRecord;
    }
    // ── v1.5 ──
    case "nrenew": {
      if ((fault = nameFault(r.name))) return fault;
      if (Object.keys(r).length !== 3) return "RECORD_EXTRA_KEY";
      return r as unknown as NameRenewRecord;
    }
    case "nprofile": {
      // v1.9 ENS-class identity (doc 36). INERT: validated for SHAPE + DETERMINISM only. The resolver
      // stays semantics-agnostic (NO reserved keys — the app layer keeps send targets out of `p`; doc 36 §6).
      if (!onlyKeys(r, NPROFILE_KEYS)) return "RECORD_EXTRA_KEY";
      if ((fault = nameFault(r.name))) return fault;
      const p = r.p as Record<string, unknown> | undefined;
      if (!p || typeof p !== "object" || Array.isArray(p)) return "RECORD_BAD_SHAPE";
      const keys = Object.keys(p);
      if (keys.length > PROFILE_MAX_KEYS) return "RECORD_PROFILE_TOO_MANY_KEYS"; // empty p is valid (= clear the profile)
      for (const k of keys) {
        // ASCII charset (PKEY) → the key sort can't fork across UTF-16/codepoint impls. string→string
        // values only; each ≤ PROFILE_MAX_VALUE_BYTES. (well-formed UTF-16 already enforced above.)
        if (!PKEY.test(k)) return "RECORD_PROFILE_BAD_KEY";
        const val = p[k];
        if (typeof val !== "string") return "RECORD_PROFILE_BAD_VALUE";
        if (new TextEncoder().encode(val).length > PROFILE_MAX_VALUE_BYTES) return "RECORD_PROFILE_VALUE_TOO_LONG";
      }
      return r as unknown as NameProfileRecord;
    }
    case "tmeta": {
      if (!isTicker(r.ticker)) return "RECORD_BAD_TICKER";
      // a csd-swarm content hash: 0x + 64 lowercase hex (Content Convention v1)
      if (typeof r.hash !== "string" || !HASH_RE.test(r.hash)) return "RECORD_BAD_HASH";
      if (Object.keys(r).length !== 4) return "RECORD_EXTRA_KEY";
      return r as unknown as TokenMetaRecord;
    }
    case "fclaim": {
      // v2.8 open-lane claim (§31). Parse is HEIGHT-AGNOSTIC; the resolve GRANT handler is V28-gated, so below
      // V28 a parsed fclaim is inert (the nfinalize precedent). Exact-key allowlist + isHash(offer); the expiry
      // rides the carrying Propose's expires_epoch, so there is NO expiresEpoch in the body.
      if (!onlyKeys(r, FCLAIM_KEYS)) return "RECORD_EXTRA_KEY";
      if (!isHash(r.offer)) return "RECORD_BAD_HASH";
      return r as unknown as FclaimRecord;
    }
    default:
      return "RECORD_UNKNOWN_TYPE"; // unknown t — forward-compatible no-op
  }
}

/** A record builder's refusal: the record does not validate, and `code` names the first rule it breaks (CONVENTION §40). */
export class RecordError extends Error {
  readonly code: RecordCode;
  constructor(code: RecordCode) {
    super(`record does not validate against CONVENTION.md (${code})`);
    this.name = "RecordError";
    this.code = code;
  }
}

/** Build (and self-validate) a record → {record, uri, payloadHash} ready to anchor; a RecordError names the rule it breaks. */
export function buildRecord(record: CairnXRecord): BuiltRecord {
  const uri = canonicalJson(record);
  const ph = payloadHash(record);
  const back = explainRecord(uri, ph);
  if (!back.ok) throw new RecordError(back.code);
  return { record, uri, payloadHash: ph };
}

export const deploy = (r: Omit<DeployRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "deploy", ...r });
export const mint = (r: Omit<MintRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "mint", ...r });
export const transfer = (r: Omit<TransferRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "transfer", ...r });
export const offer = (r: Omit<OfferRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "offer", ...r });
export const bid = (r: Omit<BidRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "bid", ...r });
export const offerCancelAll = (r: Omit<OfferCancelAllRecord, "v" | "t"> = {}): BuiltRecord =>
  buildRecord({ v: 1, t: "ocancel", ...r });
// names (v1.1)
export const nameCommitRecord = (r: Omit<NameCommitRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "ncommit", ...r });
export const nameClaim = (r: Omit<NameRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "name", ...r });
// v2.5 winner-only register finalize (salt mandatory; carries the reg fee)
export const nameFinalize = (r: Omit<NameFinalizeRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nfinalize", ...r });
export const nameXfer = (r: Omit<NameXferRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nxfer", ...r });
export const nameSet = (r: Omit<NameSetRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nset", ...r });
export const nameRenew = (r: Omit<NameRenewRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nrenew", ...r });
export const tokenMeta = (r: Omit<TokenMetaRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "tmeta", ...r });
// v1.9 ENS-class identity. NOTE: the address-key policy (no addr/address/coin in `p`) is an APP-LAYER
// concern enforced in the wallet builder + UI (doc 36 §6) — this low-level builder stays permissive,
// matching the semantics-agnostic resolver.
export const nameProfile = (r: Omit<NameProfileRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nprofile", ...r });
// v2.8 open-lane claim (§31): a short-expiry Propose reserving an offer; the fill Attests this record's txid.
export const fclaim = (r: Omit<FclaimRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "fclaim", ...r });
