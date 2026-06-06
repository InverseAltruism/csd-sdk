// Content addressing — how an off-chain payload maps to the on-chain `payload_hash`.
// CSD Content Convention v1: payload_hash = sha256(canonicalJson(content)).
// Canonical JSON = recursively sorted keys, compact (no insignificant whitespace), UTF-8.
// (This is the ecosystem convention L1's content swarm keys on; lifted from Cairn's
// proven `stableStringify`/`buildCommitment`.)
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** payload_hash for a content record (0x-hex sha256 of its canonical JSON). */
export function payloadHash(content: unknown): string {
  return "0x" + bytesToHex(sha256(utf8ToBytes(canonicalJson(content))));
}

/** Verify served bytes match an on-chain payload_hash (self-certification). */
export function verifyContentBytes(bytes: Uint8Array, payloadHashHex: string): boolean {
  return "0x" + bytesToHex(sha256(bytes)) === payloadHashHex.toLowerCase();
}
