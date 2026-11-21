// indexerFeed: the Scanner as a replica source. The recorded capture through the loop gives cairnx-core's corpus and
// its pinned events hash; with verifyInclusion the cursor is the final block, not the tip, and the next step resumes
// there; a request budget ends a step at a boundary; a branch switch during a scan is BRANCH_MOVED; a feed whose
// events below the cursor changed rolls back to the last event block that agrees and resumes on the new branch; a record
// below the activation height is left out.
import { ACTIVATION_HEIGHT, CAIRNX_EVENT_RULE, canonicalJson, type ChainEvent } from "@inversealtruism/cairnx-core";
import { levelOf, memoryStore, replicaLoop, type Cursor, type Loop, type Step } from "../src/index.js";
import { applyOrder } from "../src/order.js";
import { Scanner, indexerFeed } from "../src/server.js";
import { done, ok } from "./check.js";
import { corpus, fx, pinned } from "./core-files.js";
import { captureIndexer } from "./indexer-capture.js";
import { H0, KA, KB, KC, KEYS, buildChain, defaultSpecs, type Spec } from "./scan/scan-chain.js";

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
  ok("a tip above the final height: the cursor is the final block with its hash, the tip stays the indexer's",
    first.kind === "blocks" && first.cursor.height === H0 + 8 && first.cursor.hash === signed.hashAt(H0 + 8) && first.tip.height === H0 + 40,
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

done("cairnx-replica indexerFeed");
