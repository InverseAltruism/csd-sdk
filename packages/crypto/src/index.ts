// @inversealtruism/csd-crypto — Compute Substrate crypto primitives. Thin, debuggable wrappers over @noble.
//   address  = hash160(compressed pubkey)  (raw 20-byte hash160, 0x-hex; no base58/bech32)
//   sign     = secp256k1 ECDSA, RFC6979 deterministic, LOW-S enforced, compact 64-byte
// (Matches consensus crypto/mod.rs + the proven csdcore.ts.)
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";

const strip0x = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);
const hb = (h: string): Uint8Array => hexToBytes(strip0x(h));
const hx = (b: Uint8Array): string => "0x" + bytesToHex(b);

/** hash160(x) = ripemd160(sha256(x)) → 0x-hex (20 bytes). */
export function hash160(bytes: Uint8Array): string { return hx(ripemd160(sha256(bytes))); }

export function pubFromPriv(priv: string): string { return hx(secp256k1.getPublicKey(hb(priv), true)); }
export function addrFromPub(pub33: string): string { return hash160(hb(pub33)); }
export function addrFromPriv(priv: string): string { return hash160(secp256k1.getPublicKey(hb(priv), true)); }

/** A valid 0x..40-hex CSD address (raw hash160). */
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export function isValidAddr(a: string): boolean { return ADDR_RE.test(a); }

export function isValidPriv(h: string): boolean {
  try { const b = hb(h); return b.length === 32 && secp256k1.utils.isValidPrivateKey(b); } catch { return false; }
}

export function keygen(): { priv: string; pub: string; addr: string } {
  const k = secp256k1.utils.randomPrivateKey();
  const priv = hx(k);
  return { priv, pub: pubFromPriv(priv), addr: addrFromPriv(priv) };
}

export const randomNonce = (): string => bytesToHex(randomBytes(32));

/** Sign a 32-byte digest (e.g. a sighash). RFC6979 + LOW-S; returns compact 64-byte sig + pub33. */
export function signDigest(digestHex: string, priv: string): { sig64: string; pub33: string } {
  const sig = secp256k1.sign(hb(digestHex), hb(priv), { lowS: true });
  return { sig64: hx(sig.toCompactRawBytes()), pub33: pubFromPriv(priv) };
}

/** Verify a compact-64 LOW-S signature over a digest. Rejects high-S (malleability). */
export function verifyDigest(sig64: string, pub33: string, digestHex: string): boolean {
  const s = hb(sig64), p = hb(pub33);
  if (s.length !== 64 || p.length !== 33) return false;
  try {
    if (secp256k1.Signature.fromCompact(s).hasHighS()) return false;
    return secp256k1.verify(s, hb(digestHex), p, { lowS: true });
  } catch { return false; }
}

/** p2pkh scriptSig = 0x40 ‖ sig64 ‖ 0x21 ‖ pub33 (the 99-byte spend script). */
export function buildScriptSig(sig64: string, pub33: string): string {
  return "0x40" + strip0x(sig64) + "21" + strip0x(pub33);
}
