// @inversealtruism/csd-registry — L3 discovery/identity built entirely on CSD's
// Propose/Attest primitive. No new tx types, no fork. The resolvers are pure and
// deterministic (replay an epoch set → identical result anywhere); the discovery
// helpers read them from an L2 indexer OR compute them client-side from raw records.
import { payloadHash } from "@inversealtruism/csd-codec";
import { signBinding, commitHash } from "./verify.js";
import { resolvePeers, resolveGateways, resolveIdentity, reverseIdentity } from "./resolve.js";
import { DOMAINS } from "./types.js";
import type {
  ChainRecord, ResolveOpts, RankedPeer, RankedGateway, ResolvedIdentity,
  PeerContent, GatewayContent, IdentityCommitContent, IdentityRevealContent, ExternalProof,
} from "./types.js";

export * from "./types.js";
export { resolvePeers, resolveGateways, resolveIdentity, reverseIdentity, epochOf } from "./resolve.js";
export { bindDigest, commitHash, signBinding, verifyPeer, verifyGateway, verifyIdentitySig } from "./verify.js";

/** A built registry record ready to anchor: Propose{domain, payloadHash} + serve `content` via L1. */
export interface BuiltRecord { domain: string; content: object; payloadHash: string }

// Drop undefined-valued keys so the canonical bytes (what gets served) and the
// payload_hash agree — canonicalJson must hash exactly the JSON a transport returns.
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ── publish builders (CLI / wallet / console call these, then buildPropose) ──

export function buildPeerRecord(args: { priv: string; peer_id: string; multiaddrs: string[]; caps?: string[]; address: string; signed_peer_record?: string; ts?: number }): BuiltRecord {
  const { sig64, pub33 } = signBinding("peer", { peer_id: args.peer_id, address: args.address.toLowerCase() }, args.priv);
  const content = clean<PeerContent>({ v: 1, t: "peer", peer_id: args.peer_id, multiaddrs: args.multiaddrs, caps: args.caps, pub: pub33, sig: sig64, signed_peer_record: args.signed_peer_record, ts: args.ts });
  return { domain: DOMAINS.peers, content, payloadHash: payloadHash(content) };
}

export function buildGatewayRecord(args: { priv: string; url: string; kind?: "gateway" | "pin"; serves?: string[]; address: string; ts?: number }): BuiltRecord {
  if (!args.url.includes("{hash}")) throw new Error("gateway url must contain the {hash} template, e.g. https://gw/content/0x{hash}");
  const { sig64, pub33 } = signBinding("gateway", { url: args.url, address: args.address.toLowerCase() }, args.priv);
  const content = clean<GatewayContent>({ v: 1, t: "gateway", kind: args.kind ?? "gateway", url: args.url, serves: args.serves ?? ["csd-payloads"], pub: pub33, sig: sig64, ts: args.ts });
  return { domain: DOMAINS.gateways, content, payloadHash: payloadHash(content) };
}

/** Step 1 of identity: publish the commit one epoch before revealing the handle. */
export function buildIdentityCommit(args: { handle: string; salt: string; address: string }): BuiltRecord {
  const content: IdentityCommitContent = { v: 1, t: "identity-commit", commit: commitHash(args.handle, args.salt, args.address) };
  return { domain: DOMAINS.identity, content, payloadHash: payloadHash(content) };
}

/** Step 2 of identity: reveal the handle+salt and sign the binding. */
export function buildIdentityReveal(args: { priv: string; handle: string; salt: string; address: string; proofs?: ExternalProof[]; ts?: number }): BuiltRecord {
  const { sig64, pub33 } = signBinding("identity", { handle: args.handle, address: args.address.toLowerCase() }, args.priv);
  const content = clean<IdentityRevealContent>({ v: 1, t: "identity-reveal", handle: args.handle, salt: args.salt, address: args.address.toLowerCase(), pub: pub33, sig: sig64, proofs: args.proofs, ts: args.ts });
  return { domain: DOMAINS.identity, content, payloadHash: payloadHash(content) };
}

// ── high-level discovery: read resolver results from an L2 indexer ──
export interface IndexerSource { baseUrl: string; fetch?: typeof fetch }
async function getJson<T>(src: IndexerSource, path: string): Promise<T> {
  const f = src.fetch ?? fetch;
  const r = await f(src.baseUrl.replace(/\/$/, "") + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}
export async function discoverPeers(src: IndexerSource): Promise<RankedPeer[]> { return getJson<RankedPeer[]>(src, "/registry/peers"); }
export async function discoverGateways(src: IndexerSource): Promise<RankedGateway[]> { return getJson<RankedGateway[]>(src, "/registry/gateways"); }
export async function resolveName(src: IndexerSource, handle: string): Promise<ResolvedIdentity | null> {
  try { return await getJson<ResolvedIdentity | null>(src, `/identity/${encodeURIComponent(handle)}`); } catch { return null; }
}
export async function reverseName(src: IndexerSource, address: string): Promise<ResolvedIdentity | null> {
  try { return await getJson<ResolvedIdentity | null>(src, `/address/${address}/identity`); } catch { return null; }
}

// ── trust-minimized: compute the same answers client-side from raw records ──
export const fromRecords = {
  peers: (records: ChainRecord[], opts: ResolveOpts): RankedPeer[] => resolvePeers(records, opts),
  gateways: (records: ChainRecord[], opts: ResolveOpts): RankedGateway[] => resolveGateways(records, opts),
  name: (records: ChainRecord[], handle: string, opts: ResolveOpts): ResolvedIdentity | null => resolveIdentity(records, handle, opts),
  reverse: (records: ChainRecord[], address: string, opts: ResolveOpts): ResolvedIdentity | null => reverseIdentity(records, address, opts),
};
