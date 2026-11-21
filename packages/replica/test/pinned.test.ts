// pinned (pinned.ts), derivePin and the presets local({ pin }) and hosted, over cairnx-core's block fixture and the
// recorded captures. A pin at 30,000 is derived from the fixture; each check of the first step is broken alone with
// every other check kept, and must refuse with nothing committed; the chain not holding the pin is PIN_OFF_CHAIN under
// each root; a refusal stays through a later step and a reopen; the honest path runs on the production call shape.
import { createHash } from "node:crypto";
import { CAIRNX_EVENT_RULE, FINAL_DEPTH, applyOrder, canonicalJson, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { hosted, hostedBlocks, local, nodeBlocks } from "../src/browser.js";
import { derivePin } from "../src/server.js";
import { checkPin, memoryStore, open, openLog, pinned, ReplicaConfigError, replicaLoop, type Basis, type BlocksSource, type Commit, type Pin, type Store } from "../src/index.js";
import { fixtureSource, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx, pinned as hashes } from "./core-files.js";
import { all, ANCHOR, callerHeaders, front, ORIGIN } from "./hosted-harness.js";
import { blockAt, branchFrom, cap, NODE, node, type Answers } from "./node-harness.js";
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
let fr = front({ answers: all });
const live = witnessOn(all, TIP), hostedOf = (witness?: typeof live.witness) => hosted({ pin: pinOf(), origin: ORIGIN, fetch: front({ answers: all }).f, ...(witness ? { witness } : {}) });
const h0 = await open({ ...hostedOf(live.witness), clock }), hs0 = await h0.advance(), hst = await h0.state();
ok("hosted with a witness: verified, the deep state equal to resolve() over the corpus", hs0.verified && hst.verified && stateHash(hst.value) === truth, codes(hs0));
const h1 = await open({ ...hostedOf(), clock }), hs1 = await h1.advance();
ok("hosted with no witness: NOT_WITNESSED alone, never verified (the pin's branch is confirmed by no one)", codes(hs1) === "NOT_WITNESSED" && !hs1.verified);
await h0.close(); await h1.close();
const own = memoryStore(), h2 = await open({ ...hosted({ pin: pinOf(), origin: ORIGIN, fetch: front({ answers: all }).f, witness: live.witness, store: own }), clock });
const hs2 = await h2.advance();
await h2.close();
const o2 = await own.open({ format: 1, rule: CAIRNX_EVENT_RULE, basis: hs2.vouch });
ok("hosted with a store: the reader fills that store, verified; without one each call has a memory store of its own",
  hs2.verified && o2.ok && o2.meta?.cursor?.height === TIP && hostedOf().store !== hostedOf().store && hostedOf().store !== undefined, codes(hs2));
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
let logBReads = 0;
const dB = await derivePin(upTo(30_090)), pinB: Pin = { ...dB.pin, log: async () => { logBReads++; return dB.log; } }, nB = node({ answers: cap.answers }), storeAB = memoryStore();
const rA = await open({ ...local({ node: NODE, pin: pinOf(), fetch: n0.f }), store: storeAB, clock });
await rA.advance(); await rA.close();
const rB = await open({ ...local({ node: NODE, pin: pinB, fetch: nB.f }), store: storeAB, clock }), aB = await rB.advance();
const belowB = nB.log.filter((l) => /^\/block\/height\/([0-9]+)$/.test(l.path) && Number(l.path.split("/")[3]) <= 30_090).length;
ok("a newer pin over a pinned memory store: kept by the loop's rule (whatever the store), the newer log not read, verified under it",
  aB.verified && belowB === 0 && logBReads === 0 && aB.cursor?.height === TIP && (aB.vouch as { pin: { height: number } }).pin.height === 30_090);
await rB.close();
await bl.close();

console.log("the review's fixes:");
/** A memory store counting the commits it accepted. */
function counted(): { store: Store; commits: Commit[] } {
  const inner = memoryStore(), commits: Commit[] = [];
  return { store: { ...inner, async commit(c) { const r = await inner.commit(c); if (r.ok) commits.push(c); return r; } }, commits };
}
now = timeAt(TIP) * 1000 + MIN;
// F1: an anchor root without a pin emits PIN_OFF_CHAIN for headers that do not link above its anchor; only a pinned
// basis puts that code in why, so the answer stays as it was before pins (verified, the step refused).
const shifted: Answers = { ...all };
for (let h = ANCHOR.height + 1; h < TIP; h++) { const b = blockAt(all, h + 1); b.height = h; shifted[`/block/height/${h}`] = JSON.stringify(b); }
const sv: { answers: Answers; tip?: number } = { answers: all }, np = await open({ source: hostedBlocks({ origin: ORIGIN, root: { kind: "anchor", anchor: ANCHOR, window: 8 }, fetch: front(sv).f }),
  witnesses: [witnessOn(all, TIP).witness], clock }), np0 = await np.advance();
sv.answers = shifted; sv.tip = TIP - 1; now += 2 * MIN;
const np1 = await np.advance(), npState = await np.state();
ok("no pin, an anchor root whose server stops linking: the step refused PIN_OFF_CHAIN, the answer verified as before pins",
  np0.verified && np1.lastError?.code === "PIN_OFF_CHAIN" && np1.verified && codes(np1) === "" && npState.verified, `${codes(np1)} ${np1.lastError?.code}`);
await np.close();
now = timeAt(TIP) * 1000 + MIN;
// F2: a root whose tip is below the pin: nothing is committed under any root.
const forked = { ...all, ...branchFrom(29_940) }, cb = counted(), hc = { answers: forked, tip: 29_950 as number | null };
const callerBelow = await open({ source: pinned({ pin: pinOf(), then: hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: callerHeaders(hc).headers }, fetch: front({ answers: forked }).f }) }),
  store: cb.store, witnesses: [witnessOn(forked, TIP).witness], clock }), cbs = await callerBelow.advance();
ok("a caller root whose headers end at 29,950, below the pin: SOURCE_UNAVAILABLE, 0 commits", cbs.lastError?.code === "SOURCE_UNAVAILABLE" && cb.commits.length === 0 && cbs.cursor === null,
  `${cbs.lastError?.code} commits=${cb.commits.length}`);
hc.tip = TIP; now += 2 * MIN;
const cbs2 = await callerBelow.advance();
ok("the same caller's headers then pass the pin on a branch without it: PIN_OFF_CHAIN, still 0 commits", cbs2.lastError?.code === "PIN_OFF_CHAIN" && cb.commits.length === 0, `${cbs2.lastError?.code} commits=${cb.commits.length}`);
await callerBelow.close();
const ob = counted(), ownBelow = await open({ source: pinned({ pin: pinOf(), then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers, tip: 29_990 }).f }) }), store: ob.store, clock });
const obs = await ownBelow.advance(), hb = counted();
const hostedBelow = await open({ source: pinned({ pin: pinOf(), then: hostedBlocks({ origin: ORIGIN, root: { kind: "anchor", anchor: { height: P, hash: d.pin.blockHash } }, fetch: front({ answers: all, tip: 29_990 }).f }) }),
  store: hb.store, witnesses: [witnessOn(all, TIP).witness], clock }), hbs = await hostedBelow.advance();
ok("one's own node and an anchor root with their tips at 29,990, below the pin: SOURCE_UNAVAILABLE, 0 commits each",
  obs.lastError?.code === "SOURCE_UNAVAILABLE" && ob.commits.length === 0 && hbs.lastError?.code === "SOURCE_UNAVAILABLE" && hb.commits.length === 0, `${obs.lastError?.code} ${hbs.lastError?.code}`);
await ownBelow.close(); await hostedBelow.close();
const atPin = await open({ ...local({ node: NODE, pin: pinOf(), fetch: node({ answers: cap.answers, tip: P }).f }), clock: () => timeAt(P) * 1000 + MIN }), atPinS = await atPin.advance();
ok("the honest node with its tip exactly at the pin: the log committed, the cursor the pin", atPinS.cursor?.height === P && atPinS.cursor.hash === d.pin.blockHash && atPinS.lastError === null);
await atPin.close();
// F3: a store that holds the pin's rows is bound to the descriptor at every reopen, without reading the log.
let logReads = 0;
const counting = (pin: Pin): Pin => ({ ...pin, log: async () => { logReads++; return pin.log(); } });
const shared = memoryStore(), edits: [string, Partial<Omit<Pin, "log">>, string][] = [
  ["eventsHash", { eventsHash: d117.pin.eventsHash }, "PIN_MISMATCH"], ["stateHash", { stateHash: d117.pin.stateHash }, "PIN_MISMATCH"],
  ["gate table", { gates: { ...d.pin.gates, V11_HEIGHT: 29_961 } }, "RULES_DIFFER"]];
const fill = await open({ ...local({ node: NODE, pin: pinOf(), fetch: node({ answers: cap.answers }).f }), store: shared, clock });
const fs0 = await fill.advance();
await fill.close();
for (const [name, edit, code] of edits) {
  logReads = 0;
  const r = await open({ ...local({ node: NODE, pin: counting(pinOf(edit)), fetch: node({ answers: cap.answers }).f }), store: shared, clock }), a = await r.advance(), st = await r.state();
  ok(`a store an honest reader filled, reopened under a descriptor with another ${name}: ${code}, not verified, the log not read`,
    fs0.verified && !a.verified && !st.verified && codes(a).split(",").includes(code) && logReads === 0, `${codes(a)} reads=${logReads}`);
  await r.close();
}
logReads = 0;
const honestAgain = await open({ ...local({ node: NODE, pin: counting(pinOf()), fetch: node({ answers: cap.answers }).f }), store: shared, clock }), ha = await honestAgain.advance();
ok("the same store reopened under the honest descriptor: verified, the log not read", ha.verified && logReads === 0, codes(ha));
await honestAgain.close();
// F4: the log's sets reach `then`: an Attest at 29,973 on a Propose at 29,969 is an event only with them.
const d970 = await derivePin(upTo(29_970)), want970 = corpus.events.filter((e) => e.height <= TIP).length;
const r970 = await open({ ...local({ node: NODE, pin: { ...d970.pin, log: async () => d970.log }, fetch: node({ answers: cap.answers }).f }), clock });
const s970 = await r970.advance(), st970 = await r970.state(), ev970 = await r970.events(null, { limit: 1000, minDepth: 0 });
ok(`a pin at 29,970: the ${want970} corpus events to 30,300 held and the deep state the corpus's`,
  s970.verified && ev970.verified && ev970.value.items.length === want970 && st970.verified && stateHash(st970.value) === truth, `${ev970.verified ? ev970.value.items.length : "-"} events`);
await r970.close();
// derivePin over a fixture that does not start at the activation height.
const late = await derivePin({ ...upTo(30_090), from: 30_001, blocks: fx.blocks.filter((b) => b.height > 30_000 && b.height <= 30_090) }).then(() => null, (e: unknown) => e);
ok("derivePin refuses a fixture that starts above the activation height", late instanceof Error && /starts at 30001/.test(late.message));
// The conditions the review found untested.
const wrongHosted = await open({ ...hosted({ pin: pinOf({ blockHash: hashAt(P + 1) }), origin: ORIGIN, fetch: (fr = front({ answers: all })).f, witness: witnessOn(all, TIP).witness }), clock });
const wh0 = await wrongHosted.advance(), whReads = fr.log.length;
now += 10 * MIN;
const wh1 = await wrongHosted.advance();
ok("the hosted preset over a pin naming another block: PIN_OFF_CHAIN kept, the front door not read again 10 minutes later",
  wh0.lastError?.code === "PIN_OFF_CHAIN" && wh1.lastError?.code === "PIN_OFF_CHAIN" && fr.log.length === whReads && !wh1.verified, `${fr.log.length - whReads} more reads`);
await wrongHosted.close();
now = timeAt(TIP) * 1000 + MIN;
const mixed: Answers = { ...all, [`/block/height/30100`]: branchFrom(30_100)["/block/height/30100"]! };
const mixedLoop = replicaLoop({ source: pinned({ pin: pinOf(), then: hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: callerHeaders({ answers: mixed, tip: TIP }).headers }, fetch: front({ answers: mixed }).f }) }),
  store: memoryStore(), clock: () => now });
const mxs = await mixedLoop.advance();
ok("caller headers that do not link at 30,101, above the pin: BRANCH_MOVED at 30,100, a step's refusal, not the pin's", mxs.lastError?.code === "BRANCH_MOVED" && mxs.cursor?.height === 30_100,
  `${mxs.lastError?.code} ${mxs.cursor?.height}`);
await mixedLoop.close();
const callerAt = (floor: number) => pinned({ pin: pinOf(), then: hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: { ...callerHeaders({ answers: all, tip: TIP }).headers, floor } }, fetch: front({ answers: all }).f }) });
const f990 = await open({ source: callerAt(29_990), witnesses: [witnessOn(all, TIP).witness], clock }), f990s = await f990.advance(), f001 = await open({ source: callerAt(30_001), clock }).then(() => null, (e: unknown) => e);
ok("a caller floor of 29,990 under the pin at 30,000: verified; 30,001: BELOW_FLOOR", f990s.verified && f001 instanceof ReplicaConfigError && f001.code === "BELOW_FLOOR", codes(f990s));
await f990.close();
const form = (o: Record<string, unknown>) => { try { checkPin({ ...pinOf(), ...o }); return null; } catch (e) { return e; } };
ok("checkPin refuses a height off an epoch boundary, one below the activation height, and a format other than 1",
  [{ height: P + 1 }, { height: 29_850 }, { format: 2 }].every((o) => form(o) instanceof ReplicaConfigError) && form({}) === null);

console.log("the second read's fixes:");
// The reopen bind under openLog: the loop holds no state, so no state hash is compared; the events hash binds the store.
const logStore = memoryStore(), logPin = () => pinned({ pin: pinOf(), then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) });
const lg1 = await openLog({ source: logPin(), store: logStore, rule: CAIRNX_EVENT_RULE, clock });
for (let i = 0; i < 3; i++) await lg1.advance();
const lgs1 = lg1.status();
await lg1.close();
const lg2 = await openLog({ source: logPin(), store: logStore, rule: CAIRNX_EVENT_RULE, clock }), lgs2 = await lg2.advance(), lgEv = await lg2.events(null, { limit: 1000 });
ok("openLog over a pin of its own rule: verified at 30,300, and again through a reopen, its events read verified",
  lgs1.verified && lgs1.cursor?.height === TIP && lgs2.verified && lgEv.verified && lgEv.value.items.length === corpus.events.filter((e) => e.height <= DEEP).length,
  `${codes(lgs1)} / ${codes(lgs2)} ${lgs2.lastError?.reason ?? ""}`);
await lg2.close();
// A log() that rejects is SOURCE_UNAVAILABLE with nothing committed, and is read again at the next step.
let tries = 0;
const flaky: Pin = { ...pinOf(), log: async () => { if (++tries < 3) throw new Error("not yet"); return d.log; } };
const fl = replicaLoop({ source: pinned({ pin: flaky, then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f }) }), store: memoryStore(), clock: () => now });
const fl1 = await fl.advance();
now += 10 * MIN; await fl.advance(); now += 10 * MIN;
const fl3 = await fl.advance();
ok("a log() that rejects twice: SOURCE_UNAVAILABLE with no cursor, then loaded on the third step", fl1.lastError?.code === "SOURCE_UNAVAILABLE" && fl1.cursor === null &&
  fl3.cursor?.height === TIP && tries === 3, `${fl1.lastError?.code} ${fl3.cursor?.height} tries=${tries}`);
await fl.close();
// An event at the pin's own height (30,330): its row keeps the pin's block hash.
const top330 = fx.blocks.find((b) => b.height === 30_330)!, d330 = await derivePin({ ...fx, to: 30_330, toHash: top330.hash, blocks: fx.blocks.filter((b) => b.height <= 30_330) });
const tip330 = { height: 30_330, hash: top330.hash, time: 0 };
const idleThen: BlocksSource = { basis: { kind: "blocks", root: { kind: "own-node", node: NODE }, bodies: NODE }, floor: null, tip: async () => tip330,
  next: async () => ({ kind: "idle", tip: tip330 }), block: async () => { throw new Error("no block is read"); } };
const l330 = replicaLoop({ source: pinned({ pin: { ...d330.pin, log: async () => d330.log }, then: idleThen }), store: memoryStore() });
await l330.advance();
const row330 = l330.rows(30_330)[0];
ok("a pin at 30,330, where an event lies: the pin's row holds that event and the pin's block hash", row330?.height === 30_330 && row330.events.length > 0 && row330.hash === top330.hash);
await l330.close();
done("cairnx-replica pinned");
