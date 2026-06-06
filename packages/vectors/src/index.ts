// @inversealtruism/csd-vectors — the golden conformance contract.
//
// These fixtures are transcribed verbatim from the Compute Substrate node's frozen test
// suite at /opt/substrate_miner/src/compute-substrate/tests/golden_vectors.rs (the canonical
// source of truth) plus the consensus params. Any @inversealtruism/csd-* codec/crypto/header impl whose
// output diverges from these is wrong. `live.ts` holds additional real on-chain fixtures
// pulled from the node (regenerate with scripts/gen-live-vectors.ts).
//
// Self-contained (no @inversealtruism/csd-codec import) so the dependency graph is a clean DAG: codec
// depends on vectors for its conformance test, never the reverse. VTx is structurally
// identical to @inversealtruism/csd-codec's Tx.
export type VApp =
  | { type: "None" }
  | { type: "Propose"; domain: string; payloadHash: string; uri: string; expiresEpoch: number }
  | { type: "Attest"; proposalId: string; score: number; confidence: number };
export interface VTx {
  version: number;
  inputs: { prevTxid: string; vout: number; scriptSig: string }[];
  outputs: { value: number; scriptPubkey: string }[];
  locktime: number;
  app: VApp;
}

/** A header conformance vector. */
export interface HeaderVector {
  header: { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number };
  expectedConsensusBytes: string; // 0x-hex of serialize_header (84 bytes)
  expectedHeaderHash: string;     // 0x-hex sha256d(serialize_header)
}

/** A transaction conformance vector. */
export interface TxVector {
  tx: VTx;
  expectedConsensusBytes: string; // 0x-hex of bincode(tx) — UNSTRIPPED (as serialize() emits)
  expectedTxid: string;           // 0x-hex sha256d(bincode(stripped_tx))
  expectedSighash: string;        // 0x-hex sha256d(tagged_hash("CSD_SIG_V1", bincode(stripped)‖CHAIN_ID_HASH))
}

// ── golden_vectors.rs ──

export const GOLDEN_HEADER: HeaderVector = {
  header: {
    version: 1,
    prev: "0x" + "01".repeat(32),
    merkle: "0x" + "02".repeat(32),
    time: 1_700_000_000,
    bits: 0x1f00ffff,
    nonce: 0x12345678,
  },
  expectedConsensusBytes:
    "0x010000000101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020200f1536500000000ffff001f78563412",
  expectedHeaderHash: "0x43d20f3acdf747e099025c89abed445c29275d8891b6e8469b3d64543af82b06",
};

export const GOLDEN_TX: TxVector = {
  tx: {
    version: 1,
    inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 3, scriptSig: "0x0102030405" }],
    outputs: [
      { value: 42, scriptPubkey: "0x" + "09".repeat(20) },
      { value: 1000, scriptPubkey: "0x" + "08".repeat(20) },
    ],
    locktime: 0x3939,
    app: { type: "None" },
  },
  expectedConsensusBytes:
    "0x0100000001000000000000000000000000000000000000000000000000000000000000000000000000000000030000000500000000000000010203040502000000000000002a000000000000000909090909090909090909090909090909090909e80300000000000008080808080808080808080808080808080808083939000000000000",
  expectedTxid: "0x876f5cbd6770ce8679730b8ad565ba136fa30bd750ef4f3345b8f7289393dd6b",
  expectedSighash: "0x4a852522eed155b7763f425df1233daa132482e47249696905cdcc775a5113e2",
};

/**
 * Compact `bits` → expected 32-byte big-endian target.
 * NOTE: golden_vectors.rs's frozen EXPECT_POW_LIMIT_TARGET (`0x0000ffff…`) is the target for
 * bits `0x1f00ffff` (the value the golden header also uses) — it predates POW_LIMIT_BITS being
 * changed to `0x1e00ffff` in params/mod.rs, so that one frozen const is stale. The bits→target
 * ALGORITHM is verified correct against 6 real mainnet blocks (powOk 6/6); we pin the correct
 * pairing here.
 */
export const GOLDEN_POW = {
  bits: 0x1f00ffff,
  expectedTargetBE: "0x0000ffff00000000000000000000000000000000000000000000000000000000",
};

/** Genesis anchor (params/mod.rs). */
export const GOLDEN_GENESIS = {
  hash: "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52",
  time: 1_777_474_800,
  bits: 0x1e00ffff,
};

export const HEADER_VECTORS: HeaderVector[] = [GOLDEN_HEADER];
export const TX_VECTORS: TxVector[] = [GOLDEN_TX];

export * from "./live.js";
