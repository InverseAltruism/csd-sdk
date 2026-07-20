// Block header codec + PoW. Header is a fixed 84-byte little-endian struct; hash = sha256d.
// (chain/index.rs serialize_header + header_hash; chain/pow.rs bits→target + check.)
import { hb, hx, hbFixed, u32, u64, sha256d } from "./bytes.js";
import { MAX_U128, POW_LIMIT_BITS } from "./params.js";

export interface BlockHeader {
  version: number;
  prev: string;   // 0x..64 hex
  merkle: string; // 0x..64 hex
  time: number | bigint;
  bits: number;
  nonce: number;
}

/** Exact 84-byte LE header serialization. */
export function serializeHeader(h: BlockHeader): Uint8Array {
  const buf = new Uint8Array(84);
  buf.set(u32(h.version), 0);
  buf.set(hbFixed(h.prev, 32), 4);
  buf.set(hbFixed(h.merkle, 32), 36);
  buf.set(u64(h.time), 68);
  buf.set(u32(h.bits), 76);
  buf.set(u32(h.nonce), 80);
  return buf;
}

/** Header hash = sha256d(serialize_header). Returned 0x-hex (big-endian byte order as hashed). */
export function headerHash(h: BlockHeader): string { return hx(sha256d(serializeHeader(h))); }
export function headerHashBytes(h: BlockHeader): Uint8Array { return sha256d(serializeHeader(h)); }

/**
 * Decode Bitcoin-style compact `bits` to a 256-bit target as a 32-byte big-endian array.
 * Mirrors pow.rs bits_to_target_bytes: returns all-zero (an impossible/invalid target) for
 * the rejection cases (exp 0, mant 0, sign bit set, exp>32, overflow).
 */
export function bitsToTarget(bits: number): Uint8Array {
  const exp = (bits >>> 24) & 0xff;
  const mant = bits & 0x00ffffff;
  const out = new Uint8Array(32);
  if (exp === 0 || mant === 0) return out;
  if ((mant & 0x00800000) !== 0) return out; // sign bit set → invalid
  if (exp > 32) return out;
  let target: bigint;
  if (exp <= 3) target = BigInt(mant) >> BigInt(8 * (3 - exp));
  else target = BigInt(mant) << BigInt(8 * (exp - 3));
  if (target === 0n) return out;
  if (target >= 1n << 256n) return out; // > 256 bits → invalid
  // write big-endian into 32 bytes
  for (let i = 31; i >= 0 && target > 0n; i--) { out[i] = Number(target & 0xffn); target >>= 8n; }
  return out;
}

export function targetToBigInt(target: Uint8Array): bigint {
  let v = 0n;
  for (const byte of target) v = (v << 8n) | BigInt(byte);
  return v;
}

/** A 256-bit target value → 32-byte big-endian array (right-aligned; matches biguint_to_target_bytes). */
export function bigIntToTarget(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

/** Minimal big-endian bytes of x (no leading zeros), like BigUint::to_bytes_be. */
function minBE(x: bigint): number[] {
  if (x === 0n) return [];
  const b: number[] = [];
  while (x > 0n) { b.unshift(Number(x & 0xffn)); x >>= 8n; }
  return b;
}

/**
 * Encode a 32-byte BE target back to canonical compact `bits` (port of pow.rs
 * target_bytes_to_bits). Needed by the LWMA re-derivation in @inversealtruism/csd-light.
 */
export function targetToBits(target: Uint8Array): number {
  const x = targetToBigInt(target);
  if (x === 0n) return 0;
  const bytes = minBE(x);
  let exp = bytes.length;
  let mant: number;
  if (exp <= 3) {
    const shift = BigInt(8 * (3 - exp));
    mant = Number((x << shift) & 0xffffffffn) & 0x00ffffff;
  } else {
    mant = ((bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!) >>> 0;
  }
  if ((mant & 0x00800000) !== 0) { mant >>= 8; exp += 1; }
  mant &= 0x00ffffff;
  return ((exp << 24) | mant) >>> 0;
}

/**
 * The largest (easiest) target consensus allows — the value of POW_LIMIT_BITS as an integer.
 * The Rust node gates EVERY PoW/work check on "not easier than the pow limit" (chain/pow.rs
 * bits_within_pow_limit, reached from pow_ok_strict and work_from_bits). Without this gate the JS
 * verifier would deem valid a header whose `bits` encode a difficulty easier than the limit — one
 * the node rejects at chain/index.rs ("bits beyond pow limit") — a consensus-conformance divergence
 * (audit NEW-1). The `target > POW_LIMIT_TARGET` check below mirrors the node at 0 differential divergence.
 */
const POW_LIMIT_TARGET = targetToBigInt(bitsToTarget(POW_LIMIT_BITS));

/** PoW validity: header hash ≤ target(bits), AND bits within the pow limit (both BE), per the node. */
export function powOk(headerHashBE: Uint8Array, bits: number): boolean {
  const target = targetToBigInt(bitsToTarget(bits));
  if (target === 0n || target > POW_LIMIT_TARGET) return false; // invalid, or easier than pow limit → never valid
  return targetToBigInt(headerHashBE) <= target;
}

/**
 * Chainwork contributed by a header at difficulty `bits`: floor(2^256 / (target + 1)), CLAMPED to
 * u128 — faithful to the node's `work_from_bits` (pow.rs), which returns `w.to_u128().unwrap_or(MAX)`.
 * A no-op at any realistic difficulty (work ≪ 2^128), but keeps the SDK a byte-exact port at extremes
 * instead of diverging from the node's u128 accounting (finding A-S4).
 */
export function workForBits(bits: number): bigint {
  const target = targetToBigInt(bitsToTarget(bits));
  // Beyond the pow limit (or invalid) → the node's work_from_bits bails; treat as no work so an
  // easier-than-limit header cannot accrue chainwork in the JS light client (audit NEW-1).
  if (target === 0n || target > POW_LIMIT_TARGET) return 0n;
  const w = (1n << 256n) / (target + 1n);
  return w > MAX_U128 ? MAX_U128 : w;
}

// ── merkle (Bitcoin-style: leaves = txids, odd row duplicates the last) ──

/** Compute the tx-merkle root from the ordered list of txids (0x-hex). */
export function merkleRoot(txidsHex: string[]): string {
  if (txidsHex.length === 0) return "0x" + "00".repeat(32);
  let layer = txidsHex.map(hb);
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = i + 1 < layer.length ? layer[i + 1]! : layer[i]!; // duplicate last if odd
      const buf = new Uint8Array(64); buf.set(left, 0); buf.set(right, 32);
      next.push(sha256d(buf));
    }
    layer = next;
  }
  return hx(layer[0]!);
}

/**
 * Verify a merkle inclusion proof (Electrum format): fold `txid` up the branch and assert it
 * equals `merkleRootHex`. `pos` is the tx index in the block; its bits select sibling side.
 *
 * B8-sdklow (REBIND, audit LOW): declared boolean and now BEHAVES boolean - malformed proof material
 * (non-hex / odd-length txid, sibling, or root) returns false instead of throwing. A verifier that
 * crashes on hostile input is an availability hole at a trust boundary, and every refusal path here is
 * fail-closed either way (false and throw both refuse; nothing formerly rejected is now accepted).
 */
export function verifyMerkleProof(txidHex: string, pos: number, branchHex: string[], merkleRootHex: string): boolean {
  try {
    let cur = hb(txidHex);
    let idx = pos;
    for (const sibHex of branchHex) {
      const sib = hb(sibHex);
      const buf = new Uint8Array(64);
      if (idx & 1) { buf.set(sib, 0); buf.set(cur, 32); } else { buf.set(cur, 0); buf.set(sib, 32); }
      cur = sha256d(buf);
      idx >>= 1;
    }
    // Normalize the expected root through hb→hx so the check is insensitive to a `0x` prefix or
    // case. Without this, a correctly-valued but unprefixed root makes a VALID proof verify as
    // false — a dangerous asymmetry for a verifier (good data looks rejected).
    return hx(cur) === hx(hb(merkleRootHex));
  } catch {
    return false;   // malformed input IS a failed verification, never a crash
  }
}

/** Build the merkle branch for tx at index `pos` from the full ordered txid list. */
export function merkleBranch(txidsHex: string[], pos: number): string[] {
  let layer = txidsHex.map(hb);
  const branch: string[] = [];
  let idx = pos;
  while (layer.length > 1) {
    const sibIdx = idx ^ 1;
    const sib = sibIdx < layer.length ? layer[sibIdx]! : layer[idx]!; // odd-row dup
    branch.push(hx(sib));
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = i + 1 < layer.length ? layer[i + 1]! : layer[i]!;
      const buf = new Uint8Array(64); buf.set(left, 0); buf.set(right, 32);
      next.push(sha256d(buf));
    }
    layer = next; idx >>= 1;
  }
  return branch;
}
