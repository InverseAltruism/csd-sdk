// @inversealtruism/csd-crypto conformance: address derivation, LOW-S determinism, verify, against the
// node's funded key (block-21043 era) + property checks.
import { hash160, pubFromPriv, addrFromPriv, addrFromPub, isValidAddr, isValidPriv, keygen, signDigest, verifyDigest, buildScriptSig } from "../src/index.js";
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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
