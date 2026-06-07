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
