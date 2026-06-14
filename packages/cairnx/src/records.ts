// CairnX record validation + builders (pure; no I/O).
import { canonicalJson, payloadHash } from "@inversealtruism/csd-codec";
import {
  ADDR_RE, AMOUNT_RE, HASH_RE, MAX_AMOUNT, MAX_RECORD_BYTES, NAME_RE, RESERVED_NAMES, TICKER_RE,
  type BidRecord, type CairnXRecord, type DeployRecord, type MintRecord, type NameCommitRecord,
  type NameRecord, type NameSetRecord, type NameRenewRecord, type TokenMetaRecord, type NameXferRecord, type OfferCancelAllRecord,
  type OfferRecord, type TransferRecord,
} from "./types.js";

export interface BuiltRecord { record: CairnXRecord; uri: string; payloadHash: string }

export function parseAmount(s: unknown, opts: { allowZero?: boolean } = {}): bigint | null {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) return null;
  const v = BigInt(s);
  if (v > MAX_AMOUNT) return null;
  if (v === 0n && !opts.allowZero) return null;
  return v;
}

const isAddr = (a: unknown): a is string => typeof a === "string" && ADDR_RE.test(a);
const isTicker = (t: unknown): t is string => typeof t === "string" && TICKER_RE.test(t);
const isHash = (h: unknown): h is string => typeof h === "string" && HASH_RE.test(h);
/** A claimable name: lowercase-ASCII, 1–32, no leading/trailing hyphen, not reserved. */
export const isName = (n: unknown): n is string => typeof n === "string" && NAME_RE.test(n) && !RESERVED_NAMES.has(n);

/** Deterministic commit hash for front-run-proof name registration (commit-reveal). */
export function nameCommit(name: string, salt: string, owner: string): string {
  return payloadHash({ t: "cairnx:name:commit:v1", name, salt, owner: owner.toLowerCase() });
}

/**
 * True iff a JS string is well-formed UTF-16 (no lone/unpaired surrogate). A lone surrogate has NO
 * valid UTF-8 encoding, so per CONVENTION A1 ("raw UTF-8, never escaped") its canonical form is
 * UNDEFINABLE: V8's JSON.stringify escapes it to ASCII `\uXXXX` and accepts, while a spec-conformant
 * raw-UTF-8 resolver (Rust serde_json / Python / Go) rejects or mangles it to U+FFFD. That is a
 * cross-language consensus FORK on identical chain bytes. We use the native primitive where present
 * (Node ≥20 / modern V8) and fall back to a manual surrogate scan for older runtimes.
 */
function strWellFormed(s: string): boolean {
  const wf = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;
  if (typeof wf === "function") return wf.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {                 // high surrogate: must be followed by a low one
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {          // lone low surrogate
      return false;
    }
  }
  return true;
}
/** Recursively reject any non-well-formed UTF-16 string anywhere in a decoded record (keys + values). */
function isWellFormedDeep(v: unknown): boolean {
  if (typeof v === "string") return strWellFormed(v);
  if (Array.isArray(v)) return v.every(isWellFormedDeep);
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (!strWellFormed(k)) return false;
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
const DEPLOY_KEYS = new Set(["v", "t", "ticker", "name", "decimals", "supply", "mint", "mintLimit"]);
const MINT_KEYS = new Set(["v", "t", "ticker", "amount"]);
const TRANSFER_KEYS = new Set(["v", "t", "ticker", "to", "amount", "memo", "ts"]);
const OFFER_KEYS = new Set(["v", "t", "give", "want", "min", "bid", "taker", "memo", "ts"]);
const BID_KEYS = new Set(["v", "t", "want", "give", "memo", "ts"]);
const NAME_KEYS = new Set(["v", "t", "name", "salt"]);

/**
 * Parse + validate a record from an anchored `uri`. Returns null for anything invalid —
 * per CONVENTION §3, invalid is a no-op, never an error that poisons the replay.
 * Requirements enforced here: uri is canonical JSON of the record, ≤512 bytes,
 * payload_hash commits to it, schema rules of §4.
 */
export function parseRecord(uri: string, payloadHashHex: string): CairnXRecord | null {
  if (new TextEncoder().encode(uri).length > MAX_RECORD_BYTES) return null;
  let obj: unknown;
  try { obj = JSON.parse(uri); } catch { return null; }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  // canonical form + hash commitment (sha256(uri) == payload_hash ⇔ uri === canonicalJson(obj))
  try {
    if (canonicalJson(obj) !== uri) return null;
    if (payloadHash(obj).toLowerCase() !== payloadHashHex.toLowerCase()) return null;
  } catch { return null; }
  // Determinism gate (CONVENTION A1/A5): a record carrying any non-well-formed UTF-16 string (lone
  // surrogate) is canonically UNDEFINABLE across languages, so it is an INVALID no-op everywhere —
  // never an ASCII-escaped record that one resolver credits and another rejects. Must run AFTER the
  // canonical gate (the uri itself is pure-ASCII `\uXXXX`; the surrogate only exists in `obj`).
  if (!isWellFormedDeep(obj)) return null;

  const r = obj as Record<string, unknown>;
  if (r.v !== 1 || typeof r.t !== "string") return null;

  switch (r.t) {
    case "deploy": {
      if (!onlyKeys(r, DEPLOY_KEYS)) return null;
      if (!isTicker(r.ticker)) return null;
      // `.length` = UTF-16 code units IS the consensus unit (CONVENTION A6): an astral codepoint is 2
      // units, so a port counting codepoints/bytes would fork at the 32-unit boundary. Keep `.length`.
      if (r.name !== undefined && (typeof r.name !== "string" || r.name.length > 32)) return null;
      if (typeof r.decimals !== "number" || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 8) return null;
      if (parseAmount(r.supply) === null) return null;
      if (r.mint !== "open" && r.mint !== "issuer") return null;
      if (r.mint === "open" && parseAmount(r.mintLimit) === null) return null;
      if (r.mint === "issuer" && r.mintLimit !== undefined) return null;
      return r as unknown as DeployRecord;
    }
    case "mint": {
      if (!onlyKeys(r, MINT_KEYS)) return null;
      if (!isTicker(r.ticker)) return null;
      if (r.amount !== undefined && parseAmount(r.amount) === null) return null;
      return r as unknown as MintRecord;
    }
    case "transfer": {
      if (!onlyKeys(r, TRANSFER_KEYS)) return null;
      if (!isTicker(r.ticker) || !isAddr(r.to) || parseAmount(r.amount) === null) return null;
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      // Number.isSafeInteger (not just isInteger): a `ts` ≥ 2^53 (or 1e21, which IS an integer)
      // serializes as the JS-specific "1e+21" / loses precision, forking the canonical bytes vs a
      // u64/decimal porter (audit M1). Bounding to the safe range makes every honest impl agree.
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r as unknown as TransferRecord;
    }
    case "offer": {
      if (!onlyKeys(r, OFFER_KEYS)) return null;
      const g = r.give as Record<string, unknown> | undefined;
      const w = r.want as Record<string, unknown> | undefined;
      if (!g || !w || typeof g !== "object" || Array.isArray(g) || typeof w !== "object" || Array.isArray(w)) return null;
      // give is EITHER {ticker,amount} OR {name} — exactly one shape, no extra keys mixing them
      const gKeys = Object.keys(g).sort().join(",");
      if (gKeys === "amount,ticker") { if (!isTicker(g.ticker) || parseAmount(g.amount) === null) return null; }
      else if (gKeys === "name") { if (!isName(g.name)) return null; }
      else return null;
      // want is EITHER {value[,payto]} (CSD) OR {ticker,amount[,payto]} (v1.2 token-priced)
      const wKeys = Object.keys(w).filter((k) => k !== "payto").sort().join(",");
      if (wKeys === "value") {
        if (parseAmount(w.value, { allowZero: true }) === null) return null;
      } else if (wKeys === "amount,ticker") {
        if (!isTicker(w.ticker) || parseAmount(w.amount, { allowZero: true }) === null) return null;
        if (gKeys === "amount,ticker" && w.ticker === g.ticker) return null; // give≠want token
        if (r.min !== undefined) return null;                               // whole-fill only
      } else return null;
      if (w.payto !== undefined && !isAddr(w.payto)) return null;
      // v1.2 partial fills: min only on CSD-priced TOKEN offers, 1 ≤ min ≤ want.value
      if (r.min !== undefined) {
        if (gKeys !== "amount,ticker" || wKeys !== "value") return null;
        const mn = parseAmount(r.min);
        if (mn === null || mn > parseAmount(w.value, { allowZero: true })!) return null;
      }
      if (r.bid !== undefined && !isHash(r.bid)) return null;
      if (r.taker !== undefined && !isAddr(r.taker)) return null;
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r as unknown as OfferRecord;
    }
    case "ocancel": {
      // at most one give-filter; bare {v,t} = cancel ALL my earlier open offers
      if (r.ticker !== undefined && r.name !== undefined) return null;
      if (r.ticker !== undefined && !isTicker(r.ticker)) return null;
      if (r.name !== undefined && !isName(r.name)) return null;
      const n = Object.keys(r).length;
      if (n !== 2 + (r.ticker !== undefined ? 1 : 0) + (r.name !== undefined ? 1 : 0)) return null;
      return r as unknown as OfferCancelAllRecord;
    }
    case "bid": {
      if (!onlyKeys(r, BID_KEYS)) return null;
      const w = r.want as Record<string, unknown> | undefined;
      const g = r.give as Record<string, unknown> | undefined;
      if (!w || !g || typeof w !== "object" || Array.isArray(w) || typeof g !== "object" || Array.isArray(g)) return null;
      const wKeys = Object.keys(w).sort().join(",");
      if (wKeys === "amount,ticker") { if (!isTicker(w.ticker) || parseAmount(w.amount) === null) return null; }
      else if (wKeys === "name") { if (!isName(w.name)) return null; }
      else return null;
      if (Object.keys(g).sort().join(",") !== "value" || parseAmount(g.value) === null) return null; // CSD > 0
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r as unknown as BidRecord;
    }
    // ── names (v1.1) ──
    case "ncommit": {
      if (!isHash(r.commit)) return null;
      if (Object.keys(r).length !== 3) return null; // v,t,commit only
      return r as unknown as NameCommitRecord;
    }
    case "name": {
      // onlyKeys closes the last cross-language determinism fork (audit M1 / cairn-redteam FORK-1):
      // `name` is a value-bearing record (claims ownership + pays the reg fee), so a decoy astral-codepoint
      // key would canonicalize differently under UTF-16 vs codepoint/byte sort and fork two honest resolvers.
      // The other value records (deploy/mint/transfer/offer/bid) were already gated; this was the one gap.
      if (!onlyKeys(r, NAME_KEYS)) return null;
      if (!isName(r.name)) return null;
      if (r.salt !== undefined && (typeof r.salt !== "string" || !/^[0-9a-fA-F]{16,128}$/.test(r.salt))) return null;
      return r as unknown as NameRecord;
    }
    case "nxfer": {
      if (!isName(r.name) || !isAddr(r.to)) return null;
      if (Object.keys(r).length !== 4) return null;
      return r as unknown as NameXferRecord;
    }
    case "nset": {
      if (!isName(r.name) || !isAddr(r.addr)) return null;
      if (Object.keys(r).length !== 4) return null;
      return r as unknown as NameSetRecord;
    }
    // ── v1.5 ──
    case "nrenew": {
      if (!isName(r.name)) return null;
      if (Object.keys(r).length !== 3) return null;
      return r as unknown as NameRenewRecord;
    }
    case "tmeta": {
      if (!isTicker(r.ticker)) return null;
      // a csd-swarm content hash: 0x + 64 lowercase hex (Content Convention v1)
      if (typeof r.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(r.hash)) return null;
      if (Object.keys(r).length !== 4) return null;
      return r as unknown as TokenMetaRecord;
    }
    default:
      return null; // unknown t — forward-compatible no-op
  }
}

/** Build (and self-validate) a record → {record, uri, payloadHash} ready to anchor. */
export function buildRecord(record: CairnXRecord): BuiltRecord {
  const uri = canonicalJson(record);
  const ph = payloadHash(record);
  const back = parseRecord(uri, ph);
  if (back === null) throw new Error("record does not validate against CONVENTION.md");
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
export const nameXfer = (r: Omit<NameXferRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nxfer", ...r });
export const nameSet = (r: Omit<NameSetRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nset", ...r });
export const nameRenew = (r: Omit<NameRenewRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "nrenew", ...r });
export const tokenMeta = (r: Omit<TokenMetaRecord, "v" | "t">): BuiltRecord =>
  buildRecord({ v: 1, t: "tmeta", ...r });
