// CONVENTION §34, the state hash and the events hash: every vector of test/vectors/hashes.json against src, the corpus
// values, and what the language-neutral file does not hold (input JSON does not carry, and the call shapes production sends).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EVENTS_HASH_START, blockEvents, blockMembers, canonicalJson, eventsHash, eventsHashStep, resolve, stateHash,
  type ChainEvent, type EventRuleTx, type HashedEvent,
} from "../src/index.js";

let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; };
const throws = (name: string, fn: () => unknown) => { assert.throws(fn, /events hash/, name); pass++; };

type Case = { name: string; prev?: string; blocks: { height: number; events: HashedEvent[] }[]; expect: unknown };
type Pins = Record<string, { eventsHash: string; stateHash: string }>;
const raw = (f: string) => readFileSync(new URL(`./vectors/${f}`, import.meta.url));
const file = JSON.parse(raw("hashes.json").toString("utf8")) as
  { format: number; start: string; cases: Case[]; corpus: { file: string; sha256: string; heights: Pins } };

const run = (c: Case): unknown => {
  let steps: unknown = "prev" in c ? c.prev : EVENTS_HASH_START;
  for (let i = 0; i < c.blocks.length; i++) {
    try { steps = eventsHashStep(steps as string, c.blocks[i]!.height, c.blocks[i]!.events); } catch { steps = { error: i }; break; }
  }
  if ("prev" in c) return { steps };
  let list: unknown;
  try { list = eventsHash(c.blocks.flatMap((b) => b.events)); } catch { list = "error"; }
  return { steps, list };
};

ok("the start value is 32 zero bytes", file.format === 1 && file.start === "0x" + "00".repeat(32) && EVENTS_HASH_START === file.start);
ok("the file holds the cases", file.cases.length >= 40);
for (const c of file.cases) ok(`vector ${c.name}`, canonicalJson(run(c)) === canonicalJson(c.expect));

// Real data: the corpus is in feed order, so the events hash reads it in a stable sort by height. The state hashes are
// recomputed by vectors.test.ts against replay-hashes.json; here the file must carry those pins.
const corpusRaw = raw(file.corpus.file);
ok("the corpus part names the committed corpus", createHash("sha256").update(corpusRaw).digest("hex") === file.corpus.sha256);
const events = (JSON.parse(corpusRaw.toString("utf8")) as { events: ChainEvent[] }).events;
const pinned = JSON.parse(raw("replay-hashes.json").toString("utf8")) as { hashes: Record<string, string> };
ok("the corpus part covers every pinned height", canonicalJson(Object.keys(file.corpus.heights)) === canonicalJson(Object.keys(pinned.hashes)));
const byHeight = [...events].sort((a, b) => a.height - b.height);
for (const [H, want] of Object.entries(file.corpus.heights)) {
  ok(`corpus eventsHash @${H}`, eventsHash(byHeight.filter((e) => e.height <= Number(H))) === want.eventsHash);
  ok(`corpus stateHash @${H} is the replay pin`, want.stateHash === "0x" + pinned.hashes[H]);
}
throws("the corpus in feed order is refused (a height below the one before it)", () => eventsHash(events));

// stateHash is sha256 of canonicalState's UTF-8 bytes, over every case vector (the numeric profile keys of §5.1 A2
// among them), checked against node:crypto over the pinned expected state.
const cases = JSON.parse(raw("cases.json").toString("utf8")) as { cases: { events: ChainEvent[]; tipHeight: number; expectedState: unknown }[] };
let states = 0;
for (const c of cases.cases)
  if (stateHash(resolve(c.events, c.tipHeight)) === "0x" + createHash("sha256").update(JSON.stringify(c.expectedState), "utf8").digest("hex")) states++;
ok(`stateHash over ${cases.cases.length} case vectors (${states} equal)`, states === cases.cases.length);

// Input JSON does not carry.
const AU = "0x" + "a1".repeat(20), TX = "0x" + "11".repeat(32), H = 100_000;
const ev = (over: Partial<Record<string, unknown>> = {}) => ({ kind: "propose", id: TX, proposer: AU, height: H, pos: 1, ...over }) as HashedEvent;
for (const height of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 64]) throws(`a height of ${height} is refused`, () => eventsHashStep(EVENTS_HASH_START, height, [ev({ height })]));
throws("a bigint height is refused", () => eventsHashStep(EVENTS_HASH_START, 100_000n as unknown as number, []));
throws("a pos of NaN is refused", () => eventsHashStep(EVENTS_HASH_START, H, [ev({ pos: Number.NaN })]));
throws("a null event is refused", () => eventsHashStep(EVENTS_HASH_START, H, [null as unknown as HashedEvent]));
throws("events that are not a list are refused", () => eventsHashStep(EVENTS_HASH_START, H, undefined as unknown as HashedEvent[]));
throws("a list that is not a list is refused", () => eventsHash({} as unknown as HashedEvent[]));

// The call shape production sends: blockEvents' output, in apply order, for a block whose Attest precedes its Propose.
const pid = "0x" + "22".repeat(32);
const txs: EventRuleTx[] = [
  { pos: 1, txid: "0x" + "33".repeat(32), tx: { app: { type: "Attest", proposalId: pid, score: 100, confidence: 0 }, outputs: [] } },
  { pos: 2, txid: pid, tx: { app: { type: "Propose", domain: "cairnx:v1", payloadHash: TX, uri: "{}", expiresEpoch: 9000 }, outputs: [] } },
];
const sofar = { eventIds: new Set<string>(), proposeIds: new Set<string>() };
const applied = blockEvents(H, txs, sofar, blockMembers(H, txs, sofar).map(() => AU));
ok("blockEvents lists the Propose first", applied.map((e) => e.pos).join() === "2,1");
const step = eventsHashStep(EVENTS_HASH_START, H, applied);
ok("its events hash is that of position order", step === eventsHashStep(EVENTS_HASH_START, H, [...applied].reverse()) && step === eventsHash(applied));
ok("a block without events leaves the value", eventsHashStep(step, H + 1, []) === step);

console.log(`cairnx-core hashes (CONVENTION §34): ${pass} passed (${file.cases.length} vectors, ${Object.keys(file.corpus.heights).length} corpus heights)`);
