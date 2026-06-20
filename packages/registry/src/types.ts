// L3 registry record schemas + the normalized input the resolvers replay over.
//
// The golden rule (see docs/ecosystem/04-registry.md): the chain provides ORDERING +
// sybil-priced WEIGHT. It does NOT provide uniqueness. Uniqueness is an indexer
// CONVENTION (first-resolvable-verified-anchor wins; weight only ranks), which any
// independent indexer re-derives identically by replaying epochs in anchor order.

/** On-chain registry domains. `CSD_Peers` is already live; the others are conventions. */
export const DOMAINS = {
  peers: "csd:peers",
  peersLegacy: "CSD_Peers", // the domain already seeded in the wild
  gateways: "csd:gateways",
  identity: "csd:identity",
} as const;

/** Record payload kinds (the `t` discriminator inside the off-chain content). */
export type RecordKind = "peer" | "gateway" | "identity-commit" | "identity-reveal";

// ── off-chain content shapes (committed by payload_hash, served via L1) ──

export interface PeerContent {
  v: 1; t: "peer";
  peer_id: string;            // libp2p PeerId
  multiaddrs: string[];       // /ip4/…/tcp/…/p2p/<id>
  caps?: string[];            // ["full","archive","miner",…]
  pub: string;                // pub33 of the proposing address (binds peer_id↔address)
  sig: string;                // sig64 over bindDigest("peer", {peer_id, address})
  signed_peer_record?: string; // optional opaque libp2p envelope (base64) for libp2p use
  ts?: number;
}

export interface GatewayContent {
  v: 1; t: "gateway";
  kind: "gateway" | "pin";
  url: string;                // https://gw/content/0x{hash}  (must contain {hash})
  serves?: string[];          // ["csd-payloads"]
  pub: string;                // pub33 of proposer
  sig: string;                // sig64 over bindDigest("gateway", {url, address})
  ts?: number;
}

export interface IdentityCommitContent {
  v: 1; t: "identity-commit";
  commit: string;             // sha256(handle|salt|address) — published one epoch before reveal
}

export interface IdentityRevealContent {
  v: 1; t: "identity-reveal";
  handle: string;
  salt: string;               // reveals the prior commit
  address: string;            // the addr20 being bound
  pub: string;                // pub33; addrFromPub(pub) MUST equal address
  sig: string;                // sig64 over bindDigest("identity", {handle, address})
  proofs?: ExternalProof[];   // DNS/.well-known, github-gist — revalidated on read by workers
  ts?: number;
}

export type ExternalProof =
  | { type: "dns"; domain: string; path: string }
  | { type: "github-gist"; url: string }
  | { type: "signed" }; // the on-record sig itself

export type RecordContent = PeerContent | GatewayContent | IdentityCommitContent | IdentityRevealContent;

// ── the normalized chain record the resolvers consume (built from indexer rows or
//    directly from raw chain data; identical either way → identical resolution) ──
export interface ChainRecord {
  domain: string;
  proposalId: string;   // txid — the anchor identity + deterministic tiebreak
  proposer: string;     // addr20 that signed the Propose
  payloadHash: string;
  fee: number;          // propose fee (sats)
  height: number;       // anchor height (ordering)
  expiresEpoch: number; // 0 = no explicit expiry
  content: RecordContent | null; // null = late-published / unresolved (never counted as present)
  attestations: AttRecord[];
}
export interface AttRecord { attester: string; fee: number; score: number; confidence: number; height: number }

// ── resolver options + outputs ──
export interface ResolveOpts {
  nowEpoch: number;       // current epoch = floor(tipHeight / EPOCH_LEN)
  topK?: number;          // cap results (default 25)
  /** @deprecated IGNORED. The recency-decay base is a FIXED consensus convention (0.97/epoch); making it
   *  caller-tunable would fork the ranking across clients. Kept only for back-compat of existing call sites. */
  decayPerEpoch?: number;
  freshWithin?: number;   // require activity within N epochs (gateways); default 24 (~1 day)
  externalVerified?: (r: ChainRecord) => boolean; // identity: external proof currently re-resolves
}

export interface RankedPeer { peer_id: string; multiaddrs: string[]; caps: string[]; address: string; weight: number; proposalId: string; height: number }
export interface RankedGateway { url: string; kind: string; address: string; weight: number; proposalId: string; height: number; lastActiveEpoch: number }
export interface ResolvedIdentity { handle: string; address: string; proposalId: string; height: number; weight: number; verified: boolean }
