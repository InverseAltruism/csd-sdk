// Signature-encoding vectors: which 64 bytes the node's verify_sig accepts (compute-substrate src/crypto/mod.rs:
// Signature::from_compact, so r || s only, then low S). Each spends one coin of `owner` in the same cairnx:v1 Propose,
// input 0's scriptSig = 0x40 || sig64 || 0x21 || pub33. The bytes were chosen and the key solved for
// (P = r^-1 (sR - hG); for the DER one d = (s k - h) / r).
//
// How `nodeAccepts` was produced (no harness is committed): a Rust program on secp256k1 0.29.1, the version in the
// node's Cargo.lock, ran verify_sig's steps after the sighash on (sig64, pub33, expectedSighash):
// Message::from_digest_slice(expectedSighash), PublicKey::from_slice(pub33), Signature::from_compact(sig64), refuse
// when normalize_s() changes the signature, then Secp256k1::verification_only().verify_ecdsa. It printed ok for A1 and
// A2 and "signature failed verification" for B (2026-11-02).
import type { VTx } from "./index.js";

export interface SigVector {
  /** Short label (A1, A2, B). */
  name: string;
  /** The signed tx: a cairnx:v1 Propose whose input 0 carries 0x40 || sig64 || 0x21 || pub33. */
  tx: VTx;
  /** sighash(tx), the 32-byte digest sig64 signs (scriptSigs are stripped before hashing). */
  expectedSighash: string;
  /** The 64 signature bytes in input 0's scriptSig. */
  sig64: string;
  /** The 33-byte compressed public key in input 0's scriptSig. */
  pub33: string;
  /** hash160(pub33): the addr20 of the coin input 0 spends, the value to pass to authorOf as its script_pubkey. */
  owner: string;
  /** verify_sig's verdict on (sig64, pub33, expectedSighash), from the node's crate. A signature verdict only, not
   *  acceptance of the tx: its input 0 spends a made-up outpoint (prevTxid 0xabab..ab). */
  nodeAccepts: boolean;
}

const spend = (sig64: string, pub33: string): VTx => ({
  version: 1,
  inputs: [{ prevTxid: "0x" + "ab".repeat(32), vout: 0, scriptSig: "0x40" + sig64.slice(2) + "21" + pub33.slice(2) }],
  outputs: [{ value: 25_000_000, scriptPubkey: "0x" + "cd".repeat(20) }],
  locktime: 0,
  app: { type: "Propose", domain: "cairnx:v1", payloadHash: "0x" + "ef".repeat(32), uri: "u", expiresEpoch: 5000 },
});
const SIGHASH = "0x388d3773d75bede6c1f89ca79e3a593fd8556e3dd38a95a93a0c256e56f53338";
const vector = (name: string, sig64: string, pub33: string, owner: string, nodeAccepts: boolean): SigVector =>
  ({ name, tx: spend(sig64, pub33), expectedSighash: SIGHASH, sig64, pub33, owner, nodeAccepts });

/** A compact low-S signature whose bytes are also DER-shaped (30 3e 02 14 <20 bytes> 02 26 <38 bytes>); read as DER
 *  its s integer is too wide for the curve. The node accepts it. */
export const SIG_COMPACT_DER_SHAPED_A1 = vector("A1",
  "0x303e02147bf05397ac95dc9ab603c7896caf09c686c0b65b02263504e050e16252f13603d35a2051522a50f14f572a922ad0eedee26eb2398009eb62bcad669b",
  "0x028eb8a2807c2905b0520fa36656def108b69ee5d20547d669130c18c4f1ee57d9", "0x8bf866f3335bdf3e0c9ef90742043686d86fdcad", true);

/** A compact low-S signature whose bytes are also DER-shaped (30 3e 02 20 <32 bytes> 02 1a <26 bytes>); read as DER it
 *  is another in-range (r, s) pair that does not verify. The node accepts it. */
export const SIG_COMPACT_DER_SHAPED_A2 = vector("A2",
  "0x303e0220210a5337f8df3171a6c06c7e5b78915f1c2e62ac732ed16ef081a25401da0a04021a079244ee8095b0ce396bd6b456148b6c7ad05fb7098c8cfd3b92",
  "0x02e12d0185bc0518bd203d50fe266085cbf12dea388f54a4f74ca7a064d9a67c79", "0x611ee0b4575a026f20934e3412cd085e584daa35", true);

/** A valid DER signature that is 64 bytes long (30 3e 02 20 <r> 02 1a <s>); its compact reading is no signature. The
 *  node refuses it. */
export const SIG_DER64_B = vector("B",
  "0x303e02202c0e65d00bb81ca65be239b50a9741b987c5c77078ae5e2910938df83a7f9d05021a1fdf47c2a27bf6607ebf8a6a7e5bf00c158f860bc35e1215ade2",
  "0x02962d3549a3b73677e8fe9831f24141b84948d116927b85a96b483cf8563993fa", "0x41d9c3cd30ea9e5567c003f5f9328786f3108012", false);

export const SIG_VECTORS: SigVector[] = [SIG_COMPACT_DER_SHAPED_A1, SIG_COMPACT_DER_SHAPED_A2, SIG_DER64_B];
