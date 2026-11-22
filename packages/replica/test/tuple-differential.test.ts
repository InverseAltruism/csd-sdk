// The replica's tuple book against the resolver's (the reference copy test/fixtures/cairnx-tuple-c89ab86.ts, which the
// hosted front door serves), fed the same feed: every boundary either holds must be the same tuple in both.
// (1) The recorded capture (cairnx-core's block fixture as a csd-indexer, test/indexer-capture.ts) to 117,012: the
// replica's loop over indexerFeed, and the resolver's book advanced as its service advances it, one accepted scan per
// epoch (each scan's events are the capture's at or below that scan's tip: the Scanner's scan of the capture cut at a
// tip is exactly those, test/indexer-feed.test.ts). Every boundary from 29,880 to 117,000 is compared.
// (2) A synthetic chain through the resolver's own Scanner and the service's call shape, step by step: a growing tip,
// a reorg below kept boundaries that changes a record (both drop the boundaries above the fork and compute them again
// from the new branch), a reorg above every kept boundary (both keep them), and a refused scan (the tip block changed
// during it): the resolver withholds every tuple until an accepted scan, the replica commits nothing and keeps serving
// what it committed before, which equals what the resolver served before and serves again after.
import { FINAL_DEPTH, mint } from "@inversealtruism/cairnx-core";
import { memoryStore, replicaLoop, type Loop } from "../src/index.js";
import { branchRefusal, indexerFeed, Scanner } from "../src/server.js";
import { tupleOf, type Tuple } from "../src/tuple.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { TupleBook } from "./fixtures/cairnx-tuple-c89ab86.js";
import { captureIndexer } from "./indexer-capture.js";
import { A, H0, buildChain, defaultSpecs, type Spec } from "./scan/scan-chain.js";

const WIDE = { maxBlocks: 100_000, maxRequests: 100_000 };
const same = (a: Tuple | null | undefined, b: Tuple | null | undefined) => a != null && b != null && JSON.stringify(a) === JSON.stringify(b);
const hashReader = (f: typeof fetch) => async (h: number): Promise<string | null> => {
  const r = await f(`http://idx/block-height/${h}`);
  return r.ok ? String(await r.json()).toLowerCase() : null;
};
/** The boundaries the resolver's book serves now, by height. */
const served = (book: TupleBook) => new Map(book.heights().flatMap((h) => { const t = book.get(h); return t === undefined ? [] : [[h, t] as const]; }));

console.log("the recorded capture, every boundary to 117,000:");
{
  const TOP = 117_000 + FINAL_DEPTH, f = captureIndexer(fx, TOP), hashAt = hashReader(f);
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: f }), store: memoryStore(), ...WIDE });
  await loop.open();
  const s = await loop.advance();
  const all = (await new Scanner({ indexerUrl: "http://idx", fetch: f }).scan()).events;
  const book = new TupleBook(), theirs = new Map<number, Tuple>();
  let accepted = 0;
  for (let tip = 29_880 + FINAL_DEPTH; tip <= TOP; tip += 30) {
    if (await book.advance({ tip, tipHash: (await hashAt(tip))!, events: all.filter((e) => e.height <= tip), reorgEpoch: 0, hashAt })) accepted++;
    for (const [h, t] of served(book)) if (!theirs.has(h)) theirs.set(h, t);
  }
  const ours = loop.boundaryHeights(), diff = ours.filter((h) => !same(tupleOf(loop.boundary(h)), theirs.get(h)));
  ok(`the loop reached 117,012 and the resolver's book accepted every scan (${accepted})`, s.cursor?.height === TOP && accepted === Math.floor((TOP - 29_892) / 30) + 1);
  ok(`both hold the same boundaries (${ours.length}) and the same tuple at each: ${diff.length} differ`,
    ours.length === theirs.size && ours.every((h) => theirs.has(h)) && diff.length === 0 && ours[0] === 29_880 && ours.at(-1) === 117_000, diff.slice(0, 3).join(", "));
  await loop.close();
}

console.log("a synthetic chain: growth, a reorg below and above kept boundaries, a refused scan:");
{
  const at = (h: number, amount: string): Spec => ({ kind: "propose", rec: mint({ ticker: "DUST", amount }), proposer: A, height: h });
  const a = buildChain([...defaultSpecs(), at(H0 + 55, "6"), at(H0 + 95, "8")]);
  const b = buildChain([...defaultSpecs(), at(H0 + 57, "7"), at(H0 + 95, "8")], { forks: [{ name: "b", from: H0 + 50 }] });
  const c = buildChain([...defaultSpecs(), at(H0 + 57, "7"), at(H0 + 95, "8")], { forks: [{ name: "b", from: H0 + 50 }, { name: "c", from: H0 + 155 }] });
  let now: typeof fetch = a.indexer({ tip: H0 + 20 });
  const f = ((i: string, r?: RequestInit) => now(i, r)) as unknown as typeof fetch;
  const real = (async (i: string | URL | Request, r?: RequestInit) => {
    const x = (await f(String(i), r)) as unknown as { status: number; json(): Promise<unknown> };
    return x instanceof Response ? x : new Response(JSON.stringify(await x.json()), { status: x.status });
  }) as typeof fetch;
  const loop: Loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real, pageSize: 3 }), store: memoryStore(), ...WIDE });
  await loop.open();
  const scanner = new Scanner({ indexerUrl: "http://idx", fetch: real, pageSize: 3 }), book = new TupleBook(() => scanner.reorgEpoch), hashAt = hashReader(real);
  let compared = 0, differ = 0, steps = 0;
  /** One poll of each: the replica's advance, and the resolver's scan, then its book as its service runs it. */
  const step = async () => {
    steps++;
    await loop.advance();
    const r = await scanner.scan();
    if (branchRefusal(r.anchor) !== null) { book.withhold(); return; }
    if (!(await book.advance({ tip: r.tipHeight, tipHash: r.anchor.hashAfter!, events: r.events, reorgEpoch: scanner.reorgEpoch, hashAt }))) book.withhold();
  };
  const compare = () => { for (const [h, t] of served(book)) { compared++; if (!same(tupleOf(loop.boundary(h)), t)) differ++; } };
  const ours = () => new Map(loop.boundaryHeights().map((h) => [h, JSON.stringify(tupleOf(loop.boundary(h)))]));
  for (let tip = H0 + 20; tip <= H0 + 140; tip += 10) { now = a.indexer({ tip }); await step(); compare(); }
  const onA = ours();
  ok(`branch A to ${H0 + 140}: the same tuple at every boundary served (${served(book).size})`, served(book).size === onA.size && differ === 0);
  now = b.indexer({ tip: H0 + 150 });
  await step(); compare();
  const onB = ours(), s1 = loop.status();
  const fork = [...onA.keys()].filter((h) => h >= H0 + 50);
  ok(`a reorg from ${H0 + 50} with a record changed: both computed the boundaries above it again (${fork.join(", ")}), equal`,
    s1.lastReorg !== null && fork.every((h) => onB.get(h) !== onA.get(h)) && [...onA.keys()].filter((h) => h < H0 + 50).every((h) => onB.get(h) === onA.get(h)) &&
    differ === 0 && served(book).size === onB.size);
  // A refused scan: the block at the tip changes between the scan's reads.
  let reads = 0;
  const steady = b.indexer({ tip: H0 + 160 });
  now = (async (i: string, r?: RequestInit) => (String(i).endsWith(`/block-height/${H0 + 160}`) && reads++ % 2 === 1
    ? ({ ok: true, status: 200, json: async () => "0x" + "ee".repeat(32) } as unknown as Response) : steady(i, r))) as unknown as typeof fetch;
  await step();
  const refused = ours();
  ok("a refused scan: the resolver withholds every tuple, the replica commits nothing and keeps what it served",
    loop.status().lastError?.code === "BRANCH_MOVED" && served(book).size === 0 && [...onB].every(([h, t]) => refused.get(h) === t) && refused.size === onB.size);
  now = b.indexer({ tip: H0 + 170 });
  await step(); compare();
  ok("the next accepted scan: both serve again, equal at every boundary", served(book).size === loop.boundaryHeights().length && differ === 0);
  // A reorg above every kept boundary: C leaves B at H0 + 155, above the newest boundary 12 deep at H0 + 170 (H0 + 140).
  const keptB = ours();
  now = c.indexer({ tip: H0 + 170 });
  await step(); compare();
  const onC = ours();
  ok("a reorg above every kept boundary: both keep every tuple as it was", [...keptB].every(([h, t]) => onC.get(h) === t) && differ === 0);
  ok(`over ${steps} polls, ${compared} served tuples compared, ${differ} differ`, compared > 0 && differ === 0);
  await loop.close();
}

done("cairnx-replica tuple differential");
