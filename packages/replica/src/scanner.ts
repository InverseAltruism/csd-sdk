// CairnX v1, chain event source. Pulls cairnx:v1 proposals + their attestations from a
// csd-indexer (reorg-safe, battle-tested) and normalizes them into resolver events.
// Trust note: consensus data (heights, proposers, uris, outputs) is read from the indexer,
// the same posture as every indexer consumer; anyone can run their own and must converge
// (the resolver re-verifies payload_hash ↔ uri internally either way).
//
// Output binding, gated behind ScanOptions.verifyInclusion (the hook point is Scanner.tx(), below):
//   • OFF (default), outputs are read from the indexer. A lying feed is not harmless then: a forged paidTo,
//     on a fill or on a deploy or name-registration fee output, makes a fill or mint apply that the chain's
//     data does not support, a canonicalState that diverges from an honest replica's.
//   • ON, every payment/fee-feeding tx is MERKLE-VERIFIED: its `/tx/:id/merkle-proof` is folded against the
//     header merkle from ScanOptions.headerMerkleAt + a conf-depth gate (confDepth). A forged output the
//     indexer can't merkle-prove is REJECTED → the indexer is demoted to a data source. The Scanner checks no
//     proof of work: headers, tip and raw bodies are as trusted as their source.
//     Honest data verifies identically (replay-identical); only a lying indexer's forgeries differ.
// Turn it on before any consumer treats received CSD as spendable.
// With verifyInclusion on, two further rules hold (scan() and eventHeight(), below):
//   (1) Final height cutoff. Only records at height <= depthTip - confDepth (the heights verifyTx's depth
//       gate accepts) are emitted; every proposal and attestation above it is left for a later pass. The
//       cut is by height, never per record, because resolve() replays in (height, pos) order: the emitted
//       events are always the prefix of the full replay up to the cutoff. The returned tipHeight is still
//       the indexer tip (consumers compare it with their node's tip).
//   (2) Event heights come from verifyTx's merkle-proven height; a row height that disagrees fails the scan.
//   (3) A record's own fields come from the node's raw body (boundPropose/boundAttest): the app payload, which the
//       txid recompute binds, and the author (csd-crypto authorOf): the owner of the coin the first input spends,
//       read from that coin's source tx after its txid is recomputed, when the first input's scriptSig is that
//       owner's signature over the tx's sighash. A body with no author fails the scan, and a row field that
//       disagrees fails the scan, apart from the uri of a body whose uri holds U+0000 (boundPropose).
// None of these rules applies with the flag off.
import { MAX_TX_OUTPUTS, verifyMerkleProof, txid as codecTxid, type App, type Tx } from "@inversealtruism/csd-codec";
import { authorOf } from "@inversealtruism/csd-crypto";
import { ADDR_RE, DOMAIN, EPOCH_LEN, FINAL_DEPTH, paidToFromOutputs, type AttestEvent, type ChainEvent, type ProposeEvent } from "@inversealtruism/cairnx-core";
import { SourceError } from "./errors.js";
import { either, waitingOut } from "./http.js";
import { KEPT_REFRESH_SCANS, MAX_KEPT_EVENTS, eventsOf, fullPullOrder, keptFrom, type Block, type ChainPos, type Kept } from "./kept.js";

// A consensus-order scalar (block height / tx pos) from an indexer row MUST be a real non-negative safe
// integer: it feeds the resolver's ordinal SORT (height, then pos), so a NaN would make event ORDER
// implementation-defined = silently nondeterministic state. Fail loud like the tipHeight guard in pull() (wrong
// state is worse than no state); the honest indexer returns JSON integers so no real feed is affected.
const reqOrd = (v: unknown, what: string): number => {
  // Accept only a real number or a plain decimal STRING; reject null/array/bool/hex that Number() would
  // silently coerce (null->0, [5]->5); an honest indexer sends JSON integers, so this rejects only garbage.
  if (typeof v !== "number" && !(typeof v === "string" && /^[0-9]+$/.test(v)))
    throw new Error(`indexer row has a non-integer ${what} (${String(v)}): refusing to resolve from an unordered feed`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`indexer row has an out-of-range ${what} (${String(v)}): refusing to resolve from an unordered feed`);
  return n;
};

// An expiry EPOCH from an indexer row. Deliberately NOT reqOrd: the indexer CLAMPS attacker-chosen u64
// epochs to a 2^53 sentinel that the resolver then rejects PER-RECORD
// ("expiresEpoch out of safe-integer range"), so an isSafeInteger throw here would
// let any proposer freeze the WHOLE resolver for one 0.25-CSD anchor (the scan aborts → state stale
// forever). So: accept a number or a plain decimal string, throw only on NaN/negative/absent/wrong-type
// (absence never occurs in an honest feed), and PASS unsafe ints (≥ 2^53) through UNCHANGED so the
// resolver's per-record guard fires instead of a scan-wide abort.
const reqEpoch = (v: unknown, what: string): number => {
  if (typeof v !== "number" && !(typeof v === "string" && /^[0-9]+$/.test(v)))
    throw new Error(`indexer row has a non-numeric ${what} (${String(v)}): refusing to resolve from a malformed feed`);
  const n = Number(v);
  if (Number.isNaN(n) || n < 0) throw new Error(`indexer row has an out-of-range ${what} (${String(v)}): refusing to resolve from a malformed feed`);
  return n;
};

// The 0x-addr a raw scriptPubkey pays (codec form: 40 hex, 0x optional), else null.
const addrOfScriptPubkey = (spk: unknown): string | null => {
  const a = String(spk ?? "").toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{40}$/.test(a) ? "0x" + a : null;
};

// A raw u64 expiry as the indexer's expires_epoch column holds it: past 2^53 - 1 it is the 2^53 sentinel (see
// reqEpoch), which the resolver rejects per record exactly as it rejects the real value.
const epochOfBody = (v: number | bigint): number => (BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER) ? 2 ** 53 : Number(v));

// Bound a cache without the "full .clear() → refetch EVERYTHING next pass" cliff: when it
// crosses `cap`, evict the OLDEST insertion-order entries down to 90% of cap (Map preserves insertion
// order). So a poll refetches at most the evicted 10% sliver instead of the whole cache. Pure perf; the
// cache is (txid,height)-immutable derived data, so eviction never changes resolved state.
function boundCache<K, V>(m: Map<K, V>, cap: number): void {
  if (m.size <= cap) return;
  const target = Math.floor(cap * 0.9);
  const it = m.keys();
  while (m.size > target) { const k = it.next().value as K; m.delete(k); }
}

interface RawProposal {
  txid: string; payload_hash: string; uri: string; expires_epoch: number;
  proposer: string; height: number;
}
interface RawAttest { txid: string; attester: string; score: number; confidence?: number; height: number }

/** A proposal row's record fields as the indexer reports them; throws on a field no event can be built from. */
const proposalFields = (row: RawProposal) => ({
  proposer: (row.proposer ?? "").toLowerCase(), uri: row.uri, payloadHash: (row.payload_hash ?? "").toLowerCase(),
  expiresEpoch: reqEpoch(row.expires_epoch, "proposal expires_epoch"), // sentinel-tolerant, see reqEpoch
});
/** An attestation row's record fields as the indexer reports them; throws on a field no event can be built from. */
const attestFields = (row: RawAttest) => ({
  // score via reqOrd (fail loud, unlike expires_epoch): score is a consensus u32 the indexer's
  // clampInt guarantees safe in an honest feed; a NaN here means a lying indexer, abort loud.
  attester: row.attester.toLowerCase(), score: reqOrd(row.score, "attest score"),
  // confidence gates token-debiting fills (CONF_TOKEN_FILL): default 0, never a fill marker
  confidence: Number.isSafeInteger(Number(row.confidence)) && Number(row.confidence) >= 0 ? Number(row.confidence) : 0,
});
/** Whether an event can be built from a chain-order feed row's record fields: a row it cannot makes the scan pull in
 *  full, which reads the record from the legacy endpoints instead. */
const feedFieldsOk = (kind: "proposals" | "attestations", row: Record<string, unknown>): boolean => {
  try {
    if (kind === "proposals") proposalFields(row as unknown as RawProposal);
    else attestFields(row as unknown as RawAttest);
    return true;
  } catch { return false; }
};

/** The body's record fields, after checking that the row reported each of them (verifyInclusion on). */
function sameAsRow<T extends Record<string, unknown>>(what: string, id: string, row: T, body: T): T {
  for (const k of Object.keys(body))
    if (row[k] !== body[k])
      throw new Error(`F4: ${what} ${k} for ${id} differs from the node's transaction body (row ${JSON.stringify(row[k])}, body ${JSON.stringify(body[k])}) (indexer misreporting)`);
  return body;
}

export interface ScanOptions {
  indexerUrl: string;            // e.g. http://127.0.0.1:8793
  fetch?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;             // proposal pull page (default 10 000 = the indexer clamp); tests shrink it
  attPageSize?: number;          // attestation pull page (default 5 000); tests shrink it
  feedPageSize?: number;         // chain-order feed page (default 1 000 = csd-indexer FEED_LIMIT_MAX); tests shrink it
  keptMax?: number;              // most events kept across scans (default MAX_KEPT_EVENTS); tests shrink it
  keptRefresh?: number;          // accepted scans kept events serve before a full pull replaces them (default KEPT_REFRESH_SCANS); tests shrink it
  // When true, every payment/fee-feeding tx is merkle-verified against the header merkle
  // from headerMerkleAt + a conf-depth gate before its outputs are trusted. Default OFF.
  verifyInclusion?: boolean;
  // Header merkle at a height, the trust anchor for verifyInclusion: the Scanner checks no PoW, so this is
  // as trusted as its source (PoW would need e.g. a genesis-synced csd-light client).
  // THROWS if it has no header at that height. Required when verifyInclusion is true.
  headerMerkleAt?: (height: number) => Promise<string>;
  // RAW tx fetch by txid, returns the FULL consensus tx so its txid can be RECOMPUTED (binding the
  // outputs to the txid; the indexer's decoded /tx outputs are otherwise unbound). Required when
  // verifyInclusion is true. Wire it to an indexer raw-tx endpoint (deserialize), see header note.
  // A u64 past 2^53 (an expires_epoch) must arrive as an exact bigint, or the recompute fails the scan.
  rawTxAt?: (txid: string) => Promise<Tx>;
  // Merkle proof fetch by txid: { block_height, pos, merkle[], merkle_root }. Defaults to the
  // indexer's /tx/:id/merkle-proof. Override for tests / a second source.
  merkleProofAt?: (txid: string) => Promise<{ block_height: number; pos: number; merkle: string[]; merkle_root: string }>;
  // Tip height, the depth reference for the conf-depth gate. When the indexer may lie, its tip
  // (/blocks/tip/height) is attacker-supplied, so a lying indexer could inflate it to make a shallow tx look
  // deep. Wire this to the SAME source as headerMerkleAt (e.g. one's own node's tip), so neither operand of the
  // depth gate comes from the indexer. Required when verifyInclusion is true; resolved once per scan.
  verifiedTipHeight?: () => Promise<number>;
  // Min confirmations a tx needs before its outputs feed a payment/fee check. Default 12.
  confDepth?: number;
  // The longest Retry-After (ms) a 429 or 503 is waited out before the same request goes again (http.ts waitingOut);
  // a full pull then keeps what it read across a stop (scan()). Default 0: a 429 or 503 throws, as any other status.
  waitMaxMs?: number;
}

/** What one scan() call takes: `signal` ends its requests and waits, rejecting with its reason; `due()`, asked after
 *  each Retry-After wait, stops the scan there when true (a step's deadline). */
export interface ScanRun { readonly signal?: AbortSignal; due?(): boolean }

/** A full pull's answers, by path, read at the tip `tip` whose block hash before the pull was `hash`; the first
 *  `confirmed` were read before a later read of that hash gave it again. */
interface Memo { readonly tip: number; readonly hash: string; answers: Map<string, unknown>; confirmed: number }

/** `body` is set only with verifyInclusion on: the node's txid-bound app payload and the author of its raw tx. */
interface TxInfo { pos: number; height: number; outputs: { addr: string; value: number }[]; body?: { app: App; signer: string } }

/** A feed row's height or position, or null for anything reqOrd refuses. */
const feedOrd = (v: unknown): number | null => {
  try { return reqOrd(v, "feed position"); } catch { return null; }
};

export class Scanner {
  private base: string;
  private f: typeof fetch;
  private timeoutMs: number;
  /** Keyed per (txid, height). A re-mined block can move a tx's position, so invalidateCacheOnReorg drops it when a
   *  block the cached rows sit in changes. Only txs at or below the scan's sampled tip are cached: a block that lands
   *  during the pull sits above the anchor that check samples (test/scan/scan-cache-band.test.ts). */
  private txCache = new Map<string, TxInfo>();
  /** attestation lists of CLOSED-window proposals are consensus-immutable (attests are
   *  rejected after expires_epoch), so once the window ended ≥FINALITY blocks below the tip
   *  they can never change, cache them forever. The full pull refetches live-window lists per pass;
   *  a scan that has kept events reads neither (`kept`). */
  private attCache = new Map<string, AttestEvent[]>();
  /** The events the last accepted scan kept, checked against the chain by invalidateCacheOnReorg. */
  private kept: Kept | null = null;
  /** What the scan in progress keeps if it is accepted (scan()). */
  private nextKept: Kept | null = null;
  /** The cache keys the scan in progress wrote: what an unsuccessful scan takes back out (scan()). */
  private written: { tx: string[]; att: string[] } | null = null;
  /** The attCache freeze horizon's block hash, re-sampled each scan. A closed window is
   *  cached forever on the assumption that history ≥FINALITY below the tip can't change, but a
   *  reorg DEEPER than FINALITY violates it, leaving a long-running scanner serving a stale
   *  `filled`/attestation set a fresh scanner would not. Any reorg that could poison a frozen
   *  window forks BELOW that window's expiry (< this boundary), so it necessarily changes the
   *  block AT this boundary, detect that and drop the closed cache (parity with txCache, which
   *  is height-keyed and self-refreshes). Without an indexer answer we keep the prior anchor and
   *  never false-clear. */
  private reorgAnchor: { h: number; hash: string } | null = null;
  /** The PREVIOUS scan's tip {height,hash}. A reorg that can move any cached tx
   *  (all cached at height ≤ this) replaces the block at this height, so a hash change here catches
   *  shallow reorgs the tip−FINALITY deep anchor misses. Re-sampled each scan. */
  private prevTip: { h: number; hash: string } | null = null;
  private pageSize: number;
  private attPageSize: number;
  private feedPageSize: number;
  private keptMax: number;
  private keptRefresh: number;
  private verifyInclusion: boolean;
  private headerMerkleAt?: (height: number) => Promise<string>;
  private rawTxAt?: (txid: string) => Promise<Tx>;
  private merkleProofAt: (txid: string) => Promise<{ block_height: number; pos: number; merkle: string[]; merkle_root: string }>;
  private verifiedTipHeight?: () => Promise<number>;
  private confDepth: number;
  private waitMaxMs: number;
  private run: ScanRun = {};
  /** The full pull in progress, or one a stop suspended, which the next scan resumes (scan()). */
  private memo: Memo | null = null;
  /** Whether getJson reads through the memo: only inside pullAll, whose answers at one tip are what the memo holds. */
  private memoOn = false;
  private tipHeight = 0;          // set per scan (indexer-fed): attCache freeze horizon + fallback tip
  private depthTip = 0;           // set per scan (verifiedTipHeight with verifyInclusion on, else the indexer tip): the conf-depth reference
  private lastFinal: number | null = null;
  /** The last scan's final height (verified tip less confDepth) with verifyInclusion on, else null: every event that
   *  scan returned is at or below it, and nothing above it was considered. */
  get finalHeight(): number | null { return this.lastFinal; }
  private reorgClears = 0;
  /** How many times a scan dropped its caches because the chain under them changed or could not be confirmed
   *  (invalidateCacheOnReorg). Any reorg that replaces a block at or below the previous scan's tip moves it. */
  get reorgEpoch(): number { return this.reorgClears; }
  /** CONVENTION §34's final depth (cairnx-core `FINAL_DEPTH`), read by the reorg guards. */
  static readonly FINALITY = FINAL_DEPTH;

  constructor(opts: ScanOptions) {
    this.base = opts.indexerUrl.replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.pageSize = opts.pageSize ?? 10_000;
    this.attPageSize = opts.attPageSize ?? 5_000;
    this.feedPageSize = opts.feedPageSize ?? 1_000;
    this.keptMax = opts.keptMax ?? MAX_KEPT_EVENTS;
    this.keptRefresh = opts.keptRefresh ?? KEPT_REFRESH_SCANS;
    this.verifyInclusion = opts.verifyInclusion ?? false;
    this.headerMerkleAt = opts.headerMerkleAt;
    this.rawTxAt = opts.rawTxAt;
    this.merkleProofAt = opts.merkleProofAt ?? ((txid) => this.getJson(`/tx/${txid}/merkle-proof`));
    this.verifiedTipHeight = opts.verifiedTipHeight;
    this.confDepth = opts.confDepth ?? Scanner.FINALITY;
    this.waitMaxMs = opts.waitMaxMs ?? 0;
    if (this.verifyInclusion && (!this.headerMerkleAt || !this.rawTxAt || !this.verifiedTipHeight))
      throw new Error("scan: verifyInclusion requires headerMerkleAt (header merkle source) + rawTxAt (raw tx for txid recompute) + verifiedTipHeight (depth reference)");
  }

  /** One GET below the base, with the run's signal and the request timeout; with waitMaxMs, a 429 or 503 is waited out
   *  and the memo's pull confirmed after each wait (`confirm` false for the confirming read itself). */
  private get(path: string, confirm = true): Promise<Response> {
    const signal = this.run.signal, send = () => {
      const t = AbortSignal.timeout(this.timeoutMs);
      return this.f(`${this.base}${path}`, { signal: signal ? either(signal, t) : t, redirect: "error" });
    };
    if (this.waitMaxMs <= 0) return send();
    return waitingOut(send, path, this.waitMaxMs, signal ?? new AbortController().signal, confirm ? () => this.confirm() : undefined);
  }

  private async getJson<T>(path: string): Promise<T> {
    const m = this.memoOn ? this.memo : null;
    if (m?.answers.has(path)) return m.answers.get(path) as T;
    const r = await this.get(path);
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    const v = (await r.json()) as T;
    m?.answers.set(path, v);
    return v;
  }

  /** After a wait: with a pull in the memo, the block at its tip read again. The same hash confirms every answer the
   *  memo holds (read between two equal reads, the rule an accepted scan uses); another is a reorg, and the pull is
   *  refused. Then a due run stops here, with nothing of the memo unconfirmed. */
  private async confirm(): Promise<void> {
    const m = this.memo;
    if (m !== null) {
      const r = await this.get(`/block-height/${m.tip}`, false);
      if (!r.ok) throw new Error(`/block-height/${m.tip} -> ${r.status}`);
      if ((await r.json()) !== m.hash) throw new SourceError("BRANCH_MOVED", "the block at the indexer's tip changed during the scan (a reorg)");
      m.confirmed = m.answers.size;
    }
    if (this.run.due?.() === true) throw new SourceError("SOURCE_RATE_LIMITED", "the scan stopped at the step's deadline after a wait; the next scan resumes it", 0);
  }

  private async tx(txid: string, height: number): Promise<TxInfo> {
    const key = `${txid}:${height}`;
    const hit = this.txCache.get(key);
    if (hit) return hit;
    const t = await this.getJson<{ pos: number; height: number; outputs: { addr: string; value: number }[] }>(`/tx/${txid}`);
    // Harden against a malicious/buggy indexer. Outputs feed fee/payment checks, so each is
    // tightly validated: value a NON-NEGATIVE SAFE INTEGER as a real number (NOT a hex/decimal
    // string that BigInt would silently mis-parse), addr a real 0x-40-hex (an empty/missing addr
    // would create a phantom "" payment bucket). A malformed output is SKIPPED, never throws,
    // dropping outputs is CONSERVATIVE (it can only make a payment look smaller → a fill/fee that
    // truly wasn't covered gets rejected), and one weird tx can't DoS the whole scan.
    // consensus admits at most MAX_TX_OUTPUTS outputs, so a listed output past them is in no transaction
    const raw = Array.isArray(t.outputs) ? t.outputs.slice(0, MAX_TX_OUTPUTS) : [];
    const outputs: { addr: string; value: number }[] = [];
    for (const o of raw) {
      if (typeof o.value !== "number" || !Number.isSafeInteger(o.value) || o.value < 0) continue;
      const addr = String(o.addr ?? "").toLowerCase();
      if (!ADDR_RE.test(addr)) continue; // cairnx-core's address regex
      outputs.push({ addr, value: o.value });
    }
    // height via reqOrd (fail loud): the old `Number(t.height) || height` row-fallback could only mask
    // garbage, the indexer serves /tx/:id for MINED txs only (mempool 404s), so an honest feed always
    // carries a real height and the fallback never fired.
    let info: TxInfo = { pos: reqOrd(t.pos, "tx pos"), height: reqOrd(t.height, "tx height"), outputs };
    // When enabled, DON'T trust the indexer's decoded outputs, bind them to consensus.
    if (this.verifyInclusion) info = await this.verifyTx(txid, info.height, outputs);
    if (info.height <= this.tipHeight) {
      this.txCache.set(key, info);
      this.written?.tx.push(key);
      boundCache(this.txCache, 50_000);
    }
    return info;
  }

  // Output binding, gated by verifyInclusion. Demotes the indexer to a
  // data source for payments by binding every output to consensus, fail-CLOSED on any gap:
  //   (1) conf-depth gate: the tx must be ≥ confDepth below the tip, too-shallow txs
  //       (reorg-exposed) don't feed a payment/fee check.
  //   (2) txid-recompute BIND: fetch the RAW tx, recompute its txid with the consensus codec, and
  //       require it == the expected txid. This binds the OUTPUTS to the txid (the indexer's decoded
  //       outputs are otherwise unbound, a real merkle-provable txid could carry fabricated outputs).
  //   (3) merkle inclusion: fold the txid via /tx/:id/merkle-proof and require the proof's root == the
  //       header merkle at that height (headerMerkleAt). So the txid is mined in a sufficiently deep block
  //       of the chain the header source follows.
  // Any failure THROWS → the scan surfaces it rather than resolve from unverified payment data.
  private async verifyTx(txid: string, height: number, indexerOutputs: { addr: string; value: number }[]): Promise<TxInfo> {
    // (2) txid-recompute bind → authoritative outputs from the raw tx, not the indexer's decode.
    const rawTx = await this.rawTxAt!(txid);
    if (codecTxid(rawTx).toLowerCase() !== txid.toLowerCase())
      throw new Error(`F4: raw tx for ${txid} recomputes to a different txid (forged body)`);
    // The proposer or attester: the owner of the coin input 0 spends (authorOf). The txid strips scriptSigs, so the
    // signature alone could be any key's; the coin's script_pubkey is read from its source tx, which the input's
    // prevTxid commits once that tx recomputes to it: one more node read per record verified, cached with its TxInfo.
    const in0 = rawTx.inputs[0];
    let signer: string | null = null;
    if (in0) {
      const source = await this.rawTxAt!(in0.prevTxid);
      if (codecTxid(source).toLowerCase() !== in0.prevTxid.toLowerCase())
        throw new Error(`F4: source tx ${in0.prevTxid} of ${txid} recomputes to a different txid (forged body)`);
      signer = authorOf(rawTx, source.outputs[in0.vout]?.scriptPubkey);
    }
    if (!signer) throw new Error(`F4: tx ${txid} has no author: input 0 carries no signature over its sighash by the owner of the coin it spends (node misreporting)`);
    const outputs: { addr: string; value: number }[] = [];
    // NOTE: deliberately NOT shared with tx()'s output loop, tx() enforces strict `typeof value === "number"`
    // on indexer JSON while this loop must accept the codec's number|bigint, and scriptPubkey is 0x-optional.
    for (const o of rawTx.outputs) {
      const v = Number(o.value);
      if (!Number.isSafeInteger(v) || v < 0) continue;
      const addr = addrOfScriptPubkey(o.scriptPubkey);
      if (!addr) continue;
      outputs.push({ addr, value: v });
    }
    // (3) merkle inclusion against the header source's merkle root.
    const proof = await this.merkleProofAt(txid);
    const verifiedRoot = await this.headerMerkleAt!(proof.block_height);
    if (String(verifiedRoot).toLowerCase().replace(/^0x/, "") !== String(proof.merkle_root).toLowerCase().replace(/^0x/, ""))
      throw new Error(`F4: tx ${txid} merkle root != header merkle at ${proof.block_height}`);
    if (!verifyMerkleProof(txid, proof.pos, proof.merkle, proof.merkle_root))
      throw new Error(`F4: tx ${txid} does not merkle-prove into block ${proof.block_height}`);
    // (1) conf-depth gate, AFTER verification, on operands the indexer does not supply. A gate on the
    // indexer-claimed height against the indexer-fed tip would pass a lying indexer that claims a deep height
    // and proves a near-tip block, and a NaN claimed height (NaN < confDepth is false). Neither operand comes
    // from the indexer: depth = verifiedTip - proof.block_height (the merkle-proven
    // height, trusted by the checks just above), and the indexer's own claimed height MUST equal the proven
    // one (else it is lying about where the tx sits). isSafeInteger guards NaN/Infinity on every operand.
    if (!Number.isSafeInteger(proof.block_height) || proof.block_height < 0)
      throw new Error(`F4: tx ${txid} merkle proof has a non-integer block_height ${proof.block_height}`);
    if (height !== proof.block_height)
      throw new Error(`F4: tx ${txid} indexer-claimed height ${height} != merkle-proven height ${proof.block_height} (indexer misreporting)`);
    const depth = this.depthTip - proof.block_height;
    if (!Number.isSafeInteger(depth) || depth < this.confDepth)
      throw new Error(`F4: tx ${txid} verified at ${proof.block_height} is shallower than confDepth ${this.confDepth} (verified tip ${this.depthTip})`);
    // The divergence signal: with verifyInclusion on this is the exact tell that the indexer fed
    // outputs the consensus-bound recompute rejected. Compare the full {addr,value} multiset, not just the
    // count, so a same-count value/addr substitution is also caught. The verified `outputs` win regardless.
    const fp = (os: { addr: string; value: number }[]) => os.map((o) => `${o.addr}:${o.value}`).sort().join(",");
    if (fp(indexerOutputs) !== fp(outputs))
      console.warn(`F4: indexer decode for ${txid} differs from the consensus-bound outputs (indexer=${indexerOutputs.length} verified=${outputs.length}). Using verified outputs; the indexer is lying or buggy`);
    return { pos: proof.pos, height: proof.block_height, outputs, body: { app: rawTx.app, signer } };
  }

  /** The height that orders an event in resolve(). With verifyInclusion on it is the merkle-proven height
   *  from verifyTx, and the indexer row must report the same one: a row height that disagrees could move the
   *  event within the replay, so the scan fails as it does for a forged record. Off, it is the row height. */
  private eventHeight(rowHeight: unknown, info: TxInfo, what: string, txid: string): number {
    const h = reqOrd(rowHeight, what);
    if (!this.verifyInclusion) return h;
    if (h !== info.height)
      throw new Error(`F4: ${what} ${h} for ${txid} != merkle-proven height ${info.height} (indexer misreporting)`);
    return info.height;
  }

  /** A proposal's record fields. Off, the indexer row's. On, the node body's, and every row field must equal them
   *  (the uri only when the body's holds no U+0000): the body must be a cairnx:v1 Propose, and a row that disagrees
   *  fails the scan as a misreported height does. */
  private boundPropose(row: RawProposal, info: TxInfo, pid: string): Pick<ProposeEvent, "proposer" | "uri" | "payloadHash" | "expiresEpoch"> {
    const fromRow = proposalFields(row);
    if (!this.verifyInclusion) return fromRow;
    const { app, signer } = info.body!;
    if (app.type !== "Propose") throw new Error(`F4: proposal ${pid} is not a Propose in the node's transaction body (${app.type}) (indexer misreporting)`);
    if (app.domain !== DOMAIN) throw new Error(`F4: proposal ${pid} has domain ${JSON.stringify(app.domain)} in the node's transaction body, not ${DOMAIN} (indexer misreporting)`);
    const body = { proposer: signer, uri: app.uri, payloadHash: String(app.payloadHash).toLowerCase(), expiresEpoch: epochOfBody(app.expiresEpoch) };
    // A uri holding U+0000 is no JSON, so resolve() logs the event invalid as it does any uri that is no record. An
    // indexer store that holds no U+0000 serves another uri for it, so that one field is not compared
    // (test/scan/scan-nul-body.test.ts).
    return sameAsRow("proposal", pid, body.uri.includes("\u0000") ? { ...fromRow, uri: body.uri } : fromRow, body);
  }

  /** An attestation's record fields, as boundPropose: the body must be an Attest of the proposal whose list served it. */
  private boundAttest(row: RawAttest, info: TxInfo, pid: string, txid: string): Pick<AttestEvent, "attester" | "score" | "confidence"> {
    const fromRow = attestFields(row);
    if (!this.verifyInclusion) return fromRow;
    const { app, signer } = info.body!;
    if (app.type !== "Attest") throw new Error(`F4: attestation ${txid} is not an Attest in the node's transaction body (${app.type}) (indexer misreporting)`);
    if (String(app.proposalId).toLowerCase() !== pid)
      throw new Error(`F4: attestation ${txid} attests ${String(app.proposalId).toLowerCase()} in the node's transaction body, listed under ${pid} (indexer misreporting)`);
    return sameAsRow("attestation", txid, fromRow, { attester: signer, score: app.score, confidence: app.confidence });
  }

  /** A proposal row and its transaction (tx()) as the event resolve() replays: one home for the full pull and the feed
   *  rows. */
  private proposeEvent(p: RawProposal, info: TxInfo): ProposeEvent {
    const pid = p.txid.toLowerCase();
    const { proposer, uri, payloadHash, expiresEpoch } = this.boundPropose(p, info, pid);
    return {
      kind: "propose", id: pid, proposer, uri, payloadHash, expiresEpoch, height: this.eventHeight(p.height, info, "proposal height", pid), pos: info.pos,
      paidTo: paidToFromOutputs(info.outputs), // protocol-fee outputs in the SAME tx (deploy/name-reg); single-sourced from cairnx-core
    };
  }

  /** An attestation row of proposal `pid` and its transaction as the event resolve() replays (both pulls). */
  private attestEvent(a: RawAttest, pid: string, at: TxInfo): AttestEvent {
    const { attester, score, confidence } = this.boundAttest(a, at, pid, String(a.txid).toLowerCase());
    return {
      kind: "attest", txid: a.txid.toLowerCase(), proposalId: pid, attester, score, confidence,
      height: this.eventHeight(a.height, at, "attest height", String(a.txid).toLowerCase()), pos: at.pos, paidTo: paidToFromOutputs(at.outputs),
    };
  }

  /** The cairnx:v1 rows of one chain-order feed after `after`, at or below the block `tip`, which must still carry its
   *  hash (csd-indexer feedPage: every row then comes from the chain that hash commits to). Null when the indexer
   *  answers but cannot serve the read (no feed, the block left the chain, a page out of order or malformed, a row
   *  whose record fields no event can be built from): the scan then pulls in full. A request that fails throws, as
   *  every other read of the scan does. */
  private async feedRows<R extends RawProposal | RawAttest>(kind: "proposals" | "attestations", tip: Block, after: ChainPos | null): Promise<{ row: R; at: ChainPos }[] | null> {
    const out: { row: R; at: ChainPos }[] = [];
    let cur = after;
    for (let guard = 0; guard < 10_000; guard++) {
      const q = `/${kind}?domain=${encodeURIComponent(DOMAIN)}&at=${tip.h}:${tip.hash}&limit=${this.feedPageSize}${cur ? `&after=${cur.height}:${cur.pos}` : ""}`;
      const r = await this.get(q);
      if (!r.ok) return null;
      let page: { at?: { height?: unknown; hash?: unknown }; rows?: unknown; next?: unknown } | null;
      try { page = (await r.json()) as typeof page; } catch { return null; }
      if (!page || !Array.isArray(page.rows) || page.at?.height !== tip.h || String(page.at.hash).toLowerCase() !== tip.hash.toLowerCase()) return null;
      for (const row of page.rows as Record<string, unknown>[]) {
        const height = feedOrd(row?.height), pos = feedOrd(row?.pos);
        if (height === null || pos === null || height > tip.h || typeof row.txid !== "string") return null;
        if (kind === "attestations" && typeof row.proposal_id !== "string") return null;
        if (!feedFieldsOk(kind, row)) return null;
        if (cur && !(height > cur.height || (height === cur.height && pos > cur.pos))) return null;
        cur = { height, pos };
        out.push({ row: row as unknown as R, at: cur });
      }
      // csd-indexer sets `next` when the page was full at its own limit, which may be below ours
      if (page.next == null && page.rows.length < this.feedPageSize) return out;
      if (page.rows.length === 0) return null;
    }
    return null;
  }

  /** The incremental pull: the kept events plus the feed rows after them, at or below `upTo`, in the full
   *  pull's order. Kept rows are at or below `k.upTo` and every row of the chain there is kept, so each new row lies
   *  after them in chain order, and an attestation after its proposal (the node rejects an Attest of a proposal it has
   *  not applied, and one in an epoch past the proposal's expiry, compute-substrate src/state/app_state.rs). Null when
   *  the feed cannot serve the read or serves a row that breaks that (one at or below `k.upTo`, an id kept already, an
   *  unknown proposal, one whose transaction is not at the row's height and position): the scan then pulls in full.
   *  A row's feed coordinates page the feed and set where the next read starts; its transaction's place is its event's.
   *  When the two disagree a page can skip rows (test/scan/scan-incremental-fallback.test.ts). */
  private async pullNew(k: Kept, tip: Block, deep: Block | null, upTo: number): Promise<Kept | null> {
    const props = await this.feedRows<RawProposal>("proposals", tip, k.last.p);
    if (!props) return null;
    const atts = await this.feedRows<RawAttest & { proposal_id: string }>("attestations", tip, k.last.a);
    if (!atts) return null;
    const txAt = async (txid: string, at: ChainPos): Promise<TxInfo | null> => {
      const info = await this.tx(txid, at.height);
      return info.height === at.height && info.pos === at.pos ? info : null;
    };
    const map = new Map(k.props), ids = new Set(k.ids);
    let lastP = k.last.p, lastA = k.last.a;
    const fresh: ProposeEvent[] = [];
    for (const { row, at } of props) {
      if (at.height > upTo) break;
      if (at.height <= k.upTo || ids.has(row.txid.toLowerCase())) return null;
      const info = await txAt(row.txid, at);
      if (!info) return null;
      const pe = this.proposeEvent(row, info);
      ids.add(pe.id);
      fresh.push(pe);
      lastP = at;
    }
    for (const pe of fresh.sort(fullPullOrder)) map.set(pe.id, { pe, atts: [] });
    const grown = new Map<string, AttestEvent[]>();
    for (const { row, at } of atts) {
      if (at.height > upTo) break;
      const pid = row.proposal_id.toLowerCase();
      if (at.height <= k.upTo || !map.has(pid) || ids.has(row.txid.toLowerCase())) return null;
      const info = await txAt(row.txid, at);
      if (!info) return null;
      const ae = this.attestEvent(row, pid, info);
      ids.add(ae.txid);
      lastA = at;
      const list = grown.get(pid);
      if (list) list.push(ae); else grown.set(pid, [ae]);
    }
    for (const [pid, list] of grown) {
      const e = map.get(pid);
      if (e) map.set(pid, { pe: e.pe, atts: e.atts.concat(list.sort(fullPullOrder)) });
    }
    return { upTo: Math.max(k.upTo, upTo), anchor: tip, deep, props: map, ids, last: { p: lastP, a: lastA }, scans: k.scans + 1 };
  }

  /** The COMPLETE attestation list for a proposal, via keyset pagination. Each indexer response is
   *  bounded (DoS-safe), so we page on (height,txid) until a short page. Completeness is REQUIRED: the
   *  resolver replays every fill/cancel/partial-fill, so a silently truncated list would diverge ledger
   *  state. txid is unique per attest tx, so (height,txid) is a strict total order, no dup/skip at a
   *  page boundary. The guard bounds a pathological proposal (>5M attests) rather than loop forever. */
  private async allAttestations(txid: string): Promise<RawAttest[]> {
    const PAGE = this.attPageSize;
    const out: RawAttest[] = [];
    const seen = new Set<string>();   // txid de-dup, see the push loop below
    let afterH: number | undefined, afterT: string | undefined, done = false;
    for (let guard = 0; guard < 1_000; guard++) {
      const cursor = afterH !== undefined ? `&after_height=${afterH}&after_txid=${afterT}` : "";
      const page = await this.getJson<RawAttest[]>(`/proposal/${txid}/attestations?limit=${PAGE}${cursor}`);
      // A non-array HTTP-200 body would throw TypeError on the spread and abort the whole
      // scan (→ stale-state-forever). Fail loud with a clear message, like the saturation guard below.
      if (!Array.isArray(page)) throw new Error(`indexer returned a non-array attestations page for ${txid}; refusing to resolve from a malformed feed`);
      // The feed pushes pages VERBATIM, so a duplicated attestation (a buggy/hostile indexer, or overlapping
      // pages) would ride into resolve() TWICE and double-apply, double-crediting o.paid/o.delivered on a
      // partial fill (resolve() de-dups only from V29). txid is unique per attest tx, so de-dup by it before pushing: the first
      // occurrence wins, any repeat is dropped. The cursor + short-page test still key on the RAW `page` (the
      // indexer's real pagination), so this never masks a truncated feed; it only drops exact-txid repeats.
      for (const a of page) {
        const k = String(a.txid).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(a);
      }
      if (page.length < PAGE) { done = true; break; }
      const last = page[page.length - 1];
      if (!last) throw new Error(`indexer returned a full attestations page for ${txid} without a last row`);
      afterH = Number(last.height); afterT = last.txid;
    }
    // The resolver replays EVERY attest, so a truncated list diverges ledger state. If the guard ran out
    // with a still-full last page, the list is incomplete, fail loud rather than resolve from it (parity
    // with the non-array/saturation guards; wrong state is worse than no state).
    if (!done) throw new Error(`attestation feed for ${txid} exceeded the pagination guard (>5M attests); refusing to resolve from a truncated list`);
    return out;
  }
  // paidTo comes from cairnx-core's paidToFromOutputs, the resolver's own fee aggregation, so the two cannot drift.

  /** Pull the COMPLETE domain proposal history via the height cursor (?from=, ascending,
   *  page until a short page; de-dup by txid at the boundary). Against a pre-cursor indexer
   *  the pages don't advance, if that happens at the clamp, FAIL LOUDLY rather than resolve
   *  from a silently-truncated feed (wrong state is worse than no state). */
  private async pullProposals(): Promise<RawProposal[]> {
    const PAGE = this.pageSize;
    const byId = new Map<string, RawProposal>();
    let from = 0, done = false;
    for (let guard = 0; guard < 1_000; guard++) {           // 10M proposals ≫ any plausible domain
      const rows = await this.getJson<RawProposal[]>(
        `/domain/${encodeURIComponent(DOMAIN)}/proposals?limit=${PAGE}&from=${from}`);
      if (!Array.isArray(rows)) throw new Error("indexer returned a non-array proposals page; refusing to resolve from a malformed feed");
      let fresh = 0;
      let maxH = from;
      for (const r of rows) {
        const id = (r.txid ?? "").toLowerCase();
        if (!byId.has(id)) fresh++;
        byId.set(id, r);                                    // last-seen wins (mid-scan reorg)
        if (Number(r.height) > maxH) maxH = Number(r.height);
      }
      if (rows.length < PAGE) { done = true; break; }       // short page = history complete
      if (fresh === 0) {
        // full page, nothing new: a legacy indexer ignoring ?from= just re-served its newest-
        // first clamp window, the domain has outgrown it and the feed is TRUNCATED.
        throw new Error("indexer proposal feed saturated at the 10k clamp without cursor support: upgrade csd-indexer (?from= pagination) before trusting resolved state");
      }
      // A FULL page whose max height didn't advance past the cursor means every row
      // sits at/below `from`, i.e. 10k proposals in (or below) a single block, which is impossible for a
      // real domain. This is a stuck / rotating-decoy / lying feed that the fresh===0 guard alone misses
      // (it keeps emitting NEW decoy txids at a fixed height). Fail loud rather than silently truncate.
      if (maxH <= from)
        throw new Error("indexer proposal feed did not advance the height cursor on a full page: stale/hostile feed (replace csd-indexer)");
      from = maxH;                                          // overlap at maxH is de-duped by txid
    }
    // Guard exhausted with a still-full last page = the domain outgrew the 10M-proposal bound and the pull
    // is truncated. Fail loud (parity with the saturation/stuck guards) rather than resolve from a partial
    // history that would drop the most recent proposals.
    if (!done) throw new Error("proposal pull exceeded the pagination guard (>10M proposals); refusing to resolve from a truncated history");
    return [...byId.values()];
  }

  /** Drop the order-sensitive caches (txCache positions, attCache closed-window sets) whenever the
   *  canonical chain the cached rows live in changed under us. Two independent triggers:
   *
   *  (1) SHALLOW-reorg positions: a reorg entirely ABOVE the tip−FINALITY
   *      anchor leaves that anchor unchanged, so (2) alone misses it, yet it can still swap the block
   *      positions of already-cached txs (an offer and its ocancel reordered in one block flips the offer
   *      back to "open", and the stale-open resolver then lets a payment-bearing fill burn). Any reorg
   *      that could move a cached tx (all cached at height ≤ the PREVIOUS scan's tip) must replace the
   *      block at that previous tip height, so a hash change there is a sound, cheap detector. On any
   *      change, or an indexer that can't confirm the prior tip hash, clear and force a refetch; the
   *      position-bearing events then re-derive and change the events a replay reads.
   *
   *  (2) DEEP-reorg frozen windows: a reorg deeper than FINALITY can poison a frozen
   *      closed-window attCache; detected at the tip−FINALITY boundary. Largely subsumed by (1), kept as a
   *      tested belt-and-suspenders line (and it keeps-on-error, protecting the long-lived closed cache).
   *
   *  (3) The kept events stay while the block they are anchored to is still on the chain; after a reorg
   *      above their deep block they roll back to it (the rows above it are read again), after any other change
   *      they are dropped and the scan pulls in full.
   *
   *  Conservative throughout: an unconfirmable prior hash clears (a harmless refetch), never false-keeps. Returns this
   *  scan's tip block and its tip less FINALITY, as read here (null for a read that failed): what its kept events
   *  are anchored to. */
  private async invalidateCacheOnReorg(tipHeight: number): Promise<{ tip: Block | null; deep: Block | null }> {
    // This scan's own anchor is sampled first, so the hash read after the pull brackets this cache check as well as
    // the pull: a branch switch after this read shows in the check or as a moved tip (test/scan/scan-anchor-bracket.test.ts).
    let anchor: string;
    try { anchor = await this.getJson<string>(`/block-height/${tipHeight}`); } catch (e) { if (this.stops(e)) throw e; anchor = "!unconfirmed-tip"; }
    // every hash read here, so check (3) reads none of them twice
    const read = new Map<number, string | null>([[tipHeight, anchor.startsWith("!") ? null : anchor]]);
    // (1) shallow: did the block at the previous scan's tip height change identity? (the anchor itself when the
    // heights coincide: no second read of one block)
    const pt = this.prevTip;
    if (pt) {
      let nowHash: string | null = null;
      if (pt.h === tipHeight) nowHash = anchor.startsWith("!") ? null : anchor;
      else { try { nowHash = await this.getJson<string>(`/block-height/${pt.h}`); } catch (e) { if (this.stops(e)) throw e; nowHash = null; } read.set(pt.h, nowHash); }
      if (nowHash !== pt.hash) { this.attCache.clear(); this.txCache.clear(); this.reorgClears++; }   // mismatch OR unconfirmable → clear
    }
    // (2) deep: freeze-horizon anchor (keeps-on-error to preserve the long-lived closed-window cache)
    const prev = this.reorgAnchor;
    if (prev) {
      let nowHash: string | null = null;
      try { nowHash = await this.getJson<string>(`/block-height/${prev.h}`); } catch (e) { if (this.stops(e)) throw e; nowHash = null; }
      if (!read.has(prev.h)) read.set(prev.h, nowHash);
      if (nowHash !== null && nowHash !== prev.hash) { this.attCache.clear(); this.txCache.clear(); this.reorgClears++; }
    }
    // (3) the kept events; a hash that cannot be read counts as changed
    const k = this.kept;
    if (k) {
      const hashAt = async (h: number): Promise<string | null> => {
        const known = read.get(h);
        if (known !== undefined) return known;
        let v: string | null = null;
        try { v = await this.getJson<string>(`/block-height/${h}`); } catch (e) { if (this.stops(e)) throw e; v = null; }
        read.set(h, v);
        return v;
      };
      if ((await hashAt(k.anchor.h)) !== k.anchor.hash)
        this.kept = k.deep && (await hashAt(k.deep.h)) === k.deep.hash ? keptFrom(eventsOf(k, null), Math.min(k.upTo, k.deep.h), k.deep, null, this.keptMax, k.scans) : null;
    }
    // Record the shallow anchor for the next scan. On a failed sample the prior (lower) anchor is not kept: this
    // scan caches txs up to the current tip, so a lagging anchor would leave (prevTip.h, tip] unguarded. The
    // sentinel is not a block hash, so the next scan clears (test/scan/scan-reorg-pos.test.ts, fault paths).
    this.prevTip = { h: tipHeight, hash: anchor };
    const h = Math.max(0, tipHeight - Scanner.FINALITY);
    let deep: Block | null = null;
    try { deep = { h, hash: await this.getJson<string>(`/block-height/${h}`) }; this.reorgAnchor = deep; }
    catch (e) { if (this.stops(e)) throw e; /* indexer can't answer → keep the prior anchor for the next scan */ }
    return { tip: anchor.startsWith("!") ? null : { h: tipHeight, hash: anchor }, deep };
  }

  /** One scan: all CairnX events + the indexer tip. A scan that ends off one branch, or throws, may have cached
   *  rows of a branch the chain later leaves, and the next scan's reorg check compares against the hash sampled before
   *  this pull, so it would keep them: such a scan takes back out every row it cached and nothing an accepted scan
   *  cached (test/scan/scan-refused-cache.test.ts), and keeps no events of its own. The original error is rethrown.
   *  With waitMaxMs, a full pull that stops for transport (`run.signal`, or a 429 or 503 it does not wait out, a
   *  due run among them) keeps the answers its memo confirmed, and the next scan resumes it while the block at its tip
   *  is unchanged, sending only what it has not read (test/scan/scan-resume.test.ts); every other end drops them. */
  async scan(run: ScanRun = {}): Promise<{ events: ChainEvent[]; tipHeight: number; anchor: ScanAnchor }> {
    this.run = run;
    this.written = { tx: [], att: [] };
    this.nextKept = null;
    let accepted = false, resumable = false;
    try {
      const r = await this.pull();
      accepted = r.anchor.branch === "one";
      return r;
    } catch (e) {
      resumable = this.run.signal?.aborted === true || (e instanceof SourceError && (e.code === "SOURCE_RATE_LIMITED" || e.code === "SOURCE_UNAVAILABLE"));
      throw e;
    } finally {
      this.memoOn = false;
      const m = this.memo;
      this.memo = resumable && m !== null && m.confirmed > 0 ? { ...m, answers: new Map([...m.answers].slice(0, m.confirmed)) } : null;
      if (!accepted) this.takeBack({ tx: 0, att: 0 });
      this.written = null;
      if (accepted) this.kept = this.nextKept;
      this.nextKept = null;
      this.run = {};
    }
  }

  /** Whether `e` ends the scan rather than a read that a fallback absorbs: the run's signal, or a SourceError, which only
   *  waitingOut (a refusal it does not wait out) and confirm (a moved tip, a due run) throw here. */
  private stops(e: unknown): boolean {
    return this.run.signal?.aborted === true || e instanceof SourceError;
  }

  /** Takes the cache rows the scan in progress wrote since `from` (counts of its `written` lists) back out of the caches;
   *  rows other scans wrote stay. */
  private takeBack(from: { tx: number; att: number }): void {
    const w = this.written;
    if (!w) return;
    for (const k of w.tx.splice(from.tx)) this.txCache.delete(k);
    for (const k of w.att.splice(from.att)) this.attCache.delete(k);
  }

  private async pull(): Promise<{ events: ChainEvent[]; tipHeight: number; anchor: ScanAnchor }> {
    // Validate the single most load-bearing scalar (every OTHER numeric field is already
    // defensively wrapped). tipHeight drives the conf-depth gate AND the attCache freeze horizon
    // (closedBelowEpoch); a string/NaN/negative tip would NaN the gate and collapse the freeze to 0
    // (refetch-everything regression). Fail loud, like the pullProposals saturation guard, rather than
    // resolve from a garbage tip. Honest data is unchanged (the indexer returns a JSON integer).
    // A pull a stop suspended resumes at its own tip; its memo is dropped below unless the block there is unchanged.
    const resume = this.memo !== null;
    const rawTip = resume ? this.memo!.tip : await this.getJson<unknown>("/blocks/tip/height");
    // Number() reads null, "", [] and false as 0 and [7] as 7 (test/scan/scan-tip-guard.test.ts)
    const tipHeight = typeof rawTip === "number" || (typeof rawTip === "string" && /^[0-9]+$/.test(rawTip)) ? Number(rawTip) : NaN;
    if (!Number.isSafeInteger(tipHeight) || tipHeight < 0)
      throw new Error("indexer returned a non-numeric/negative tip height");
    this.tipHeight = tipHeight;   // indexer-fed: attCache freeze horizon
    // Depth reference for the conf-depth gate: verifiedTipHeight with verifyInclusion on (the indexer tip is
    // attacker-supplied in the threat that flag answers), else the indexer tip (the gate is unused then).
    if (this.verifyInclusion) {
      const vt = Number(await this.verifiedTipHeight!());
      if (!Number.isSafeInteger(vt) || vt < 0) throw new Error("F4: verifiedTipHeight returned a non-numeric/negative tip");
      this.depthTip = vt;
    } else {
      this.depthTip = tipHeight;
    }
    const blocks = await this.invalidateCacheOnReorg(tipHeight);
    // verifyInclusion on: verifyTx accepts a tx iff depthTip - height >= confDepth, so the highest final height is
    // depthTip - confDepth. A record above it is checked against the cutoff BEFORE tx() (whose verifyTx
    // would throw on it). A row that lies low is caught by eventHeight(); one that lies high only defers
    // its record, which an indexer can already do by omitting the row.
    const finalHeight = this.depthTip - this.confDepth;
    this.lastFinal = this.verifyInclusion ? finalHeight : null;
    // This scan keeps the events at or below its declared tip, the block its feed reads are bound to (and with
    // verifyInclusion on, at or below the final height, the ones it emits): a row above the tip can come from a block
    // that landed during the pull, part read.
    const upTo = this.verifyInclusion ? Math.min(tipHeight, finalHeight) : tipHeight;
    // Kept events that have served keptRefresh accepted scans are not read on from: this scan pulls in full, and if it
    // is accepted its events replace them; if not, they stay and the next scan tries again.
    const k = this.kept;
    // a feed read the scan does not take keeps nothing it cached: the full pull reads those transactions again
    const mark = { tx: this.written?.tx.length ?? 0, att: this.written?.att.length ?? 0 };
    const next = !resume && blocks.tip && k && k.upTo <= tipHeight && k.scans < this.keptRefresh ? await this.pullNew(k, blocks.tip, blocks.deep, upTo) : null;
    if (!next) this.takeBack(mark);
    let events: ChainEvent[];
    if (next) {
      events = eventsOf(next, this.verifyInclusion ? finalHeight : null);
      this.nextKept = next.ids.size <= this.keptMax ? next : null;
    } else {
      // The memo holds the answers of one pull at one tip block: a resumed pull's while the block there, read again
      // above, is unchanged; else a new one's (with waitMaxMs, and the block's hash read). A resumed pull whose block
      // changed is pulled again in full at that height.
      const hash = blocks.tip?.hash ?? null, m = this.memo;
      if (m !== null && (m.tip !== tipHeight || m.hash !== hash)) this.memo = null;
      if (this.memo === null && this.waitMaxMs > 0 && hash !== null) this.memo = { tip: tipHeight, hash, answers: new Map(), confirmed: 0 };
      this.memoOn = true;
      events = await this.pullAll(tipHeight, finalHeight);
      this.memoOn = false;
      this.nextKept = blocks.tip ? keptFrom(events, upTo, blocks.tip, blocks.deep, this.keptMax) : null;
    }
    // The block hash at the declared tip, read BEFORE the pull (recorded by
    // invalidateCacheOnReorg above) and again AFTER it. Equal non-null hashes mean the block at that height was the
    // same at both reads; a newer tip above it is normal and does not change this hash. A switch away and back
    // entirely inside one pull is not seen here: a residual the clients' own fill replays bound.
    const hashBefore = this.prevTip && this.prevTip.h === tipHeight && !String(this.prevTip.hash).startsWith("!") ? this.prevTip.hash : null;
    let read: unknown = null;
    try { read = await this.getJson<unknown>(`/block-height/${tipHeight}`); } catch (e) { if (this.stops(e)) throw e; read = null; }
    const hashAfter = typeof read === "string" ? read : null;
    const branch = !hashBefore || !hashAfter ? "unread" : hashBefore === hashAfter ? "one" : "moved";
    return { events, tipHeight, anchor: { height: tipHeight, hashBefore, hashAfter, branch } };
  }

  /** The full pull: every proposal of the domain and the attestation list of each one whose window is open (a closed
   *  window's list from attCache). The first scan, any scan that has no kept events to read on from, and the refresh. */
  private async pullAll(tipHeight: number, finalHeight: number): Promise<ChainEvent[]> {
    const props = await this.pullProposals();
    // a window that ended ≥FINALITY blocks below the tip can never gain attestations again
    const closedBelowEpoch = Math.floor(Math.max(0, tipHeight - Scanner.FINALITY) / EPOCH_LEN);
    const isFinal = (rowHeight: unknown, what: string) => !this.verifyInclusion || reqOrd(rowHeight, what) <= finalHeight;

    const events: ChainEvent[] = [];
    for (const p of props) {
      if (!isFinal(p.height, "proposal height")) continue;
      const pe = this.proposeEvent(p, await this.tx(p.txid, p.height));
      events.push(pe);
      const pid = pe.id;

      const closed = pe.expiresEpoch < closedBelowEpoch;
      // the refresh included, so KEPT_REFRESH_SCANS bounds no row of a cached closed window's list
      let aes = closed ? this.attCache.get(pid) : undefined;
      let deferred = false;
      if (!aes) {
        const atts = await this.allAttestations(p.txid);
        aes = [];
        for (const a of atts) {
          if (!isFinal(a.height, "attest height")) { deferred = true; continue; }
          aes.push(this.attestEvent(a, pid, await this.tx(a.txid, a.height)));
        }
        // a list with deferred entries is incomplete, so it must not be frozen as a closed window's list
        if (closed && !deferred) {
          this.attCache.set(pid, aes);
          this.written?.att.push(pid);
          boundCache(this.attCache, 100_000); // bounded eviction (was a full clear = refetch cliff)
        }
      }
      // a cached list can sit above a lower cutoff (the verified tip moved back); keep the prefix. One push per event:
      // spread into push() as call arguments, a list of about 125,000 or more throws (test/scan/scan-long-list.test.ts).
      for (const a of aes) if (!this.verifyInclusion || a.height <= finalHeight) events.push(a);
    }
    return events;
  }
}

/** Which branch one scan read, sampled before and after the pull. `branch` is the one-branch-per-scan
 *  rule every caller reads: "one" when both hashes were read and are equal, "moved" when the block at the declared
 *  tip changed during the pull (the events may mix two branches), "unread" when either hash could not be read. */
export interface ScanAnchor { height: number; hashBefore: string | null; hashAfter: string | null; branch: "one" | "moved" | "unread" }
/** The one-branch rule every caller of `Scanner.scan()` applies before it publishes, reconciles, signs or reads a
 *  balance from the scan: null when the scan read one branch, otherwise why not. "unread" refuses as "moved" does: an
 *  anchor read that failed while the tip block changed would leave a mixed scan looking like a quiet one. Both are
 *  transient; the next scan decides again. */
export function branchRefusal(a: Pick<ScanAnchor, "branch" | "hashAfter"> | null | undefined): string | null {
  if (a?.branch === "one" && a.hashAfter) return null;
  return a?.branch === "moved" ? "the block at the indexer's tip changed during the scan (a reorg)"
    : "the indexer's tip hash could not be read before and after the scan";
}
