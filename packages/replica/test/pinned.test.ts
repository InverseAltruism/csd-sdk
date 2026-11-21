// pinned (pinned.ts), derivePin and the presets local({ pin }) and hosted, over cairnx-core's block fixture and the
// recorded captures. A pin at 30,000 is derived from the fixture; each check of the first step is broken alone with
// every other check kept, and must refuse with nothing committed; the chain not holding the pin is PIN_OFF_CHAIN under
// each root; a refusal stays through a later step and a reopen; the honest path runs on the production call shape.
import { createHash } from "node:crypto";
import { CAIRNX_EVENT_RULE, FINAL_DEPTH, applyOrder, canonicalJson, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { hosted, hostedBlocks, local, nodeBlocks } from "../src/browser.js";
import { derivePin } from "../src/server.js";
import { memoryStore, open, openLog, pinned, ReplicaConfigError, replicaLoop, type Basis, type Pin, type Store } from "../src/index.js";
import { fixtureSource, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx, pinned as hashes } from "./core-files.js";
import { all, callerHeaders, front, ORIGIN } from "./hosted-harness.js";
import { branchFrom, cap, NODE, node } from "./node-harness.js";
import { hashAt, timeAt, witnessOn } from "./reader-harness.js";

const P = 30_000, TIP = cap.to, DEEP = TIP - FINAL_DEPTH, MIN = 60_000;
let now = timeAt(TIP) * 1000 + MIN;
const clock = () => now;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const truth = stateHash(resolve(corpus.events.filter((e) => e.height <= DEEP), DEEP));
const upTo = (h: number): BlockFixture => ({ ...fx, to: h, toHash: hashAt(h), blocks: fx.blocks.filter((b) => b.height <= h) });
const d = await derivePin(upTo(P)), text = new TextDecoder().decode(d.log);
const pinOf = (o: Partial<Omit<Pin, "log">> = {}, log: string | Uint8Array = d.log): Pin =>
  ({ ...d.pin, ...o, log: async () => (typeof log === "string" ? new TextEncoder().encode(log) : log) });
const syncSha = (t: string): string => `0x${createHash("sha256").update(t, "utf8").digest("hex")}`;

console.log("derivePin over cairnx-core's fixture:");
const d117 = await derivePin(fx), want117 = canonicalJson([...corpus.events].sort(applyOrder));
ok("the pin at 117,000 equals the corpus (sorted into the order of section 33.3) byte for byte and both hashes of hashes.json",
  new TextDecoder().decode(d117.log) === want117 && d117.pin.eventsHash === hashes["117000"]!.eventsHash && d117.pin.stateHash === hashes["117000"]!.stateHash &&
  d117.pin.blockHash === fx.toHash && d117.pin.logSha256 === syncSha(want117));
ok("its gate table is the loaded core's cut at the pin", Object.values(d117.pin.gates).every((h) => h <= 117_000) && d117.pin.gates.ACTIVATION_HEIGHT === 29_860 &&
  d117.pin.gates.V29_HEIGHT === 88_000);

console.log("the honest path, local({ node, pin }) and hosted({ pin, origin, witness }):");
const n0 = node({ answers: cap.answers }), r0 = await open({ ...local({ node: NODE, pin: pinOf(), fetch: n0.f }), clock }), s0 = await r0.advance();
const st0 = await r0.state(), below = n0.log.filter((l) => /^\/block\/height\/([0-9]+)$/.test(l.path) && Number(l.path.split("/")[3]) <= P).length;
ok("local with a pin: verified at level 3, proof pinned, the deep state equal to resolve() over the corpus, no block at or below the pin read",
  s0.verified && s0.level === 3 && s0.proof === "pinned" && s0.vouch.kind === "pinned" && s0.cursor?.height === TIP && st0.verified && stateHash(st0.value) === truth && below === 0,
  `${codes(s0)} below=${below}`);
await r0.close();
const live = witnessOn(all, TIP), hostedOf = (witness?: typeof live.witness) => hosted({ pin: pinOf(), origin: ORIGIN, fetch: front({ answers: all }).f, ...(witness ? { witness } : {}) });
const h0 = await open({ ...hostedOf(live.witness), clock }), hs0 = await h0.advance(), hst = await h0.state();
ok("hosted with a witness: verified, the deep state equal to resolve() over the corpus", hs0.verified && hst.verified && stateHash(hst.value) === truth, codes(hs0));
const h1 = await open({ ...hostedOf(), clock }), hs1 = await h1.advance();
ok("hosted with no witness: NOT_WITNESSED alone, never verified (the pin's branch is confirmed by no one)", codes(hs1) === "NOT_WITNESSED" && !hs1.verified);
await h0.close(); await h1.close();
const bl = replicaLoop({ source: pinned({ pin: pinOf(), then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) }), store: memoryStore() });
await bl.advance();
const pb = bl.boundary(P);
ok("the pin's boundary is held with the pin's block hash, events hash and state hash once it is FINAL_DEPTH deep",
  pb !== null && pb.hash === d.pin.blockHash && pb.eventsHash === d.pin.eventsHash && pb.stateHash === d.pin.stateHash);

console.log("each check of the first step, broken alone: refused, nothing committed:");
async function first(pin: Pin, rule = CAIRNX_EVENT_RULE, answers = cap.answers) {
  const loop = replicaLoop({ source: pinned({ pin, then: nodeBlocks({ node: NODE, fetch: node({ answers }).f }) }), store: memoryStore(), rule });
  return { s: await loop.advance() };
}
const twoAt = (() => { const evs = JSON.parse(text) as { height: number }[]; return evs.findIndex((e, i) => i > 0 && evs[i - 1]!.height === e.height); })();
const swapped = (() => { const evs = JSON.parse(text) as unknown[]; [evs[twoAt - 1], evs[twoAt]] = [evs[twoAt], evs[twoAt - 1]]; return canonicalJson(evs); })();
const flipped = text.replace('"uri":"{\\"', '"uri":"{ \\"');
const cases: [string, Pin, string][] = [
  ["one changed byte in the log (a space inside a uri)", pinOf({}, flipped), "PIN_MISMATCH"],
  ["the pin's logSha256 edited", pinOf({ logSha256: syncSha(`${text} `) }), "PIN_MISMATCH"],
  ["the log re-serialized with spaces, its sha256 carried", pinOf({ logSha256: syncSha(JSON.stringify(JSON.parse(text), null, 1)) }, JSON.stringify(JSON.parse(text), null, 1)), "PIN_MISMATCH"],
  [`two events of one block swapped (index ${twoAt}), the sha256 carried`, pinOf({ logSha256: syncSha(swapped) }, swapped), "PIN_MISMATCH"],
  ["the pin's eventsHash edited", pinOf({ eventsHash: d117.pin.eventsHash }), "PIN_MISMATCH"],
  ["the pin's gate table moved below the pin", pinOf({ gates: { ...d.pin.gates, V11_HEIGHT: 29_961 } }), "RULES_DIFFER"],
  ["the pin's stateHash edited", pinOf({ stateHash: d117.pin.stateHash }), "PIN_MISMATCH"],
  ["a pin of another rule, in a loop of CairnX's", pinOf({ rule: { domain: "other:v1", activationHeight: CAIRNX_EVENT_RULE.activationHeight } }), "PIN_MISMATCH"],
];
for (const [name, pin, code] of cases) {
  const f = await first(pin);
  ok(`${name}: ${code}, no cursor`, f.s.lastError?.code === code && f.s.cursor === null, `${f.s.lastError?.code} ${f.s.lastError?.reason}`);
}
ok("the flipped log really differs by one byte and the swap keeps the events hash and the state", flipped.length === text.length + 1 && twoAt > 0 &&
  JSON.stringify(resolve(JSON.parse(swapped), P)) === JSON.stringify(resolve(JSON.parse(text), P)));
const otherRule = { domain: "other:v1", activationHeight: CAIRNX_EVENT_RULE.activationHeight };
const ol = await openLog({ source: pinned({ pin: pinOf(), then: nodeBlocks({ node: NODE, fetch: n0.f }) }), rule: otherRule }).then(() => null, (e: unknown) => e);
ok("openLog of another rule over a CairnX pin throws ReplicaConfigError PIN_MISMATCH", ol instanceof ReplicaConfigError && ol.code === "PIN_MISMATCH");
const lo = await open(local({ node: NODE, pin: pinOf({ rule: otherRule }) })).then(() => null, (e: unknown) => e);
ok("open over a pin of another rule throws ReplicaConfigError PIN_MISMATCH", lo instanceof ReplicaConfigError && lo.code === "PIN_MISMATCH");

console.log("the chain does not hold the pin: PIN_OFF_CHAIN, nothing committed:");
const branch = { ...cap.answers, ...branchFrom(29_990) }, ballAll = { ...all, ...branchFrom(29_990) };
const offNode = await first(pinOf(), CAIRNX_EVENT_RULE, branch);
ok("one's own node serving another block at the pin", offNode.s.lastError?.code === "PIN_OFF_CHAIN" && offNode.s.cursor === null, offNode.s.lastError?.reason);
// A branch a server could serve needs valid proof of work, which branchFrom's re-mined headers lack; so the pin names
// another block (30,001's hash) at 30,000 and the server serves the recorded chain, whose seed is valid.
const offPin = pinOf({ blockHash: hashAt(P + 1) });
const offHosted = replicaLoop({ source: pinned({ pin: offPin, then: hostedBlocks({ origin: ORIGIN, root: { kind: "anchor", anchor: { height: P, hash: offPin.blockHash } }, fetch: front({ answers: all }).f }) }), store: memoryStore() });
const oh = await offHosted.advance();
ok("a pin naming another block than the front door's valid headers hold at its height", oh.lastError?.code === "PIN_OFF_CHAIN" && oh.cursor === null, oh.lastError?.reason);
const offCaller = replicaLoop({ source: pinned({ pin: pinOf(), then: hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: callerHeaders({ answers: ballAll, tip: TIP }).headers }, fetch: front({ answers: ballAll }).f }) }), store: memoryStore() });
const oc = await offCaller.advance();
ok("caller headers holding another block at the pin", oc.lastError?.code === "PIN_OFF_CHAIN" && oc.cursor === null, oc.lastError?.reason);

console.log("a reorg below the pin after the log loaded, and the refusal kept:");
const served = { answers: cap.answers }, nr = node(served), store1 = memoryStore();
const r1 = await open({ ...local({ node: NODE, pin: pinOf(), fetch: nr.f }), store: store1, clock }), a1 = await r1.advance();
served.answers = branch;
now += 5 * MIN;
const a2 = await r1.advance();
ok("the node forks at 29,990, below the pin: PIN_OFF_CHAIN in why, not verified, the cursor still the recorded 30,300",
  a1.verified && !a2.verified && codes(a2).split(",").includes("PIN_OFF_CHAIN") && a2.cursor?.hash === hashAt(TIP), codes(a2));
served.answers = cap.answers;
now += 10 * MIN;
const reads = nr.log.length, a3 = await r1.advance();
ok("the node back on the recorded chain, a step taken 10 minutes later: still PIN_OFF_CHAIN, `then` not asked again",
  codes(a3).split(",").includes("PIN_OFF_CHAIN") && !a3.verified && a3.lastError?.code === "PIN_OFF_CHAIN" && nr.log.length === reads, codes(a3));
await r1.close();
now = timeAt(TIP) * 1000 + MIN;
const r2 = await open({ ...local({ node: NODE, pin: pinOf(), fetch: node({ answers: branch }).f }), store: store1, clock }), a4 = await r2.advance();
ok("the store reopened under the same pin over the forked node: PIN_OFF_CHAIN again, never verified", !a4.verified && codes(a4).split(",").includes("PIN_OFF_CHAIN"), codes(a4));
await r2.close();
const r3 = await open({ source: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }), store: store1, clock }), a5 = await r3.advance();
ok("the store reopened under another source (the node alone): reset, its answers vouched by blocks from activation, none by the pin",
  a5.vouch.kind === "blocks" && a5.proof === "inclusion" && a5.verified);
await r3.close();
const bad = pinOf({ eventsHash: d117.pin.eventsHash }), store2 = memoryStore();
for (const k of [1, 2]) {
  const r = await open({ ...local({ node: NODE, pin: bad, fetch: n0.f }), store: store2, clock }), a = await r.advance();
  ok(`a pin refused PIN_MISMATCH, open number ${k} over the same store: PIN_MISMATCH, nothing held`, codes(a).split(",").includes("PIN_MISMATCH") && a.cursor === null && !a.verified, codes(a));
  await r.close();
}

console.log("stores and bases:");
const fx300 = upTo(TIP), fstore: Store = memoryStore();
const feed = await open({ source: fixtureSource(fx300, { tipTime: timeAt(TIP) }), store: fstore, clock });
await feed.advance(); await feed.close();
const feedBasis: Basis = { kind: "feed", feed: "fixture", inclusion: false }, nf = node({ answers: cap.answers });
const overFeed = await open({ ...local({ node: NODE, pin: pinOf(), fetch: nf.f }), store: fstore, clock }), af = await overFeed.advance();
const belowF = nf.log.filter((l) => /^\/block\/height\/([0-9]+)$/.test(l.path) && Number(l.path.split("/")[3]) <= P).length;
ok("a store a feed filled, opened under a pin: reset, refilled from the log and blocks (the feed's basis no longer opens it)",
  af.verified && af.vouch.kind === "pinned" && belowF === 0 && !(await fstore.open({ format: 1, rule: CAIRNX_EVENT_RULE, basis: feedBasis })).ok);
await overFeed.close();
const dB = await derivePin(upTo(30_090)), pinB: Pin = { ...dB.pin, log: async () => dB.log }, nB = node({ answers: cap.answers }), storeAB = memoryStore();
const rA = await open({ ...local({ node: NODE, pin: pinOf(), fetch: n0.f }), store: storeAB, clock });
await rA.advance(); await rA.close();
const rB = await open({ ...local({ node: NODE, pin: pinB, fetch: nB.f }), store: storeAB, clock }), aB = await rB.advance();
const belowB = nB.log.filter((l) => /^\/block\/height\/([0-9]+)$/.test(l.path) && Number(l.path.split("/")[3]) <= 30_090).length;
ok("a newer pin over a pinned memory store: reset and refilled from the newer log (the keep rule is the disk store's)",
  aB.verified && belowB === 0 && aB.cursor?.height === TIP && (aB.vouch as { pin: { height: number } }).pin.height === 30_090);
await rB.close();
await bl.close();
done("cairnx-replica pinned");
