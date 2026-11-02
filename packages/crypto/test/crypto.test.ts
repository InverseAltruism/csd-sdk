// @inversealtruism/csd-crypto conformance: address derivation, LOW-S determinism, verify, against the
// node's funded key (block-21043 era) + property checks.
import { hash160, pubFromPriv, addrFromPriv, addrFromPub, isValidAddr, isValidPriv, keygen, signDigest, verifyDigest, buildScriptSig, parseScriptSig, signerAddrFromScriptSig, recoverSigner, authorOf } from "../src/index.js";
import { sighash, txid, merkleRoot, type Tx } from "@inversealtruism/csd-codec";
import { GOLDEN_TX, GOLDEN_PROPOSE_TX, GOLDEN_ATTEST_TX } from "@inversealtruism/csd-vectors";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };

// known vector: privkey → pub → addr (a deterministic keypair)
const PRIV = "0x" + "11".repeat(32);
const pub = pubFromPriv(PRIV);
ok("pubFromPriv is 33-byte compressed (0x02/0x03 prefix)", /^0x0[23][0-9a-f]{64}$/.test(pub));
ok("addrFromPriv == addrFromPub(pub)", addrFromPriv(PRIV) === addrFromPub(pub));
ok("addr is a valid 0x..40 address", isValidAddr(addrFromPriv(PRIV)));
ok("hash160 is 0x..40", /^0x[0-9a-f]{40}$/.test(hash160(new Uint8Array(33))));
ok("isValidPriv accepts a 32-byte key / rejects junk", isValidPriv(PRIV) && !isValidPriv("0x00") && !isValidPriv("0xzz"));

// signing: deterministic (RFC6979) + LOW-S + verifies; tamper fails
const sh = sighash(GOLDEN_TX.tx as any);
const a = signDigest(sh, PRIV), b = signDigest(sh, PRIV);
ok("signDigest is deterministic (RFC6979)", a.sig64 === b.sig64);
ok("signature verifies", verifyDigest(a.sig64, a.pub33, sh));
ok("verify rejects a wrong digest", !verifyDigest(a.sig64, a.pub33, "0x" + "00".repeat(32)));
// LOW-S malleability guard: actually CONSTRUCT the high-S twin (s' = N - s) of the valid signature
// and assert verifyDigest REJECTS it. (r, N-s) is a valid ECDSA pair; accepting it would allow
// signature/txid malleability. The old test only checked the genuine sig's S was low (tautology).
{
  const raw = a.sig64.replace(/^0x/, "");
  const r = raw.slice(0, 64);
  const S = BigInt("0x" + raw.slice(64));
  const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  ok("the genuine signature is low-S", S <= N / 2n);
  const highSig = "0x" + r + (N - S).toString(16).padStart(64, "0");
  ok("the constructed twin is genuinely high-S", N - S > N / 2n);
  ok("verify REJECTS the high-S twin (malleability blocked)", verifyDigest(highSig, a.pub33, sh) === false);
}
ok("buildScriptSig is 99 bytes (0x40+64+0x21+33)", buildScriptSig(a.sig64, a.pub33).slice(2).length / 2 === 99);

// The real Propose and Attest vectors: the mined signature verifies against the pinned sighash, which
// ties expectedSighash to what the node accepted rather than to this SDK's own sighash().
for (const [name, v] of [["Propose", GOLDEN_PROPOSE_TX], ["Attest", GOLDEN_ATTEST_TX]] as const) {
  const p = parseScriptSig(v.tx.inputs[0]!.scriptSig);
  ok(`${name} vector: the on-chain signature verifies against expectedSighash`, !!p && verifyDigest(p.sig64, p.pub33, v.expectedSighash));
  ok(`${name} vector: the same signature fails against a one-bit-different digest`,
    !!p && !verifyDigest(p.sig64, p.pub33, v.expectedSighash.slice(0, -1) + (v.expectedSighash.endsWith("0") ? "1" : "0")));
}

const g = keygen();
ok("keygen produces a valid self-consistent keypair", isValidPriv(g.priv) && addrFromPriv(g.priv) === g.addr);

// ── scriptSig parsing: the two contracts (Plan 57 B4; see the src block comment) ──
{
  const ss = buildScriptSig(a.sig64, a.pub33);           // a REAL signed script for this digest
  const expectAddr = addrFromPriv(PRIV);

  // round-trip: build -> parse recovers the exact fields
  const p = parseScriptSig(ss);
  ok("parseScriptSig round-trips buildScriptSig (sig64+pub33)", p !== null && p.sig64 === a.sig64 && p.pub33 === a.pub33);
  ok("signerAddrFromScriptSig == hash160(pub) == the signer's addr", signerAddrFromScriptSig(ss) === expectAddr);

  // SCANNER contract: trailing bytes tolerated (matches chainscan.ts/decode.ts byte-for-byte)
  const trailing = ss + "deadbeef";
  ok("scanner contract: trailing bytes tolerated by parse + addr", parseScriptSig(trailing) !== null && signerAddrFromScriptSig(trailing) === expectAddr);
  // WALLET contract: exact length + signature must verify
  ok("strict contract: recoverSigner REJECTS trailing bytes", recoverSigner(trailing, sh) === null);
  ok("recoverSigner authenticates the honest script", recoverSigner(ss, sh) === expectAddr);
  ok("recoverSigner rejects a wrong digest (anti re-attribution)", recoverSigner(ss, "0x" + "00".repeat(32)) === null);
  {
    // substitute another key's pubkey into the script: structural parse still succeeds (scanner
    // attributes to the substituted key; the node validated the real spend), strict recover fails.
    const forged = "0x40" + a.sig64.slice(2) + "21" + pubFromPriv("0x" + "22".repeat(32)).slice(2);
    ok("substituted pubkey: scanner parses (structural), strict recover REFUSES", parseScriptSig(forged) !== null && recoverSigner(forged, sh) === null);
  }
  // malformations: both contracts refuse
  ok("wrong sig-length prefix refused", parseScriptSig("0x41" + ss.slice(4)) === null);
  ok("wrong pub-length marker refused", parseScriptSig(ss.slice(0, 132) + "22" + ss.slice(134)) === null);
  ok("too-short script refused", parseScriptSig(ss.slice(0, 100)) === null && recoverSigner(ss.slice(0, 100), sh) === null);
  ok("non-hex garbage refused without throwing", parseScriptSig("0x40" + "zz".repeat(64) + "21" + "aa".repeat(33)) === null);
  {
    // uppercase-hex script: both contracts normalize case (node RPC emits lowercase; defense only)
    const upper = "0x" + ss.slice(2).toUpperCase();
    ok("uppercase hex normalizes in both contracts", signerAddrFromScriptSig(upper) === expectAddr && recoverSigner(upper, sh) === expectAddr);
  }
  ok("null/undefined refused", parseScriptSig(null) === null && signerAddrFromScriptSig(undefined) === null && recoverSigner(null, sh) === null);
}

// The node takes exactly 32 digest bytes (Message::from_digest_slice). noble reads a longer digest by its leftmost
// 256 bits and a shorter one as a smaller integer, so each case below verifies or signs in noble without the check.
{
  const long = sh + "00";                                  // reads as sh after truncation
  const short = "0x" + sh.slice(4);                        // 31 bytes, the integer 0x00 || short
  const overShort = signDigest("0x00" + sh.slice(4), PRIV);
  const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  ok("verifyDigest refuses a 33-byte digest whose first 32 bytes are the signed digest", !verifyDigest(a.sig64, a.pub33, long));
  ok("verifyDigest refuses a 31-byte digest equal as an integer to the signed digest",
    !verifyDigest(overShort.sig64, overShort.pub33, short));
  ok("signDigest throws on a 31-byte and on a 33-byte digest", throws(() => signDigest(short, PRIV)) && throws(() => signDigest(long, PRIV)));
}

const base: Tx = {
  version: 1, locktime: 0,
  inputs: [{ prevTxid: "0x" + "ab".repeat(32), vout: 0, scriptSig: "0x" }],
  outputs: [{ value: 25_000_000n, scriptPubkey: "0x" + "cd".repeat(20) }],
  app: { type: "Propose", domain: "cairnx:v1", payloadHash: "0x" + "ef".repeat(32), uri: "u", expiresEpoch: 5000n },
};
const withScriptSig = (tx: Tx, scriptSig: string, i = 0): Tx =>
  ({ ...tx, inputs: tx.inputs.map((x, j) => (j === i ? { ...x, scriptSig } : x)) });

// authorOf: a block-body provider can swap input 0's scriptSig for another key's valid signature over the same
// sighash (txid and sighash strip scriptSigs, so the merkle root still matches). The author is the coin's owner.
{
  const owner = "0x" + "11".repeat(32), other = "0x" + "22".repeat(32);
  const signedBy = (priv: string): Tx => {
    const { sig64, pub33 } = signDigest(sighash(base), priv);
    return { ...base, inputs: [{ ...base.inputs[0]!, scriptSig: buildScriptSig(sig64, pub33) }] };
  };
  const honest = signedBy(owner), swapped = signedBy(other);
  const ownerSpk = addrFromPriv(owner);   // the node JSON form of the spent output's script_pubkey
  ok("authorOf: a swapped body has the same txid and merkle root",
    txid(honest) === txid(swapped) && merkleRoot([txid(honest)]) === merkleRoot([txid(swapped)]));
  ok("authorOf: recoverSigner alone attributes the swapped body to the swapper",
    recoverSigner(swapped.inputs[0]!.scriptSig, sighash(swapped)) === addrFromPriv(other).toLowerCase());
  ok("authorOf: the honest body's author is the coin owner", authorOf(honest, ownerSpk) === ownerSpk.toLowerCase());
  ok("authorOf: the swapped body has no author (signer does not own the spent coin)", authorOf(swapped, ownerSpk) === null);

  // Every input signs the same sighash; the author is input 0's owner, never another input's.
  const two: Tx = { ...base, inputs: [base.inputs[0]!, { prevTxid: "0x" + "ac".repeat(32), vout: 1, scriptSig: "0x" }] };
  const s0 = signDigest(sighash(two), owner), s1 = signDigest(sighash(two), other);
  const both = withScriptSig(withScriptSig(two, buildScriptSig(s0.sig64, s0.pub33), 0), buildScriptSig(s1.sig64, s1.pub33), 1);
  ok("authorOf: a two-input tx's author is input 0's owner", authorOf(both, ownerSpk) === ownerSpk.toLowerCase());
  ok("authorOf: input 1's owner is not the author", authorOf(both, addrFromPriv(other)) === null);
}

// The node reads the 64 signature bytes as compact r || s only (crypto/mod.rs verify_sig, Signature::from_compact)
// and requires low S. Fixed vectors over sighash(base), built by choosing the bytes and solving for the key; the
// node's crate (secp256k1 0.29.1, verify_sig's steps) returns ok for A1 and A2 and "signature failed verification"
// for B.
{
  const DIGEST = "0x388d3773d75bede6c1f89ca79e3a593fd8556e3dd38a95a93a0c256e56f53338";
  ok("DER-shape vectors: sighash(base) is the digest they were built over", sighash(base) === DIGEST);
  // Compact low-S signatures whose bytes are also DER-shaped: 30 3e 02 L <L bytes> 02 (58 - L) <58 - L bytes>.
  // A1 (L = 20) has an s integer too wide for the curve; A2 (L = 32) reads as DER into another in-range pair.
  const compactValid = [
    ["A1", "0x303e02147bf05397ac95dc9ab603c7896caf09c686c0b65b02263504e050e16252f13603d35a2051522a50f14f572a922ad0eedee26eb2398009eb62bcad669b",
      "0x028eb8a2807c2905b0520fa36656def108b69ee5d20547d669130c18c4f1ee57d9", "0x8bf866f3335bdf3e0c9ef90742043686d86fdcad"],
    ["A2", "0x303e0220210a5337f8df3171a6c06c7e5b78915f1c2e62ac732ed16ef081a25401da0a04021a079244ee8095b0ce396bd6b456148b6c7ad05fb7098c8cfd3b92",
      "0x02e12d0185bc0518bd203d50fe266085cbf12dea388f54a4f74ca7a064d9a67c79", "0x611ee0b4575a026f20934e3412cd085e584daa35"],
  ] as const;
  for (const [name, sig64, pub33, owner] of compactValid) {
    const ss = buildScriptSig(sig64, pub33);
    ok(`${name}: hash160(pub33) is the vector's owner`, addrFromPub(pub33) === owner);
    ok(`${name}: verifyDigest accepts the node-valid compact signature`, verifyDigest(sig64, pub33, DIGEST));
    ok(`${name}: recoverSigner names its signer`, recoverSigner(ss, DIGEST) === owner);
    ok(`${name}: authorOf names the coin owner`, authorOf(withScriptSig(base, ss), owner) === owner);
  }
  // B: a valid 64-byte DER signature 30 3e 02 20 <r 32> 02 1a <s 26>; its compact reading is no signature.
  const derSig = "0x303e02202c0e65d00bb81ca65be239b50a9741b987c5c77078ae5e2910938df83a7f9d05021a1fdf47c2a27bf6607ebf8a6a7e5bf00c158f860bc35e1215ade2";
  const derPub = "0x02962d3549a3b73677e8fe9831f24141b84948d116927b85a96b483cf8563993fa";
  const derOwner = "0x41d9c3cd30ea9e5567c003f5f9328786f3108012";
  const derSs = buildScriptSig(derSig, derPub);
  ok("B: hash160(pub33) is the vector's owner", addrFromPub(derPub) === derOwner);
  ok("B: verifyDigest refuses a DER signature the node refuses", !verifyDigest(derSig, derPub, DIGEST));
  ok("B: recoverSigner names no signer", recoverSigner(derSs, DIGEST) === null);
  ok("B: authorOf names no author", authorOf(withScriptSig(base, derSs), derOwner) === null);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
