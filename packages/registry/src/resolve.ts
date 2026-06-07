// The deterministic resolvers — the heart of L3. Each replays a set of ChainRecords
// in anchor order and returns the same result for the same input, on any machine. That
// determinism IS the trust model: two independent indexers (or a client-side SDK run)
// converge because they apply the identical convention, not because consensus signed it.
import { EPOCH_LEN } from "@inversealtruism/csd-codec";
import type {
  ChainRecord, ResolveOpts, RankedPeer, RankedGateway, ResolvedIdentity,
  PeerContent, GatewayContent, IdentityRevealContent, IdentityCommitContent,
} from "./types.js";
import { DOMAINS } from "./types.js";
import { verifyPeer, verifyGateway, verifyIdentitySig, commitHash } from "./verify.js";

export const epochOf = (height: number): number => Math.floor(height / EPOCH_LEN);

/** Σ(propose fee + attestation fees), then recency-decayed toward the current epoch. */
function decayedWeight(r: ChainRecord, nowEpoch: number, decay: number): number {
  const base = r.fee + r.attestations.reduce((s, a) => s + (a.fee || 0), 0);
  const lastEpoch = Math.max(epochOf(r.height), ...r.attestations.map((a) => epochOf(a.height)), 0);
  const age = Math.max(0, nowEpoch - lastEpoch);
  return base * Math.pow(decay, age);
}
const lastActiveEpoch = (r: ChainRecord): number =>
  Math.max(epochOf(r.height), ...r.attestations.map((a) => epochOf(a.height)), 0);

const notExpired = (r: ChainRecord, nowEpoch: number): boolean => r.expiresEpoch === 0 || nowEpoch <= r.expiresEpoch;
// stable anchor order: height, then proposalId — fully deterministic across implementations
const byAnchor = (a: ChainRecord, b: ChainRecord) => a.height - b.height || (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0);

// keep, per group key, the highest-weight record (ties → earliest anchor)
function dedupeBest(recs: ChainRecord[], key: (r: ChainRecord) => string, nowEpoch: number, decay: number): ChainRecord[] {
  const best = new Map<string, ChainRecord>();
  for (const r of [...recs].sort(byAnchor)) {
    const k = key(r);
    const cur = best.get(k);
    if (!cur || decayedWeight(r, nowEpoch, decay) > decayedWeight(cur, nowEpoch, decay)) best.set(k, r);
  }
  return [...best.values()];
}

// ── csd:peers — durable, sybil-priced bootstrap list (peers aren't unique names) ──
export function resolvePeers(records: ChainRecord[], opts: ResolveOpts): RankedPeer[] {
  const { nowEpoch, topK = 25, decayPerEpoch = 0.97 } = opts;
  const cand = records.filter(
    (r) => (r.domain === DOMAINS.peers || r.domain === DOMAINS.peersLegacy) && notExpired(r, nowEpoch) && verifyPeer(r),
  );
  return dedupeBest(cand, (r) => (r.content as PeerContent).peer_id, nowEpoch, decayPerEpoch)
    .map((r) => {
      const c = r.content as PeerContent;
      return { peer_id: c.peer_id, multiaddrs: c.multiaddrs ?? [], caps: c.caps ?? [], address: r.proposer, weight: decayedWeight(r, nowEpoch, decayPerEpoch), proposalId: r.proposalId, height: r.height };
    })
    .sort((a, b) => b.weight - a.weight || (a.proposalId < b.proposalId ? -1 : 1))
    .slice(0, topK);
}

// ── csd:gateways — uptime-attested content gateways; stale ones drop out ──
export function resolveGateways(records: ChainRecord[], opts: ResolveOpts): RankedGateway[] {
  const { nowEpoch, topK = 25, decayPerEpoch = 0.97, freshWithin = 24 } = opts;
  const cand = records.filter(
    (r) => r.domain === DOMAINS.gateways && notExpired(r, nowEpoch) && verifyGateway(r) && nowEpoch - lastActiveEpoch(r) <= freshWithin,
  );
  return dedupeBest(cand, (r) => (r.content as GatewayContent).url, nowEpoch, decayPerEpoch)
    .map((r) => {
      const c = r.content as GatewayContent;
      return { url: c.url, kind: c.kind, address: r.proposer, weight: decayedWeight(r, nowEpoch, decayPerEpoch), proposalId: r.proposalId, height: r.height, lastActiveEpoch: lastActiveEpoch(r) };
    })
    .sort((a, b) => b.weight - a.weight || (a.proposalId < b.proposalId ? -1 : 1))
    .slice(0, topK);
}

// a reveal is valid only if a matching commit by the SAME address was anchored in an
// EARLIER epoch (Namecoin/Sidetree commit-reveal → fee-front-running can't steal a name)
function hasPriorCommit(reveal: ChainRecord, records: ChainRecord[]): boolean {
  const c = reveal.content as IdentityRevealContent;
  const want = commitHash(c.handle, c.salt, c.address);
  const revealEpoch = epochOf(reveal.height);
  return records.some((r) => {
    const cc = r.content as IdentityCommitContent | null;
    return r.domain === DOMAINS.identity && cc?.t === "identity-commit" &&
      r.proposer.toLowerCase() === reveal.proposer.toLowerCase() &&
      cc.commit === want && epochOf(r.height) < revealEpoch;
  });
}

/** name → address. First-anchored VERIFIED claim wins; weight only breaks same-epoch ties. */
export function resolveIdentity(records: ChainRecord[], handle: string, opts: ResolveOpts): ResolvedIdentity | null {
  const { nowEpoch, decayPerEpoch = 0.97, externalVerified } = opts;
  const claims = records.filter((r) => {
    const c = r.content as IdentityRevealContent | null;
    return r.domain === DOMAINS.identity && c?.t === "identity-reveal" && c.handle === handle &&
      notExpired(r, nowEpoch) && verifyIdentitySig(r) && hasPriorCommit(r, records) &&
      (externalVerified ? externalVerified(r) : true);
  });
  if (claims.length === 0) return null;
  const winner = claims.sort((a, b) =>
    epochOf(a.height) - epochOf(b.height) ||                                  // earliest epoch wins
    decayedWeight(b, nowEpoch, decayPerEpoch) - decayedWeight(a, nowEpoch, decayPerEpoch) || // then weight (same-epoch tie)
    byAnchor(a, b),                                                            // then stable anchor
  )[0]!;
  const c = winner.content as IdentityRevealContent;
  return { handle, address: c.address, proposalId: winner.proposalId, height: winner.height, weight: decayedWeight(winner, nowEpoch, decayPerEpoch), verified: true };
}

/** address → primary name (ENSIP-3 reverse): the highest-weight handle this address legitimately owns. */
export function reverseIdentity(records: ChainRecord[], address: string, opts: ResolveOpts): ResolvedIdentity | null {
  const addr = address.toLowerCase();
  const handles = new Set<string>();
  for (const r of records) {
    const c = r.content as IdentityRevealContent | null;
    if (r.domain === DOMAINS.identity && c?.t === "identity-reveal" && c.address.toLowerCase() === addr) handles.add(c.handle);
  }
  let best: ResolvedIdentity | null = null;
  for (const h of handles) {
    const res = resolveIdentity(records, h, opts);
    if (res && res.address.toLowerCase() === addr && (!best || res.weight > best.weight)) best = res;
  }
  return best;
}
