// @inversealtruism/csd-siwc — "Sign in with CSD" (SIWC): audience-bound, replay-resistant
// wallet authentication for Compute Substrate, modeled on CAIP-122 / EIP-4361 (Sign-In with X).
//
// The signed artifact is a human-readable, line-structured message that binds:
//   domain (the relying-party origin) · account · CAIP-2 chain id · server-issued nonce ·
//   issued-at · expiration. A signature made for one domain/nonce CANNOT be replayed at another
//   relying party, and — because the digest is domain-separated from the tx sighash — can NEVER be
//   replayed as a transaction.
//
// Trust model (mirrors the rest of the SDK): the byte contract here is canonical and deterministic;
// the wallet builder, this verifier, and any second-language port MUST produce byte-identical
// messages + digests. Conformance vectors + a Python reference gate it.
//
//   digest  = sha256d( tagged_hash("CSD-SIWC-v1", utf8(message)) )      // disjoint from tx + legacy login
//   verify  = parse(canonical) → domain/chain/nonce/time checks → verifyDigest → hash160(pub)==account
//             and the RETURNED identity is that hash160(pub), lowercase, never the message's account line
//
// IMPORTANT: this library is stateless. SINGLE-USE NONCE is the relying party's responsibility:
// issue a fresh nonce per attempt, store it bound to the browser session, and DELETE it atomically
// on a successful verify. The signature is NOT a bearer token — after verify, issue your OWN session.
import { taggedHash, sha256d, GENESIS_HASH } from "@inversealtruism/csd-codec";
import { signDigest, verifyDigest, addrFromPub, isValidAddr } from "@inversealtruism/csd-crypto";
import { utf8ToBytes, bytesToHex, randomBytes } from "@noble/hashes/utils";

/** Domain-separation tag for the SIWC auth digest. Distinct from the tx sighash tag ("CSD_SIG_V1")
 *  and the legacy login digest ("cairn-login:"). Bump the version suffix on any byte-contract change. */
export const SIWC_TAG = "CSD-SIWC-v1";
export const SIWC_VERSION = "1";
const HEADER_SUFFIX = " wants you to sign in with your Compute Substrate account:";

/** CAIP-2 chain id derived from a genesis hash (bip122-style: first 16 bytes / 32 hex). */
export function caip2FromGenesis(genesisHash: string): string {
  const hex = genesisHash.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{32,}$/.test(hex)) throw new Error("caip2FromGenesis: bad genesis hash");
  return "csd:" + hex.slice(0, 32);
}
/** The mainnet CAIP-2 id (csd:<genesis16>). RPs and the wallet MUST agree on this exact string. */
export const CSD_CHAIN_MAINNET = caip2FromGenesis(GENESIS_HASH);

export interface SiwcFields {
  domain: string;            // RP authority host[:port] — the audience. From the wallet's attested origin.
  account: string;           // 0x..40hex CSD address (hash160).
  statement?: string;        // optional one-line human statement (no '\n'); empty == omitted.
  uri: string;               // subject of the sign-in (RP url).
  version: string;           // "1".
  chainId: string;           // CAIP-2 id (e.g. CSD_CHAIN_MAINNET).
  nonce: string;             // server-issued, single-use, >=8 alnum (>=16 recommended).
  issuedAt: string;          // RFC3339 UTC, second precision.
  expirationTime?: string;   // RFC3339 UTC. REQUIRED by verifySiwc (do not omit in practice).
  notBefore?: string;        // RFC3339 UTC.
  requestId?: string;
  resources?: string[];      // authorization scoping; one URI per line.
}

const NONCE_RE = /^[A-Za-z0-9]{8,}$/;
// Block ALL line terminators, not only \n/\r: the Unicode separators U+2028/U+2029/U+0085 (+ \v/\f) can
// render as a line break in a UI, letting a signed field DISPLAY differently than it verifies (audit L17).
// The build→parse canonical round-trip already guards message STRUCTURE; this guards field VALUES.
const hasLF = (s: string) => /[\n\r\u2028\u2029\u0085\u000b\u000c]/.test(s);

// Reject ill-formed UTF-16 (an unpaired surrogate) in every field value. utf8ToBytes() maps a lone
// surrogate to U+FFFD, so two DIFFERENT messages hash to ONE digest (siwcDigest is non-injective over
// arbitrary strings); the Python reference cannot encode one at all, which is the C1 cross-language
// class. No honest client makes one: a lone surrogate has no UTF-8 encoding and only survives a JSON
// "\ud800" escape. Valid pairs are stripped first, so real astral text (emoji) is untouched. No
// lookbehind: this module ships to MV3 and to browsers.
const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDFFF]/.test(s) && /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));

function assertField(name: string, v: string): void {
  if (typeof v !== "string" || v.length === 0) throw new Error(`siwc: ${name} required`);
  if (hasLF(v)) throw new Error(`siwc: ${name} must not contain a newline`);
  if (hasLoneSurrogate(v)) throw new Error(`siwc: ${name} must not contain an unpaired surrogate`);
}

// Parse an RFC3339 timestamp that MUST carry an explicit timezone (Z or ±hh:mm). `Date.parse` of a
// no-timezone string is interpreted as LOCAL time, so the same SIWC message would verify differently per
// server timezone (audit L2). A missing/zoneless/invalid timestamp → NaN → rejected by the caller.
const RFC3339_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const parseTime = (s: string): number => (RFC3339_TZ.test(s) ? Date.parse(s) : NaN);

/** Build the canonical SIWC message (the exact bytes that get signed). Deterministic; validates inputs. */
export function buildSiwcMessage(f: SiwcFields): string {
  assertField("domain", f.domain);
  if (!isValidAddr(f.account)) throw new Error("siwc: account must be a 0x..40hex CSD address");
  assertField("uri", f.uri);
  if (f.version !== SIWC_VERSION) throw new Error(`siwc: version must be "${SIWC_VERSION}"`);
  assertField("chainId", f.chainId);
  if (!NONCE_RE.test(f.nonce)) throw new Error("siwc: nonce must be >=8 alphanumeric chars");
  assertField("issuedAt", f.issuedAt);
  const stmt = f.statement != null && f.statement !== "" ? f.statement : undefined;
  // Same guard set as every other field (stmt is non-empty here, so the required-check cannot fire).
  // One call site, so a future field rule can never apply to the other fields but skip the statement.
  if (stmt !== undefined) assertField("statement", stmt);
  for (const opt of ["expirationTime", "notBefore", "requestId"] as const) {
    const v = f[opt]; if (v !== undefined) assertField(opt, v);
  }
  const resources = f.resources;
  if (resources !== undefined) for (const r of resources) assertField("resource", r);

  const lines: string[] = [f.domain + HEADER_SUFFIX, f.account, ""];
  if (stmt !== undefined) lines.push(stmt);
  lines.push("");
  lines.push("URI: " + f.uri);
  lines.push("Version: " + f.version);
  lines.push("Chain ID: " + f.chainId);
  lines.push("Nonce: " + f.nonce);
  lines.push("Issued At: " + f.issuedAt);
  if (f.expirationTime !== undefined) lines.push("Expiration Time: " + f.expirationTime);
  if (f.notBefore !== undefined) lines.push("Not Before: " + f.notBefore);
  if (f.requestId !== undefined) lines.push("Request ID: " + f.requestId);
  if (resources !== undefined) { lines.push("Resources:"); for (const r of resources) lines.push("- " + r); }
  return lines.join("\n");
}

/** Strict parser: extracts fields then requires buildSiwcMessage(fields) === input (canonical
 *  round-trip). Any non-canonical / malformed message → null. */
export function parseSiwcMessage(message: string): SiwcFields | null {
  if (typeof message !== "string" || message.includes("\r")) return null;
  const lines = message.split("\n");
  const header = lines[0];
  if (header === undefined || !header.endsWith(HEADER_SUFFIX)) return null;
  const domain = header.slice(0, -HEADER_SUFFIX.length);
  const account = lines[1];
  if (account === undefined) return null;
  if (lines[2] !== "") return null;
  let i: number; let statement: string | undefined;
  if (lines[3] === "") { statement = undefined; i = 4; }                 // no statement → blank then tag block
  else { statement = lines[3]; if (statement === undefined || lines[4] !== "") return null; i = 5; } // statement then blank

  const take = (prefix: string): string | null => {
    const ln = lines[i];
    if (ln === undefined || !ln.startsWith(prefix)) return null;
    i++; return ln.slice(prefix.length);
  };
  const uri = take("URI: "); if (uri === null) return null;
  const version = take("Version: "); if (version === null) return null;
  const chainId = take("Chain ID: "); if (chainId === null) return null;
  const nonce = take("Nonce: "); if (nonce === null) return null;
  const issuedAt = take("Issued At: "); if (issuedAt === null) return null;
  const opt = (prefix: string): string | undefined => {
    const ln = lines[i];
    if (ln !== undefined && ln.startsWith(prefix)) { i++; return ln.slice(prefix.length); }
    return undefined;
  };
  const expirationTime = opt("Expiration Time: ");
  const notBefore = opt("Not Before: ");
  const requestId = opt("Request ID: ");
  let resources: string[] | undefined;
  if (lines[i] === "Resources:") {
    i++; const rs: string[] = [];
    while (i < lines.length) { const ln = lines[i]; if (ln === undefined || !ln.startsWith("- ")) return null; rs.push(ln.slice(2)); i++; }
    resources = rs;
  }
  if (i !== lines.length) return null; // trailing junk

  const f: SiwcFields = { domain, account, statement, uri, version, chainId, nonce, issuedAt, expirationTime, notBefore, requestId, resources };
  try { if (buildSiwcMessage(f) !== message) return null; } catch { return null; } // canonical gate
  return f;
}

/** The SIWC auth digest (0x-hex). Domain-separated from tx sighash + legacy login digest. */
export function siwcDigest(message: string): string {
  // Defined only over well-formed UTF-16. utf8ToBytes() maps a lone surrogate to U+FFFD, so without
  // this refusal two distinct messages share one digest and a signature over one verifies the other.
  // buildSiwcMessage and parseSiwcMessage already refuse such a message, so verifySiwc returns
  // "malformed-message" and never reaches this throw (pinned by test); this guards a DIRECT caller.
  if (hasLoneSurrogate(message)) throw new Error("siwc: message must not contain an unpaired surrogate");
  return "0x" + bytesToHex(sha256d(taggedHash(SIWC_TAG, utf8ToBytes(message))));
}

/** Sign a SIWC message with a private key (for SDK/CLI/test contexts; the wallet signs in-process). */
export function signSiwc(fields: SiwcFields, priv: string): { message: string; account: string; pub33: string; sig64: string; chainId: string } {
  const message = buildSiwcMessage(fields);
  const { sig64, pub33 } = signDigest(siwcDigest(message), priv);
  return { message, account: fields.account, pub33, sig64, chainId: fields.chainId };
}

export interface VerifyExpected {
  domain: string;      // the RP's own expected frontend origin authority (host[:port]).
  nonce: string;       // the nonce the RP issued for THIS attempt (RP must also consume it on success).
  chainId: string;     // expected CAIP-2 id (e.g. CSD_CHAIN_MAINNET).
  now?: number;        // ms epoch (default Date.now()).
  skewMs?: number;     // allowed clock skew on the expiration/not-before/age bounds (default 0).
  /** Tolerance on the FUTURE-dating bound only (issuedAt ≤ now + this). Defaults to max(skewMs, 120s):
   *  independent NTP clocks routinely differ by a few seconds, so a freshly-signed message (issuedAt≈now)
   *  must not be rejected just because the RP's clock lags the wallet's. Set 0 to forbid any future-dating.
   *  (This is the DOCUMENTED replacement for the old hidden +5min that was silently added atop skewMs — L3.) */
  futureSkewMs?: number;
}
const DEFAULT_FUTURE_SKEW_MS = 120_000;
export type VerifyResult = { ok: true; account: string; fields: SiwcFields } | { ok: false; reason: string };

/** Verify a SIWC sign-in, server-side, fail-closed. Ordered checks. The returned `account` is derived
 *  ONLY from the recovered key: lowercase 0x-hex hash160(pub33), one string per key. The message's own
 *  account line is compared case-insensitively and then discarded. `fields` stays the VERBATIM parse of
 *  the signed message, so `fields.account` keeps the client's casing: key a user record on `account`,
 *  never on `fields.account`. Returns "bad-clock" if the caller's now/skewMs/futureSkewMs is not finite. */
export function verifySiwc(input: { message: string; sig64: string; pub33: string }, expected: VerifyExpected): VerifyResult {
  const f = parseSiwcMessage(input.message);
  if (!f) return { ok: false, reason: "malformed-message" };
  if (f.version !== SIWC_VERSION) return { ok: false, reason: "unsupported-version" };
  if (f.domain !== expected.domain) return { ok: false, reason: "domain-mismatch" };
  if (f.chainId !== expected.chainId) return { ok: false, reason: "chain-mismatch" };
  if (f.nonce !== expected.nonce) return { ok: false, reason: "nonce-mismatch" };
  if (!isValidAddr(f.account)) return { ok: false, reason: "bad-account" };
  const now = expected.now ?? Date.now();
  const skew = expected.skewMs ?? 0;
  const futureSkew = expected.futureSkewMs ?? Math.max(skew, DEFAULT_FUTURE_SKEW_MS);
  // `??` passes NaN through (it only catches null/undefined), and every bound below is a `>`/`>=`
  // comparison, which is FALSE against NaN. One non-finite input therefore disables all of them at once
  // and a years-expired sign-in returns ok:true. Infinity has the same effect on the skew bounds, and a
  // JS caller passing a numeric STRING breaks the future bound by concatenation. A non-finite bound is
  // an RP configuration error, never a user action, so failing closed here declines nothing legitimate.
  if (!Number.isFinite(now) || !Number.isFinite(skew) || !Number.isFinite(futureSkew)) return { ok: false, reason: "bad-clock" };
  const iat = parseTime(f.issuedAt); if (Number.isNaN(iat)) return { ok: false, reason: "bad-issued-at" };
  // Bound issuedAt against the clock (audit SIWC-IAT): reject a message issued in the future (beyond the
  // DOCUMENTED futureSkew — default 120s, replacing the old HIDDEN +5min added atop skewMs, audit L3) or
  // more than an hour ago. The age bound caps EFFECTIVE validity to ~1h from issuance regardless of expiry.
  if (iat > now + futureSkew) return { ok: false, reason: "issued-in-future" };
  if (now - iat > 60 * 60_000 + skew) return { ok: false, reason: "issued-too-long-ago" };
  if (f.expirationTime === undefined) return { ok: false, reason: "missing-expiration" }; // require expiry
  const exp = parseTime(f.expirationTime); if (Number.isNaN(exp)) return { ok: false, reason: "bad-expiration" };
  if (now >= exp + skew) return { ok: false, reason: "expired" };
  if (f.notBefore !== undefined) {
    const nbf = parseTime(f.notBefore); if (Number.isNaN(nbf)) return { ok: false, reason: "bad-not-before" };
    if (now + skew < nbf) return { ok: false, reason: "not-yet-valid" };
  }
  if (!verifyDigest(input.sig64, input.pub33, siwcDigest(input.message))) return { ok: false, reason: "bad-signature" };
  // Identity = hash160(recovered key). The client-supplied f.account is only ever COMPARED (case-
  // insensitively, so a mixed-case address still signs in) and then discarded; returning it gave a
  // relying party one identity string per hex-letter casing of the same key. addrFromPub emits
  // lowercase 0x-hex, and the returned FORM is pinned by test rather than re-normalized here.
  const derived = addrFromPub(input.pub33);
  if (derived.toLowerCase() !== f.account.toLowerCase()) return { ok: false, reason: "account-mismatch" };
  return { ok: true, account: derived, fields: f };
}

/** A fresh single-use nonce (128-bit, alphanumeric hex). The RP issues + stores + consumes it. */
export function generateNonce(): string { return bytesToHex(randomBytes(16)); }

/** Format a ms-epoch as RFC3339 UTC, second precision (e.g. "2026-06-17T12:34:56Z"). */
export function rfc3339(ms: number): string { return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"); }
