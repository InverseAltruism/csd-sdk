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
/** A claimable name: lowercase-ASCII, 3–32, no leading/trailing hyphen, not reserved. */
export const isName = (n: unknown): n is string => typeof n === "string" && NAME_RE.test(n) && !RESERVED_NAMES.has(n);

/** Deterministic commit hash for front-run-proof name registration (commit-reveal). */
export function nameCommit(name: string, salt: string, owner: string): string {
  return payloadHash({ t: "cairnx:name:commit:v1", name, salt, owner: owner.toLowerCase() });
}

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

  const r = obj as Record<string, unknown>;
  if (r.v !== 1 || typeof r.t !== "string") return null;

  switch (r.t) {
    case "deploy": {
      if (!isTicker(r.ticker)) return null;
      if (r.name !== undefined && (typeof r.name !== "string" || r.name.length > 32)) return null;
      if (typeof r.decimals !== "number" || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 8) return null;
      if (parseAmount(r.supply) === null) return null;
      if (r.mint !== "open" && r.mint !== "issuer") return null;
      if (r.mint === "open" && parseAmount(r.mintLimit) === null) return null;
      if (r.mint === "issuer" && r.mintLimit !== undefined) return null;
      return r as unknown as DeployRecord;
    }
    case "mint": {
      if (!isTicker(r.ticker)) return null;
      if (r.amount !== undefined && parseAmount(r.amount) === null) return null;
      return r as unknown as MintRecord;
    }
    case "transfer": {
      if (!isTicker(r.ticker) || !isAddr(r.to) || parseAmount(r.amount) === null) return null;
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isInteger(r.ts))) return null;
      return r as unknown as TransferRecord;
    }
    case "offer": {
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
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isInteger(r.ts))) return null;
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
      const w = r.want as Record<string, unknown> | undefined;
      const g = r.give as Record<string, unknown> | undefined;
      if (!w || !g || typeof w !== "object" || Array.isArray(w) || typeof g !== "object" || Array.isArray(g)) return null;
      const wKeys = Object.keys(w).sort().join(",");
      if (wKeys === "amount,ticker") { if (!isTicker(w.ticker) || parseAmount(w.amount) === null) return null; }
      else if (wKeys === "name") { if (!isName(w.name)) return null; }
      else return null;
      if (Object.keys(g).sort().join(",") !== "value" || parseAmount(g.value) === null) return null; // CSD > 0
      if (r.memo !== undefined && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== undefined && (typeof r.ts !== "number" || !Number.isInteger(r.ts))) return null;
      return r as unknown as BidRecord;
    }
    // ── names (v1.1) ──
    case "ncommit": {
      if (!isHash(r.commit)) return null;
      if (Object.keys(r).length !== 3) return null; // v,t,commit only
      return r as unknown as NameCommitRecord;
    }
    case "name": {
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
