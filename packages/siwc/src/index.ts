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
const hasLF = (s: string) => s.includes("\n") || s.includes("\r");

function assertField(name: string, v: string): void {
  if (typeof v !== "string" || v.length === 0) throw new Error(`siwc: ${name} required`);
  if (hasLF(v)) throw new Error(`siwc: ${name} must not contain a newline`);
}

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
  if (stmt !== undefined && hasLF(stmt)) throw new Error("siwc: statement must not contain a newline");
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
  skewMs?: number;     // allowed clock skew on time bounds (default 0).
}
export type VerifyResult = { ok: true; account: string; fields: SiwcFields } | { ok: false; reason: string };

/** Verify a SIWC sign-in, server-side, fail-closed. Ordered checks; identity is derived ONLY from
 *  the recovered key (never from a client-supplied address field). Returns the proven account. */
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
  const iat = Date.parse(f.issuedAt); if (Number.isNaN(iat)) return { ok: false, reason: "bad-issued-at" };
  // Bound issuedAt against the clock (audit SIWC-IAT): reject a message issued in the future (beyond skew
  // tolerance) or more than an hour ago. The age bound also caps EFFECTIVE validity to ~1h from issuance,
  // independent of a far-future expirationTime, since a stale issuedAt is rejected here regardless of expiry.
  if (iat > now + skew + 5 * 60_000) return { ok: false, reason: "issued-in-future" };
  if (now - iat > 60 * 60_000 + skew) return { ok: false, reason: "issued-too-long-ago" };
  if (f.expirationTime === undefined) return { ok: false, reason: "missing-expiration" }; // require expiry
  const exp = Date.parse(f.expirationTime); if (Number.isNaN(exp)) return { ok: false, reason: "bad-expiration" };
  if (now >= exp + skew) return { ok: false, reason: "expired" };
  if (f.notBefore !== undefined) {
    const nbf = Date.parse(f.notBefore); if (Number.isNaN(nbf)) return { ok: false, reason: "bad-not-before" };
    if (now + skew < nbf) return { ok: false, reason: "not-yet-valid" };
  }
  if (!verifyDigest(input.sig64, input.pub33, siwcDigest(input.message))) return { ok: false, reason: "bad-signature" };
  if (addrFromPub(input.pub33).toLowerCase() !== f.account.toLowerCase()) return { ok: false, reason: "account-mismatch" };
  return { ok: true, account: f.account, fields: f };
}

/** A fresh single-use nonce (128-bit, alphanumeric hex). The RP issues + stores + consumes it. */
export function generateNonce(): string { return bytesToHex(randomBytes(16)); }

/** Format a ms-epoch as RFC3339 UTC, second precision (e.g. "2026-06-17T12:34:56Z"). */
export function rfc3339(ms: number): string { return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"); }
