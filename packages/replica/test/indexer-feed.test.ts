// indexerFeed: the Scanner as a replica source. The recorded capture through the loop gives cairnx-core's corpus and
// its pinned events hash; with verifyInclusion the cursor is the final block, not the tip, and the next step resumes
// there; a request budget ends a step at a boundary; a branch switch during a scan is BRANCH_MOVED; a feed whose
// events below the cursor changed rolls back to the last event block that agrees and resumes on the new branch; a record
// below the activation height is left out, and so is an Attest on it; a verified tip that moves back rolls nothing
// back; a block hash the store holds that the indexer no longer gives rolls back to the last one it does.
import { ACTIVATION_HEIGHT, CAIRNX_EVENT_RULE, canonicalJson, mint, type ChainEvent } from "@inversealtruism/cairnx-core";
import { levelOf, memoryStore, open, replicaLoop, type Cursor, type Loop, type Step } from "../src/index.js";
import { applyOrder } from "../src/order.js";
import { Scanner, indexerFeed } from "../src/server.js";
import { fixtureSource, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx, pinned } from "./core-files.js";
import { captureIndexer } from "./indexer-capture.js";
import { A, H0, KA, KB, KC, KEYS, buildChain, defaultSpecs, timeAt, type Spec } from "./scan/scan-chain.js";

/** scan-chain's indexer answers objects shaped like a Response; the block-hash reads take a real one. */
const real = (f: typeof fetch): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const r = (await f(input, init)) as unknown as { status: number; json(): Promise<unknown> };
  return r instanceof Response ? r : new Response(JSON.stringify(await r.json()), { status: r.status });
}) as typeof fetch;
const canon = (events: readonly ChainEvent[]) => canonicalJson([...events].sort(applyOrder));
const held = (loop: Loop) => loop.rows(0).flatMap((r) => r.events);
const next = (src: ReturnType<typeof indexerFeed>, cursor: Cursor | null, maxRequests: number): Promise<Step> => src.next({
  rule: CAIRNX_EVENT_RULE, cursor, sofar: { eventIds: new Set(), proposeIds: new Set() }, hashAt: () => null, eventsHashAt: () => null,
  budget: { deadlineAt: Number.POSITIVE_INFINITY, maxRequests, maxBlocks: 10_000 }, signal: new AbortController().signal, now: () => 0,
});
const WIDE = { maxBlocks: 100_000, maxRequests: 100_000 };

console.log("basis:");
const plain = buildChain(defaultSpecs());
const signed = buildChain(defaultSpecs({ A: KA, B: KB, C: KC }), { keys: KEYS });
ok("a feed without inclusion is level 1", levelOf(indexerFeed({ indexerUrl: "http://idx" }).basis) === 1);
ok("with verifyInclusion it is level 2", levelOf(indexerFeed({ indexerUrl: "http://idx", ...signed.verified({ verifiedTip: H0 + 40 }) }).basis) === 2);

console.log("the recorded capture (29,860 to 117,000) through the loop:");
{
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://capture", fetch: captureIndexer(fx) }), store: memoryStore(), ...WIDE });
  await loop.open();
  const s = await loop.advance({ budgetMs: 600_000 });
  ok("the cursor is the capture's last block", s.cursor?.height === 117_000 && s.cursor.hash === fx.toHash && s.lastError === null, JSON.stringify(s.lastError));
  ok("the events hash at 117,000 is the one cairnx-core pins over its corpus", s.eventsHash === pinned["117000"]?.eventsHash);
  ok(`the ${corpus.events.length} events are the corpus's, in the order of section 33.3`, s.eventCount === corpus.events.length && canon(held(loop)) === canon(corpus.events));
  await loop.close();
}

console.log("verifyInclusion: the cursor is the final block");
{
  let verifiedTip = H0 + 20;
  const opts = { indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: H0 + 40 })), pageSize: 3,
    ...signed.verified({ verifiedTip: Number.MAX_SAFE_INTEGER }), verifiedTipHeight: async () => verifiedTip };
  const first = await next(indexerFeed(opts), null, 100);
  ok("an indexer's tip above the final height: the cursor is the final block with its hash, and so is the step's tip, with its time",
    first.kind === "blocks" && first.cursor.height === H0 + 8 && first.cursor.hash === signed.hashAt(H0 + 8) &&
    JSON.stringify(first.tip) === JSON.stringify({ height: H0 + 8, hash: signed.hashAt(H0 + 8), time: timeAt(H0 + 8) }),
    JSON.stringify(first.kind === "blocks" ? { cursor: first.cursor, tip: first.tip } : first));
  const loop = replicaLoop({ source: indexerFeed(opts), store: memoryStore(), ...WIDE });
  await loop.open();
  const a = await loop.advance();
  verifiedTip = H0 + 40;
  const b = await loop.advance();
  const all = (await new Scanner({ indexerUrl: "http://idx", fetch: signed.indexer({ tip: H0 + 40 }), pageSize: 3 }).scan()).events;
  ok("the next step resumes from the final block: every event once, none lost", a.cursor?.height === H0 + 8 && b.cursor?.height === H0 + 28 &&
    b.eventCount === all.length && canon(held(loop)) === canon(all), `${a.cursor?.height} ${b.cursor?.height} ${b.eventCount}/${all.length}`);
  await loop.close();
}

console.log("the request budget:");
{
  const opts = { indexerUrl: "http://idx", fetch: real(plain.indexer({ tip: H0 + 40 })), pageSize: 3 };
  const first = await next(indexerFeed(opts), null, 2);
  const boundary = Math.floor(ACTIVATION_HEIGHT / 30) * 30 + 30;
  ok("one boundary read: the step ends at that boundary, with the tip as its reach",
    first.kind === "blocks" && first.cursor.height === boundary && first.cursor.hash === plain.hashAt(boundary) && first.reach === H0 + 40);
  const loop = replicaLoop({ source: indexerFeed(opts), store: memoryStore(), maxBlocks: 64, maxRequests: 2 });
  await loop.open();
  const s = await loop.advance();
  const all = (await new Scanner(opts).scan()).events;
  ok("steps of one boundary each reach the tip with every event once", s.cursor?.height === H0 + 40 && canon(held(loop)) === canon(all) && s.eventCount === all.length);
  await loop.close();
}

console.log("a branch switch during the scan:");
{
  let reads = 0;
  const base = real(plain.indexer({ tip: H0 + 40 }));
  const flipping = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith(`/block-height/${H0 + 40}`) && reads++ > 0) return Response.json("0x" + "ee".repeat(32));
    return base(input, init);
  }) as typeof fetch;
  const moved = await next(indexerFeed({ indexerUrl: "http://idx", fetch: flipping, pageSize: 3 }), null, 100);
  ok("the tip block's hash changed between the scan's reads: BRANCH_MOVED", moved.kind === "cannot" && moved.code === "BRANCH_MOVED");
  const steady = await next(indexerFeed({ indexerUrl: "http://idx", fetch: base, pageSize: 3 }), null, 100);
  ok("paired: the same chain read steadily gives blocks", steady.kind === "blocks" && steady.cursor.height === H0 + 40);
}

console.log("a feed whose events below the cursor changed:");
{
  // Branch B keeps A's records up to H0 + 10 and replaces those above with one at H0 + 13; its blocks from H0 + 12 are its own.
  const specsA = defaultSpecs(), specsB: Spec[] = [...specsA.slice(0, 8), { ...specsA[9]!, height: H0 + 13 }];
  const chainB = buildChain(specsB, { forks: [{ name: "b", from: H0 + 12 }] });
  let fetchNow = real(plain.indexer({ tip: H0 + 40 }));
  const source = indexerFeed({ indexerUrl: "http://idx", fetch: ((i: string | URL | Request, r?: RequestInit) => fetchNow(i, r)) as typeof fetch, pageSize: 3 });
  const loop = replicaLoop({ source, store: memoryStore(), ...WIDE });
  await loop.open();
  const a = await loop.advance();
  fetchNow = real(chainB.indexer({ tip: H0 + 40 }));
  const b = await loop.advance();
  const want = (await new Scanner({ indexerUrl: "http://idx", fetch: chainB.indexer({ tip: H0 + 40 }), pageSize: 3 }).scan()).events;
  ok("the loop rolls back to the last event block both branches share", a.lastReorg === null && b.lastReorg?.to.height === H0 + 10, JSON.stringify(b.lastReorg));
  ok("and resumes with branch B's events, each once", b.cursor?.height === H0 + 40 && b.cursor.hash === chainB.hashAt(H0 + 40) && canon(held(loop)) === canon(want));
  await loop.close();
}

console.log("a record below the activation height:");
{
  // A cairnx:v1 Propose mined before the rule's activation is no event of the rule; the indexer lists it all the same.
  const early: Spec[] = [...defaultSpecs(), { ...defaultSpecs()[1]!, height: ACTIVATION_HEIGHT - 5 }];
  const chain = buildChain(early);
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(chain.indexer({ tip: H0 + 40 })), pageSize: 3 }), store: memoryStore(), ...WIDE });
  await loop.open();
  const s = await loop.advance();
  const all = (await new Scanner({ indexerUrl: "http://idx", fetch: chain.indexer({ tip: H0 + 40 }), pageSize: 3 }).scan()).events;
  ok("is left out of the steps, and the loop reaches the tip with every event from activation",
    s.cursor?.height === H0 + 40 && s.lastError === null && all.some((e) => e.height < ACTIVATION_HEIGHT) &&
    canon(held(loop)) === canon(all.filter((e) => e.height >= ACTIVATION_HEIGHT)), JSON.stringify(s.lastError));
  const again = await loop.advance();
  ok("and the next scan, which lists it again, agrees with the store: no rollback", again.lastReorg === null && again.cursor?.height === H0 + 40 &&
    again.eventCount === s.eventCount, JSON.stringify(again.lastReorg));
  await loop.close();
}

console.log("an Attest at or above activation on a Propose mined below it:");
{
  type Chain = ReturnType<typeof buildChain>;
  // The same chain as complete blocks, for the package's block path: cairnx-core's rule over each block's transactions.
  const blocksOf = (chain: Chain, tip: number): BlockFixture => {
    const heights = [...new Set(chain.txs.map((x) => x.height))].filter((h) => h <= tip).sort((a, b) => a - b);
    return { format: 1, from: heights[0]!, to: tip, toHash: chain.hashAt(tip), blocks: heights.map((height) => ({
      height, hash: chain.hashAt(height), txs: chain.txs.filter((x) => x.height === height).map((x) => {
        const app = x.tx.app as Record<string, unknown>;
        return { pos: x.pos, txid: x.txid, author: x.spec.kind === "propose" ? x.spec.proposer : x.spec.attester,
          app: { ...app, type: String(app.type), ...(app.type === "Propose" ? { expiresEpoch: String(app.expiresEpoch) } : {}) },
          outputs: x.tx.outputs.map((o) => ({ scriptPubkey: "0x" + o.scriptPubkey, value: String(o.value) })) };
      }) })) };
  };
  const base = defaultSpecs();
  const specs: Spec[] = [...base, { ...base[1]!, height: ACTIVATION_HEIGHT - 5 }, { kind: "attest", of: base.length, attester: A, score: 1, confidence: 0, height: H0 + 5 }];
  // Positions from 1, as in a block (position 0 is the coinbase, which the rule refuses to read as a record).
  const seen = new Map<number, number>();
  const chain = buildChain(specs.map((x) => { const pos = (seen.get(x.height) ?? 0) + 1; seen.set(x.height, pos); return { ...x, pos }; }));
  const feed = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(chain.indexer({ tip: H0 + 40 })), pageSize: 3 }), store: memoryStore(), ...WIDE });
  const blocks = replicaLoop({ source: fixtureSource(blocksOf(chain, H0 + 40)), store: memoryStore(), ...WIDE });
  await feed.open(); await blocks.open();
  const f = await feed.advance(), b = await blocks.advance();
  ok("the feed takes its steps to the tip", f.lastError === null && f.cursor?.height === H0 + 40, JSON.stringify(f.lastError));
  ok("its events and events hash are the block path's over the same chain (the Attest left out by both)",
    f.eventsHash === b.eventsHash && f.eventCount === b.eventCount && canon(held(feed)) === canon(held(blocks)) && f.eventCount === base.length,
    `${f.eventCount}/${b.eventCount}`);
  await feed.close(); await blocks.close();
}

console.log("verifyInclusion: the verified tip moves back, then forward:");
{
  let verifiedTip = H0 + 20;
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: H0 + 40 })), pageSize: 3,
    ...signed.verified({ verifiedTip: Number.MAX_SAFE_INTEGER }), verifiedTipHeight: async () => verifiedTip }), store: memoryStore(), ...WIDE });
  await loop.open();
  const a = await loop.advance();
  verifiedTip = 5;   // a header source syncing again from genesis
  const back = await loop.advance();
  ok("below the cursor, with no chain change: no rollback, no event lost", back.lastReorg === null && back.lastError === null &&
    back.cursor?.height === a.cursor?.height && back.eventCount === a.eventCount && a.eventCount > 0, JSON.stringify(back.lastReorg));
  verifiedTip = H0 + 40;
  const fwd = await loop.advance();
  const all = (await new Scanner({ indexerUrl: "http://idx", fetch: signed.indexer({ tip: H0 + 40 }), pageSize: 3 }).scan()).events;
  ok("forward again: the loop resumes from its cursor with every event once", fwd.cursor?.height === H0 + 28 && fwd.eventCount === all.length &&
    canon(held(loop)) === canon(all));
  await loop.close();
}

{
  // The verified tip moves back by ten blocks, the indexer's tip stays: the final height drops below the cursor, and
  // the cursor's block is still the indexer's.
  let verifiedTip = H0 + 40;
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: H0 + 40 })), pageSize: 3,
    ...signed.verified({ verifiedTip: Number.MAX_SAFE_INTEGER }), verifiedTipHeight: async () => verifiedTip }), store: memoryStore(), ...WIDE });
  await loop.open();
  const a = await loop.advance();
  verifiedTip = H0 + 30;
  const back = await loop.advance();
  ok("a final height ten blocks below the cursor, the indexer's tip above it: no rollback, no event lost",
    a.cursor?.height === H0 + 28 && back.lastReorg === null && back.cursor?.height === H0 + 28 && back.eventCount === a.eventCount, JSON.stringify(back.lastReorg));
  await loop.close();
}

console.log("the indexer's tip below the cursor, at a held boundary, at the floor and under it:");
{
  // One chain, no inclusion: the store to 30,090, then the indexer's tip drops to a height and stays there.
  const T0 = 30_090, live = { tip: T0 };
  const f = ((i: string | URL | Request, r?: RequestInit) => real(plain.indexer({ tip: live.tip }))(i, r)) as typeof fetch;
  const floor = ACTIVATION_HEIGHT - 1;
  for (const T1 of [30_061, 30_060, 30_030, 29_970, floor]) {
    live.tip = T0;
    const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: f, pageSize: 3 }), store: memoryStore(), ...WIDE });
    await loop.open();
    const a = await loop.advance();
    live.tip = T1;
    const s = await loop.advance();
    const unfinal = loop.boundaryHeights().filter((h) => h + 12 > T1);
    ok(`tip ${T0} to ${T1}: rolled back, the cursor the indexer's tip, no boundary served under 12 deep on its chain`,
      a.cursor?.height === T0 && s.lastReorg !== null && s.cursor?.height === T1 && s.cursor.hash === plain.hashAt(T1) && unfinal.length === 0 && s.lastError === null,
      JSON.stringify({ c: s.cursor?.height, r: s.lastReorg?.to.height, e: s.lastError, unfinal }));
    await loop.close();
  }
  live.tip = T0;
  const under = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: f, pageSize: 3 }), store: memoryStore(), ...WIDE });
  await under.open();
  await under.advance();
  live.tip = 100;
  const u = await under.advance();
  ok("tip under the floor: no block above it to roll back to, the step idle at the indexer's tip below the cursor",
    u.lastReorg === null && u.cursor?.height === T0 && u.tip?.height === 100 && u.lastError === null, JSON.stringify({ c: u.cursor?.height, t: u.tip, e: u.lastError }));
  live.tip = T0 + 5;
  const back = await under.advance();
  ok("and once the indexer's tip passes the cursor again on the same chain, it goes on from the cursor", back.lastReorg === null && back.cursor?.height === T0 + 5);
  await under.close();
}
{
  // With inclusion, a shorter branch above the boundary: A to 29,965 with a record at 29,952, the final height 29,953;
  // then B from 29,946 to 29,963, the final height 29,951, under the cursor 29,953.
  const B0 = H0 + 40, rec: Spec = { kind: "propose", rec: mint({ ticker: "DUST", amount: "7" }), proposer: KA, height: B0 + 12 };
  const a = buildChain([...defaultSpecs({ A: KA, B: KB, C: KC }), rec], { keys: KEYS });
  const b = buildChain(defaultSpecs({ A: KA, B: KB, C: KC }), { keys: KEYS, forks: [{ name: "b", from: B0 + 6 }] });
  let w = { chain: a, tip: B0 + 25 };
  const opts = { indexerUrl: "http://idx", fetch: ((i: string | URL | Request, r?: RequestInit) => real(w.chain.indexer({ tip: w.tip }))(i, r)) as typeof fetch, pageSize: 3,
    verifyInclusion: true, headerMerkleAt: (h: number) => w.chain.verified({ verifiedTip: w.tip }).headerMerkleAt!(h),
    rawTxAt: (id: string) => w.chain.verified({ verifiedTip: w.tip }).rawTxAt!(id), verifiedTipHeight: async () => w.tip };
  const loop = replicaLoop({ source: indexerFeed(opts), store: memoryStore(), ...WIDE });
  await loop.open();
  const s1 = await loop.advance();
  w = { chain: b, tip: B0 + 23 };
  const s2 = await loop.advance();
  const want = (await new Scanner({ indexerUrl: "http://idx", fetch: b.indexer({ tip: B0 + 23 }), pageSize: 3, ...b.verified({ verifiedTip: B0 + 23 }) }).scan()).events;
  ok("with inclusion, a shorter branch above the boundary under the cursor: rolled back, the record gone, ended at the new final height",
    s1.cursor?.height === B0 + 13 && s2.lastReorg?.to.height === B0 && s2.cursor?.height === B0 + 11 && s2.cursor.hash === b.hashAt(B0 + 11) &&
    canon(held(loop)) === canon(want.filter((e) => e.height <= B0 + 11)), JSON.stringify({ c1: s1.cursor?.height, c2: s2.cursor, r: s2.lastReorg, e: s2.lastError }));
  await loop.close();
}
{
  // With inclusion and the header source ahead of the indexer: the cursor is the indexer's tip; the verified tip then
  // moves back below it on the same chain.
  const TT = H0 + 70;
  for (const k of [1, 12, 30]) {
    let vt = TT + 400;
    const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: TT })), pageSize: 3,
      ...signed.verified({ verifiedTip: Number.MAX_SAFE_INTEGER }), verifiedTipHeight: async () => vt }), store: memoryStore(), ...WIDE });
    await loop.open();
    const a = await loop.advance();
    vt = TT - k;
    const s = await loop.advance();
    ok(`the cursor at the indexer's tip ${TT}, the verified tip back to ${TT - k}: no rollback`, a.cursor?.height === TT && s.lastReorg === null && s.cursor?.height === TT &&
      s.eventCount === a.eventCount, JSON.stringify({ a: a.cursor?.height, r: s.lastReorg }));
    await loop.close();
  }
}

console.log("block hashes the indexer no longer gives:");
{
  const TIP = H0 + 40;   // an epoch boundary
  const switching = (first: typeof fetch) => { const box = { now: first }; return { box, fetch: ((i: string | URL | Request, r?: RequestInit) => box.now(i, r)) as typeof fetch }; };
  // Blocks from TIP - 1 replaced, every record kept: the store's events agree, its hashes at TIP do not.
  const a = buildChain(defaultSpecs()), b = buildChain(defaultSpecs(), { forks: [{ name: "b", from: TIP - 1 }] });
  const sw = switching(real(a.indexer({ tip: TIP })));
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: sw.fetch, pageSize: 3 }), store: memoryStore(), ...WIDE });
  await loop.open();
  await loop.advance();
  sw.box.now = real(b.indexer({ tip: TIP }));
  const s = await loop.advance();
  ok("a reorg that changes no record rolls back to the last boundary whose hash agrees and ends on the new branch",
    s.lastReorg?.to.height === TIP - 30 && s.cursor?.height === TIP && s.cursor.hash === b.hashAt(TIP), JSON.stringify(s.lastReorg));
  sw.box.now = real(b.indexer({ tip: TIP + 30 }));
  await loop.advance();
  ok("the boundary row and the Boundary at TIP hold the new branch's hash", loop.rows(TIP).find((r) => r.height === TIP)?.hash === b.hashAt(TIP) &&
    loop.boundary(TIP)?.hash === b.hashAt(TIP));
  await loop.close();
}
{
  // The boundary block keeps its record while a record above it moves: the events agree up to the boundary, its hash does not.
  const TIP = H0 + 40, atB: Spec = { kind: "propose", rec: mint({ ticker: "DUST", amount: "7" }), proposer: A, height: TIP };
  const up = (h: number): Spec => ({ kind: "propose", rec: mint({ ticker: "DUST", amount: "9" }), proposer: A, height: h });
  const a = buildChain([...defaultSpecs(), atB, up(TIP + 2)]), b = buildChain([...defaultSpecs(), atB, up(TIP + 3)], { forks: [{ name: "b", from: TIP - 1 }] });
  let fetchNow = real(a.indexer({ tip: TIP + 5 }));
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: ((i: string | URL | Request, r?: RequestInit) => fetchNow(i, r)) as typeof fetch, pageSize: 3 }),
    store: memoryStore(), ...WIDE });
  await loop.open();
  await loop.advance();
  fetchNow = real(b.indexer({ tip: TIP + 5 }));
  const s = await loop.advance();
  const want = (await new Scanner({ indexerUrl: "http://idx", fetch: b.indexer({ tip: TIP + 5 }), pageSize: 3 }).scan()).events;
  ok("a record moved above a boundary whose block was replaced: the step rolls back below it and recovers",
    s.lastError === null && s.lastReorg?.to.height === TIP - 30 && s.cursor?.hash === b.hashAt(TIP + 5) && canon(held(loop)) === canon(want),
    JSON.stringify({ e: s.lastError, r: s.lastReorg }));
  await loop.close();
}
{
  // A shorter branch that changes no record: blocks from B + 6 replaced, the indexer's tip at B + 11, below the store's
  // cursor B + 13. The boundary B held below agrees; the cursor's block is not on the indexer's chain.
  const B = H0 + 40, a = buildChain(defaultSpecs()), b = buildChain(defaultSpecs(), { forks: [{ name: "b", from: B + 6 }] });
  let fetchNow = real(a.indexer({ tip: B + 13 }));
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: ((i: string | URL | Request, r?: RequestInit) => fetchNow(i, r)) as typeof fetch, pageSize: 3 }),
    store: memoryStore(), ...WIDE });
  await loop.open();
  const a1 = await loop.advance();
  fetchNow = real(b.indexer({ tip: B + 11 }));
  const s = await loop.advance();
  ok("a shorter branch with only block hashes changed: rolled back to the boundary that agrees, ended on the indexer's tip",
    a1.cursor?.height === B + 13 && s.lastReorg?.from.height === B + 13 && s.lastReorg.to.height === B && s.cursor?.height === B + 11 &&
    s.cursor.hash === b.hashAt(B + 11) && s.eventCount === a1.eventCount, JSON.stringify({ c: s.cursor, r: s.lastReorg }));
  await loop.close();
}
{
  // A read of the tip's height after the scan's two reads gives another branch: the cursor keeps the scan's own hash.
  const TIP = H0 + 40, base = real(plain.indexer({ tip: TIP }));
  let reads = 0;
  const late = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith(`/block-height/${TIP}`) && reads++ >= 2 ? Response.json("0x" + "ee".repeat(32)) : base(input, init)) as typeof fetch;
  const st = await next(indexerFeed({ indexerUrl: "http://idx", fetch: late, pageSize: 3 }), null, 100);
  ok("a boundary at the tip takes the tip's hash from the scan", st.kind === "blocks" && st.cursor.height === TIP && st.cursor.hash === st.tip.hash &&
    st.blocks.find((x) => x.height === TIP)?.hash === st.tip.hash);
}

console.log("the tip a step reports:");
{
  const TIP = H0 + 40, base = real(plain.indexer({ tip: TIP }));
  const st = await next(indexerFeed({ indexerUrl: "http://idx", fetch: base, pageSize: 3 }), null, 100);
  ok("without inclusion: the indexer's tip with the header time its /block/<hash> gives",
    st.kind === "blocks" && JSON.stringify(st.tip) === JSON.stringify({ height: TIP, hash: plain.hashAt(TIP), time: timeAt(TIP) }), JSON.stringify(st));
  for (const [what, body] of [
    ["another height", (b: Record<string, unknown>) => ({ ...b, height: TIP - 1 })], ["another hash", (b: Record<string, unknown>) => ({ ...b, hash: plain.hashAt(TIP - 1) })],
    ["a time that is not a whole number", (b: Record<string, unknown>) => ({ ...b, time: 1.5 })], ["no time", (b: Record<string, unknown>) => ({ ...b, time: undefined })],
  ] as const) {
    const lying = (async (i: string | URL | Request, r?: RequestInit) => {
      const got = await base(i, r);
      return String(i).includes("/block/0x") ? Response.json(body((await got.json()) as Record<string, unknown>)) : got;
    }) as typeof fetch;
    const bad = await next(indexerFeed({ indexerUrl: "http://idx", fetch: lying, pageSize: 3 }), null, 100);
    ok(`a /block answer with ${what}: SOURCE_MALFORMED`, bad.kind === "cannot" && bad.code === "SOURCE_MALFORMED", JSON.stringify(bad));
  }
  for (const [what, form] of [["without 0x", (h: string) => h.slice(2)], ["in upper case", (h: string) => `0x${h.slice(2).toUpperCase()}`]] as const) {
    const other = (async (i: string | URL | Request, r?: RequestInit) => {
      const got = await base(i, r);
      if (!String(i).includes("/block/0x")) return got;
      const b = (await got.json()) as Record<string, unknown>;
      return Response.json({ ...b, hash: form(String(b.hash)) });
    }) as typeof fetch;
    const st2 = await next(indexerFeed({ indexerUrl: "http://idx", fetch: other, pageSize: 3 }), null, 100);
    ok(`paired: a /block answer naming the hash ${what}, a form /block-height's reader takes, is the block`, st2.kind === "blocks" && st2.tip.time === timeAt(TIP), JSON.stringify(st2));
  }
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: base, pageSize: 3 }), store: memoryStore(), ...WIDE });
  await loop.open();
  const s = await loop.advance();
  ok("the loop takes that tip", s.tip?.height === TIP && s.tip.time === timeAt(TIP) && s.cursor?.height === TIP);
  await loop.close();
  const sig = new AbortController().signal, plainFeed = indexerFeed({ indexerUrl: "http://idx", fetch: base, pageSize: 3 });
  ok("Source.tip() without inclusion: the indexer's tip with its time", JSON.stringify(await plainFeed.tip(sig)) === JSON.stringify({ height: TIP, hash: plain.hashAt(TIP), time: timeAt(TIP) }));
  const incFeed = indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: TIP })), pageSize: 3, ...signed.verified({ verifiedTip: TIP }) });
  const before = await incFeed.tip(sig), first = await next(incFeed, null, 100), after = await incFeed.tip(sig);
  ok("Source.tip() with inclusion: null before the first step, then that step's tip, the final height", before === null && first.kind === "blocks" &&
    JSON.stringify(after) === JSON.stringify(first.tip) && after?.height === TIP - 12, JSON.stringify(after));
}
{
  // Through open(): the verdict and notes of a feed without and with inclusion, the clock a minute after the tip block.
  const TIP = H0 + 40, clockAt = (h: number) => () => (timeAt(h) + 60) * 1000;
  const why = (x: { why: readonly { code: string }[] }) => x.why.map((w) => w.code).join(",");
  const notes = (x: { notes: readonly { code: string }[] }) => x.notes.map((w) => w.code).join(",");
  const plainR = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: TIP })), pageSize: 3 }), clock: clockAt(TIP), step: WIDE });
  const p = await plainR.advance();
  ok("without inclusion: LEVEL_FEED alone, no note, the tip the indexer's", why(p) === "LEVEL_FEED" && notes(p) === "" && p.at?.tipHeight === TIP, `${why(p)} | ${notes(p)}`);
  await plainR.close();
  const final = TIP - 12;
  const incR = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: TIP })), pageSize: 3, ...signed.verified({ verifiedTip: TIP }) }),
    clock: clockAt(TIP), step: WIDE });
  const q = await incR.advance();
  ok(`with inclusion: the tip and the cursor are the final height ${final}, LEVEL_FEED alone, the note FINAL_VIEW`,
    q.level === 2 && q.cursor?.height === final && q.at?.tipHeight === final && why(q) === "LEVEL_FEED" && notes(q) === "FINAL_VIEW", `${why(q)} | ${notes(q)} | ${JSON.stringify(q.at)}`);
  await incR.close();
  // The final block is 12 target block times older than the chain's tip: not stale 45 minutes after it, stale after 55.
  const at = (min: number) => () => (timeAt(final) + min * 60) * 1000;
  for (const [min, stale] of [[45, false], [55, true]] as const) {
    const r = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: TIP })), pageSize: 3, ...signed.verified({ verifiedTip: TIP }) }),
      clock: at(min), step: WIDE });
    const x = await r.advance();
    ok(`with inclusion, ${min} minutes after the final block: ${stale ? "TIP_STALE" : "not stale"}`, why(x).includes("TIP_STALE") === stale, why(x));
    await r.close();
  }
  const r31 = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: TIP })), pageSize: 3 }), clock: () => (timeAt(TIP) + 31 * 60) * 1000, step: WIDE });
  const y = await r31.advance();
  ok("paired, without inclusion: 31 minutes after the tip block is TIP_STALE", why(y) === "LEVEL_FEED,TIP_STALE", why(y));
  await r31.close();
  // A step whose budget ends before the final height: its cursor below its tip, which the reader reports as BEHIND.
  const z = await next(indexerFeed({ indexerUrl: "http://idx", fetch: real(signed.indexer({ tip: TIP })), pageSize: 3, ...signed.verified({ verifiedTip: TIP }) }), null, 2);
  ok("with inclusion, a step that stops short of the final height: its cursor below its tip, the final height, its reach",
    z.kind === "blocks" && z.cursor.height < final && z.tip.height === final && z.reach === final, JSON.stringify(z.kind === "blocks" ? { c: z.cursor, t: z.tip, r: z.reach } : z));
}

done("cairnx-replica indexerFeed");
