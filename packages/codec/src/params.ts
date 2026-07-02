// Compute Substrate consensus constants — frozen, lifted from
// /opt/substrate_miner/src/compute-substrate/src/params/mod.rs. These are NOT tunable;
// they define the chain. Verified against the node's golden vectors.
import { hexToBytes } from "@noble/hashes/utils";

/** CHAIN_ID = "compute-substrate-mainnet". */
export const CHAIN_ID = "compute-substrate-mainnet";

/** sha256(CHAIN_ID) — domain-separation tail in the sighash preimage. */
export const CHAIN_ID_HASH: Uint8Array = hexToBytes("1b17c7b04d05394674ca2c8e24f7433e251a1973cac2000c7b60966546e0b875");

/** Genesis block header hash (the chain's anchor; pin this in the light client). */
export const GENESIS_HASH = "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52";
export const GENESIS_TIME = 1_777_474_800;

/** PoW / difficulty. */
export const TARGET_BLOCK_SECS = 120;
export const INITIAL_BITS = 0x1e00ffff;
export const POW_LIMIT_BITS = 0x1e00ffff;
export const LWMA_WINDOW = 45;
export const LWMA_SOLVETIME_MAX_FACTOR = 12; // max solvetime = 12 × TARGET_BLOCK_SECS = 1440s
export const MAX_FUTURE_DRIFT_SECS = 2 * 60 * 60;
export const MTP_WINDOW = 11;
export const MIN_BLOCK_SPACING_SECS = 60;

/** App layer. */
export const EPOCH_LEN = 30; // blocks per epoch (~1h)

/** Supply / fees (base units; 1 CSD = COIN). */
export const COIN = 100_000_000;
export const INITIAL_REWARD = 50 * COIN;
export const HALVING_INTERVAL = 1_051_200;
export const MAX_HALVINGS = 64;
export const MIN_FEE_PROPOSE = 25_000_000; // 0.25 CSD
export const MIN_FEE_ATTEST = 5_000_000; // 0.05 CSD

/** Consensus tx limits. */
export const MAX_TX_BYTES = 100_000; // 100 KB (node params: MAX_TX_BYTES)
export const MAX_TX_INPUTS = 512;
export const MAX_TX_OUTPUTS = 512;

/** Largest u128 — the node clamps per-block work to u128 and saturating_adds cumulative chainwork. */
export const MAX_U128 = (1n << 128n) - 1n;

/** block_reward(height) — INITIAL_REWARD halved every HALVING_INTERVAL, 0 after MAX_HALVINGS. */
export function blockReward(height: number): number {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  if (halvings >= MAX_HALVINGS) return 0;
  return Math.floor(INITIAL_REWARD / 2 ** halvings);
}

// ── exact-bigint emission (Plan 57 B4). The number `blockReward` above stays for compat; these
// exist because the indexer's analytics discipline is exact BigInt end to end and it (plus
// cairn's netstats) had re-typed this schedule locally. Semantics pinned by test against the
// live chain: emission counts blocks 0..height INCLUSIVE (genesis pays), verified equal to the
// indexer's DB-derived emitted supply (SUM(coinbase) - SUM(fees)) at a live height. ──

/** blockReward, exact base-unit bigint. Non-finite heights yield 0n (the number twin yields NaN;
 *  a bigint cannot, and 0n is the same "no reward" answer emittedSupplyBase gives). */
export function blockRewardBase(height: number): bigint {
  if (!Number.isFinite(height)) return 0n;
  const era = Math.floor(height / HALVING_INTERVAL);
  if (era >= MAX_HALVINGS) return 0n;
  return BigInt(INITIAL_REWARD) >> BigInt(era);
}

/** Total subsidy emitted for blocks 0..height inclusive (exact base units). */
export function emittedSupplyBase(height: number): bigint {
  if (!Number.isFinite(height) || height < 0) return 0n;
  const blocks = BigInt(Math.floor(height)) + 1n; // 0..height inclusive
  const interval = BigInt(HALVING_INTERVAL);
  let s = 0n;
  for (let era = 0n; era < BigInt(MAX_HALVINGS); era++) {
    const eraStart = era * interval;
    if (blocks <= eraStart) break;
    const inEra = blocks - eraStart < interval ? blocks - eraStart : interval;
    s += (BigInt(INITIAL_REWARD) >> era) * inEra;
  }
  return s;
}

/** The asymptotic max supply (all MAX_HALVINGS eras fully emitted), exact base units. */
export function maxSupplyBase(): bigint {
  let s = 0n;
  for (let era = 0n; era < BigInt(MAX_HALVINGS); era++) s += (BigInt(INITIAL_REWARD) >> era) * BigInt(HALVING_INTERVAL);
  return s;
}
