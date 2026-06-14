// @inversealtruism/csd-light — Compute Substrate light client.
//
// Trust model (honest): the PoW header chain is the root of trust. We verify, for every header:
//   1. it links to its parent (prev == headerHash(parent))
//   2. its PoW is valid (sha256d(header) ≤ target(bits))
//   3. its `bits` is exactly what the LWMA mandates (re-derived locally from the window) — so a
//      server cannot feed a low-difficulty fork
// and we follow the MAX-CHAINWORK chain (reorg-aware: a higher-work branch replaces ours). What
// we CANNOT prove from headers alone: that an output is still UNSPENT (no UTXO commitment in the
// header) — so balances are `rpc-trusted` unless backed by a block scan. Every read carries a
// `trustLevel`. (See ROADMAP §honest-limits.)
//
// Two start modes:
//   • sync(to)                 — full verification from GENESIS (chainwork is absolute).
//   • syncFromCheckpoint(...)  — seed a TRUSTED header window at a pinned checkpoint, then verify
//                                forward (practical: no 27k-block genesis fetch). chainwork is
//                                relative to the checkpoint; the seed is trusted, not re-verified.
import {
  type BlockHeader, headerHash, headerHashBytes, powOk, workForBits,
  verifyMerkleProof, merkleBranch, GENESIS_HASH, INITIAL_BITS, LWMA_WINDOW, MAX_U128,
} from "@inversealtruism/csd-codec";
import { CsdClient, rpcHeaderToHeader, type RpcTxJson } from "@inversealtruism/csd-client";
import { expectedBitsFromWindow } from "./lwma.js";

export { expectedBits, expectedBitsFromWindow } from "./lwma.js";

/** Cumulative chainwork add, saturating at u128 — matches the node's `chainwork.saturating_add` (A-S4). */
const satAddWork = (a: bigint, bits: number): bigint => { const s = a + workForBits(bits); return s > MAX_U128 ? MAX_U128 : s; };

export type TrustLevel = "verified-inclusion" | "scanned" | "rpc-trusted";

export interface VerifiedHeader { height: number; hash: string; header: BlockHeader; chainwork: bigint; trusted?: boolean }
export interface InclusionResult { trustLevel: TrustLevel; included: boolean; blockHeight?: number; confirmations?: number; reason?: string }
export interface ReorgResult { adopted: boolean; rolledBack?: number; newTip?: number; reason?: string }

export type HeaderProvider = (height: number) => Promise<{ header: BlockHeader; hash: string; txids: string[] }>;

export type HeadersBatchProvider = (from: number, count: number) => Promise<{ header: BlockHeader; hash: string }[]>;

export interface LightClientOptions {
  client?: CsdClient;
  baseUrl?: string;
  headerProvider?: HeaderProvider;
  /** Optional BATCH header source (e.g. an indexer /headers/{from}/{count} endpoint): sync()
   *  prefers it, collapsing per-height full-block fetches into a few header-only requests. */
  headersBatchProvider?: HeadersBatchProvider;
  /** Pin checkpoints {height: expectedHash}: any header at a pinned height — whether synced forward,
   *  seeded, or restored from a snapshot — must match, else it's rejected (optional trust anchor). */
  checkpoints?: Record<number, string>;
}

export class LightClient {
  private readonly client?: CsdClient;
  private readonly provider: HeaderProvider;
  private readonly checkpoints: Record<number, string>;
  /** Verified header chain. chain[i].height = baseHeight + i. */
  readonly chain: VerifiedHeader[] = [];
  /** Height of chain[0] — 0 for genesis-start, the seed start for checkpoint-start. */
  baseHeight = 0;

  private readonly batch?: HeadersBatchProvider;

  constructor(opts: LightClientOptions = {}) {
    this.client = opts.client ?? (opts.baseUrl ? new CsdClient({ baseUrl: opts.baseUrl }) : undefined);
    this.batch = opts.headersBatchProvider;
    this.checkpoints = opts.checkpoints ?? {};
    this.provider = opts.headerProvider ?? (async (h: number) => {
      if (!this.client) throw new Error("LightClient needs a client/baseUrl or a headerProvider");
      const b = await this.client.blockByHeight(h);
      return { header: rpcHeaderToHeader(b.header), hash: b.hash, txids: b.txs.map((t) => t.txid) };
    });
  }

  get tip(): VerifiedHeader | undefined { return this.chain[this.chain.length - 1]; }
  get chainwork(): bigint { return this.tip?.chainwork ?? 0n; }
  /** Whether every header back to genesis was verified (vs trusted from a checkpoint). */
  get fullyVerified(): boolean { return this.baseHeight === 0; }
  private at(height: number): VerifiedHeader | undefined { return this.chain[height - this.baseHeight]; }
  /** The chronological LWMA window (≤ LWMA_WINDOW headers) immediately preceding `height`. */
  private windowBefore(height: number): BlockHeader[] {
    const startIdx = Math.max(0, height - this.baseHeight - LWMA_WINDOW);
    const endIdx = height - this.baseHeight; // exclusive
    return this.chain.slice(startIdx, endIdx).map((c) => c.header);
  }
  /** Enforce a pinned checkpoint hash, if one is configured for this height (the only trust anchor). */
  private pinCheckpoint(height: number, hash: string): void {
    const cp = this.checkpoints[height];
    if (cp && cp.toLowerCase() !== hash.toLowerCase()) throw new Error(`checkpoint mismatch at ${height}`);
  }

  /** Sync + VERIFY headers [from..to] from genesis (or contiguous to the current tip). */
  async sync(to: number, from = this.baseHeight + this.chain.length): Promise<VerifiedHeader> {
    if (from !== this.baseHeight + this.chain.length) throw new Error(`non-contiguous sync: tip ${this.baseHeight + this.chain.length - 1}, asked from ${from}`);
    if (this.batch) {
      for (let h = from; h <= to; ) {
        const want = Math.min(512, to - h + 1);
        const rows = await this.batch(h, want);
        if (!rows.length) throw new Error(`batch provider returned no headers at ${h}`);
        for (const r of rows.slice(0, want)) { this.ingest(h, r.header, r.hash); h++; }
      }
    } else {
      for (let h = from; h <= to; h++) { const { header, hash } = await this.provider(h); this.ingest(h, header, hash); }
    }
    if (!this.tip) throw new Error("sync produced no tip");
    return this.tip;
  }

  /** Verify a single header at `height` and append it (full consensus checks). */
  ingest(height: number, header: BlockHeader, claimedHash?: string): VerifiedHeader {
    if (height !== this.baseHeight + this.chain.length) throw new Error(`out-of-order ingest at ${height} (tip ${this.baseHeight + this.chain.length - 1})`);
    const vh = this.verifyOne(height, header, this.windowBefore(height), this.at(height - 1), claimedHash);
    this.chain.push(vh);
    return vh;
  }

  /** Pure verification of one header against a window + parent (no mutation). */
  private verifyOne(height: number, header: BlockHeader, window: BlockHeader[], parent: VerifiedHeader | undefined, claimedHash?: string): VerifiedHeader {
    const hash = headerHash(header);
    if (claimedHash && claimedHash.toLowerCase() !== hash.toLowerCase()) throw new Error(`header hash mismatch at ${height}`);
    if (height === 0) {
      if (hash.toLowerCase() !== GENESIS_HASH.toLowerCase()) throw new Error(`foreign genesis: ${hash}`);
      if (header.bits !== INITIAL_BITS) throw new Error("genesis bits != INITIAL_BITS");
    } else {
      if (!parent) throw new Error(`no parent context for height ${height}`);
      if (header.prev.toLowerCase() !== parent.hash.toLowerCase()) throw new Error(`broken prev link at ${height}`);
      const exp = expectedBitsFromWindow(window, height);
      if (header.bits !== exp) throw new Error(`bad bits at ${height}: header ${header.bits.toString(16)} != LWMA ${exp.toString(16)}`);
    }
    if (!powOk(headerHashBytes(header), header.bits)) throw new Error(`invalid PoW at ${height}`);
    this.pinCheckpoint(height, hash);
    return { height, hash, header, chainwork: satAddWork(parent?.chainwork ?? 0n, header.bits) };
  }

  /**
   * Seed a TRUSTED, contiguous header run ending at a pinned checkpoint, so forward sync needs
   * only a small window — not a 27k-block genesis fetch. The seed is the trust anchor (PoW links
   * are still spot-checked, but seed bits aren't LWMA-re-derived; that's the explicit trade for
   * not syncing from genesis). chainwork becomes RELATIVE to the seed. `checkpointHash` MUST match
   * the last seeded header.
   */
  seedTrusted(seed: { height: number; header: BlockHeader; hash?: string }[], checkpointHash: string): void {
    if (this.chain.length) throw new Error("seedTrusted must be called on a fresh client");
    if (!seed.length) throw new Error("empty seed");
    this.baseHeight = seed[0]!.height;
    let prevHash: string | null = null;
    for (let i = 0; i < seed.length; i++) {
      const s = seed[i]!;
      if (s.height !== this.baseHeight + i) throw new Error("seed not contiguous");
      const hash = headerHash(s.header);
      if (s.hash && s.hash.toLowerCase() !== hash.toLowerCase()) throw new Error(`seed header hash mismatch at ${s.height}`);
      if (prevHash && s.header.prev.toLowerCase() !== prevHash.toLowerCase()) throw new Error(`seed prev link broken at ${s.height}`);
      // seed bits are trusted, but PoW must still hold (cheap, catches a garbage seed)
      if (!powOk(headerHashBytes(s.header), s.header.bits)) throw new Error(`seed PoW invalid at ${s.height}`);
      this.pinCheckpoint(s.height, hash); // honour any pinned hash inside the seed window
      this.chain.push({ height: s.height, hash, header: s.header, chainwork: satAddWork(this.chain[i - 1]?.chainwork ?? 0n, s.header.bits), trusted: true });
      prevHash = hash;
    }
    if (this.tip!.hash.toLowerCase() !== checkpointHash.toLowerCase()) throw new Error(`checkpoint hash mismatch: seeded tip ${this.tip!.hash} != ${checkpointHash}`);
  }

  /** Fetch + seed the LWMA window ending at `checkpointHeight`, asserting its hash, then ready to sync forward. */
  async syncFromCheckpoint(checkpointHeight: number, checkpointHash: string, context = LWMA_WINDOW): Promise<void> {
    const start = Math.max(0, checkpointHeight - context);
    const seed: { height: number; header: BlockHeader; hash: string }[] = [];
    for (let h = start; h <= checkpointHeight; h++) { const { header, hash } = await this.provider(h); seed.push({ height: h, header, hash }); }
    this.seedTrusted(seed, checkpointHash);
  }

  /**
   * Offer a competing branch (contiguous headers starting one above a common ancestor we hold).
   * Verifies it from the ancestor; if its cumulative chainwork EXCEEDS our current tip, we roll
   * back to the ancestor and adopt it (max-work rule). Otherwise we keep our chain.
   */
  tryReorg(alt: { height: number; header: BlockHeader; hash?: string }[]): ReorgResult {
    if (!alt.length) return { adopted: false, reason: "empty branch" };
    const ancestorHeight = alt[0]!.height - 1;
    const ancestor = this.at(ancestorHeight);
    if (!ancestor) return { adopted: false, reason: `no common ancestor at ${ancestorHeight}` };
    // verify the alt branch off the ancestor, accumulating its own window
    const verified: VerifiedHeader[] = [];
    let prev = ancestor;
    const baseWindow = this.windowBefore(ancestorHeight + 1); // window for the first alt block
    const window = [...baseWindow];
    for (let i = 0; i < alt.length; i++) {
      const a = alt[i]!;
      if (a.height !== ancestorHeight + 1 + i) return { adopted: false, reason: "alt not contiguous" };
      let vh: VerifiedHeader;
      try { vh = this.verifyOne(a.height, a.header, window, prev, a.hash); }
      catch (e: any) { return { adopted: false, reason: `alt invalid at ${a.height}: ${e?.message}` }; }
      verified.push(vh); prev = vh;
      window.push(a.header); if (window.length > LWMA_WINDOW) window.shift();
    }
    const altTip = verified[verified.length - 1]!;
    if (altTip.chainwork <= this.chainwork) return { adopted: false, reason: `alt work ${altTip.chainwork} ≤ current ${this.chainwork}` };
    // adopt: truncate to ancestor, append the verified alt branch
    const rolledBack = (this.baseHeight + this.chain.length) - 1 - ancestorHeight;
    this.chain.length = ancestorHeight - this.baseHeight + 1;
    for (const v of verified) this.chain.push(v);
    return { adopted: true, rolledBack, newTip: altTip.height };
  }

  /** Verify a tx's inclusion against a verified header (merkle proof built from the block). */
  async verifyTxInclusion(txidHex: string): Promise<InclusionResult> {
    if (!this.client) return { trustLevel: "rpc-trusted", included: false, reason: "no client for proof fetch" };
    const t = await this.client.tx(txidHex);
    if (!t.ok || t.height == null) return { trustLevel: "rpc-trusted", included: false, reason: "tx not in a block (mempool/unknown)" };
    const height = t.height;
    let tipHeight = this.baseHeight + this.chain.length - 1;
    if (height < this.baseHeight) return { trustLevel: "rpc-trusted", included: false, reason: `tx below the synced base (${this.baseHeight})` };
    if (height > tipHeight) {
      const gap = height - tipHeight;
      if (gap > 256) return { trustLevel: "rpc-trusted", included: false, reason: `tx at ${height} is ${gap} blocks beyond tip — sync(${height}) first` };
      await this.sync(height);
      // sync() advanced the tip — recompute it, else `confirmations` below uses the STALE pre-sync
      // tip and under-reports (≤0) the depth of a tx that is actually at depth ≥1.
      tipHeight = this.baseHeight + this.chain.length - 1;
    }
    const verified = this.at(height);
    if (!verified) return { trustLevel: "rpc-trusted", included: false, reason: "could not verify the containing header" };
    const b = await this.client.blockByHeight(height);
    const txids = b.txs.map((x) => x.txid);
    const pos = txids.findIndex((x) => x.toLowerCase() === txidHex.toLowerCase());
    if (pos < 0) return { trustLevel: "rpc-trusted", included: false, reason: "tx not listed in block" };
    const ok = verifyMerkleProof(txidHex, pos, merkleBranch(txids, pos), verified.header.merkle);
    if (!ok) return { trustLevel: "rpc-trusted", included: false, reason: "merkle proof failed" };
    return { trustLevel: "verified-inclusion", included: true, blockHeight: height, confirmations: tipHeight - height + 1 };
  }

  /**
   * Balance for an address. HONEST: `rpc-trusted` — a header chain cannot prove an output is still
   * unspent (no UTXO commitment). A future Neutrino-style scan would yield `trustLevel:'scanned'`.
   */
  async balance(addr: string): Promise<{ confirmed: number; trustLevel: TrustLevel; note: string }> {
    if (!this.client) throw new Error("no client");
    const u = await this.client.utxos(addr);
    return { confirmed: u.confirmed_balance, trustLevel: "rpc-trusted", note: "balance is RPC-trusted; a header chain cannot prove non-spend (no UTXO commitment)" };
  }

  /**
   * Serialize the verified chain for persistence. A long-lived consumer (wallet, bridge differ)
   * snapshots on shutdown and `fromSnapshot`s on boot instead of re-fetching FULL BLOCK BODIES
   * for the whole window every restart (the default provider's per-header cost). Headers only —
   * tiny (≈100 bytes/height as JSON).
   */
  toSnapshot(): ChainSnapshot {
    return {
      v: 1, baseHeight: this.baseHeight,
      headers: this.chain.map((c) => ({ height: c.height, hash: c.hash, header: c.header, chainwork: c.chainwork.toString(), trusted: c.trusted ?? false })),
    };
  }

  /**
   * Restore from a snapshot. The load RE-VERIFIES — hash recomputation, prev links, PoW on every
   * header, AND `bits` re-derived from the LWMA window for every NON-trusted (forward-synced)
   * header, exactly as the live `sync`/`verifyOne` path accepted it. Only the original seed window
   * (`trusted`) skips LWMA — the same posture `seedTrusted` allows for the checkpoint trade — but a
   * snapshot cannot smuggle trust past the pinned checkpoint hash: if `checkpoints` is configured,
   * any restored header at a pinned height must match. So a localStorage-poisoned snapshot that
   * inserts a min-difficulty (POW_LIMIT) header is REJECTED here, not restored as verified.
   * chainwork is recomputed, never read from the file.
   */
  static fromSnapshot(s: ChainSnapshot, opts: LightClientOptions = {}): LightClient {
    if (s.v !== 1 || !Array.isArray(s.headers) || !s.headers.length) throw new Error("bad snapshot");
    const lc = new LightClient(opts);
    lc.baseHeight = s.baseHeight;
    let prevHash: string | null = null;
    let work = 0n;
    for (let i = 0; i < s.headers.length; i++) {
      const e = s.headers[i]!;
      if (e.height !== s.baseHeight + i) throw new Error(`snapshot not contiguous at ${e.height}`);
      const hash = headerHash(e.header);
      if (hash.toLowerCase() !== e.hash.toLowerCase()) throw new Error(`snapshot hash mismatch at ${e.height}`);
      if (prevHash && e.header.prev.toLowerCase() !== prevHash) throw new Error(`snapshot prev link broken at ${e.height}`);
      if (!powOk(headerHashBytes(e.header), e.header.bits)) throw new Error(`snapshot PoW invalid at ${e.height}`);
      // NON-trusted (forward-synced) headers must satisfy the LWMA the live path enforced — else a
      // poisoned snapshot could restore a low-difficulty chain whose PoW alone trivially passes.
      if (!e.trusted && e.height > 0) {
        const exp = expectedBitsFromWindow(lc.windowBefore(e.height), e.height);
        if (e.header.bits !== exp) throw new Error(`snapshot bad bits at ${e.height}: ${e.header.bits.toString(16)} != LWMA ${exp.toString(16)}`);
      }
      lc.pinCheckpoint(e.height, hash); // the baked checkpoint hash is the one true anchor
      work = satAddWork(work, e.header.bits);
      lc.chain.push({ height: e.height, hash, header: e.header, chainwork: work, ...(e.trusted ? { trusted: true } : {}) });
      prevHash = hash.toLowerCase();
    }
    return lc;
  }
}

export interface ChainSnapshot {
  v: 1; baseHeight: number;
  headers: { height: number; hash: string; header: BlockHeader; chainwork: string; trusted: boolean }[];
}

export { CsdClient, rpcHeaderToHeader } from "@inversealtruism/csd-client";
export type { RpcTxJson };
