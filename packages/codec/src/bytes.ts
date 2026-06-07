// Byte/hex helpers shared by the codec. Zero Buffer, MV3/browser-safe.
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";

export { bytesToHex, hexToBytes, concatBytes, utf8ToBytes };

export const strip0x = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);
export const hb = (h: string): Uint8Array => hexToBytes(strip0x(h));
export const hx = (b: Uint8Array): string => "0x" + bytesToHex(b);
export const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
export function u64(n: number | bigint): Uint8Array {
  // REJECT inputs that can't be encoded faithfully. A `number` ≥ 2^53 has already lost precision
  // (so two different intended amounts could sign to identical bytes), and a negative would wrap
  // to a huge u64. CSD supply (~1e17 sats) exceeds 2^53, so callers MUST pass amounts in that
  // range as bigint. This guards the consensus primitive itself, not just the tx-builder layer.
  let v: bigint;
  if (typeof n === "bigint") {
    v = n;
  } else {
    if (!Number.isSafeInteger(n)) {
      throw new Error(`u64: unsafe number ${n} — pass values ≥ 2^53 (or negatives) as bigint`);
    }
    v = BigInt(n);
  }
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`u64: value ${v} out of range [0, 2^64)`);
  }
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
export const lenBytes = (b: Uint8Array): Uint8Array => concatBytes(u64(b.length), b);

// Fixed-width field decode that REJECTS a wrong byte length (consensus uses [u8;32]/[u8;20]
// and rejects anything else) — so a raw-tx builder can't silently truncate a field and sign
// bytes the caller didn't intend.
export function hbFixed(h: string, n: number): Uint8Array {
  const b = hb(h);
  if (b.length !== n) throw new Error(`expected a ${n}-byte (0x…${n * 2}-hex) field, got ${b.length} bytes`);
  return b;
}
