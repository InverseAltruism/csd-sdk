// SIWC self-test: canonical round-trip, digest domain-separation, sign/verify happy path,
// and the full negative matrix (the cross-domain replay proof is the headline).
import {
  buildSiwcMessage, parseSiwcMessage, siwcDigest, signSiwc, verifySiwc,
  generateNonce, rfc3339, caip2FromGenesis, CSD_CHAIN_MAINNET, SIWC_TAG, type SiwcFields,
} from "../src/index.js";
import { keygen, addrFromPub } from "@inversealtruism/csd-crypto";
import { taggedHash, sha256d, GENESIS_HASH } from "@inversealtruism/csd-codec";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

const T0 = Date.parse("2026-06-17T12:00:00Z");
const mkFields = (over: Partial<SiwcFields>, account: string): SiwcFields => ({
  domain: "casino.example", account, uri: "https://casino.example/login", version: "1",
  chainId: CSD_CHAIN_MAINNET, nonce: "abc123def456", issuedAt: rfc3339(T0),
  expirationTime: rfc3339(T0 + 600_000), ...over,
});

function main() {
  const kp = keygen();

  console.log("=== build / parse canonical round-trip ===");
  // canonical round-trip: parse → rebuild must reproduce the exact bytes (key order is irrelevant)
  const roundtrips = (f: SiwcFields): boolean => { const m = buildSiwcMessage(f); const p = parseSiwcMessage(m); return !!p && buildSiwcMessage(p) === m; };
  const f1 = mkFields({ statement: "Sign in to CSD Casino." }, kp.addr);
  const m1 = buildSiwcMessage(f1);
  check("message starts with the domain header", m1.startsWith("casino.example wants you to sign in with your Compute Substrate account:\n"));
  check("parse round-trips a message WITH a statement", roundtrips(f1) && parseSiwcMessage(m1)!.statement === f1.statement);
  const f2 = mkFields({}, kp.addr); // no statement
  const m2 = buildSiwcMessage(f2);
  check("parse round-trips a message WITHOUT a statement", roundtrips(f2) && parseSiwcMessage(m2)!.statement === undefined);
  check("with/without statement produce different bytes", m1 !== m2);
  const f3 = mkFields({ notBefore: rfc3339(T0), requestId: "req-7", resources: ["https://casino.example/play", "https://casino.example/wallet"] }, kp.addr);
  check("parse round-trips optional fields + resources", roundtrips(f3) && JSON.stringify(parseSiwcMessage(buildSiwcMessage(f3))!.resources) === JSON.stringify(f3.resources));

  console.log("=== digest domain-separation (un-replayable as a tx or legacy login) ===");
  const d = siwcDigest(m1);
  const txStyle = "0x" + bytesToHex(sha256d(taggedHash("CSD_SIG_V1", utf8ToBytes(m1))));   // tx sighash tag
  const loginStyle = "0x" + bytesToHex(sha256(utf8ToBytes("cairn-login:" + f1.nonce)));     // legacy login digest
  check("SIWC digest != tx-sighash-tag digest over the same bytes", d !== txStyle);
  check("SIWC digest != legacy login digest", d !== loginStyle);
  check("SIWC tag is the versioned auth tag", SIWC_TAG === "CSD-SIWC-v1");
  check("mainnet CAIP-2 id is genesis-derived", CSD_CHAIN_MAINNET === caip2FromGenesis(GENESIS_HASH) && CSD_CHAIN_MAINNET.startsWith("csd:"));

  console.log("=== sign / verify happy path ===");
  const signed = signSiwc(f1, kp.priv);
  const exp = { domain: "casino.example", nonce: "abc123def456", chainId: CSD_CHAIN_MAINNET, now: T0 + 60_000 };
  const v = verifySiwc({ message: signed.message, sig64: signed.sig64, pub33: signed.pub33 }, exp);
  check("valid sign-in verifies", v.ok === true && v.ok && v.account === kp.addr);
  check("returned account == hash160(pub)", addrFromPub(signed.pub33) === kp.addr);

  console.log("=== negative matrix (fail-closed) ===");
  const verr = (over: Partial<typeof exp>, sgn = signed) =>
    (verifySiwc({ message: sgn.message, sig64: sgn.sig64, pub33: sgn.pub33 }, { ...exp, ...over }) as any).reason;
  check("cross-domain replay rejected (signed for A, RP expects B)", verr({ domain: "evil.example" }) === "domain-mismatch");
  check("relay with wrong nonce rejected", verr({ nonce: "zzz999zzz999" }) === "nonce-mismatch");
  check("cross-chain replay rejected", verr({ chainId: "csd:deadbeefdeadbeefdeadbeefdeadbeef" }) === "chain-mismatch");
  check("expired message rejected", verr({ now: T0 + 700_000 }) === "expired");

  const noExp = signSiwc(mkFields({ expirationTime: undefined, statement: "x" }, kp.addr), kp.priv);
  check("missing expiration rejected (Supabase-class)", (verifySiwc({ message: noExp.message, sig64: noExp.sig64, pub33: noExp.pub33 }, exp) as any).reason === "missing-expiration");

  const nbf = signSiwc(mkFields({ notBefore: rfc3339(T0 + 300_000), statement: "x" }, kp.addr), kp.priv);
  check("not-yet-valid rejected", (verifySiwc({ message: nbf.message, sig64: nbf.sig64, pub33: nbf.pub33 }, { ...exp, now: T0 }) as any).reason === "not-yet-valid");

  const tampered = signed.message.replace("casino.example", "casin0.example");
  check("tampered message rejected", verifySiwc({ message: tampered, sig64: signed.sig64, pub33: signed.pub33 }, { ...exp, domain: "casin0.example" }).ok === false);

  // account-confusion: build a message claiming account B but sign with key A → identity from key wins
  const kpB = keygen();
  const fB = mkFields({ statement: "x" }, kpB.addr);
  const mB = buildSiwcMessage(fB);
  const { sig64: sigA, pub33: pubA } = signSiwc(fB, kp.priv); // signed by A over a message naming B
  check("account-confusion rejected (identity derived from recovered key only)",
    (verifySiwc({ message: mB, sig64: sigA, pub33: pubA }, exp) as any).reason === "account-mismatch");

  check("malformed message rejected", parseSiwcMessage("not a siwc message") === null && (verifySiwc({ message: "garbage", sig64: signed.sig64, pub33: signed.pub33 }, exp) as any).reason === "malformed-message");
  check("non-canonical (extra blank line) rejected by parser", parseSiwcMessage(m1 + "\n") === null);

  console.log("=== build-time validation ===");
  const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  check("build rejects a newline-injected domain", throws(() => buildSiwcMessage(mkFields({ domain: "a\nNonce: hack" }, kp.addr))));
  check("build rejects a statement with a newline", throws(() => buildSiwcMessage(mkFields({ statement: "line1\nline2" }, kp.addr))));
  check("build rejects a bad account", throws(() => buildSiwcMessage(mkFields({}, "0xnothex"))));
  check("build rejects a too-short nonce", throws(() => buildSiwcMessage(mkFields({ nonce: "short" }, kp.addr))));
  check("generateNonce is >=16 alnum + rfc3339 is second-precision UTC",
    /^[a-f0-9]{32}$/.test(generateNonce()) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(rfc3339(T0)));
  // L17: build rejects Unicode line separators (not just \n/\r) — they could render as a break in a UI.
  check("L17: build rejects a U+2028 line separator in statement", throws(() => buildSiwcMessage(mkFields({ statement: "a\u2028b" }, kp.addr))));
  check("L17: build rejects a U+0085 (NEL) in domain", throws(() => buildSiwcMessage(mkFields({ domain: "a\u0085b" }, kp.addr))));

  console.log("=== time-bound hardening (L2 zoneless / L3 hidden-skew) ===");
  // L2: a zoneless (TZ-ambiguous) issuedAt verifies differently per server TZ → must be REJECTED.
  const zoneless = signSiwc(mkFields({ issuedAt: "2026-06-17T12:00:00", statement: "x" }, kp.addr), kp.priv);
  check("L2: a zoneless issuedAt is REJECTED (no implicit local-time)",
    (verifySiwc({ message: zoneless.message, sig64: zoneless.sig64, pub33: zoneless.pub33 }, { ...exp, now: T0 + 60_000 }) as any).reason === "bad-issued-at");
  // L3: a message pre-dated 4 minutes is rejected (beyond the DOCUMENTED 120s default future-skew — the
  // old code silently allowed up to 5min + skewMs); only a larger caller-set skewMs admits it.
  const future = signSiwc(mkFields({ issuedAt: rfc3339(T0 + 4 * 60_000), expirationTime: rfc3339(T0 + 30 * 60_000), statement: "x" }, kp.addr), kp.priv);
  check("L3: a 4-min future-dated issuedAt is rejected (beyond the 120s default)",
    (verifySiwc({ message: future.message, sig64: future.sig64, pub33: future.pub33 }, { ...exp, now: T0 }) as any).reason === "issued-in-future");
  check("L3: an explicit skewMs admits the same future-dated message",
    verifySiwc({ message: future.message, sig64: future.sig64, pub33: future.pub33 }, { ...exp, now: T0, skewMs: 5 * 60_000 }).ok === true);
  // E: a freshly-signed message (issuedAt≈now) MUST verify even when the RP's clock LAGS the wallet's —
  // the default future-skew tolerates normal NTP divergence (a strict skewMs=0 alone would self-DoS).
  const fresh = signSiwc(mkFields({ issuedAt: rfc3339(T0), statement: "x" }, kp.addr), kp.priv);
  check("E: a fresh sign-in verifies when the RP clock lags the wallet (default future-skew)",
    verifySiwc({ message: fresh.message, sig64: fresh.sig64, pub33: fresh.pub33 }, { ...exp, now: T0 - 60_000 }).ok === true);
  check("E: futureSkewMs:0 makes it strict again (forbids future-dating)",
    (verifySiwc({ message: fresh.message, sig64: fresh.sig64, pub33: fresh.pub33 }, { ...exp, now: T0 - 60_000, futureSkewMs: 0 }) as any).reason === "issued-in-future");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
