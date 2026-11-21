// The reader (reader.ts) and its verified rule (verdict.ts), over the recorded captures (reader-harness.ts). The
// honest path, a replica synced to 30,300 under a caller root with a live witness, must answer verified with each
// value equal to what cairnx-core's resolve() gives over the pinned corpus at the deep height. Then each condition of
// the rule is broken alone, and the answer must carry exactly its code. Every clock is the test's.
import * as core from "@inversealtruism/cairnx-core";
import { CAIRNX_EVENT_RULE, FINAL_DEPTH, TREASURY_ADDR, nameRegFee, resolve, stateHash, type CairnXState, type EventRule } from "@inversealtruism/cairnx-core";
import { hostedBlocks, hostedWitness, nodeWitness } from "../src/browser.js";
import { BUILT_GATES, coreCheck, gatesOf } from "../src/gates.js";
import { memoryStore, open, openLog, ReplicaConfigError, type Answer, type Store, type Witness } from "../src/index.js";
import { fixtureSource, fixtures, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { all, ANCHOR, callerHeaders, front, ORIGIN } from "./hosted-harness.js";
import { branchFrom, cap, node } from "./node-harness.js";
import { callerReader, hashAt, nodeSource, scripted, synth, timeAt, witnessOn } from "./reader-harness.js";

const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const outcome = <T>(p: Promise<T>) => p.then((v) => ({ v, e: null as unknown }), (e: unknown) => ({ v: null, e }));
const MIN = 60_000, TIP = cap.to, DEEP = TIP - FINAL_DEPTH;
const truth = (h: number): CairnXState => resolve(corpus.events.filter((e) => e.height <= h), h);
const deepTruth = truth(DEEP), HOLDER = Object.keys(deepTruth.balances.CAIRN!)[0]!;
let now = timeAt(TIP) * 1000 + MIN;
const clock = () => now;

console.log("the honest path: caller root to 30,300, a live witness, depth 12:");
const live = witnessOn(all, TIP), honest = await callerReader(TIP, { witnesses: [live.witness], clock });
const hs = await honest.r.advance();
const bal = await honest.r.balance("CAIRN", HOLDER), prim = await honest.r.primary(HOLDER), st = await honest.r.state();
ok("the status is verified at level 3 with records proven for inclusion, the tip the caller's 30,300 and the confirmation at it",
  hs.verified && codes(hs) === "" && hs.level === 3 && hs.proof === "inclusion" && hs.cursor?.height === TIP && hs.witnessed?.height === TIP && hs.at?.tipHeight === TIP);
ok(`balance: verified, read at ${DEEP} (depth 12), equal to resolve() over the corpus there`, bal.verified &&
  bal.value.available === deepTruth.balances.CAIRN![HOLDER]!.available && bal.value.locked === deepTruth.balances.CAIRN![HOLDER]!.locked &&
  bal.value.deployId === deepTruth.tokens.CAIRN!.deployId && bal.at?.deepHeight === DEEP && bal.at.depth === FINAL_DEPTH && bal.at.tipTime === timeAt(TIP));
ok("primary and state(): verified, equal to resolve() over the corpus at the deep height", prim.verified && prim.value.name === core.pickPrimaryName(Object.values(deepTruth.names), HOLDER) &&
  st.verified && stateHash(st.value) === stateHash(deepTruth));
ok("state() hands out a copy: changing it changes no later answer", st.verified && ((st.value.tokens = {}), true) &&
  ((await honest.r.state()) as { value: CairnXState }).value.tokens.CAIRN !== undefined);
const evs = await honest.r.events(null, { limit: 1000 }), want = corpus.events.filter((e) => e.height <= DEEP).sort(core.applyOrder);
ok(`events(): verified, the ${want.length} corpus events at or below ${DEEP}, next at that height`, evs.verified && evs.value.items.length === want.length &&
  evs.value.items.every((e, i) => e.height === want[i]!.height && e.pos === want[i]!.pos) && evs.value.next.startsWith(`${DEEP}:`) && !evs.value.more);
const p1 = await honest.r.events(null, { limit: 5 }), p2 = await honest.r.events(p1.verified ? p1.value.next : null, { limit: 5 });
ok("events() pages: five, more, then the next five from the cursor", p1.verified && p1.value.more && p1.value.items.length === 5 && p2.verified &&
  p2.value.items[0]?.height === want[5]!.height && p2.value.items[0]?.pos === want[5]!.pos);
await honest.r.close();
const hw = hostedWitness({ origin: "https://second.example", fetch: front({ answers: all }).f }), nw = nodeWitness({ node: "http://203.0.113.9:8789", fetch: node({ answers: cap.answers }).f });
for (const [name, w] of [["hostedWitness over /api/rpc/tip and /api/headers", hw], ["nodeWitness over /tip and /block/height", nw]] as const) {
  const x = await callerReader(TIP, { witnesses: [w], clock }), s = await x.r.advance();
  ok(`${name}: it confirms the replica's tip`, s.verified && s.witnessed?.height === TIP);
  await x.r.close();
}

async function caller(tip: number, witnesses: Witness[] = [], extra = {}) {
  const x = await callerReader(tip, { witnesses, clock, ...extra });
  await x.r.advance();
  return x;
}
// name() and transfers() answer through the same verdict as balance(): each condition below is asserted on all three.
// NAMED is held with one record over the whole capture, so its two views agree and no SHALLOW enters.
const NAMED = "xname-8ma941";
const balanceWhy = async (x: { r: Awaited<ReturnType<typeof open>> }, o = {}) => {
  const b = codes(await x.r.balance("CAIRN", HOLDER, o)), n = codes(await x.r.name(NAMED, o)), t = codes(await x.r.transfers(HOLDER, null, o));
  return b === n && b === t ? b : `balance ${b}, name ${n}, transfers ${t}`;
};

console.log("each condition alone:");
const fx300: BlockFixture = { ...fx, to: TIP, toHash: hashAt(TIP), blocks: fx.blocks.filter((b) => b.height <= TIP) };
const feed = await open({ source: fixtureSource(fx300, { tipTime: timeAt(TIP) }), clock });
await feed.advance();
const fb = await feed.balance("CAIRN", HOLDER), fn = await feed.name(NAMED);
ok("a feed: LEVEL_FEED alone, the value in shown (balance and name)", codes(fb) === "LEVEL_FEED" && !fb.verified && fb.shown?.available === deepTruth.balances.CAIRN![HOLDER]!.available && fb.level === 1 &&
  codes(fn) === "LEVEL_FEED" && !fn.verified && fn.shown?.state === "held" && fn.shown.owner === deepTruth.names[NAMED]!.owner);

let tipCalls = 0;
const own = await open({ source: { ...nodeSource(), tip: async () => { tipCalls++; return null; } }, clock });
const statusBefore = own.status(), before = await own.balance("CAIRN", HOLDER), nameBefore = await own.name(NAMED);
await own.advance();
const ownAfter = await own.balance("CAIRN", HOLDER);
ok("before any step: NOT_SYNCED alone, nothing shown; one's own node needs no witness, so after the advance it is verified",
  codes(statusBefore) === "NOT_SYNCED" && !statusBefore.verified && codes(before) === "NOT_SYNCED" && before.at === null && !before.verified && before.shown === null && ownAfter.verified &&
  codes(nameBefore) === "NOT_SYNCED" && !nameBefore.verified && nameBefore.shown === null);
await own.events(null); await own.primary(HOLDER); await own.state(); await own.advance();
ok("the reader takes no tip from Source.tip(): none asked through open, advances and reads", tipCalls === 0 && own.status().verified);
await own.close();
const behind = await open({ source: nodeSource((t) => ({ ...t, height: t.height + 5, hash: synth(t.height + 5) })), clock });
await behind.advance();
ok("a tip above the cursor: BEHIND alone", (await balanceWhy({ r: behind })) === "BEHIND");
const above = await open({ source: nodeSource((t) => ({ ...t, height: t.height - 5, hash: hashAt(t.height - 5) })), clock });
await above.advance();
ok("a tip below the cursor (a root that vouches for no block above it now): BRANCH_UNRESOLVED alone", (await balanceWhy({ r: above })) === "BRANCH_UNRESOLVED");

now = timeAt(TIP) * 1000 + 31 * MIN;
const stale = await caller(TIP, [witnessOn(all, TIP).witness]);
ok("a 31-minute-old tip with a witness confirming now: TIP_STALE alone", (await balanceWhy(stale)) === "TIP_STALE");
now = timeAt(TIP) * 1000 + 29 * MIN;
const fresh29 = await caller(TIP, [witnessOn(all, TIP).witness]);
ok("control: a replica confirmed at 29 minutes is verified", (await fresh29.r.balance("CAIRN", HOLDER)).verified);
now = timeAt(TIP) * 1000 + MIN;

const BEH = TIP - 5;
now = timeAt(BEH) * 1000 + MIN;
const peer = await caller(BEH, [witnessOn(all, TIP).witness]);
ok(`a witness at ${TIP} with a valid, plausible header, the replica at ${BEH}: TIP_BEHIND_PEER alone`, (await balanceWhy(peer)) === "TIP_BEHIND_PEER" && peer.r.status().witnessed?.height === BEH);
const forged = witnessOn(all, TIP, { id: "forged", claim: (t) => ({ ...t, hash: hashAt(TIP - 1) }) });
const pf = await caller(BEH, [witnessOn(all, BEH).witness, forged.witness]);
ok("a higher tip whose header does not hash to the hash named does not count: verified", (await pf.r.balance("CAIRN", HOLDER)).verified);
const far = witnessOn(all, TIP, { id: "far", claim: (t) => ({ ...t, height: BEH + FINAL_DEPTH + 30 }) });
const pp = await caller(BEH, [witnessOn(all, BEH).witness, far.witness]);
ok(`a valid header named ${FINAL_DEPTH + 30} above the replica's tip denies, however far (no plausibility cap): TIP_BEHIND_PEER alone`, (await balanceWhy(pp)) === "TIP_BEHIND_PEER");
now = timeAt(TIP) * 1000 + MIN;

const lone = await caller(TIP);
ok("a caller root and no witness: NOT_WITNESSED alone", (await balanceWhy(lone)) === "NOT_WITNESSED");
const LOW = TIP - 20;
now = timeAt(LOW) * 1000 + MIN;
const low = await caller(LOW, [witnessOn(all, TIP).witness]);
ok(`a replica at ${LOW}, more than ${FINAL_DEPTH} below the witness's tip ${TIP}: TIP_BEHIND_PEER and NOT_WITNESSED, no confirmation`,
  (await balanceWhy(low)) === "TIP_BEHIND_PEER,NOT_WITNESSED" && low.r.status().witnessed === null);
const H1 = TIP - 20, H2 = Array.from({ length: 20 }, (_, i) => H1 + 1 + i).find((h) => timeAt(h) >= timeAt(H1) + 60)!;
now = timeAt(H1) * 1000;
const sw = witnessOn(all, H1), silent = await caller(H1, [sw.witness]);
const confirmed = silent.r.status().witnessed?.height === H1;
sw.w.silent = true;
silent.ch.c.tip = H2;
await silent.r.advance();
now = timeAt(H1) * 1000 + 29 * MIN;
const at29 = await silent.r.balance("CAIRN", HOLDER);
now = timeAt(H1) * 1000 + 31 * MIN;
const at31 = await silent.r.balance("CAIRN", HOLDER), name31 = await silent.r.name(NAMED);
ok(`confirmed at ${H1}, the witness silent since, the replica on to ${H2}: verified at 29 minutes, WITNESS_SILENT alone at 31, the value in shown`,
  confirmed && at29.verified && codes(at31) === "WITNESS_SILENT" && !at31.verified && at31.shown !== null && silent.r.status().cursor?.height === H2 &&
  codes(name31) === "WITNESS_SILENT" && !name31.verified && name31.shown?.name === NAMED);
now = timeAt(TIP) * 1000 + MIN;

const rw = witnessOn(all, TIP), rolled = await caller(TIP, [rw.witness]);
const wasOk = rolled.r.status().verified && rolled.r.status().witnessed?.height === TIP;
rw.w.silent = true;
rolled.served.answers = rolled.ch.c.answers = { ...all, ...branchFrom(30_200) };
await rolled.r.advance();
const rrs = rolled.r.status();
ok("the caller reorganises from 30,200: the rollback below the confirmed block clears it, NOT_WITNESSED alone though the witness confirmed a minute ago",
  wasOk && rrs.lastReorg?.to.height === 30_180 && rrs.cursor?.height === TIP && rrs.witnessed === null && codes(rrs) === "NOT_WITNESSED");

const alt = { ...core, resolve: (...a: Parameters<typeof resolve>) => resolve(...a) };
const differ = await caller(TIP, [witnessOn(all, TIP).witness], { core: { ...alt, V29_HEIGHT: 30_000 } });
ok("a caller's core with V29 at 30,000, at or below the tip: RULES_DIFFER alone", (await balanceWhy(differ)) === "RULES_DIFFER");
const later = await caller(TIP, [witnessOn(all, TIP).witness], { core: { ...alt, V29_HEIGHT: 99_999 } });
ok("the same core with V29 moved above the tip: verified (tables compared cut at the tip)", (await later.r.balance("CAIRN", HOLDER)).verified);
const two = await caller(TIP, [witnessOn(all, TIP).witness], { core: alt });
const tw = await two.r.balance("CAIRN", HOLDER);
ok("a second core module with the same table: verified, with the note TWO_CORES", tw.verified && tw.notes.some((n) => n.code === "TWO_CORES"));
const same = await caller(TIP, [witnessOn(all, TIP).witness], { core });
ok("the loaded core itself: verified, no note", (await same.r.balance("CAIRN", HOLDER)).notes.length === 0);
const wr = await caller(TIP, [witnessOn(all, TIP, { rules: { ...gatesOf(core), V12_HEIGHT: 30_301 } }).witness]);
ok("a witness whose gate table has V12 at 30,301: RULES_DIFFER alone", (await balanceWhy(wr)) === "RULES_DIFFER");
const wq = await caller(TIP, [witnessOn(all, TIP, { rules: gatesOf(core) }).witness]);
ok("a witness with the loaded table: verified", (await wq.r.balance("CAIRN", HOLDER)).verified);
ok("the built gate table equals the workspace cairnx-core's", JSON.stringify(gatesOf(core)) === JSON.stringify(gatesOf(BUILT_GATES)) && Object.keys(BUILT_GATES).length === 20);
ok("a loaded core that differs from the built table differs at the tip, not below its gate", coreCheck(undefined, { ...BUILT_GATES, V12_HEIGHT: 30_299 }).differ(30_299) &&
  !coreCheck(undefined, { ...BUILT_GATES, V29_HEIGHT: 90_000 }).differ(88_000 - 1) && !coreCheck(undefined).differ(Number.POSITIVE_INFINITY));

console.log("SHALLOW, on synthetic blocks: a name set as primary at 30,290:");
const AL = `0x${"a1".repeat(20)}`, f = fixtures({ lower: true });
const reg = f.prop({ v: 1, t: "name", name: "alice" }, { proposer: AL, height: 30_010, paidTo: { [TREASURY_ADDR]: String(nameRegFee("alice", 30_010)) } });
const set = f.prop({ v: 1, t: "nset", name: "alice", addr: AL }, { proposer: AL, height: 30_290 });
ok("precondition: resolve() gives alice as AL's primary at 30,290 and none at 30,289", core.pickPrimaryName(Object.values(resolve([reg, set], 30_290).names), AL) === "alice" &&
  core.pickPrimaryName(Object.values(resolve([reg], 30_289).names), AL) === null);
const syn = () => scripted([{ height: 30_010, hash: synth(30_010), events: [reg] }, { height: 30_290, hash: synth(30_290), events: [set] }], { height: TIP, hash: synth(TIP), time: now / 1000 });
const sh = await open({ source: syn(), clock });
await sh.advance();
const p12 = await sh.primary(AL), p5 = await sh.primary(AL, { minDepth: 5 }), p0 = await sh.primary(AL, { minDepth: 0 });
ok("at the default depth the two views differ: SHALLOW alone, the tip view's name in shown", codes(p12) === "SHALLOW" && !p12.verified && p12.shown?.name === "alice");
ok("at depth 5 and 0 both views name alice: verified", p5.verified && p5.value.name === "alice" && p0.verified && p0.value.name === "alice");
const b12 = await sh.balance("CAIRN", AL);
ok("a balance is the deep view and is verified while a name moved (no atTip when the views agree)", b12.verified && b12.value.available === "0" && !("atTip" in b12.value));

console.log("atTip, INPUT_INVALID, notes:");
const XFER = corpus.events.filter((e) => e.height <= TIP && e.kind === "propose" && e.uri.includes('"t":"transfer"')).sort(core.applyOrder).at(-1)!;
const md = TIP - XFER.height + 1, ownR = await open({ source: nodeSource(), clock });
await ownR.advance();
const holders = Object.keys(truth(TIP).balances.CAIRN ?? {}), moverAll = holders.map((a) => [a, truth(XFER.height - 1).balances.CAIRN?.[a]?.available, truth(TIP).balances.CAIRN?.[a]?.available] as const);
const mover = moverAll.find(([, x, y]) => x !== y)!;
const ab = await ownR.balance("CAIRN", mover[0], { minDepth: md });
ok(`a transfer at ${XFER.height} inside the last ${md} blocks: the deep balance as the value, the tip's as atTip`, ab.verified &&
  ab.value.available === (mover[1] ?? "0") && ab.value.atTip?.available === mover[2]);
const bad = [await ownR.balance("cairn", HOLDER), await ownR.balance("CAIRN", "0x12"), await ownR.balance("CAIRN", HOLDER, { minDepth: -1 }),
  await ownR.balance("CAIRN", HOLDER, { minDepth: TIP + 1 }), await ownR.events("12:x" as `${number}:${number}`), await ownR.events(null, { limit: 0 })];
ok("a lower-case ticker, a short address, a negative depth, a depth above the tip, a bad cursor, a zero limit: INPUT_INVALID alone, nothing shown",
  bad.every((a) => codes(a) === "INPUT_INVALID" && !a.verified && a.shown === null));
ok("an address in upper case is read in lower case", ((await ownR.balance("CAIRN", HOLDER.toUpperCase().replace("0X", "0x"))) as Answer<{ address: string }>).value?.address === HOLDER);
const ahead = await ownR.events("40000:0");
ok("an events cursor above the replica's: CURSOR_ABOVE_TIP noted, no items, the cursor kept", ahead.verified && ahead.notes.some((n) => n.code === "CURSOR_ABOVE_TIP") &&
  ahead.value.items.length === 0 && ahead.value.next === "40000:0");
const other = witnessOn({ ...all, ...branchFrom(TIP - 3) }, TIP, { id: "other", origin: "https://other.example" });
const dis = await caller(TIP, [witnessOn(all, TIP).witness, other.witness]);
const da = await dis.r.balance("CAIRN", HOLDER);
ok("a second witness on another branch at the same height voids the first's confirmation: NOT_WITNESSED, noted SOURCES_DISAGREE",
  codes(da) === "NOT_WITNESSED" && da.notes.some((n) => n.code === "SOURCES_DISAGREE"));
const broken: Store = { ...memoryStore(), open: async () => { throw new Error("disk gone"); } };
const un = await open({ source: nodeSource(), store: broken, clock });
const ua = await un.balance("CAIRN", HOLDER);
ok("a store that throws at open: NOT_SYNCED, noted STORE_UNAVAILABLE", codes(ua) === "NOT_SYNCED" && ua.notes.some((n) => n.code === "STORE_UNAVAILABLE"));

console.log("what open() refuses:");
const hi = callerHeaders({ answers: all, tip: TIP });
const hiSource = hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: { ...hi.headers, floor: 29_960 } }, fetch: front({ answers: all }).f });
const hiOpen = await outcome(open({ source: hiSource, clock }));
ok("caller headers from 29,960, above the activation height less one, without a pin: BELOW_FLOOR", hiOpen.e instanceof ReplicaConfigError && hiOpen.e.code === "BELOW_FLOOR");
const anc = hostedBlocks({ origin: ORIGIN, root: { kind: "anchor", anchor: { height: 29_900, hash: hashAt(29_900) } }, fetch: front({ answers: all }).f });
const ancOpen = await outcome(open({ source: anc, clock }));
ok("an anchor at 29,900: BELOW_FLOOR", ancOpen.e instanceof ReplicaConfigError && ancOpen.e.code === "BELOW_FLOOR");
const okAnchor = await outcome(open({ source: hostedBlocks({ origin: ORIGIN, root: { kind: "anchor", anchor: ANCHOR }, fetch: front({ answers: all }).f }), clock }));
ok("control: the anchor at 29,859 opens", okAnchor.e === null);
const onHeaders = await outcome(callerReader(TIP, { witnesses: [witnessOn(all, TIP, { origin: "https://headers.example/witness" }).witness], clock }));
const onFront = await outcome(open({ source: hostedBlocks({ origin: ORIGIN, root: { kind: "anchor", anchor: ANCHOR }, fetch: front({ answers: all }).f }),
  witnesses: [witnessOn(all, TIP, { origin: `${ORIGIN}/api` }).witness], clock }));
ok("a witness on the header source's origin (the caller's, or the front door under an anchor root): ReplicaConfigError",
  onHeaders.e instanceof ReplicaConfigError && onHeaders.e.code === null && onFront.e instanceof ReplicaConfigError);
const dispOpen = await outcome(open({ source: { ...nodeSource(), basis: { kind: "display", origin: "https://api.example" } }, clock }));
ok("a display basis: ReplicaConfigError (read through ./display)", dispOpen.e instanceof ReplicaConfigError);
const reused = memoryStore();
await (await open({ source: fixtureSource(fx300, { tipTime: now / 1000 }), store: reused, clock })).advance();
const reopened = await open({ source: nodeSource(), store: reused, clock });
await reopened.advance();
ok("a store filled under another basis is reset and filled again", reopened.status().cursor?.height === TIP && reopened.status().verified);

console.log("openLog over synthetic blocks of another rule:");
const RULE: EventRule = { ...CAIRNX_EVENT_RULE, domain: "example:v1", activationHeight: 1_000 };
const g = fixtures({ lower: true });
const e1 = g.prop({ v: 1, t: "deploy", ticker: "AAA", decimals: 0, supply: "10", mint: "issuer" }, { proposer: AL, height: 1_002 });
const e2 = g.att({ proposalId: e1.id, attester: AL, score: 1, height: 1_005 });
const lg = await openLog({ rule: RULE, source: scripted([{ height: 1_002, hash: synth(1_002), events: [e1] }, { height: 1_005, hash: synth(1_005), events: [e2] }],
  { height: 1_020, hash: synth(1_020), time: now / 1000 }), clock });
await lg.advance();
const l12 = await lg.events(null), l0 = await lg.events(null, { minDepth: 0 });
ok("its events at depth 0 are both, verified at level 3; at depth 12 (deep height 1,008) both too", l0.verified && l0.value.items.length === 2 && l12.verified &&
  l12.value.items.length === 2 && l12.value.next === `1008:${Number.MAX_SAFE_INTEGER}` && l0.level === 3);
const l18 = await lg.events(null, { minDepth: 18 });
ok("at depth 18 (deep height 1,002) only the first", l18.verified && l18.value.items.length === 1 && l18.value.items[0]!.height === 1_002);

for (const r of [feed, behind, above, stale.r, fresh29.r, peer.r, pf.r, pp.r, lone.r, low.r, silent.r, rolled.r, differ.r, later.r, two.r, same.r, wr.r, wq.r, sh, ownR, dis.r, un, reopened, lg]) await r.close();
done("cairnx-replica reader");
