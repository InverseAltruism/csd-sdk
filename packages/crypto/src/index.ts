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
  const d = hb(digestHex);
  // The Rust node's Message::from_digest_slice requires EXACTLY 32 bytes; noble would silently
  // pad/truncate, a latent cross-impl divergence. Enforce it here (audit L14).
  if (d.length !== 32) throw new Error(`signDigest: digest must be exactly 32 bytes, got ${d.length}`);
  const sig = secp256k1.sign(d, hb(priv), { lowS: true });
  return { sig64: hx(sig.toCompactRawBytes()), pub33: pubFromPriv(priv) };
}

/** Verify a compact-64 LOW-S signature over a digest. Rejects high-S (malleability). */
export function verifyDigest(sig64: string, pub33: string, digestHex: string): boolean {
  // Whole body fail-closed: hb() throws on malformed hex, so an attacker-supplied bad sig/pubkey/digest
  // must return false, not throw (it is reachable unauthenticated via verifySiwc + the registry
  // resolver — audit M1). Also enforce the exact 32-byte digest length (L14).
  try {
    const s = hb(sig64), p = hb(pub33), d = hb(digestHex);
    if (s.length !== 64 || p.length !== 33 || d.length !== 32) return false;
    if (secp256k1.Signature.fromCompact(s).hasHighS()) return false;
    return secp256k1.verify(s, d, p, { lowS: true });
  } catch { return false; }
}

/** p2pkh scriptSig = 0x40 ‖ sig64 ‖ 0x21 ‖ pub33 (the 99-byte spend script). */
export function buildScriptSig(sig64: string, pub33: string): string {
  return "0x40" + strip0x(sig64) + "21" + strip0x(pub33);
}

// ── scriptSig parsing (Plan 56 item 18: the SDK gap that made three consumers re-roll this) ──
// TWO exports with DELIBERATELY distinct contracts. Do not "unify" them:
//   parseScriptSig / signerAddrFromScriptSig — STRUCTURAL, the scanner contract.
//     Attribution-compatible with the copies it replaces (cairn chainscan.ts + csd-indexer
//     decode.ts; one documented strictness, see the sig-regex note below): length >= 198 hex
//     chars, TRAILING BYTES TOLERATED, no signature verification. Scanners attribute txs the node
//     has already consensus-validated, so a sig check there is redundant CPU with new failure
//     modes; changing tolerance would silently change historical attribution (the full-chain
//     differential in conformance/ pins zero deltas before any consumer swap).
//   recoverSigner — STRICT, the wallet/verifier contract (namespv): EXACT length AND the
//     signature must verify against the caller-supplied digest (the merkle root commits the tx
//     body but not the scriptSig, so without the sig check a lying node could re-attribute a
//     record's author).

export interface ParsedScriptSig { sig64: string; pub33: string }

/** Structural parse of a CSD_SIG_V1 scriptSig (scanner contract; see block comment above).
 *  null on malformation. Trailing bytes beyond the 99-byte script are tolerated by design. */
export function parseScriptSig(scriptSig: string | null | undefined): ParsedScriptSig | null {
  if (typeof scriptSig !== "string") return null;
  const h = strip0x(scriptSig).toLowerCase();
  if (h.length < 2 + 128 + 2 + 66) return null;
  if (h.slice(0, 2) !== "40") return null;          // 0x40 = 64-byte sig follows
  if (h.slice(130, 132) !== "21") return null;      // 0x21 = 33-byte pubkey follows
  const sig = h.slice(2, 130), pub = h.slice(132, 198);
  // One deliberate strictness over the replaced copies: the sig region is hex-validated too (the
  // old scanners never read those bytes, so garbage there still attributed). Unreachable via node
  // RPC (script_sig is bytes, always hex-encoded) and proven delta-free over the full live chain
  // (conformance/scriptsig-differential.mjs); required so the returned sig64 is always safe to
  // hand to verifyDigest and friends.
  if (!/^[0-9a-f]{128}$/.test(sig) || !/^[0-9a-f]{66}$/.test(pub)) return null;
  return { sig64: "0x" + sig, pub33: "0x" + pub };
}

/** The signer's addr20 (hash160 of the embedded pubkey) under the SCANNER contract.
 *  Drop-in for the deriveAddr copies in cairn/chainscan.ts and csd-indexer/decode.ts. */
export function signerAddrFromScriptSig(scriptSig: string | null | undefined): string | null {
  const p = parseScriptSig(scriptSig);
  if (!p) return null;
  try { return hash160(hb(p.pub33)); } catch { return null; }
}

/** Recover + AUTHENTICATE the signer under the STRICT wallet contract: exact 99-byte script and
 *  the signature must verify against `digestHex` (e.g. sighash(tx)). null on any malformation,
 *  trailing bytes, or bad signature. Mirrors cairn-wallet namespv's recoverSigner. */
export function recoverSigner(scriptSig: string | null | undefined, digestHex: string): string | null {
  if (typeof scriptSig !== "string") return null;
  const h = strip0x(scriptSig).toLowerCase();
  if (h.length !== 198) return null;
  const p = parseScriptSig(h);
  if (!p) return null;
  try {
    if (!verifyDigest(p.sig64, p.pub33, digestHex)) return null;
    return addrFromPub(p.pub33).toLowerCase();
  } catch { return null; }
}
