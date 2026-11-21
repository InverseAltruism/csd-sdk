// A cairnx:v1 Propose whose uri holds U+0000 (the node admits any UTF-8 uri). No JSON holds U+0000 unescaped, so it
// is no record. An indexer store that holds no U+0000 serves another uri for it: csd-indexer 0.3.8 stores each
// U+0000 as U+0001, and node:sqlite before it read the text only up to the U+0000. With verifyInclusion on (the
// armed maker) the scan takes the record from the node's body; a scan that failed on the row's other uri would fail
// on every pass, and the maker's loop pause on each. Every record here is a real signed consensus tx
// (test/scan-chain.ts with keys).
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { canonicalState, resolve } from "@inversealtruism/cairnx-core";
import type { ChainEvent, ProposeEvent } from "@inversealtruism/cairnx-core";
import { deploy, mint } from "@inversealtruism/cairnx-core";
import { H0, KA, KB, KC, KEYS as keys, buildChain, type Forge, type Spec } from "./scan-chain.js";

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
// A real record followed by U+0000 and more bytes, its payload hash the record's: the shape a store that stops at the
// U+0000 turns into a record.
const canon = mint({ ticker: "DUST", amount: "77" });
const NUL_URI = canon.uri + "\u0000junk";
const base: Spec[] = [
  { kind: "propose", rec: dep, proposer: KA, height: H0 },
  { kind: "propose", rec: mint({ ticker: "DUST", amount: "100" }), proposer: KB, height: H0 + 2 },
  { kind: "propose", rec: mint({ ticker: "DUST", amount: "5" }), proposer: KA, height: H0 + 9 },
];
const specs: Spec[] = [
  ...base,
  { kind: "propose", rec: { ...canon, uri: NUL_URI }, proposer: KC, height: H0 + 6 },
  { kind: "attest", of: 3, attester: KA, score: 100, confidence: 100, height: H0 + 8 },
];
const chain = buildChain(specs, { keys });
const plain = buildChain(base, { keys });
const NUL = chain.txs[3]!.txid, NUL_ATT = chain.txs[4]!.txid;
assert.deepEqual(plain.txs.map((x) => x.txid), chain.txs.slice(0, 3).map((x) => x.txid), "the records without U+0000 keep their txids");

const EARLY = H0 + 17;   // final height H0 + 5: the record at H0 + 6 is left for a later scan
const TIP = H0 + 40;
/** The rows two indexer stores serve for the record: csd-indexer 0.3.8's, and a store that ends the text at U+0000. */
const ROWS: { name: string; forge: Forge }[] = [
  { name: "U+0001 in its place", forge: { [NUL]: { uri: canon.uri + "\u0001junk" } } },
  { name: "cut at U+0000", forge: { [NUL]: { uri: canon.uri } } },
];

type Fetch = typeof fetch;
/** An indexer whose tip the test moves, counting full pulls (the domain list) apart from the chain-order feed reads. */
function moving(c: typeof chain, forge: Forge, tip: number) {
  const s = { tip, full: 0 };
  const f = (async (url: string) => {
    if (decodeURIComponent(new URL(url).pathname).startsWith("/domain/")) s.full++;
    return c.indexer({ tip: s.tip, forge })(url);
  }) as unknown as Fetch;
  return { s, f };
}
const flagOn = (c: typeof chain, f: Fetch, tip: () => number) =>
  new Scanner({ indexerUrl: "http://idx", fetch: f, ...c.verified({ verifiedTip: Number.MAX_SAFE_INTEGER }), verifiedTipHeight: async () => tip() });
const flagOff = (f: Fetch) => new Scanner({ indexerUrl: "http://idx", fetch: f });
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid);
const without = (evs: ChainEvent[], ids: string[]) => evs.filter((e) => !ids.includes(idOf(e)));
const INVALID = { kind: "invalid", ok: false, code: "RECORD_NOT_OBJECT", note: "unparseable/non-canonical record" };

for (const row of ROWS) {
  await at(`flag on, row ${row.name}: the full pull and the feed reads after it complete, and the record is not applied`, async () => {
    const { s, f } = moving(chain, row.forge, EARLY);
    const sc = flagOn(chain, f, () => s.tip);
    const first = await sc.scan();
    assert.equal(first.anchor.branch, "one");
    assert.equal(s.full, 1, "the first scan is the full pull");
    assert.ok(!first.events.some((e) => idOf(e) === NUL), "the record is not final yet");
    s.tip = TIP;
    for (let i = 0; i < 2; i++) {
      s.full = 0;
      const r = await sc.scan();
      assert.equal(s.full, 0, `scan ${i + 2} reads on from the feeds`);
      const fresh = await flagOn(chain, chain.indexer({ tip: TIP, forge: row.forge }), () => TIP).scan();
      assert.deepEqual(r.events, fresh.events, "the same events as a full pull");
      const pe = r.events.find((e) => idOf(e) === NUL) as ProposeEvent | undefined;
      assert.equal(pe?.uri, NUL_URI, "the event carries the node's uri");
      assert.ok(r.events.some((e) => idOf(e) === NUL_ATT), "an attestation of it is read as any other");
      const st = resolve(r.events, TIP);
      assert.deepEqual(st.events.find((e) => e.id === NUL), { height: H0 + 6, pos: 0, id: NUL, ...INVALID });
      const honest = await flagOn(plain, plain.indexer({ tip: TIP }), () => TIP).scan();
      assert.deepEqual(without(r.events, [NUL, NUL_ATT]), honest.events, "every other event is unchanged");
      assert.equal(canonicalState(st), canonicalState(resolve(honest.events, TIP)), "and so is the state");
    }
  });
}

await at("flag off, row U+0001 in its place: the full pull and the feed reads complete, and the record is not applied", async () => {
  const { s, f } = moving(chain, ROWS[0]!.forge, H0 + 3);
  const sc = flagOff(f);
  assert.ok(!(await sc.scan()).events.some((e) => idOf(e) === NUL), "the record is above the first scan's tip");
  s.tip = TIP;
  s.full = 0;
  const r = await sc.scan();
  assert.equal(s.full, 0, "the second scan reads on from the feeds");
  assert.equal((r.events.find((e) => idOf(e) === NUL) as ProposeEvent | undefined)?.uri, canon.uri + "\u0001junk");
  const st = resolve(r.events, TIP);
  assert.deepEqual(st.events.find((e) => e.id === NUL), { height: H0 + 6, pos: 0, id: NUL, ...INVALID });
  const honest = await flagOff(plain.indexer({ tip: TIP })).scan();
  assert.equal(canonicalState(st), canonicalState(resolve(honest.events, TIP)));
});

/** Every other row field that disagrees with the node's body still fails the scan: for a body without U+0000 a row uri
 *  with U+0001 or U+0000 in it, and for the body with U+0000 the fields other than its uri. */
const T0 = chain.txs[0]!.txid;
const forged: { name: string; forge: Forge; field: string }[] = [
  { name: "a record's uri with one character changed to U+0001", forge: { [T0]: { uri: dep.uri.replace("DUST", "DUS\u0001") } }, field: "uri" },
  { name: "a record's uri with U+0000 added", forge: { [T0]: { uri: dep.uri + "\u0000" } }, field: "uri" },
  { name: "the U+0000 record's proposer", forge: { [NUL]: { uri: canon.uri + "\u0001junk", proposer: KB } }, field: "proposer" },
  { name: "the U+0000 record's payload hash", forge: { [NUL]: { uri: canon.uri + "\u0001junk", payload_hash: dep.payloadHash } }, field: "payloadHash" },
  { name: "the U+0000 record's expiry epoch", forge: { [NUL]: { uri: canon.uri + "\u0001junk", expires_epoch: Number(chain.txs[3]!.expiresEpoch) + 1 } }, field: "expiresEpoch" },
];
for (const c of forged) {
  await at(`paired: ${c.name} still fails the scan with the flag on`, async () => {
    await rejects(flagOn(chain, chain.indexer({ tip: TIP, forge: c.forge }), () => TIP).scan(),
      new RegExp(`^F4: proposal ${c.field} for 0x[0-9a-f]{64} differs from the node's transaction body .* \\(indexer misreporting\\)$`, "s"));
  });
}

console.log(`scan-nul-body: ${passed} passed, ${failed.length} failed`);
assert.deepEqual(failed, []);
