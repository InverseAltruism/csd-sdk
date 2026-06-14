// Content addressing — how an off-chain payload maps to the on-chain `payload_hash`.
// CSD Content Convention v1: payload_hash = sha256(canonicalJson(content)).
// Canonical JSON = keys recursively sorted by **UTF-16 code unit** (JS `Array.prototype.sort` /
// String `<`), compact (no insignificant whitespace), then serialized as UTF-8. The sort is by
// UTF-16 code unit, NOT Unicode-codepoint or UTF-8-byte order — these agree for all BMP-below-
// U+FFFF text but DIVERGE at the astral boundary (U+FFFF sorts AFTER an astral key under UTF-16
// but BEFORE it under codepoint/UTF-8). A non-JS port MUST replicate UTF-16-code-unit key order
// (or pre-reject keys with codepoints > U+FFFF) or it will hash some objects differently.
// (This is the ecosystem convention L1's content swarm keys on; lifted from Cairn's
// proven `stableStringify`/`buildCommitment`.)
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// Max nesting depth — `canonicalJson` is recursive and is routinely run over UNTRUSTED content
// (indexers/wallets/verifiers hash attacker-supplied JSON), so an unbounded depth is a
// stack-overflow DoS. 256 is far beyond any real content record.
const MAX_DEPTH = 256;

export function canonicalJson(v: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error("canonicalJson: max nesting depth exceeded");
  if (v === null || typeof v !== "object") {
    // `undefined` is not valid JSON; JSON.stringify(undefined) returns the literal `undefined`,
    // which (a) can't be re-parsed — breaking the served-bytes==canonical self-certification —
    // and (b) collides {a:undefined,b:1} with {b:1}. Encode it as null, consistently.
    if (v === undefined) return "null";
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x, depth + 1)).join(",") + "]";
  const o = v as Record<string, unknown>;
  // Drop keys whose value is `undefined` (matches JSON.stringify object semantics) so the output
  // is always valid, re-parseable JSON and the hash is stable regardless of how undefined arose.
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k], depth + 1)).join(",") + "}";
}

/** payload_hash for a content record (0x-hex sha256 of its canonical JSON). */
export function payloadHash(content: unknown): string {
  return "0x" + bytesToHex(sha256(utf8ToBytes(canonicalJson(content))));
}

/** Verify served bytes match an on-chain payload_hash (self-certification). */
export function verifyContentBytes(bytes: Uint8Array, payloadHashHex: string): boolean {
  return "0x" + bytesToHex(sha256(bytes)) === payloadHashHex.toLowerCase();
}
