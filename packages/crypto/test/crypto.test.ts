// @inversealtruism/csd-crypto conformance: address derivation, LOW-S determinism, verify, against the
// node's funded key (block-21043 era) + property checks.
import { hash160, pubFromPriv, addrFromPriv, addrFromPub, isValidAddr, isValidPriv, keygen, signDigest, verifyDigest, buildScriptSig, parseScriptSig, signerAddrFromScriptSig, recoverSigner } from "../src/index.js";
import { sighash } from "@inversealtruism/csd-codec";
import { GOLDEN_TX } from "@inversealtruism/csd-vectors";

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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
