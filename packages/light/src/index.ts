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
  MTP_WINDOW, MIN_BLOCK_SPACING_SECS, MAX_FUTURE_DRIFT_SECS,
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
   *  AND syncFromCheckpoint prefer it, collapsing per-height full-block fetches into a few
   *  header-only requests. Carries zero trust either way (every row is PoW/LWMA-verified).
   *  Failure policy differs by call: syncFromCheckpoint DEGRADES to the per-height source when
   *  the batch source throws or returns an empty page (one-shot cold start, no self-heal), while
   *  sync() still hard-fails (incremental callers re-poll, so a failed tick heals itself). */
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
  /** Whether a real per-height source exists (vs the default provider that can only throw). */
  private readonly hasHeaderSource: boolean;

  constructor(opts: LightClientOptions = {}) {
    this.client = opts.client ?? (opts.baseUrl ? new CsdClient({ baseUrl: opts.baseUrl }) : undefined);
    this.batch = opts.headersBatchProvider;
    this.hasHeaderSource = !!(opts.headerProvider ?? this.client);
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
      // Timestamp consensus rules (H3) — mirror chain/index.rs (min-spacing, MTP, future-drift) so a
      // crafted-timestamp fork cannot steer the LWMA difficulty down. Enforced BEFORE bits/PoW, as the node does.
      this.checkTimeRules(height, header, window, parent);
      const exp = expectedBitsFromWindow(window, height);
      if (header.bits !== exp) throw new Error(`bad bits at ${height}: header ${header.bits.toString(16)} != LWMA ${exp.toString(16)}`);
    }
    if (!powOk(headerHashBytes(header), header.bits)) throw new Error(`invalid PoW at ${height}`);
    this.pinCheckpoint(height, hash);
    return { height, hash, header, chainwork: satAddWork(parent?.chainwork ?? 0n, header.bits) };
  }

  /**
   * Timestamp consensus rules (H3), a faithful port of chain/index.rs + chain/time.rs:
   *   • min spacing:  time ≥ parent.time + MIN_BLOCK_SPACING_SECS
   *   • MTP:          time > median of the last MTP_WINDOW header times ending at parent (inclusive)
   *   • future drift: time ≤ now() + MAX_FUTURE_DRIFT_SECS   (wall-clock, as the node does)
   * `window` is the chronological run preceding `height`; its last element IS the parent, so its
   * tail of MTP_WINDOW headers is exactly the node's MTP walk. Without these, an attacker could grind
   * timestamps to drive the LWMA toward POW_LIMIT.
   *
   * Edge (safe-direction): right after a checkpoint seed shorter than MTP_WINDOW, the available window
   * can be shorter than the node's full MTP walk (which would reach below baseHeight). A truncated
   * median over ascending times is ≥ the node's, so the `time > mtp` gate is only ever STRICTER here —
   * it can reject a header the node accepts, never accept one the node rejects. The standard API
   * (`syncFromCheckpoint`, context = LWMA_WINDOW = 45 ≥ MTP_WINDOW) always supplies a full window.
   */
  private checkTimeRules(height: number, header: BlockHeader, window: BlockHeader[], parent: VerifiedHeader): void {
    const time = Number(header.time);
    const minAllowed = Number(parent.header.time) + MIN_BLOCK_SPACING_SECS;
    if (time < minAllowed) throw new Error(`time too early at ${height}: ${time} < parent+${MIN_BLOCK_SPACING_SECS} (${minAllowed})`);
    const recent = window.slice(Math.max(0, window.length - MTP_WINDOW)).map((h) => Number(h.time)).sort((a, b) => a - b);
    const mtp = recent.length ? recent[Math.floor(recent.length / 2)]! : 0;
    if (time <= mtp) throw new Error(`time <= MTP at ${height}: ${time} <= ${mtp}`);
    const maxAllowed = Math.floor(Date.now() / 1000) + MAX_FUTURE_DRIFT_SECS;
    if (time > maxAllowed) throw new Error(`time too far in future at ${height}: ${time} > now+${MAX_FUTURE_DRIFT_SECS}`);
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
    let seed: { height: number; header: BlockHeader; hash: string }[] = [];
    // Prefer the batch source exactly like sync() does (Plan 56 A.3 finding 6: the common
    // cold-start path was paying the per-height full-block cost the batch hook exists to remove).
    // Same trust as the per-height provider: seedTrusted still checks PoW + prev links + pinned
    // checkpoints, and the final checkpoint-hash assert anchors the whole window.
    // Fail-SOFT on batch-source unavailability (Plan 57 R1): a configured-but-failing batch
    // source (origin outage, 429 storm, empty page) degrades the COLD START to the per-height
    // provider instead of hard-failing it. Only the FETCH is guarded: a tampered seed still
    // fails closed inside seedTrusted whichever source produced it, so the fallback trades zero
    // trust for availability. A partial batch window is discarded and re-fetched whole. Cost is
    // bounded to the pre-batch baseline (the per-height loop aborts on its FIRST failure, so a
    // total-origin outage costs one batch attempt plus one per-height attempt, then fails
    // closed). A batch-ONLY client (no per-height source) keeps the hard fail: surfacing the
    // real batch error beats a misleading "needs a client/baseUrl" from the default provider.
    if (this.batch) {
      try {
        for (let h = start; h <= checkpointHeight; ) {
          const want = Math.min(512, checkpointHeight - h + 1);
          const rows = await this.batch(h, want);
          if (!rows.length) throw new Error(`batch provider returned no headers at ${h}`);
          for (const r of rows.slice(0, want)) { seed.push({ height: h, header: r.header, hash: r.hash }); h++; }
        }
      } catch (e) {
        if (!this.hasHeaderSource) throw e;
        seed = [];
      }
    }
    if (!seed.length) {
      for (let h = start; h <= checkpointHeight; h++) { const { header, hash } = await this.provider(h); seed.push({ height: h, header, hash }); }
    }
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
   * Restore from a snapshot. The load RE-VERIFIES — hash recomputation, prev links, timestamp
   * rules, PoW on every header, AND `bits` re-derived from the LWMA window for every NON-trusted
   * (forward-synced) header, exactly as the live `sync`/`verifyOne` path accepted it. Only the
   * original seed window (`trusted`) skips the time/LWMA re-derivation — the same posture
   * `seedTrusted` allows for the checkpoint trade. A checkpoint-configured client additionally
   * refuses any snapshot (other than a genesis-rooted one, anchored by H4 below) that does not
   * CONTAIN its lowest pinned checkpoint: the per-header pin can only assert the baked hash when
   * the pinned height is inside the restored range, so without the containment rule a poisoned
   * snapshot rooted ABOVE the checkpoint would carry no anchor at all and its `trusted` seed
   * prefix would be honoured at face value (grindable at POW_LIMIT). So a localStorage-poisoned
   * snapshot is REJECTED here, not restored as verified. chainwork is recomputed, never read
   * from the file.
   */
  static fromSnapshot(s: ChainSnapshot, opts: LightClientOptions = {}): LightClient {
    if (s.v !== 1 || !Array.isArray(s.headers) || !s.headers.length) throw new Error("bad snapshot");
    const lc = new LightClient(opts);
    // Anchor containment (C1): a snapshot for a checkpoint-configured client must span its lowest
    // pinned checkpoint, or the in-loop pinCheckpoint never fires and nothing ties the restored
    // chain to the baked trust root. Genesis-rooted snapshots (baseHeight 0) are exempt: they are
    // anchored by the GENESIS_HASH check instead and may legitimately end below a checkpoint.
    // On rejection the caller discards the snapshot and cold-starts via syncFromCheckpoint.
    const pinnedHeights = Object.keys(lc.checkpoints).map(Number);
    if (pinnedHeights.length && s.baseHeight > 0) {
      const cpMin = Math.min(...pinnedHeights);
      const last = s.baseHeight + s.headers.length - 1;
      if (s.baseHeight > cpMin || last < cpMin) {
        throw new Error(`snapshot not anchored: range [${s.baseHeight}..${last}] does not contain checkpoint ${cpMin}`);
      }
    }
    lc.baseHeight = s.baseHeight;
    let prevHash: string | null = null;
    let work = 0n;
    for (let i = 0; i < s.headers.length; i++) {
      const e = s.headers[i]!;
      if (e.height !== s.baseHeight + i) throw new Error(`snapshot not contiguous at ${e.height}`);
      const hash = headerHash(e.header);
      if (hash.toLowerCase() !== e.hash.toLowerCase()) throw new Error(`snapshot hash mismatch at ${e.height}`);
      // A genesis-rooted snapshot MUST start at the real genesis (H4): otherwise a poisoned file could
      // present a fabricated low-difficulty "genesis" and a forged forward chain.
      if (i === 0 && s.baseHeight === 0) {
        if (hash.toLowerCase() !== GENESIS_HASH.toLowerCase()) throw new Error(`snapshot foreign genesis: ${hash}`);
        if (e.header.bits !== INITIAL_BITS) throw new Error("snapshot genesis bits != INITIAL_BITS");
      }
      if (prevHash && e.header.prev.toLowerCase() !== prevHash) throw new Error(`snapshot prev link broken at ${e.height}`);
      // Timestamp + LWMA rules must be re-derived for every header whose FULL preceding window is
      // present in the snapshot, REGARDLESS of the attacker-controllable `trusted` flag (H4).
      // Trust-skip is honoured ONLY for the genuine seed prefix (the first LWMA_WINDOW headers,
      // whose window extends below baseHeight and so cannot be re-derived) — exactly the run
      // seedTrusted legitimately trusts. Check order mirrors verifyOne (time BEFORE bits BEFORE
      // PoW, as the node does). The H3 time rules are deterministic for min-spacing/MTP and the
      // wall-clock future-drift bound only loosens as time passes, so an honestly-synced snapshot
      // can never regress on restore.
      const fullWindowAvailable = e.height - s.baseHeight >= LWMA_WINDOW;
      if (e.height > 0 && (!e.trusted || fullWindowAvailable)) {
        const window = lc.windowBefore(e.height);
        const parent = lc.chain[i - 1];
        if (parent) lc.checkTimeRules(e.height, e.header, window, parent);
        const exp = expectedBitsFromWindow(window, e.height);
        if (e.header.bits !== exp) throw new Error(`snapshot bad bits at ${e.height}: ${e.header.bits.toString(16)} != LWMA ${exp.toString(16)}`);
      }
      if (!powOk(headerHashBytes(e.header), e.header.bits)) throw new Error(`snapshot PoW invalid at ${e.height}`);
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
