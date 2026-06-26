# @inversealtruism/csd-registry

> **L3** of the Compute Substrate [no-fork ecosystem](https://github.com/InverseAltruism/csd-sdk).
> Peer / gateway / identity **registries built entirely on CSD's `Propose`/`Attest` primitive**, > no new transaction types, no fork. The chain provides ordering + sybil-priced weight; the
> resolvers turn that into discovery and names by a **deterministic convention**.

## The golden rule

> The chain provides **ordering + fee-weight**. It does **not** provide **uniqueness**.
> Uniqueness is a resolver **convention:** *first-resolvable-verified-anchor wins; weight only
> ranks*. Any independent indexer (or a client running this package) re-derives the identical
> result by replaying epochs in anchor order. That determinism **is** the trust model.

## Resolvers (pure, deterministic)

```ts
import { resolvePeers, resolveGateways, resolveIdentity, reverseIdentity } from "@inversealtruism/csd-registry";

const peers    = resolvePeers(records, { nowEpoch });                 // ranked bootstrap list
const gateways = resolveGateways(records, { nowEpoch, freshWithin });// uptime-attested gateways
const who      = resolveIdentity(records, "alice", { nowEpoch });    // name → address
const name     = reverseIdentity(records, "0x…", { nowEpoch });      // address → primary name
```

`records` is a `ChainRecord[]`, the normalized `Propose` + its `Attest`s for the registry
domains, built from an L2 indexer's rows **or** from raw chain data (identical input → identical
output). Same epoch set, same order-independent answer everywhere.

- **`csd:peers`:** verified signed `peer_id`↔address records, ranked by Σ fees with recency
  decay, deduped by `peer_id`. A durable, sybil-priced bootstrap list (pair with DHT/mDNS for churn).
- **`csd:gateways`:** content gateways/pins; ranked by fee × uptime-attestation weight; a gateway
  with no fresh attestation within `freshWithin` epochs drops out. Clients still verify served bytes
  against the `payload_hash` (gateways are untrusted transports).
- **`csd:identity`:** **commit-reveal** handles (publish `commit` an epoch before the `handle`
  reveal → fee-front-running can't steal a name). First-anchored *verified* claim wins; weight only
  breaks same-epoch ties. External proofs (DNS `.well-known` / GitHub gist / signed) are
  **revalidated on read:** a lost domain silently un-verifies (NIP-05 liveness).

## Publish builders

```ts
import { buildPeerRecord, buildGatewayRecord, buildIdentityCommit, buildIdentityReveal } from "@inversealtruism/csd-registry";

const r = buildIdentityCommit({ handle: "alice", salt, address });        // epoch N
// … then in epoch N+1 …
const v = buildIdentityReveal({ priv, handle: "alice", salt, address, proofs });
// each returns { domain, content, payloadHash } → serve `content` via L1, anchor with buildPropose(domain, payloadHash)
```

Each builder **signs the binding** (`addrFromPub(pub) === address` + a sig over the canonical
binding digest), so a record is only ever counted if the proposing address actually owns the
peer_id / gateway url / handle it claims.

## Discovery (from an L2 indexer)

```ts
import { discoverPeers, discoverGateways, resolveName, reverseName } from "@inversealtruism/csd-registry";
const src = { baseUrl: "https://indexer.example" };
await discoverGateways(src);     // GET /registry/gateways
await resolveName(src, "alice"); // GET /identity/alice
```

…or compute the same answers client-side with `fromRecords.*` for trust-minimization.

## Honest limits

No consensus uniqueness, this is reputation-weighted, externally-verified *claims*. Identity is
only as strong as its external proof and is revalidated on read. Fee-weighting is **economic** sybil
resistance (cheap to fake an identity, expensive to fake weight), good for discovery/ranking, not a
substitute for consensus where uniqueness truly matters. MIT.
