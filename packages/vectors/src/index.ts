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
 * This is the REAL consensus pow limit (`POW_LIMIT_BITS = 0x1e00ffff` in params/mod.rs and the Rust
 * node). An earlier version of this fixture pinned `0x1f00ffff` (target `0x0000ffff…`) — a difficulty
 * the node REJECTS as beyond the pow limit (`bits_within_pow_limit(0x1f00ffff) == false`, verified
 * against the live `csd` oracle), which masked the NEW-1 PoW-limit-gate finding. Corrected to the
 * actual limit; `GOLDEN_HEADER` keeps `0x1f00ffff` deliberately because it is a frozen cross-impl
 * *serialization* anchor (header hashing is independent of pow validity).
 */
export const GOLDEN_POW = {
  bits: 0x1e00ffff,
  expectedTargetBE: "0x000000ffff000000000000000000000000000000000000000000000000000000",
  // an easier-than-limit value the node rejects (drives the NEW-1 regression in codec.test.ts)
  beyondLimitBits: 0x1f00ffff,
};

/** Genesis anchor (params/mod.rs). */
export const GOLDEN_GENESIS = {
  hash: "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52",
  time: 1_777_474_800,
  bits: 0x1e00ffff,
};

// ── real mainnet app transactions ──
// golden_vectors.rs freezes only an `AppPayload::None` tx, so the Propose and Attest encodings are
// pinned with real mined transactions instead. Each is anchored outside this SDK twice: the txid is
// the node's (GET /tx/:id), and the signature in scriptSig, which the node verified, verifies
// against expectedSighash (asserted in csd-crypto's test).

/** A cairnx:v1 fclaim Propose, mined at 65,507. */
export const GOLDEN_PROPOSE_TX: TxVector = {
  tx: {
    version: 1,
    inputs: [{
      prevTxid: "0xa11cb429f9a2fad0f6707dfdce07977721fddab845405d67b211499e9de9547a", vout: 0,
      scriptSig: "0x40560c786b3fbbbb3ca566e586fc5b5cfaf78853fd55618ccebc1c9c5bd929b3225fbd6525c03919ebb289e5cb4a5abbb5d4e7ce79db6432de795acea25a5c1c6c21038e2468cae294322e242d476f20b581cd06def39782a4e76a12139b150338a35d",
    }],
    outputs: [{ value: 14_875_000_000, scriptPubkey: "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec" }],
    locktime: 0,
    app: {
      type: "Propose",
      domain: "cairnx:v1",
      payloadHash: "0x2a6e602b13fbf986187b1dec962193513ca0213794d7990d558a0fd4ae2bafda",
      uri: "{\"offer\":\"0xa11cb429f9a2fad0f6707dfdce07977721fddab845405d67b211499e9de9547a\",\"t\":\"fclaim\",\"v\":1}",
      expiresEpoch: 2184,
    },
  },
  expectedConsensusBytes:
    "0x010000000100000000000000a11cb429f9a2fad0f6707dfdce07977721fddab845405d67b211499e9de9547a00000000630000000000000040560c786b3fbbbb3ca566e586fc5b5cfaf78853fd55618ccebc1c9c5bd929b3225fbd6525c03919ebb289e5cb4a5abbb5d4e7ce79db6432de795acea25a5c1c6c21038e2468cae294322e242d476f20b581cd06def39782a4e76a12139b150338a35d0100000000000000c07c9e760300000044d92872a5b65d37d60ed532f41efe7c5aed59ec00000000010000000900000000000000636169726e783a76312a6e602b13fbf986187b1dec962193513ca0213794d7990d558a0fd4ae2bafda61000000000000007b226f66666572223a22307861313163623432396639613266616430663637303764666463653037393737373231666464616238343534303564363762323131343939653964653935343761222c2274223a2266636c61696d222c2276223a317d8808000000000000",
  expectedTxid: "0x43e9c34f7c8cead5808ada276835946a9307236c53fe9b932c17219a51c6d2c6",
  expectedSighash: "0xf01234520e8350bf6954b63465373e2e3dee213eea80cec3138451fcababa33b",
};

/** A cairnx:v1 token-priced fill Attest, mined at 104,675. Score (100) and confidence (1,000,000)
 *  differ, so a swapped field order cannot round-trip to the same bytes; the input spends vout 2. */
export const GOLDEN_ATTEST_TX: TxVector = {
  tx: {
    version: 1,
    inputs: [{
      prevTxid: "0x91f7346ba9931c827fb409eabe037b20270fbd2b0292bc9224b641164f10f1a6", vout: 2,
      scriptSig: "0x4094752a03d06beec06986ab3ed665a9d382d0e5cfe712e21f119401b4c877cda97430870516166cb7942b63363178c595e3f927ffa2e94e242109da10765af9f8210253148f745f7e2120af0c40111eced3b6d7f35bfcc6ec0a7166010d89df58982e",
    }],
    outputs: [{ value: 2_304_000_000, scriptPubkey: "0x6a0bda7544ced9b468143b82546acbc73b98a4ea" }],
    locktime: 0,
    app: {
      type: "Attest",
      proposalId: "0x965c918c6ee50306df462954e2559d464b01d6a957e44c706ef8366a191197a5",
      score: 100,
      confidence: 1_000_000,
    },
  },
  expectedConsensusBytes:
    "0x01000000010000000000000091f7346ba9931c827fb409eabe037b20270fbd2b0292bc9224b641164f10f1a60200000063000000000000004094752a03d06beec06986ab3ed665a9d382d0e5cfe712e21f119401b4c877cda97430870516166cb7942b63363178c595e3f927ffa2e94e242109da10765af9f8210253148f745f7e2120af0c40111eced3b6d7f35bfcc6ec0a7166010d89df58982e010000000000000000405489000000006a0bda7544ced9b468143b82546acbc73b98a4ea0000000002000000965c918c6ee50306df462954e2559d464b01d6a957e44c706ef8366a191197a56400000040420f00",
  expectedTxid: "0x9d4a43ec75ba1639e9a60feac49ac7cd0fc1950d0d34d43f602e5d467cc9e24a",
  expectedSighash: "0xcc12bb2b9b79e2cbfb76398d41304ed948b7318a1fe1d06bb5031204c96a03c3",
};

export const HEADER_VECTORS: HeaderVector[] = [GOLDEN_HEADER];
export const TX_VECTORS: TxVector[] = [GOLDEN_TX, GOLDEN_PROPOSE_TX, GOLDEN_ATTEST_TX];

export * from "./live.js";
