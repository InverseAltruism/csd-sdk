// P5.0 conformance: the resolvers are PURE + DETERMINISTIC, so the same epoch set
// yields the same result regardless of input order (two independent indexers agree).
// Fixtures are signed with REAL keys via the SDK crypto, so verification is exercised
// for real — a tampered/unsigned record is genuinely rejected, not assumed valid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keygen } from "@inversealtruism/csd-crypto";
import { EPOCH_LEN } from "@inversealtruism/csd-codec";
import {
  buildPeerRecord, buildGatewayRecord, buildIdentityCommit, buildIdentityReveal,
  resolvePeers, resolveGateways, resolveIdentity, reverseIdentity,
  type ChainRecord, type ResolveOpts, type BuiltRecord, type AttRecord,
} from "../src/index.js";

const E = EPOCH_LEN;
let seq = 0;
const txid = () => "0x" + (seq++).toString(16).padStart(64, "0");
function rec(b: BuiltRecord, proposer: string, fee: number, height: number, opts: { expiresEpoch?: number; atts?: AttRecord[] } = {}): ChainRecord {
  return { domain: b.domain, proposalId: txid(), proposer, payloadHash: b.payloadHash, fee, height, expiresEpoch: opts.expiresEpoch ?? 0, content: b.content as any, attestations: opts.atts ?? [] };
}
const shuffle = <T,>(a: T[], seed = 7): T[] => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const j = seed % (i + 1); [r[i], r[j]] = [r[j]!, r[i]!]; } return r; };
const OPTS: ResolveOpts = { nowEpoch: 10, topK: 25, decayPerEpoch: 0.97 };

// RES-H4: ranking must use the EXACT integer decay fixed-point, NOT Math.pow (which is not
// correctly-rounded → a Rust/Go/Py port can rank a near-tie differently = a cross-language fork
// of peer/gateway/IDENTITY selection). This test is the conformance PIN: it reimplements the
// canonical floored fixed-point in independent BigInt and asserts the resolver's order matches it
// exactly — over deliberately CLOSE weights. A revert to Math.pow would diverge on a near-tie here.
test("RES-H4: ranking is the exact integer decay fixed-point (no float-pow fork)", () => {
  const DSCALE = 1_000_000_000_000n;
  const powFixed = (age: number): bigint => { const a = age <= 0 ? 0 : Math.min(age, 4000); return (97n ** BigInt(a) * DSCALE) / (100n ** BigInt(a)); };
  const expectW = (base: number, age: number): bigint => BigInt(base) * powFixed(age);
  // deliberately-close pairs (same product region): base·0.97^age clusters near each other
  const specs = [
    { id: "P0", base: 100_000_000, epoch: 0 },  // age 10
    { id: "P1", base: 97_000_000, epoch: 1 },   // age 9   (≈ P0 — the float-fragile near-tie)
    { id: "P2", base: 94_090_000, epoch: 2 },   // age 8   (≈ P0/P1)
    { id: "P3", base: 200_000_000, epoch: 5 },  // age 5   (clearly heavier)
    { id: "P4", base: 50_000_000, epoch: 0 },   // age 10  (clearly lighter)
  ];
  const recs = specs.map((s) => { const k = keygen(); return { rec: rec(buildPeerRecord({ priv: k.priv, peer_id: s.id, multiaddrs: ["/ip4/1.1.1.1/tcp/1"], address: k.addr }), k.addr, s.base, s.epoch * E), age: 10 - s.epoch, base: s.base, id: s.id }; });
  // independent canonical order: exact BigInt weight desc, then proposalId asc (the stable anchor)
  const idById = new Map(recs.map((x) => [x.id, x.rec.proposalId]));
  const expected = [...recs].sort((a, b) => { const wa = expectW(a.base, a.age), wb = expectW(b.base, b.age); return wa > wb ? -1 : wa < wb ? 1 : (idById.get(a.id)! < idById.get(b.id)! ? -1 : 1); }).map((x) => x.id);
  for (let s = 1; s <= 8; s++) {
    const got = resolvePeers(shuffle(recs.map((x) => x.rec), s), OPTS).map((p) => p.peer_id);
    assert.deepEqual(got, expected, `resolver order must match the exact integer fixed-point (input order ${s})`);
  }
});

test("PEERS: verified records rank by fee-weight; unsigned/tampered rejected; determinism holds", () => {
  const a = keygen(), b = keygen(), c = keygen();
  const pA = rec(buildPeerRecord({ priv: a.priv, peer_id: "PeerA", multiaddrs: ["/ip4/1.1.1.1/tcp/4001"], address: a.addr }), a.addr, 25e6, 5);
  const pB = rec(buildPeerRecord({ priv: b.priv, peer_id: "PeerB", multiaddrs: ["/ip4/2.2.2.2/tcp/4001"], address: b.addr }), b.addr, 100e6, 6);
  // a record whose sig was signed by a DIFFERENT key than the proposer → must be rejected
  const forged = rec(buildPeerRecord({ priv: c.priv, peer_id: "PeerC", multiaddrs: ["/ip4/3.3.3.3/tcp/4001"], address: c.addr }), b.addr /* lie */, 999e6, 7);

  const out = resolvePeers([pA, pB, forged], OPTS);
  assert.equal(out.length, 2, "the forged (mismatched-proposer) record is dropped");
  assert.equal(out[0]!.peer_id, "PeerB", "higher fee-weight ranks first");
  assert.equal(out[1]!.peer_id, "PeerA");
  // determinism: any input order yields byte-identical output
  assert.deepEqual(resolvePeers(shuffle([pA, pB, forged]), OPTS), out);
  assert.deepEqual(resolvePeers(shuffle([pA, pB, forged], 99), OPTS), out);
});

test("PEERS: same peer_id from one address is deduped to the highest-weight record", () => {
  const a = keygen();
  const old = rec(buildPeerRecord({ priv: a.priv, peer_id: "P", multiaddrs: ["/ip4/1.1.1.1/tcp/1"], address: a.addr }), a.addr, 25e6, 1);
  const fresh = rec(buildPeerRecord({ priv: a.priv, peer_id: "P", multiaddrs: ["/ip4/1.1.1.1/tcp/2"], address: a.addr }), a.addr, 80e6, 200);
  const out = resolvePeers([old, fresh], { ...OPTS, nowEpoch: 12 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.multiaddrs[0], "/ip4/1.1.1.1/tcp/2", "the higher-weight record wins the dedupe");
});

test("GATEWAYS: stale (no fresh attestation) gateways drop out; fresh ones rank", () => {
  const a = keygen(), b = keygen();
  // stale: anchored long ago, no recent attestations → dropped at freshWithin
  const stale = rec(buildGatewayRecord({ priv: a.priv, url: "https://old/content/0x{hash}", address: a.addr }), a.addr, 50e6, 0);
  // fresh: recent attestation keeps it alive
  const fresh = rec(buildGatewayRecord({ priv: b.priv, url: "https://new/content/0x{hash}", address: b.addr }), b.addr, 50e6, 10,
    { atts: [{ attester: a.addr, fee: 5e6, score: 100, confidence: 100, height: 10 * E }] });
  const out = resolveGateways([stale, fresh], { nowEpoch: 12, freshWithin: 6 });
  assert.equal(out.length, 1, "stale gateway dropped");
  assert.equal(out[0]!.url, "https://new/content/0x{hash}");
  // a gateway url without the {hash} template is rejected at build time
  assert.throws(() => buildGatewayRecord({ priv: a.priv, url: "https://bad/no-template", address: a.addr }));
});

test("IDENTITY: commit-reveal required; first-anchored verified wins; front-run fails", () => {
  const owner = keygen(), attacker = keygen();
  const salt = "s3cr3t-salt";
  // owner commits at epoch 1, reveals at epoch 2 → valid
  const commit = rec(buildIdentityCommit({ handle: "alice", salt, address: owner.addr }), owner.addr, 25e6, 1 * E + 1);
  const reveal = rec(buildIdentityReveal({ priv: owner.priv, handle: "alice", salt, address: owner.addr }), owner.addr, 25e6, 2 * E + 1);
  // attacker tries to grab "alice" by paying a HUGE fee, but never committed → rejected
  const grab = rec(buildIdentityReveal({ priv: attacker.priv, handle: "alice", salt: "x", address: attacker.addr }), attacker.addr, 10_000e6, 2 * E + 2);

  const res = resolveIdentity([commit, reveal, grab], "alice", { nowEpoch: 5 });
  assert.ok(res, "alice resolves");
  assert.equal(res!.address, owner.addr, "owner (committed) wins; the higher-fee front-runner is rejected");
  // determinism under shuffle
  assert.deepEqual(resolveIdentity(shuffle([commit, reveal, grab]), "alice", { nowEpoch: 5 }), res);

  // a reveal with NO prior commit does not resolve at all
  const lone = rec(buildIdentityReveal({ priv: attacker.priv, handle: "bob", salt: "z", address: attacker.addr }), attacker.addr, 25e6, 3 * E);
  assert.equal(resolveIdentity([lone], "bob", { nowEpoch: 5 }), null, "no commit → no binding");
});

test("IDENTITY: earliest epoch wins; weight only breaks SAME-epoch ties; reverse resolves", () => {
  const first = keygen(), second = keygen();
  const salt1 = "a", salt2 = "b";
  // both legitimately commit+reveal, but `first` anchors an epoch earlier with LOWER fee
  const c1 = rec(buildIdentityCommit({ handle: "carol", salt: salt1, address: first.addr }), first.addr, 25e6, 1 * E);
  const r1 = rec(buildIdentityReveal({ priv: first.priv, handle: "carol", salt: salt1, address: first.addr }), first.addr, 25e6, 2 * E);
  const c2 = rec(buildIdentityCommit({ handle: "carol", salt: salt2, address: second.addr }), second.addr, 25e6, 2 * E);
  const r2 = rec(buildIdentityReveal({ priv: second.priv, handle: "carol", salt: salt2, address: second.addr }), second.addr, 5_000e6, 3 * E);
  const res = resolveIdentity([c1, r1, c2, r2], "carol", { nowEpoch: 6 });
  assert.equal(res!.address, first.addr, "earlier-epoch claim wins despite the later one's huge fee");

  // reverse: the address's primary handle
  const back = reverseIdentity([c1, r1, c2, r2], first.addr, { nowEpoch: 6 });
  assert.equal(back!.handle, "carol");
});

test("IDENTITY: external-proof gate can un-verify a binding on read (NIP-05 liveness)", () => {
  const owner = keygen();
  const salt = "p";
  const commit = rec(buildIdentityCommit({ handle: "dave", salt, address: owner.addr }), owner.addr, 25e6, 1 * E);
  const reveal = rec(buildIdentityReveal({ priv: owner.priv, handle: "dave", salt, address: owner.addr }), owner.addr, 25e6, 2 * E);
  // proof currently resolves → bound
  assert.ok(resolveIdentity([commit, reveal], "dave", { nowEpoch: 5, externalVerified: () => true }));
  // proof stopped resolving (domain lost) → silently un-verifies
  assert.equal(resolveIdentity([commit, reveal], "dave", { nowEpoch: 5, externalVerified: () => false }), null);
});

test("EXPIRY: an expired record is excluded", () => {
  const a = keygen();
  const p = rec(buildPeerRecord({ priv: a.priv, peer_id: "PX", multiaddrs: ["/ip4/9.9.9.9/tcp/1"], address: a.addr }), a.addr, 25e6, 5, { expiresEpoch: 3 });
  assert.equal(resolvePeers([p], { nowEpoch: 4 }).length, 0, "nowEpoch past expiresEpoch → excluded");
  assert.equal(resolvePeers([p], { nowEpoch: 2 }).length, 1, "still valid before expiry");
});

// M3: reverseIdentity (address → primary name) must rank by the EXACT integer weight the forward path
// uses (decayWeightFixed), NOT the lossy float `decayedWeight`, and break ties by the stable proposalId.
// The observable contract: a deterministic primary name regardless of record FEED ORDER for an address
// that owns ≥2 equal-weight handles (a float key + feed-order dependence would fork the answer).
test("M3: reverseIdentity is order-independent + integer-ranked (deterministic primary name)", () => {
  const owner = keygen();
  const sH = "11".repeat(8), sJ = "22".repeat(8);
  const cH = rec(buildIdentityCommit({ handle: "ha", salt: sH, address: owner.addr }), owner.addr, 25e6, 1 * E);
  const rH = rec(buildIdentityReveal({ priv: owner.priv, handle: "ha", salt: sH, address: owner.addr }), owner.addr, 25e6, 2 * E);
  const cJ = rec(buildIdentityCommit({ handle: "hb", salt: sJ, address: owner.addr }), owner.addr, 25e6, 1 * E);
  const rJ = rec(buildIdentityReveal({ priv: owner.priv, handle: "hb", salt: sJ, address: owner.addr }), owner.addr, 25e6, 2 * E);
  const all = [cH, rH, cJ, rJ];
  const base = reverseIdentity(all, owner.addr, { nowEpoch: 6 });
  assert.ok(base && (base.handle === "ha" || base.handle === "hb"), "resolves to an owned handle");
  for (let s = 1; s <= 8; s++) {
    const got = reverseIdentity(shuffle(all, s), owner.addr, { nowEpoch: 6 });
    assert.equal(got?.handle, base!.handle, `same primary name regardless of feed order (seed ${s})`);
    assert.equal(got?.proposalId, base!.proposalId, "and the same stable winner record");
  }
});

// L12: a non-integer / NaN fee from a hostile indexer row must NOT crash the resolver (BigID throw).
test("L12: a non-integer/NaN fee does not crash the resolver (defensive integer coercion)", () => {
  const k = keygen();
  const pFloat = rec(buildPeerRecord({ priv: k.priv, peer_id: "PX", multiaddrs: ["/ip4/1.1.1.1/tcp/1"], address: k.addr }), k.addr, 1.5 as unknown as number, 3 * E);
  assert.doesNotThrow(() => resolvePeers([pFloat], OPTS), "non-integer proposal fee must not throw");
  const pAtt = rec(buildPeerRecord({ priv: k.priv, peer_id: "PY", multiaddrs: ["/ip4/2.2.2.2/tcp/1"], address: k.addr }), k.addr, 25e6, 3 * E, { atts: [{ attester: k.addr, fee: NaN as unknown as number, score: 100, confidence: 0, height: 3 * E }] });
  assert.doesNotThrow(() => resolvePeers([pAtt], OPTS), "NaN attestation fee must not throw");
});

// M3 (cont): reverseIdentity must pick the HEAVIER handle by EXACT integer weight, order-independently —
// operating on the winner RECORD resolveIdentity chose (not a re-find by proposalId), so a duplicate-pid
// feed can't make it feed-order-dependent.
test("M3: reverseIdentity picks the heavier handle (integer weight), order-independent", () => {
  const owner = keygen();
  const sA = "aa".repeat(8), sB = "bb".repeat(8);
  const cA = rec(buildIdentityCommit({ handle: "hx", salt: sA, address: owner.addr }), owner.addr, 200e6, 1 * E);
  const rA = rec(buildIdentityReveal({ priv: owner.priv, handle: "hx", salt: sA, address: owner.addr }), owner.addr, 200e6, 2 * E);
  const cB = rec(buildIdentityCommit({ handle: "hy", salt: sB, address: owner.addr }), owner.addr, 100e6, 1 * E);
  const rB = rec(buildIdentityReveal({ priv: owner.priv, handle: "hy", salt: sB, address: owner.addr }), owner.addr, 100e6, 2 * E);
  const all = [cA, rA, cB, rB];
  for (let s = 0; s <= 8; s++) {
    const got = reverseIdentity(s === 0 ? all : shuffle(all, s), owner.addr, { nowEpoch: 6 });
    assert.equal(got?.handle, "hx", `heavier handle (hx, fee 200) is primary regardless of feed order (seed ${s})`);
  }
});
