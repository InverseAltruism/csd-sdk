// @csd/light — Compute Substrate light client.
//
// Trust model (honest): the PoW header chain is the root of trust. We verify, for every header:
//   1. it links to its parent (prev == headerHash(parent))
//   2. its PoW is valid (sha256d(header) ≤ target(bits))
//   3. its `bits` is exactly what the LWMA mandates (re-derived locally) — so a server can't
//      feed a low-difficulty fork
// and we follow the MAX-CHAINWORK chain. Inclusion is then provable via merkle proofs against a
// verified header. What we CANNOT prove from headers alone: that an output is still UNSPENT
// (no UTXO commitment in the header) — so balances are `rpc-trusted` unless backed by a block
// scan. Every read carries a `trustLevel` saying which it is. (See ROADMAP §honest-limits.)
import {
  type BlockHeader, headerHash, headerHashBytes, powOk, workForBits,
  verifyMerkleProof, merkleBranch, GENESIS_HASH, INITIAL_BITS,
} from "@csd/codec";
import { CsdClient, rpcHeaderToHeader, type RpcTxJson } from "@csd/client";
import { expectedBits } from "./lwma.js";

export { expectedBits } from "./lwma.js";

export type TrustLevel = "verified-inclusion" | "scanned" | "rpc-trusted";

export interface VerifiedHeader { height: number; hash: string; header: BlockHeader; chainwork: bigint }
export interface InclusionResult {
  trustLevel: TrustLevel;
  included: boolean;
  blockHeight?: number;
  confirmations?: number;
  reason?: string;
}

/** A header provider — defaults to a CsdClient, injectable for tests. */
export type HeaderProvider = (height: number) => Promise<{ header: BlockHeader; hash: string; txids: string[] }>;

export interface LightClientOptions {
  client?: CsdClient;
  baseUrl?: string;
  headerProvider?: HeaderProvider;
  /** Pin checkpoints {height: expectedHash} to bound/accelerate sync (optional). */
  checkpoints?: Record<number, string>;
}

export class LightClient {
  private readonly client?: CsdClient;
  private readonly provider: HeaderProvider;
  private readonly checkpoints: Record<number, string>;
  /** Verified header chain, index = height. */
  readonly chain: VerifiedHeader[] = [];

  constructor(opts: LightClientOptions = {}) {
    this.client = opts.client ?? (opts.baseUrl ? new CsdClient({ baseUrl: opts.baseUrl }) : undefined);
    this.checkpoints = opts.checkpoints ?? {};
    this.provider = opts.headerProvider ?? (async (h: number) => {
      if (!this.client) throw new Error("LightClient needs a client/baseUrl or a headerProvider");
      const b = await this.client.blockByHeight(h);
      return { header: rpcHeaderToHeader(b.header), hash: b.hash, txids: b.txs.map((t) => t.txid) };
    });
  }

  get tip(): VerifiedHeader | undefined { return this.chain[this.chain.length - 1]; }
  get chainwork(): bigint { return this.tip?.chainwork ?? 0n; }

  /**
   * Sync + VERIFY headers [from..to] inclusive onto the chain. `from` must be 0 (genesis) or
   * exactly chain.length (contiguous). Throws on any consensus violation. Returns the new tip.
   */
  async sync(to: number, from = this.chain.length): Promise<VerifiedHeader> {
    if (from !== this.chain.length) throw new Error(`non-contiguous sync: have ${this.chain.length}, asked from ${from}`);
    for (let h = from; h <= to; h++) {
      const { header, hash } = await this.provider(h);
      this.ingest(h, header, hash);
    }
    if (!this.tip) throw new Error("sync produced no tip");
    return this.tip;
  }

  /** Verify a single header at the given height and append it (consensus checks). */
  ingest(height: number, header: BlockHeader, claimedHash?: string): VerifiedHeader {
    if (height !== this.chain.length) throw new Error(`out-of-order ingest at ${height} (have ${this.chain.length})`);
    const hash = headerHash(header);
    if (claimedHash && claimedHash.toLowerCase() !== hash.toLowerCase()) throw new Error(`header hash mismatch at ${height}`);

    if (height === 0) {
      if (hash.toLowerCase() !== GENESIS_HASH.toLowerCase()) throw new Error(`foreign genesis: ${hash}`);
      if (header.bits !== INITIAL_BITS) throw new Error("genesis bits != INITIAL_BITS");
    } else {
      const parent = this.chain[height - 1]!;
      if (header.prev.toLowerCase() !== parent.hash.toLowerCase()) throw new Error(`broken prev link at ${height}`);
      const exp = expectedBits(this.chain.map((c) => c.header), height);
      if (header.bits !== exp) throw new Error(`bad bits at ${height}: header ${header.bits.toString(16)} != LWMA ${exp.toString(16)}`);
    }
    if (!powOk(headerHashBytes(header), header.bits)) throw new Error(`invalid PoW at ${height}`);

    const cp = this.checkpoints[height];
    if (cp && cp.toLowerCase() !== hash.toLowerCase()) throw new Error(`checkpoint mismatch at ${height}`);

    const chainwork = (this.chain[height - 1]?.chainwork ?? 0n) + workForBits(header.bits);
    const vh: VerifiedHeader = { height, hash, header, chainwork };
    this.chain.push(vh);
    return vh;
  }

  /** Verify a tx's inclusion against a verified header (merkle proof built from the block). */
  async verifyTxInclusion(txidHex: string): Promise<InclusionResult> {
    if (!this.client) return { trustLevel: "rpc-trusted", included: false, reason: "no client for proof fetch" };
    const t = await this.client.tx(txidHex);
    if (!t.ok || t.height == null) return { trustLevel: "rpc-trusted", included: false, reason: "tx not in a block (mempool/unknown)" };
    const height = t.height;
    if (height >= this.chain.length) {
      const gap = height - this.chain.length + 1;
      if (gap > 256) return { trustLevel: "rpc-trusted", included: false, reason: `tx at height ${height} is ${gap} blocks beyond the synced tip — call sync(${height}) first` };
      await this.sync(height); // small contiguous extend
    }
    const verified = this.chain[height];
    if (!verified) return { trustLevel: "rpc-trusted", included: false, reason: "could not verify the containing header" };
    // build the merkle branch from the block's ordered tx list and fold it to the VERIFIED root
    const b = await this.client.blockByHeight(height);
    const txids = b.txs.map((x) => x.txid);
    const pos = txids.findIndex((x) => x.toLowerCase() === txidHex.toLowerCase());
    if (pos < 0) return { trustLevel: "rpc-trusted", included: false, reason: "tx not listed in block" };
    const branch = merkleBranch(txids, pos);
    const ok = verifyMerkleProof(txidHex, pos, branch, verified.header.merkle);
    if (!ok) return { trustLevel: "rpc-trusted", included: false, reason: "merkle proof failed" };
    return { trustLevel: "verified-inclusion", included: true, blockHeight: height, confirmations: this.chain.length - height };
  }

  /**
   * Balance for an address. HONEST: this is `rpc-trusted` — a header chain cannot prove an output
   * is still unspent (no UTXO commitment). A future `scanBalance` will derive it from a Neutrino-
   * style block scan (`trustLevel: 'scanned'`). Surfaced, never hidden.
   */
  async balance(addr: string): Promise<{ confirmed: number; trustLevel: TrustLevel; note: string }> {
    if (!this.client) throw new Error("no client");
    const u = await this.client.utxos(addr);
    return { confirmed: u.confirmed_balance, trustLevel: "rpc-trusted", note: "balance is RPC-trusted; a header chain cannot prove non-spend (no UTXO commitment)" };
  }
}

export { CsdClient, rpcHeaderToHeader } from "@csd/client";
export type { RpcTxJson };
