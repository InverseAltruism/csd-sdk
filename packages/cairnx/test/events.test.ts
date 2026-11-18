// CONVENTION §33, the rule from a block to events: every vector of test/vectors/events.json against src, then what the
// language-neutral file cannot hold (number inputs, the corpus as normalised input, the call contract, csd-light's
// BoundTx as an input, and what resolve() does with the duplicates §33.2 removes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BoundTx } from "@inversealtruism/csd-light";
import type { App, TxOutput } from "@inversealtruism/csd-codec";
import {
  CAIRNX_EVENT_RULE, DEPLOY_FEE, TREASURY_ADDR, V29_HEIGHT, blockEvents, blockMembers, canonicalJson, deploy, eventOfTx, mint, resolve,
  type ChainEvent, type EventRule, type EventRuleTx, type EventsSoFar,
} from "../src/index.js";

// csd-light's bound transaction is an input as it is (types only: csd-light is not imported at run time).
const fromBound = (t: BoundTx): EventRuleTx => t; void fromBound;

let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; };
const throws = (name: string, fn: () => unknown) => { assert.throws(fn, Error, name); pass++; };

type VTx = { pos: number; txid: string; app: Record<string, unknown>; outputs: { value: string; scriptPubkey: string }[] };
type TxCase = { name: string; rule?: EventRule; input: VTx & { height: number }; author: string; expect: unknown };
type BlockCase = { name: string; rule?: EventRule; blocks: { height: number; txs: VTx[] }[]; authors: Record<string, string>; expect: unknown };
const file = JSON.parse(readFileSync(new URL("./vectors/events.json", import.meta.url), "utf8")) as
  { format: number; rule: EventRule; tx: TxCase[]; blocks: BlockCase[] };

const u64 = (v: unknown) => (typeof v === "string" && /^-?[0-9]+$/.test(v) ? BigInt(v) : v);
const decode = (t: VTx): EventRuleTx => ({
  pos: t.pos, txid: t.txid,
  tx: {
    app: (t.app.type === "Propose" ? { ...t.app, expiresEpoch: u64(t.app.expiresEpoch) } : t.app) as App,
    outputs: t.outputs.map((o) => ({ ...o, value: u64(o.value) }) as TxOutput),
  },
});
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid);
const runTx = (c: TxCase): unknown => {
  try { return eventOfTx(decode(c.input), c.input.height, c.author, c.rule ?? file.rule); } catch { return "error"; }
};
const runBlocks = (c: BlockCase): unknown => {
  const eventIds = new Set<string>(), proposeIds = new Set<string>(), sofar: EventsSoFar = { eventIds, proposeIds };
  const members: number[][] = [], events: ChainEvent[] = [];
  for (let i = 0; i < c.blocks.length; i++) {
    const blk = c.blocks[i]!, txs = blk.txs.map(decode);
    let evs: ChainEvent[];
    try {
      const ms = blockMembers(blk.height, txs, sofar, c.rule ?? file.rule);
      evs = blockEvents(blk.height, txs, sofar, ms.map((m) => c.authors[m.item.txid] ?? (null as unknown as string)), c.rule ?? file.rule);
      members.push(ms.map((m) => m.item.pos));
    } catch { return { error: i }; }
    for (const e of evs) { eventIds.add(idOf(e)); if (e.kind === "propose") proposeIds.add(e.id); events.push(e); }
  }
  return { members, events };
};

ok("the file's rule is CAIRNX_EVENT_RULE", file.format === 1 && canonicalJson(file.rule) === canonicalJson(CAIRNX_EVENT_RULE));
ok("the file holds both kinds of case", file.tx.length >= 40 && file.blocks.length >= 25);
for (const c of file.tx) ok(`vector ${c.name}`, canonicalJson(runTx(c)) === canonicalJson(c.expect));
for (const c of file.blocks) ok(`vector ${c.name}`, canonicalJson(runBlocks(c)) === canonicalJson(c.expect));

// The JS u64 input domain (§33.4): a bigint in [0, 2^64), or a number that is an integer in [0, 2^53]. 2^53 is the
// rule's own form of a clamped expiry; a number above it no longer identifies one u64 and is refused.
const AU = "0x" + "a1".repeat(20), PA = "0x" + "b2".repeat(20);
const H = V29_HEIGHT + 1000, HASH = "0x" + "ef".repeat(32);
const one = (expiresEpoch: number | bigint, value: number | bigint = 1): EventRuleTx => ({
  pos: 1, txid: "0x" + "01".repeat(32),
  tx: { app: { type: "Propose", domain: "cairnx:v1", payloadHash: HASH, uri: "{}", expiresEpoch }, outputs: [{ value, scriptPubkey: PA }] },
});
const expiryOf = (e: ChainEvent | null) => (e && e.kind === "propose" ? e.expiresEpoch : undefined);
ok("an expiry of 2^53 as a number gives the 2^53 sentinel", expiryOf(eventOfTx(one(2 ** 53), H, AU)) === 2 ** 53);
ok("a value of 2^53 as a number is above 2^53 - 1 and left out of paidTo", canonicalJson(eventOfTx(one(5, 2 ** 53), H, AU)?.paidTo) === "{}");
for (const n of [2 ** 53 + 2, 2 ** 64]) {
  throws(`an expiry number ${n} is refused`, () => eventOfTx(one(n), H, AU));
  throws(`an output value number ${n} is refused`, () => eventOfTx(one(5, n), H, AU));
}
ok("an expiry bigint 2^64 - 1 gives the 2^53 sentinel", expiryOf(eventOfTx(one(2n ** 64n - 1n), H, AU)) === 2 ** 53);
ok("an output value bigint 2^64 - 1 is left out of paidTo", canonicalJson(eventOfTx(one(5, 2n ** 64n - 1n), H, AU)?.paidTo) === "{}");
throws("an expiry bigint 2^64 is refused", () => eventOfTx(one(2n ** 64n), H, AU));
throws("an output value bigint 2^64 is refused", () => eventOfTx(one(5, 2n ** 64n), H, AU));
assert.match(String((() => { try { eventOfTx(one(2 ** 53 + 2), H, AU); } catch (e) { return (e as Error).message; } })()), /bigint/,
  "the refusal of a number above 2^53 says to pass a bigint");
pass++;
throws("a fractional expiry is refused", () => eventOfTx(one(1.5), H, AU));
throws("a NaN value is refused", () => eventOfTx(one(5, Number.NaN), H, AU));

// The corpus events are rows a scanner already normalised: the rule maps each to itself.
const corpus = JSON.parse(readFileSync(new URL("./vectors/replay-corpus.json", import.meta.url), "utf8")) as { events: ChainEvent[] };
let same = 0;
for (const e of corpus.events) {
  const outputs = Object.entries(e.paidTo).map(([scriptPubkey, v]) => ({ scriptPubkey, value: BigInt(v) }));
  const app: App = e.kind === "propose"
    ? { type: "Propose", domain: "cairnx:v1", payloadHash: e.payloadHash, uri: e.uri, expiresEpoch: e.expiresEpoch }
    : { type: "Attest", proposalId: e.proposalId, score: e.score, confidence: e.confidence };
  const got = eventOfTx({ pos: e.pos, txid: idOf(e), tx: { app, outputs } }, e.height, e.kind === "propose" ? e.proposer : e.attester);
  if (canonicalJson(got) === canonicalJson(e)) same++;
}
ok(`eventOfTx is the identity on the ${corpus.events.length} corpus events (${same} equal)`, same === corpus.events.length && same >= 1133);

// The two steps: authors come one per member, and blockEvents selects the members again.
const tid = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const prop = (pos: number, n: number, app: Partial<App> = {}): EventRuleTx =>
  ({ pos, txid: tid(n), tx: { app: { type: "Propose", domain: "cairnx:v1", payloadHash: HASH, uri: "{}", expiresEpoch: 9000, ...app } as App, outputs: [] } });
const empty = (): EventsSoFar => ({ eventIds: new Set<string>(), proposeIds: new Set<string>() });
const block = [prop(1, 1), prop(2, 2)];
ok("the honest call shape returns both events", blockEvents(H, block, empty(), [AU, AU]).length === 2);
throws("one author short is refused", () => blockEvents(H, block, empty(), [AU]));
throws("one author too many is refused", () => blockEvents(H, block, empty(), [AU, AU, AU]));

// §32 as corrected: resolve() fed both copies of a re-mined mint drops the later one only when both are at or above
// V29; the rule's output holds the first copy alone.
const issuer = (pos: number, n: number, built: { uri: string; payloadHash: string }, outputs: TxOutput[] = []): EventRuleTx =>
  ({ pos, txid: tid(n), tx: { app: { type: "Propose", domain: "cairnx:v1", payloadHash: built.payloadHash, uri: built.uri, expiresEpoch: 9000 }, outputs } });
const dep = issuer(1, 0xd1, deploy({ ticker: "DUP", decimals: 0, supply: "1000", mint: "issuer" }), [{ value: DEPLOY_FEE, scriptPubkey: TREASURY_ADDR }]);
const mnt = issuer(1, 0xd2, mint({ ticker: "DUP", amount: "100" }));
const ruleOver = (blocks: [number, EventRuleTx[]][]) => {
  const s = empty(), evs: ChainEvent[] = [];
  for (const [h, txs] of blocks) {
    const got = blockEvents(h, txs, s, blockMembers(h, txs, s).map(() => AU));
    for (const e of got) { (s.eventIds as Set<string>).add(idOf(e)); if (e.kind === "propose") (s.proposeIds as Set<string>).add(e.id); }
    evs.push(...got);
  }
  return evs;
};
const minted = (evs: ChainEvent[]) => resolve(evs, V29_HEIGHT + 100).tokens.DUP?.minted;
const asCopy = (h: number) => ({ ...eventOfTx(mnt, h, AU)! });
const straddle = ruleOver([[V29_HEIGHT - 10, [dep]], [V29_HEIGHT - 1, [mnt]], [V29_HEIGHT + 1, [mnt]]]);
ok("the rule keeps one copy of a mint mined on both sides of V29", straddle.length === 2 && minted(straddle) === "100");
ok("resolve() fed both copies across V29 applies both", minted([...straddle, asCopy(V29_HEIGHT + 1)]) === "200");
ok("resolve() fed both copies at or above V29 applies one", minted([straddle[0]!, asCopy(V29_HEIGHT + 1), asCopy(V29_HEIGHT + 5)]) === "100");

console.log(`cairnx-core events rule (CONVENTION §33): ${pass} passed (${file.tx.length} tx and ${file.blocks.length} blocks vectors)`);
