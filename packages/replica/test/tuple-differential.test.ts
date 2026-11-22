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
// what it committed before, which equals what the resolver served before and, with no reorg below it meanwhile (README,
// "Tuples and a reference"), serves again after.
// (3) Rollbacks to a shorter branch that leave a kept boundary 1 to 11 blocks under the new cursor, with a record of the
// branch's own and with only block hashes changed: both withdraw it and serve it again once a branch 12 or more above
// it is back. After every accepted scan, each side serves exactly the
// boundaries the other does.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

/** The replica's loop over indexerFeed and the resolver's Scanner and book, both reading the indexer `now()` gives.
 *  `step` is one poll of each: the replica's advance, then the resolver's scan and its book as its service runs it;
 *  `compare` counts the tuples the book serves and those the replica's differs at, and after an accepted scan the polls
 *  where one side serves a boundary the other does not (`uneven`). */
async function pair(now: () => typeof fetch) {
  const f = ((i: string, r?: RequestInit) => now()(i, r)) as unknown as typeof fetch;
  const real = (async (i: string | URL | Request, r?: RequestInit) => {
    const x = (await f(String(i), r)) as unknown as { status: number; json(): Promise<unknown> };
    return x instanceof Response ? x : new Response(JSON.stringify(await x.json()), { status: x.status });
  }) as typeof fetch;
  const loop: Loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: real, pageSize: 3 }), store: memoryStore(), ...WIDE });
  await loop.open();
  const scanner = new Scanner({ indexerUrl: "http://idx", fetch: real, pageSize: 3 }), book = new TupleBook(() => scanner.reorgEpoch), hashAt = hashReader(real);
  const n = { steps: 0, compared: 0, differ: 0, uneven: 0 };
  let accepted = false;
  const step = async () => {
    n.steps++;
    await loop.advance();
    const r = await scanner.scan();
    accepted = false;
    if (branchRefusal(r.anchor) !== null) { book.withhold(); return; }
    accepted = await book.advance({ tip: r.tipHeight, tipHash: r.anchor.hashAfter!, events: r.events, reorgEpoch: scanner.reorgEpoch, hashAt });
    if (!accepted) book.withhold();
  };
  const compare = () => {
    const theirs = served(book);
    for (const [h, t] of theirs) { n.compared++; if (!same(tupleOf(loop.boundary(h)), t)) n.differ++; }
    const hs = loop.boundaryHeights();
    if (accepted && (hs.length !== theirs.size || !hs.every((h) => theirs.has(h)))) n.uneven++;
  };
  const ours = () => new Map(loop.boundaryHeights().map((h) => [h, JSON.stringify(tupleOf(loop.boundary(h)))]));
  return { loop, book, n, step, compare, ours };
}

console.log("the reference copy is the resolver's code:");
{
  // The copy's tokens without comments or whitespace, its four rewritten import specifiers read back, against the hash
  // of the original's taken the same way (the copy's first lines).
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const BACK: readonly [string, string][] = [
    ['import { eventLine } from "./cairnx-tuple-deps.js";', 'import { eventLine } from "./memo.js";'],
    ['import { replay } from "./cairnx-tuple-deps.js";', 'import { replay } from "./replay.js";'],
    ['import { Scanner } from "../../src/scanner.js";', 'import { Scanner } from "./scan.js";'],
    ['} from "@inversealtruism/cairnx-core";', '} from "./types.js";'],
  ];
  let text = readFileSync(new URL("./fixtures/cairnx-tuple-c89ab86.ts", import.meta.url), "utf8");
  const once = BACK.every(([ours]) => text.split(ours).length === 2);
  for (const [ours, theirs] of BACK) text = text.replace(ours, theirs);
  const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text), tokens: string[] = [];
  for (let k = sc.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = sc.scan()) tokens.push(sc.getTokenText());
  const got = createHash("sha256").update(tokens.join("\u0000")).digest("hex");
  const ORIGINAL = "11cb05433eb532d548716658e9a3408d532f56d07af1b4e29d0f86009aa52e6e";
  ok("its code, comments and whitespace aside, hashes to the original's, as its header records", once && got === ORIGINAL && text.includes(ORIGINAL), got);
}

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
  const { loop, book, n, step, compare, ours } = await pair(() => now);
  for (let tip = H0 + 20; tip <= H0 + 140; tip += 10) { now = a.indexer({ tip }); await step(); compare(); }
  const onA = ours();
  ok(`branch A to ${H0 + 140}: the same tuple at every boundary served (${served(book).size})`, served(book).size === onA.size && n.differ === 0);
  now = b.indexer({ tip: H0 + 150 });
  await step(); compare();
  const onB = ours(), s1 = loop.status();
  const fork = [...onA.keys()].filter((h) => h >= H0 + 50);
  ok(`a reorg from ${H0 + 50} with a record changed: both computed the boundaries above it again (${fork.join(", ")}), equal`,
    s1.lastReorg !== null && fork.every((h) => onB.get(h) !== onA.get(h)) && [...onA.keys()].filter((h) => h < H0 + 50).every((h) => onB.get(h) === onA.get(h)) &&
    n.differ === 0 && served(book).size === onB.size);
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
  ok("the next accepted scan: both serve again, equal at every boundary", served(book).size === loop.boundaryHeights().length && n.differ === 0);
  // A reorg above every kept boundary: C leaves B at H0 + 155, above the newest boundary 12 deep at H0 + 170 (H0 + 140).
  const keptB = ours();
  now = c.indexer({ tip: H0 + 170 });
  await step(); compare();
  const onC = ours();
  ok("a reorg above every kept boundary: both keep every tuple as it was", [...keptB].every(([h, t]) => onC.get(h) === t) && n.differ === 0);
  ok(`over ${n.steps} polls, ${n.compared} served tuples compared, ${n.differ} differ, ${n.uneven} with a boundary one side serves alone`,
    n.compared > 0 && n.differ === 0 && n.uneven === 0);
  await loop.close();
}

console.log("rollbacks that leave a kept boundary 1 to 11 blocks under the cursor:");
{
  // B = 29,940. Branch A from B - 20 (the resolver's first scan, so both hold from the first boundary) to B + 13; then
  // shorter branches, each with a record of its own at its tip: one from B + 6 to B + 11, and for each d from 1 to 11 one
  // from B + d to B + d (a rollback to B + d - 1 and one block), each after A again at B + 13.
  const B = H0 + 40, at = (h: number, amount: string): Spec => ({ kind: "propose", rec: mint({ ticker: "DUST", amount }), proposer: A, height: h });
  const specs = [...defaultSpecs(), at(B + 3, "6")];
  const a = buildChain(specs), branch = (name: string, from: number, tip: number) => buildChain([...specs, at(tip, "9")], { forks: [{ name, from }] }).indexer({ tip });
  let now: typeof fetch = a.indexer({ tip: B - 20 });
  const { loop, book, n, step, compare } = await pair(() => now);
  const servedB = () => ({ ours: loop.boundaryHeights().includes(B) || loop.boundary(B) !== null || loop.newestBoundary()?.height === B, theirs: served(book).has(B) });
  await step(); compare();
  now = a.indexer({ tip: B + 5 });
  await step(); compare();
  now = a.indexer({ tip: B + 13 });
  await step(); compare();
  const deep = servedB(), kept = JSON.stringify(tupleOf(loop.boundary(B)));
  ok(`branch A to ${B + 13}: both serve ${B}`, deep.ours && deep.theirs && n.differ === 0);
  now = branch("r", B + 6, B + 11);
  await step(); compare();
  const shallow = servedB();
  ok(`a branch from ${B + 6} to ${B + 11}: the cursor is ${B + 11}, ${B} is 11 deep, neither serves it`,
    loop.status().cursor?.height === B + 11 && loop.status().lastReorg !== null && !shallow.ours && !shallow.theirs);
  const held: number[] = [];
  for (let d = 1; d <= 11; d++) {
    now = a.indexer({ tip: B + 13 });
    await step(); compare();
    now = branch(`x${d}`, B + d, B + d);
    await step(); compare();
    if (loop.status().cursor?.height !== B + d || servedB().ours || servedB().theirs) held.push(d);
  }
  ok("for each depth from 1 to 11 under the cursor, neither serves it", held.length === 0, held.join(", "));
  // The same rollbacks with no record of their own: only the block hashes from the fork up change, and the indexer's
  // tip is below the replica's cursor.
  const quiet = (name: string, from: number, tip: number) => buildChain(specs, { forks: [{ name, from }] }).indexer({ tip });
  const heldQuiet: number[] = [];
  for (let d = 1; d <= 11; d++) {
    now = a.indexer({ tip: B + 13 });
    await step(); compare();
    now = quiet(`q${d}`, B + d, B + d);
    await step(); compare();
    if (loop.status().cursor?.height !== B + d || servedB().ours || servedB().theirs) heldQuiet.push(d);
  }
  ok("the same with only block hashes changed: the cursor is the indexer's tip and neither serves it", heldQuiet.length === 0, heldQuiet.join(", "));
  now = a.indexer({ tip: B + 13 });
  await step(); compare();
  ok(`branch A at ${B + 13} again: both serve ${B}, the same tuple as before`, servedB().ours && servedB().theirs && JSON.stringify(tupleOf(loop.boundary(B))) === kept);
  ok(`over ${n.steps} polls, ${n.compared} served tuples compared, ${n.differ} differ, ${n.uneven} with a boundary one side serves alone`,
    n.compared > 0 && n.differ === 0 && n.uneven === 0);
  await loop.close();
}

done("cairnx-replica tuple differential");
