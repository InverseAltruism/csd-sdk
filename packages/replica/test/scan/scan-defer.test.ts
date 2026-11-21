// Scanner with verifyInclusion on: records above the final height (verified tip less confDepth) are deferred,
// never applied out of order, and event heights are the merkle-proven ones. With the flag off the scan output
// is pinned byte-for-byte to the scanner before this rule existed (fixture generated from commit 358ccdc).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Scanner } from "../../src/scanner.js";
import { resolve } from "@inversealtruism/cairnx-core";
import { EPOCH_LEN, type ChainEvent } from "@inversealtruism/cairnx-core";
import { deploy } from "@inversealtruism/cairnx-core";
import { H0, KA, KB, KC, KEYS, buildChain, defaultSpecs, replayOrder } from "./scan-chain.js";

let passed = 0;
const at = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log("  ok", name); };
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  let msg = "(resolved)";
  try { await p; } catch (e) { msg = String((e as Error).message); }
  assert.match(msg, re);
};

const URL0 = "http://idx";
const TIP = H0 + 40;                 // indexer tip; every record is at most H0 + 15
// Flag-on bodies carry a real signature (the scanner recovers the signer), so the suite runs on the default chain
// signed by key-derived actors; the 358ccdc fixture is the unsigned default chain, read with the flag off.
const chain = buildChain(defaultSpecs({ A: KA, B: KB, C: KC }), { keys: KEYS });
const off = (tip = TIP, rowHeight?: Record<string, number>) =>
  new Scanner({ indexerUrl: URL0, fetch: chain.indexer({ tip, rowHeight }), pageSize: 3 }).scan();
const on = (verifiedTip: number, rowHeight?: Record<string, number>) =>
  new Scanner({ indexerUrl: URL0, fetch: chain.indexer({ tip: TIP, rowHeight }), pageSize: 3, ...chain.verified({ verifiedTip }) }).scan();
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid);
const has = (evs: ChainEvent[], txid: string) => evs.some((e) => idOf(e) === txid);
const txAt = (h: number, pos = 0) => chain.txs.find((x) => x.height === h && x.pos === pos)!.txid;

await at("flag off: two scans of the mock feed are byte-identical to the 358ccdc scanner's output", async () => {
  const plain = buildChain(defaultSpecs());
  const s = new Scanner({ indexerUrl: URL0, fetch: plain.indexer({ tip: TIP }), pageSize: 3 });
  const scans = [await s.scan(), await s.scan()];
  assert.deepEqual(scans.map((x) => x.anchor.branch), ["one", "one"]);
  // the fixture predates anchor.branch; every other byte of both scans is pinned
  const got = JSON.stringify(scans.map(({ anchor: { branch: _b, ...anchor }, ...r }) => ({ ...r, anchor })), null, 1) + "\n";
  assert.equal(got, readFileSync(new URL("./fixtures/scan-flag-off-358ccdc.json", import.meta.url), "utf8"));
});

await at("paired: flag on with every record final emits exactly the flag-off events", async () => {
  const [a, b] = [await on(TIP), await off()];
  assert.equal(a.events.length, 10);
  assert.deepEqual(a.events, b.events);
  assert.equal(a.tipHeight, b.tipHeight);
});

await at("prefix: at every cutoff the flag-on state equals the flag-off replay of the chain truncated there", async () => {
  const full = await off();
  const states = new Set<string>();
  for (let vt = H0 + 10; vt <= H0 + 28; vt++) {
    const cutoff = vt - 12;
    const got = await on(vt);
    const truncated = await off(cutoff);          // an indexer that has only seen the chain up to the cutoff
    assert.equal(got.tipHeight, TIP, "the declared tip stays the indexer tip");
    assert.deepEqual(got.events, full.events.filter((e) => e.height <= cutoff), `vt ${vt}`);
    assert.deepEqual(replayOrder(got.events), replayOrder(truncated.events), `vt ${vt}`);
    assert.deepEqual(replayOrder(got.events), replayOrder(full.events).slice(0, got.events.length), `vt ${vt}: a prefix of the full replay`);
    const st = resolve(got.events, TIP);
    assert.deepEqual(st, resolve(truncated.events, TIP), `vt ${vt}`);
    states.add(JSON.stringify(st));
  }
  assert.ok(states.size >= 8, `the sweep crosses records that change state (${states.size} distinct states)`);
});

await at("finalHeight: the verified tip less confDepth with the flag on, null with it off", async () => {
  const sOn = new Scanner({ indexerUrl: URL0, fetch: chain.indexer({ tip: TIP }), ...chain.verified({ verifiedTip: H0 + 20 }) });
  await sOn.scan();
  assert.equal(sOn.finalHeight, H0 + 8);
  const sOff = new Scanner({ indexerUrl: URL0, fetch: chain.indexer({ tip: TIP }) });
  await sOff.scan();
  assert.equal(sOff.finalHeight, null);
});

await at("boundary: a record exactly confDepth deep is applied, one block shallower it is deferred", async () => {
  const transfer = txAt(H0 + 8);
  assert.ok(has((await on(H0 + 8 + 12)).events, transfer), "depth 12 = verifyTx's own acceptance (tip - height >= confDepth)");
  assert.ok(!has((await on(H0 + 8 + 11)).events, transfer), "depth 11 is deferred");
});

await at("a row that claims a final height for a shallow tx still fails on verifyTx's depth gate", async () => {
  const shallow = txAt(H0 + 15);                  // with vt H0+20 the cutoff is H0+8
  await rejects(on(H0 + 20, { [shallow]: H0 + 5 }), /shallower than confDepth 12/);
});

await at("flag on: a row height that disagrees with the merkle-proven height fails the scan (proposal and attest)", async () => {
  const mintC = txAt(H0 + 6, 1);
  await rejects(on(TIP, { [mintC]: H0 + 3 }), new RegExp(`proposal height ${H0 + 3} for ${mintC} != merkle-proven height ${H0 + 6}`));
  const attB = txAt(H0 + 4);
  await rejects(on(TIP, { [attB]: H0 + 5 }), new RegExp(`attest height ${H0 + 5} for ${attB} != merkle-proven height ${H0 + 4}`));
  // paired: the flag-off scanner keeps the row height, as before
  const o = await off(TIP, { [mintC]: H0 + 3 });
  assert.equal(o.events.find((e) => idOf(e) === mintC)!.height, H0 + 3);
});

// A closed window (expired >= FINALITY below the indexer tip) caches its attestation list for good.
const dep = deploy({ ticker: "SHUT", decimals: 0, supply: "10", mint: "open", mintLimit: "1" });
const closedChain = buildChain([
  { kind: "propose", rec: dep, proposer: KA, height: H0, expiresEpoch: Math.floor(H0 / EPOCH_LEN) + 1 },
  { kind: "attest", of: 0, attester: KB, score: 1, confidence: 0, height: H0 + 9 },
], { keys: KEYS });
const ATT = closedChain.txs[1]!.txid;
const closedScanner = (vt: { h: number }) => new Scanner({
  indexerUrl: URL0, fetch: closedChain.indexer({ tip: H0 + 200 }),
  ...closedChain.verified({ verifiedTip: H0 + 200 }), verifiedTipHeight: async () => vt.h,
});

await at("a closed window with a deferred attestation is not cached: the attestation lands once final", async () => {
  const vt = { h: H0 + 20 };                      // cutoff H0+8: the attestation at H0+9 is deferred
  const s = closedScanner(vt);
  assert.ok(!has((await s.scan()).events, ATT));
  vt.h = H0 + 21;                                 // cutoff H0+9
  assert.ok(has((await s.scan()).events, ATT));
});

await at("a cached closed-window list is still cut at a lower cutoff (the verified tip moved back)", async () => {
  const vt = { h: H0 + 30 };
  const s = closedScanner(vt);
  assert.ok(has((await s.scan()).events, ATT));
  vt.h = H0 + 20;
  const evs = (await s.scan()).events;
  assert.ok(!has(evs, ATT));
  assert.ok(evs.every((e) => e.height <= H0 + 8));
});

console.log(`scan-defer: ${passed} passed`);
