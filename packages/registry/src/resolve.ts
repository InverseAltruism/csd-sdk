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

// ── deterministic recency decay (audit RES-H4) ──────────────────────────────────────────────
// The decay factor is the CONVENTION constant 0.97/epoch. Computing it as `Math.pow(0.97, age)`
// is a CROSS-LANGUAGE DETERMINISM FORK: IEEE-754 `pow` is not correctly-rounded, so a Rust/Go/Py
// port can rank a near-tie differently and resolve a peer/gateway/IDENTITY (name→payee) to a
// DIFFERENT winner on the same chain. We compute 0.97^age in EXACT BigInt fixed-point instead, and
// drive every ORDERING decision from the integer value. (Only `pow` was non-deterministic — plain
// IEEE-754 multiply/divide IS correctly-rounded, so the human-facing `.weight` number stays stable.)
const DECAY_SCALE = 1_000_000_000_000n;   // 1e12 fixed-point
const DECAY_NUM = 97n, DECAY_DEN = 100n;  // 0.97 as an exact rational
const _powCache = new Map<number, bigint>();
// 0.97^age × DECAY_SCALE, exact integer. Capped where the ratio rounds to 0 at this scale.
function decayPowFixed(age: number): bigint {
  const a = age <= 0 ? 0 : Math.min(age, 4000);
  let v = _powCache.get(a);
  if (v === undefined) { v = (DECAY_NUM ** BigInt(a) * DECAY_SCALE) / (DECAY_DEN ** BigInt(a)); _powCache.set(a, v); }
  return v;
}
const lastActiveEpoch = (r: ChainRecord): number =>
  Math.max(epochOf(r.height), ...r.attestations.map((a) => epochOf(a.height)), 0);
const baseWeight = (r: ChainRecord): number => r.fee + r.attestations.reduce((s, a) => s + (a.fee || 0), 0);
/** EXACT integer ranking weight = base × 0.97^age (× DECAY_SCALE). The cross-impl-stable order key. */
function decayWeightFixed(r: ChainRecord, nowEpoch: number): bigint {
  return BigInt(baseWeight(r)) * decayPowFixed(Math.max(0, nowEpoch - lastActiveEpoch(r)));
}
/** −1/0/1 by EXACT integer weight (descending: heavier first). */
function cmpWeightDesc(a: ChainRecord, b: ChainRecord, nowEpoch: number): number {
  const wa = decayWeightFixed(a, nowEpoch), wb = decayWeightFixed(b, nowEpoch);
  return wa > wb ? -1 : wa < wb ? 1 : 0;
}
/** Human-facing decayed weight (DISPLAY ONLY — never an ordering key). Deterministic: no `pow`. */
function decayedWeight(r: ChainRecord, nowEpoch: number, _decay?: number): number {
  return Number(baseWeight(r)) * (Number(decayPowFixed(Math.max(0, nowEpoch - lastActiveEpoch(r)))) / Number(DECAY_SCALE));
}

const notExpired = (r: ChainRecord, nowEpoch: number): boolean => r.expiresEpoch === 0 || nowEpoch <= r.expiresEpoch;
// stable anchor order: height, then proposalId — fully deterministic across implementations
const byAnchor = (a: ChainRecord, b: ChainRecord) => a.height - b.height || (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0);

// keep, per group key, the highest-weight record (ties → earliest anchor)
function dedupeBest(recs: ChainRecord[], key: (r: ChainRecord) => string, nowEpoch: number, _decay: number): ChainRecord[] {
  const best = new Map<string, ChainRecord>();
  for (const r of [...recs].sort(byAnchor)) {
    const k = key(r);
    const cur = best.get(k);
    // strict `>` over byAnchor-sorted input ⇒ ties keep the earliest anchor; EXACT integer weight (RES-H4)
    if (!cur || decayWeightFixed(r, nowEpoch) > decayWeightFixed(cur, nowEpoch)) best.set(k, r);
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
    .sort((a, b) => cmpWeightDesc(a, b, nowEpoch) || (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0))
    .slice(0, topK)
    .map((r) => {
      const c = r.content as PeerContent;
      return { peer_id: c.peer_id, multiaddrs: c.multiaddrs ?? [], caps: c.caps ?? [], address: r.proposer, weight: decayedWeight(r, nowEpoch), proposalId: r.proposalId, height: r.height };
    });
}

// ── csd:gateways — uptime-attested content gateways; stale ones drop out ──
export function resolveGateways(records: ChainRecord[], opts: ResolveOpts): RankedGateway[] {
  const { nowEpoch, topK = 25, decayPerEpoch = 0.97, freshWithin = 24 } = opts;
  const cand = records.filter(
    (r) => r.domain === DOMAINS.gateways && notExpired(r, nowEpoch) && verifyGateway(r) && nowEpoch - lastActiveEpoch(r) <= freshWithin,
  );
  return dedupeBest(cand, (r) => (r.content as GatewayContent).url, nowEpoch, decayPerEpoch)
    .sort((a, b) => cmpWeightDesc(a, b, nowEpoch) || (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0))
    .slice(0, topK)
    .map((r) => {
      const c = r.content as GatewayContent;
      return { url: c.url, kind: c.kind, address: r.proposer, weight: decayedWeight(r, nowEpoch), proposalId: r.proposalId, height: r.height, lastActiveEpoch: lastActiveEpoch(r) };
    });
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
  const { nowEpoch, externalVerified } = opts;
  const claims = records.filter((r) => {
    const c = r.content as IdentityRevealContent | null;
    return r.domain === DOMAINS.identity && c?.t === "identity-reveal" && c.handle === handle &&
      notExpired(r, nowEpoch) && verifyIdentitySig(r) && hasPriorCommit(r, records) &&
      (externalVerified ? externalVerified(r) : true);
  });
  if (claims.length === 0) return null;
  const winner = claims.sort((a, b) =>
    epochOf(a.height) - epochOf(b.height) ||   // earliest epoch wins
    cmpWeightDesc(a, b, nowEpoch) ||           // then EXACT integer weight (same-epoch tie; RES-H4)
    byAnchor(a, b),                            // then stable anchor (unique proposalId)
  )[0]!;
  const c = winner.content as IdentityRevealContent;
  return { handle, address: c.address, proposalId: winner.proposalId, height: winner.height, weight: decayedWeight(winner, nowEpoch), verified: true };
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
    // Highest weight wins; ties broken by the SAME stable anchor key the forward path uses
    // (proposalId asc — a unique txid). Without this tiebreak the winner depended on `handles`
    // iteration (= record feed) order, so two honest indexers/clients fed the same chain in a
    // different order could return DIFFERENT primary names for an address that owns ≥2 equal-weight
    // handles — a determinism fork of the L3 recompute-to-verify guarantee (audit M4).
    if (res && res.address.toLowerCase() === addr &&
        (!best || res.weight > best.weight ||
         (res.weight === best.weight && res.proposalId < best.proposalId))) best = res;
  }
  return best;
}
