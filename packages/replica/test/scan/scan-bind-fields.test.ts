// Scanner with verifyInclusion on: a record's own fields (proposer, uri, payload hash, expiry, domain; attester, score,
// confidence, target proposal) come from the node's transaction body, and an indexer row that disagrees with the
// body fails the scan. Every record here is a real signed consensus tx (test/scan-chain.ts with keys): its output
// pays PAYEE, so the signer can only come from the scriptSig. Each forged case changes one row field of a real txid.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { resolve } from "@inversealtruism/cairnx-core";
import { DOMAIN, type AttestEvent, type ChainEvent, type ProposeEvent } from "@inversealtruism/cairnx-core";
import { deploy, mint } from "@inversealtruism/cairnx-core";
import { H0, KA, KB, KC, KEYS as keys, PAYEE, buildChain, type Forge, type Spec } from "./scan-chain.js";

let passed = 0;
const failed: string[] = [];
const at = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log("  ok", name); }
  catch (e) { failed.push(name); console.log("  FAIL", name, "\n   ", (e as Error).message.split("\n").slice(0, 4).join("\n    ")); }
};
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  let msg = "(resolved)";
  try { await p; } catch (e) { msg = String((e as Error).message); }
  assert.match(msg, re);
};

const dep = deploy({ ticker: "DUST", decimals: 2, supply: "1000000", mint: "open", mintLimit: "1000" });
const forgedDep = deploy({ ticker: "DUST", decimals: 2, supply: "999999999", mint: "open", mintLimit: "999999999" });
const specs: Spec[] = [
  { kind: "propose", rec: dep, proposer: KA, height: H0 },
  { kind: "propose", rec: mint({ ticker: "DUST", amount: "100" }), proposer: KB, height: H0 + 2 },
  { kind: "attest", of: 0, attester: KB, score: 7, confidence: 100, height: H0 + 4 },
  { kind: "attest", of: 1, attester: KC, score: 3, confidence: 100, height: H0 + 5 },
  // a u64 expiry past 2^53: the indexer row carries its 2^53 sentinel, the body the real value
  { kind: "propose", rec: mint({ ticker: "DUST", amount: "300" }), proposer: KC, height: H0 + 6, expiresEpoch: 2n ** 64n - 1n },
];
const TIP = H0 + 40;
const chain = buildChain(specs, { keys });
const [T0, T1, T2, T3, T4] = chain.txs.map((x) => x.txid);

type Fetch = typeof fetch;
const off = (f: Fetch) => new Scanner({ indexerUrl: "http://idx", fetch: f }).scan();
const on = (f: Fetch, c = chain) => new Scanner({ indexerUrl: "http://idx", fetch: f, ...c.verified({ verifiedTip: TIP }) }).scan();
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid);
const ev = (evs: ChainEvent[], id: string) => evs.find((e) => idOf(e) === id);

await at("paired: honest signed records with the flag on give the flag-off events and state", async () => {
  const [a, b] = [await on(chain.indexer({ tip: TIP })), await off(chain.indexer({ tip: TIP }))];
  assert.equal(a.events.length, 5);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(resolve(a.events, TIP), resolve(b.events, TIP));
  const d = ev(a.events, T0) as ProposeEvent;
  assert.equal(d.proposer, KA, "the proposer is the scriptSig signer");
  assert.deepEqual(Object.keys(d.paidTo), [PAYEE], "and not the first output's address");
  assert.equal((ev(a.events, T2) as AttestEvent).attester, KB);
  assert.equal((ev(a.events, T4) as ProposeEvent).expiresEpoch, 2 ** 53, "a u64 expiry past 2^53 matches the row's sentinel");
  assert.equal(resolve(a.events, TIP).tokens.DUST?.deployer, KA);
});

/** One forged row field of a real txid: `field` is the event field it lands in with the flag off, `value` the forged value. */
const cases: { name: string; forge: Forge; id: string; field: string; value: unknown }[] = [
  { name: "proposer", forge: { [T0]: { proposer: KC } }, id: T0, field: "proposer", value: KC },
  { name: "uri (with its matching payload hash)", forge: { [T0]: { uri: forgedDep.uri, payload_hash: forgedDep.payloadHash } }, id: T0, field: "uri", value: forgedDep.uri },
  { name: "payload hash", forge: { [T1]: { payload_hash: forgedDep.payloadHash } }, id: T1, field: "payloadHash", value: forgedDep.payloadHash },
  { name: "expiry epoch", forge: { [T0]: { expires_epoch: chain.txs[0]!.expiresEpoch as number + 5 } }, id: T0, field: "expiresEpoch", value: chain.txs[0]!.expiresEpoch as number + 5 },
  { name: "attester", forge: { [T2]: { attester: KC } }, id: T2, field: "attester", value: KC },
  { name: "score", forge: { [T2]: { score: 100 } }, id: T2, field: "score", value: 100 },
  { name: "confidence", forge: { [T2]: { confidence: 1_000_000 } }, id: T2, field: "confidence", value: 1_000_000 },
  { name: "target proposal (an attestation listed under another proposal)", forge: { [T3]: { proposal_id: T0 } }, id: T3, field: "proposalId", value: T0 },
];
for (const c of cases) {
  await at(`forged ${c.name}: applied with the flag off, fails the scan with the flag on`, async () => {
    const f = chain.indexer({ tip: TIP, forge: c.forge });
    const got = ev((await off(f)).events, c.id) as unknown as Record<string, unknown>;
    assert.deepEqual(got[c.field], c.value, "the flag-off scanner takes the row's value");
    await rejects(on(f), /^F4: .* \(indexer misreporting\)$/);
  });
}

await at("forged domain: a real proposal of another domain listed as cairnx:v1 fails the scan with the flag on", async () => {
  const other = buildChain([...specs, { kind: "propose", rec: mint({ ticker: "DUST", amount: "77" }), proposer: KA, height: H0 + 7, domain: "cairnx:test" }], { keys });
  const f = other.indexer({ tip: TIP });
  assert.ok(ev((await off(f)).events, other.txs[5]!.txid), "the flag-off scanner takes the row");
  await rejects(on(f, other), /^F4: .* domain .* \(indexer misreporting\)$/);
});

await at("forged kind: an attestation's txid listed as a proposal fails the scan with the flag on", async () => {
  const base = chain.indexer({ tip: TIP });
  const f = (async (url: string) => {
    const r = await base(url);
    if (decodeURIComponent(new URL(url).pathname) !== `/domain/${DOMAIN}/proposals`) return r;
    const rows = await r.json() as unknown[];
    rows.push({ txid: T2, payload_hash: forgedDep.payloadHash, uri: forgedDep.uri, expires_epoch: 99_999, proposer: KB, height: H0 + 4 });
    return { ok: true, status: 200, json: async () => rows } as unknown as Response;
  }) as unknown as Fetch;
  assert.ok((await off(f)).events.some((e) => e.kind === "propose" && e.id === T2), "the flag-off scanner takes the row");
  await rejects(on(f), /^F4: .* not a Propose .* \(indexer misreporting\)$/);
});

console.log(`scan-bind-fields: ${passed} passed, ${failed.length} failed`);
assert.deepEqual(failed, []);
