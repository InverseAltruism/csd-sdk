// @inversealtruism/csd-indexwire — the csd-indexer REST wire contract.
//
// WHY THIS PACKAGE EXISTS: the proposal/attestation/tx row shapes the indexer serves were
// hand-maintained in 3+ places (indexer serializer, cairnx scanner's local RawProposal, cairn's
// project reader, cairn-sdk's untyped IndexerClient, and the test suites of each). A field rename
// or type drift on any side was invisible until a consumer misbehaved. This package is the single
// source of truth: the TYPES are the published contract, the GUARDS are the production consumer
// postures, extracted verbatim so adopting them is a zero-behavior-change swap.
//
// GUARD POSTURE (inherited from the hardened consumers, do not "improve" without a resolver-side
// review — several of these asymmetries are deliberate):
//   - STRUCTURE fails LOUD: a non-array page, a missing txid, a non-ordinal height/pos throws.
//     Wrong state is worse than no state — the CairnX resolver freezes on last-good state rather
//     than resolve from a malformed feed.
//   - VALUES fail CONSERVATIVE: a malformed tx output is SKIPPED, never thrown. Dropping an output
//     can only make a payment look SMALLER, so a fill/fee that truly wasn't covered gets rejected;
//     one weird tx cannot DoS the whole scan.
//   - Coercions are exactly the resolver feed's: ids/addresses lowercased, epochs/scores through
//     Number() (a saturated expires_epoch stays non-safe on purpose — GRX-WIRE-CLAMP-1: the
//     resolver's own isSafeInteger gate must fire identically on indexer and SPV wires).
//
// Versioning: additive response fields are a minor bump; renames/removals are a major bump and a
// changelog entry. The indexer's /health `version` field says what the producer runs.

// ── wire row types (snake_case: these ARE the serialized shapes on the wire) ──────────────────

/** Row of GET /domain/:d/proposals (and /proposal/:id). Numbers >2^53 serialize as decimal strings. */
export interface ProposalRow {
  txid: string;
  domain: string;
  payload_hash: string;
  uri: string;
  expires_epoch: number | string;
  proposer: string;
  fee: number | string;
  height: number;
  time: number | string;
}

/** Row of GET /proposal/:id/attestations. */
export interface AttestationRow {
  txid: string;
  proposal_id: string;
  attester: string;
  score: number | string;
  confidence: number | string;
  fee: number | string;
  height: number;
  time: number | string;
}

/** One decoded output as served inside a tx (GET /tx/:id, and address tx lists since 0.2.5). */
export interface TxOut {
  txid: string;
  vout: number;
  addr: string | null;
  value: number | string;
  height: number;
  spent_txid: string | null;
  spent_height: number | string | null;
}

/** GET /tx/:id (and each row of /address/:a/txs[/chain/:last] since indexer 0.2.5). */
export interface TxRow {
  txid: string;
  height: number;
  pos: number;
  app_type: string | null;
  signer: string | null;
  fee: number | string;
  time: number | string;
  n_in: number;
  n_out: number;
  coinbase: number;
  outputs: TxOut[];
}

/** GET /health. `version` + `backend` are additive as of indexer 0.2.5. */
export interface HealthResponse {
  ok: boolean;
  version?: string;
  backend?: "sqlite" | "postgres";
  indexed_height: number;
  tip_height: number;
  tip_hash: string | null;
  chainwork: string | null;
  seconds_since_tip: number | null;
  stale: boolean;
  final_depth: number;
  blocks: number;
  txs: number;
  proposals: number;
  attestations: number;
}

// ── guards ─────────────────────────────────────────────────────────────────────────────────────

/** Structural fail-loud: a 200 body that should be an array but isn't means a broken/hostile feed. */
export function requireArrayPage(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`indexer returned a non-array ${what} page: refusing to parse`);
  return v;
}

/**
 * Fail-loud ordinal (the cairnx scanner's reqOrd): heights/positions feed a deterministic sort in
 * the resolver, so a NaN/negative/unsafe value must throw, never silently coerce — an unordered
 * feed would nondeterministically reorder consensus apply order.
 */
export function requireOrdinal(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`indexer row has an out-of-range ${what} (${String(v)}): refusing to resolve from an unordered feed`);
  }
  return n;
}

/** Validated + resolver-normalized proposal row: ids/addrs lowercased, height ordinal-checked. */
export interface NormalizedProposalRow {
  txid: string;
  payload_hash: string;
  uri: string;
  expires_epoch: number; // Number()-coerced; may be non-safe BY DESIGN (GRX-WIRE-CLAMP-1)
  proposer: string;
  height: number;
}

export function parseProposalRow(v: unknown): NormalizedProposalRow {
  if (v === null || typeof v !== "object") throw new Error("indexer proposal row is not an object");
  const p = v as Record<string, unknown>;
  if (typeof p.txid !== "string" || p.txid.length === 0) throw new Error("indexer proposal row lacks a txid");
  return {
    txid: p.txid.toLowerCase(),
    payload_hash: String(p.payload_hash ?? "").toLowerCase(),
    uri: String(p.uri ?? ""),
    expires_epoch: Number(p.expires_epoch),
    proposer: String(p.proposer ?? "").toLowerCase(),
    height: requireOrdinal(p.height, "proposal height"),
  };
}

/** Validated + resolver-normalized attestation row. confidence: safe non-negative int or 0 (it
 *  gates token-debiting fills, so an absent/garbage value must read as "no fill marker"). */
export interface NormalizedAttestationRow {
  txid: string;
  attester: string;
  score: number; // Number()-coerced verbatim (downstream resolver validates semantics)
  confidence: number;
  height: number;
}

export function parseAttestationRow(v: unknown): NormalizedAttestationRow {
  if (v === null || typeof v !== "object") throw new Error("indexer attestation row is not an object");
  const a = v as Record<string, unknown>;
  if (typeof a.txid !== "string" || a.txid.length === 0) throw new Error("indexer attestation row lacks a txid");
  if (typeof a.attester !== "string") throw new Error("indexer attestation row lacks an attester");
  const conf = Number(a.confidence);
  return {
    txid: a.txid.toLowerCase(),
    attester: a.attester.toLowerCase(),
    score: Number(a.score),
    confidence: Number.isSafeInteger(conf) && conf >= 0 ? conf : 0,
    height: requireOrdinal(a.height, "attest height"),
  };
}

/** Cap mirrored from the scanner: one tx cannot smuggle an unbounded output array through a scan. */
export const MAX_OUTPUTS_PER_TX = 1024;

/**
 * Conservative output filter (the cairnx scanner's posture, verbatim): outputs feed fee/payment
 * detection, so each must be a real non-negative SAFE-INTEGER number (never a string a BigInt
 * would mis-parse) paying a real 0x-40-hex address. A malformed output is SKIPPED, never thrown —
 * dropping is conservative (a payment can only look smaller → over-rejects, never over-credits).
 */
export function conservativeOutputs(v: unknown): { addr: string; value: number }[] {
  const raw = Array.isArray(v) ? v.slice(0, MAX_OUTPUTS_PER_TX) : [];
  const outputs: { addr: string; value: number }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.value !== "number" || !Number.isSafeInteger(o.value) || o.value < 0) continue;
    const addr = String(o.addr ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    outputs.push({ addr, value: o.value });
  }
  return outputs;
}

/** Structural health parse: load-bearing fields validated, additive fields tolerated. */
export function parseHealth(v: unknown): HealthResponse {
  if (v === null || typeof v !== "object") throw new Error("indexer /health is not an object");
  const h = v as Record<string, unknown>;
  const num = (x: unknown, what: string): number => {
    const n = Number(x);
    if (!Number.isFinite(n)) throw new Error(`indexer /health has a non-numeric ${what}`);
    return n;
  };
  return {
    ok: h.ok === true,
    ...(typeof h.version === "string" ? { version: h.version } : {}),
    ...(h.backend === "sqlite" || h.backend === "postgres" ? { backend: h.backend } : {}),
    indexed_height: num(h.indexed_height, "indexed_height"),
    tip_height: num(h.tip_height, "tip_height"),
    tip_hash: typeof h.tip_hash === "string" ? h.tip_hash : null,
    chainwork: typeof h.chainwork === "string" ? h.chainwork : null,
    seconds_since_tip: h.seconds_since_tip == null ? null : num(h.seconds_since_tip, "seconds_since_tip"),
    stale: h.stale === true,
    final_depth: num(h.final_depth, "final_depth"),
    blocks: num(h.blocks, "blocks"),
    txs: num(h.txs, "txs"),
    proposals: num(h.proposals, "proposals"),
    attestations: num(h.attestations, "attestations"),
  };
}
