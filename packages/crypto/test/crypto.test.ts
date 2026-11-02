// @inversealtruism/csd-crypto conformance: address derivation, LOW-S determinism, verify, against the
// node's funded key (block-21043 era) + property checks.
import { hash160, pubFromPriv, addrFromPriv, addrFromPub, isValidAddr, isValidPriv, keygen, signDigest, verifyDigest, buildScriptSig, parseScriptSig, signerAddrFromScriptSig, recoverSigner, authorOf } from "../src/index.js";
import { sighash, txid, merkleRoot, type Tx } from "@inversealtruism/csd-codec";
import { GOLDEN_TX, GOLDEN_PROPOSE_TX, GOLDEN_ATTEST_TX, SIG_VECTORS } from "@inversealtruism/csd-vectors";

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
// and requires low S. csd-vectors' SIG_VECTORS carry the node crate's verdict on each: two compact signatures whose
// bytes are also DER-shaped (accepted) and one 64-byte DER signature (refused). Each identity primitive must agree.
ok("SIG_VECTORS hold signatures the node accepts and one it refuses", SIG_VECTORS.some((v) => v.nodeAccepts) && SIG_VECTORS.some((v) => !v.nodeAccepts));
for (const v of SIG_VECTORS) {
  const ss = v.tx.inputs[0]!.scriptSig;
  const author = v.nodeAccepts ? v.owner : null;
  const verdict = v.nodeAccepts ? "accepts" : "refuses";
  ok(`${v.name}: the vector's sighash and owner re-derive`, sighash(v.tx as Tx) === v.expectedSighash && addrFromPub(v.pub33) === v.owner);
  ok(`${v.name}: verifyDigest ${verdict} as the node does`, verifyDigest(v.sig64, v.pub33, v.expectedSighash) === v.nodeAccepts);
  ok(`${v.name}: recoverSigner names ${author ? "the signer" : "no signer"}`, recoverSigner(ss, v.expectedSighash) === author);
  ok(`${v.name}: authorOf names ${author ? "the coin owner" : "no author"}`, authorOf(v.tx as Tx, v.owner) === author);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
