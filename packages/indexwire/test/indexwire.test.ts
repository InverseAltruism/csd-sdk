// indexwire guard tests. Fixtures under "real wire" are VERBATIM captures from the live Granus
// indexer (2026-07-03, tip ~45,955) — they bind the types/guards to what the producer actually
// serves. The adversarial cases pin the fail-loud-on-structure / conservative-on-values posture
// documented in src/index.ts; if one of these assertions has to change, a consumer's behavior is
// changing with it — review resolver-side first.
import { strict as assert } from "node:assert";
import {
  requireArrayPage, requireOrdinal, parseProposalRow, parseAttestationRow,
  conservativeOutputs, parseHealth, MAX_OUTPUTS_PER_TX,
} from "../src/index.js";

let pass = 0;
const ok = (name: string, fn: () => void) => { fn(); pass++; console.log("  ✓ " + name); };
const throws = (name: string, fn: () => void, re: RegExp) => {
  let threw = false;
  try { fn(); } catch (e) { threw = true; assert.match(String(e), re, name); }
  assert.equal(threw, true, `${name}: expected a throw`);
  pass++; console.log("  ✓ " + name);
};

// ── real wire: live-captured proposal row (register-flow offer, height 44,680) ──
const LIVE_PROPOSAL = {
  txid: "0x6c7cb301453588e5f1c62911c5601d02a2d8907b45062a83711e73cb97314da7",
  domain: "cairnx:v1",
  payload_hash: "0xa7e1a9b37c4d1019cc4f151297312f40cdbc8b99cc9d89852af490a783288211",
  uri: '{"give":{"name":"1"},"t":"offer","v":1,"want":{"value":"200000000"}}',
  expires_epoch: 1495,
  proposer: "0xc25117a104e2cba2a69ad3981a3c67299f550504",
  fee: 25000000,
  height: 44680,
  time: 1782911913,
};

ok("live proposal row parses and normalizes verbatim", () => {
  const p = parseProposalRow(LIVE_PROPOSAL);
  assert.equal(p.txid, LIVE_PROPOSAL.txid);
  assert.equal(p.payload_hash, LIVE_PROPOSAL.payload_hash);
  assert.equal(p.uri, LIVE_PROPOSAL.uri);
  assert.equal(p.expires_epoch, 1495);
  assert.equal(p.proposer, LIVE_PROPOSAL.proposer);
  assert.equal(p.height, 44680);
});

ok("uppercase ids/addrs are lowercased (resolver feed normalization)", () => {
  const p = parseProposalRow({ ...LIVE_PROPOSAL, txid: LIVE_PROPOSAL.txid.toUpperCase(), proposer: LIVE_PROPOSAL.proposer.toUpperCase() });
  assert.equal(p.txid, LIVE_PROPOSAL.txid);
  assert.equal(p.proposer, LIVE_PROPOSAL.proposer);
});

ok("missing payload_hash/proposer/uri degrade to '' (tolerant fields), NOT a throw", () => {
  const p = parseProposalRow({ txid: LIVE_PROPOSAL.txid, height: 1 });
  assert.equal(p.payload_hash, "");
  assert.equal(p.proposer, "");
  assert.equal(p.uri, "");
});

ok("saturated expires_epoch stays NON-safe by design (GRX-WIRE-CLAMP-1)", () => {
  const p = parseProposalRow({ ...LIVE_PROPOSAL, expires_epoch: "9007199254740993" });
  assert.equal(Number.isSafeInteger(p.expires_epoch), false); // the resolver's own gate must fire
});

throws("proposal without txid fails LOUD", () => parseProposalRow({ height: 1 }), /lacks a txid/);
throws("non-object proposal row fails LOUD", () => parseProposalRow("[]"), /not an object/);
throws("fractional proposal height fails LOUD (ordered-feed guard)", () => parseProposalRow({ ...LIVE_PROPOSAL, height: 44680.5 }), /out-of-range proposal height/);
throws("negative height fails LOUD", () => requireOrdinal(-1, "h"), /out-of-range h/);
throws("NaN pos fails LOUD", () => requireOrdinal("abc", "tx pos"), /out-of-range tx pos/);
throws("non-array page fails LOUD", () => requireArrayPage({ rows: [] }, "proposals"), /non-array proposals page/);

// ── attestation rows ──
ok("attestation row parses; confidence clamps garbage to 0 (never a phantom fill marker)", () => {
  const a = parseAttestationRow({ txid: "0xAB", proposal_id: "0xcd", attester: "0xEF", score: "100", confidence: -3, fee: 1, height: 7, time: 0 });
  assert.equal(a.txid, "0xab");
  assert.equal(a.attester, "0xef");
  assert.equal(a.score, 100);
  assert.equal(a.confidence, 0);
  assert.equal(a.height, 7);
});
throws("attestation without attester fails LOUD", () => parseAttestationRow({ txid: "0xab", height: 1 }), /lacks an attester/);
throws("attestation with unsafe height fails LOUD", () => parseAttestationRow({ txid: "0xab", attester: "0xcd", height: 2 ** 53 }), /out-of-range attest height/);

// ── conservative outputs (skip-not-throw; dropping only shrinks a payment) ──
const GOOD_OUT = { addr: "0x" + "ab".repeat(20), value: 25000000 };
ok("valid output passes; addr lowercased", () => {
  const outs = conservativeOutputs([{ ...GOOD_OUT, addr: GOOD_OUT.addr.toUpperCase() }]);
  assert.deepEqual(outs, [GOOD_OUT]);
});
ok("string/negative/unsafe/fractional values + bad addrs are SKIPPED, never thrown", () => {
  const outs = conservativeOutputs([
    { addr: GOOD_OUT.addr, value: "25000000" },        // string value: BigInt-misparse hazard
    { addr: GOOD_OUT.addr, value: -1 },                 // negative
    { addr: GOOD_OUT.addr, value: 2 ** 53 },            // not a safe integer
    { addr: GOOD_OUT.addr, value: 0.5 },                // fractional
    { addr: "0x1234", value: 1 },                       // short addr
    { value: 1 },                                       // missing addr
    null,                                               // garbage entry
    GOOD_OUT,                                           // the one survivor
  ]);
  assert.deepEqual(outs, [GOOD_OUT]);
});
ok("non-array outputs degrade to [] (conservative)", () => assert.deepEqual(conservativeOutputs("x"), []));
ok(`output list is capped at ${MAX_OUTPUTS_PER_TX}`, () => {
  const outs = conservativeOutputs(Array.from({ length: MAX_OUTPUTS_PER_TX + 100 }, () => GOOD_OUT));
  assert.equal(outs.length, MAX_OUTPUTS_PER_TX);
});
ok("boundary: 2^53-1 is a valid value", () => {
  assert.equal(conservativeOutputs([{ addr: GOOD_OUT.addr, value: 2 ** 53 - 1 }]).length, 1);
});

// ── real wire: live-captured /health (pre-0.2.5 producer: no version/backend yet) ──
const LIVE_HEALTH = {
  ok: true, indexed_height: 45955, tip_height: 45955,
  tip_hash: "0x0000000000007169c14c109addb37e9a263d10114ed42a3595f1637b041daf33",
  chainwork: "3238190776829089165", seconds_since_tip: 371, stale: false, final_depth: 6,
  blocks: 45956, txs: 48675, proposals: 324, attestations: 184,
};
ok("live /health parses (additive version/backend absent => omitted)", () => {
  const h = parseHealth(LIVE_HEALTH);
  assert.equal(h.ok, true);
  assert.equal(h.version, undefined);
  assert.equal(h.backend, undefined);
  assert.equal(h.tip_height, 45955);
  assert.equal(h.chainwork, LIVE_HEALTH.chainwork);
});
ok("0.2.5+ /health carries version/backend through", () => {
  const h = parseHealth({ ...LIVE_HEALTH, version: "0.2.5", backend: "postgres" });
  assert.equal(h.version, "0.2.5");
  assert.equal(h.backend, "postgres");
});
ok("unknown backend value is dropped, not invented", () => {
  const h = parseHealth({ ...LIVE_HEALTH, backend: "mysql" });
  assert.equal(h.backend, undefined);
});
throws("/health with non-numeric tip fails LOUD", () => parseHealth({ ...LIVE_HEALTH, tip_height: "soon" }), /non-numeric tip_height/);
ok("empty-index health (-1 tip) is structurally valid", () => {
  const h = parseHealth({ ...LIVE_HEALTH, indexed_height: -1, tip_height: -1, tip_hash: null, chainwork: null, seconds_since_tip: null, stale: true, blocks: 0, txs: 0, proposals: 0, attestations: 0 });
  assert.equal(h.tip_height, -1);
  assert.equal(h.seconds_since_tip, null);
});

console.log(`\nindexwire: ${pass} assertions passed`);
