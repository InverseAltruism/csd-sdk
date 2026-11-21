// hostedBlocks under the anchor root over our front door served from the recorded node answers (hosted-harness.ts).
// With the anchor at 29,859 and a window of 8 the loop must reach both hashes cairnx-core pins at 30,300 from aligned
// pages; the tip it reports is a header the window verified, never the server's claim; a page an edge cache holds
// stale is read again past it; a header with bad proof of work, a page that does not link and a branch with bad
// proof of work, inside and below the window, are refused with the store kept; a store the window does not hold is
// verified from workRoot, one that keeps the window is not; a walk from workRoot progresses at any budget; a server behind rolls nothing back. Every
// step the source emits is checked against the contract's own functions. The work rule on two real branches is
// hosted-work.test.ts; the caller root is hosted-caller.test.ts.
import { createHash } from "node:crypto";
import { headerHash } from "@inversealtruism/csd-codec";
import { rpcHeaderToHeader } from "@inversealtruism/csd-client";
import { hostedBlocks } from "../src/browser.js";
import { anchorRoot } from "../src/anchor-root.js";
import { nodeBlocks } from "../src/browser.js";
import { httpSessions } from "../src/http.js";
import { levelOf, memoryStore, readBlocks, replicaLoop, ReplicaConfigError, SourceError, type Source, type Store } from "../src/index.js";
import { done, ok, thrown } from "./check.js";
import { ANCHOR, all, belowBytes, driveHosted, front, ORIGIN } from "./hosted-harness.js";
import { NODE, blockAt, branchFrom, cap, ctx, edit, hashesOk, json, node, refused, type Answers } from "./node-harness.js";

const anchor = { kind: "anchor", anchor: ANCHOR, window: 8 } as const;
const branch = (fork: number): Answers => ({ ...all, ...branchFrom(fork) });
const outcome = <T>(p: Promise<T>) => p.then((v) => ({ v, e: null as unknown }), (e: unknown) => ({ v: null, e }));
// A header edited and its hash recomputed: the hash is honest, its proof of work is not.
const reHeader = (a: Answers, h: number, f: (hd: Record<string, unknown> & { nonce: number; prev: string }) => void) =>
  edit(a, h, (b) => { f(b.header); b.hash = headerHash(rpcHeaderToHeader(b.header as never)); });

console.log("the anchor root, honest:");
ok("the capture below activation (29,815 to 29,859) is pinned and links to 29,860",
  createHash("sha256").update(belowBytes).digest("hex") === "6094ae367b3204744c04850f8be3227b759e2c3072a48513f5fc0dc7a4841d39" && ANCHOR.hash === blockAt(all, 29_860).header.prev);
const served: { answers: Answers } = { answers: all }, h = driveHosted(served, anchor), hs = await h.run();
const pages = h.fr.log.filter((l) => l.path.startsWith("/api/blocks/")).map((l) => l.path.split("/").slice(3).map(Number) as [number, number]);
ok("it ends at 30,300 on the recorded hash, at level 3 on the anchor root, with nothing refused", hs.cursor?.height === cap.to &&
  hs.cursor.hash === blockAt(all, cap.to).hash && hs.lastError === null && levelOf(h.inner.basis) === 3 && h.inner.basis.kind === "blocks" && h.inner.basis.root.kind === "anchor");
ok("both hashes equal hashes.json at 29,860, 29,960 and 30,300", hashesOk(h.loop));
ok(`each page is the route's aligned 64 or ends at the tip, read once (${pages.length} pages)`, pages.length === 8 &&
  pages.every(([f, n]) => (f % 64 === 0 && n === 64) || f + n - 1 === cap.to) && new Set(pages.map((p) => p.join())).size === pages.length);
ok("one header read seeds the window; no page is read past caches; every request bypasses HTTP caches and refuses redirects",
  h.fr.reads(/^\/api\/headers\//) === 1 && h.fr.reads(/./, true) === 0 && h.fr.log.every((l) => l.init?.cache === "no-store" && l.init.redirect === "error"));
ok("every step keeps the contract", h.bad.length === 0, h.bad.join("; "));
const window8 = await outcome((async () => { const out: number[] = []; for await (const b of readBlocks({ source: h.inner, from: 30_292, to: 30_300, authors: "none" })) out.push(b.height); return out; })());
const deeper = await outcome(readBlocks({ source: h.inner, from: 30_000, to: 30_000, authors: "none" }).next());
ok("readBlocks reads 9 verified blocks from the window; 30,000, below it, is SOURCE_UNAVAILABLE", window8.v?.length === 9 &&
  deeper.e instanceof SourceError && deeper.e.code === "SOURCE_UNAVAILABLE");
served.answers = branch(30_296);
const swapped = await outcome(readBlocks({ source: h.inner, from: 30_296, to: 30_296, authors: "none" }).next());
ok("readBlocks over a block that is not the verified one: HEADER_INVALID", swapped.e instanceof SourceError && swapped.e.code === "HEADER_INVALID");
served.answers = all;
Object.assign(served, { edge: edit(all, 30_277, (b) => { b.txs.splice(1, 1); }) });
const reread = await outcome(readBlocks({ source: h.inner, from: 30_277, to: 30_277, authors: "none" }).next());
ok("readBlocks over a body an edge holds wrong reads it again past the edge and binds it", reread.v?.value?.height === 30_277 && h.fr.reads(/^\/api\/blocks\/30277\/1$/, true) === 1);
Object.assign(served, { edge: undefined });
ok("an origin with credentials, a window of 0 or an anchor hash out of form throws ReplicaConfigError", [{ origin: "https://u:p@front.example", root: anchor },
  { origin: ORIGIN, root: { ...anchor, window: 0 } }, { origin: ORIGIN, root: { kind: "anchor", anchor: { height: 29_859, hash: "0x12" } } }]
  .every((x) => thrown(() => hostedBlocks(x as Parameters<typeof hostedBlocks>[0])) instanceof ReplicaConfigError));

console.log("a server that claims a tip above what it can show:");
const junk: Answers = {};
for (let x = 30_301, prev = blockAt(all, cap.to).hash; x <= 30_312; x++) {
  const b = blockAt(all, cap.to);
  Object.assign(b, { height: x }); Object.assign(b.header, { prev, nonce: b.header.nonce + x });
  junk[`/block/height/${x}`] = JSON.stringify({ ...b, hash: (prev = headerHash(rpcHeaderToHeader(b.header as never))) });
}
const liar: { answers: Answers; tip: number } = { answers: all, tip: 30_299 }, lr = driveHosted(liar, anchor);
await lr.run();
Object.assign(liar, { answers: { ...all, ...junk }, tip: 30_312 });
const lrs = await lr.run(), realTip = { height: cap.to, hash: blockAt(all, cap.to).hash, time: Number(blockAt(all, cap.to).header.time) };
ok("tip 30,312 claimed over 12 hash-consistent junk rows: the step commits 30,300 and reports that verified header as its tip, from the loop and from source.tip()",
  lrs.cursor?.height === cap.to && JSON.stringify(lrs.tip) === JSON.stringify(realTip) && JSON.stringify(await lr.inner.tip(new AbortController().signal)) === JSON.stringify(realTip) &&
  lr.steps.some((x) => x.step.kind === "blocks" && x.step.reach === 30_312 && x.step.tip.height === cap.to));
ok("so a state asked for at depth 12 from that tip is 30,288's, not the cursor's", lrs.tip !== null && lrs.tip.height - 12 === 30_288 && lr.loop.stateAt(lrs.tip.height, 12) !== null &&
  lr.loop.eventsHashAt(lrs.tip.height - 12) === lr.loop.eventsHashAt(30_288));

console.log("pages an edge cache holds stale:");
// One stale page from a branch at 30,100 (it links, then fails proof of work), one from a branch at 30,140 (its first
// block does not link to the cursor).
const stalePage: Answers = {}, b100 = branchFrom(30_100), b140 = branchFrom(30_140);
for (let x = 30_080; x <= 30_143; x++) stalePage[`/block/height/${x}`] = b100[`/block/height/${x}`]!;
for (let x = 30_144; x <= 30_207; x++) stalePage[`/block/height/${x}`] = b140[`/block/height/${x}`]!;
const staleBody = edit(all, 30_228, (b) => { b.txs.splice(3, 1); });
const st = driveHosted({ answers: all, edge: { ...stalePage, ...staleBody } }, anchor), sts = await st.run();
ok("two pages from other branches and a page with a body missing a transaction, each read again past the edge (no header read): on to the pinned hashes",
  sts.cursor?.hash === blockAt(all, cap.to).hash && sts.lastError === null && hashesOk(st.loop) && st.fr.reads(/^\/api\/blocks\//, true) === 3 &&
  st.fr.reads(/^\/api\/headers\//) === 1 && st.bad.length === 0);
const wrong = driveHosted({ answers: { ...all, ...staleBody } }, anchor), ws = await wrong.run();
ok("a body wrong at the origin too: BODY_MISMATCH after one fresh read, the blocks before it kept", refused(ws, "BODY_MISMATCH", 30_227) &&
  wrong.fr.reads(/^\/api\/blocks\/30208\//, true) >= 1);

const partial = driveHosted({ answers: all, tip: 30_250, edge: staleBody }, anchor), pts = await partial.run();
ok("a partial page re-read past the edge asks the range still expected (30,228 to 30,250)", pts.cursor?.height === 30_250 && pts.lastError === null &&
  partial.fr.log.some((l) => l.fresh && l.path === "/api/blocks/30228/23") && !partial.fr.log.some((l) => l.fresh && l.path === "/api/blocks/30208/43"));
const readerless = (p: string) => { if (!p.startsWith("/api/blocks/30080/")) return null; const r = json(`{"ok":true,"blocks":[${Array.from({ length: 64 }, (_, i) => all[`/block/height/${30_080 + i}`]).join(",")}]}`); Object.defineProperty(r, "body", { value: null }); return r; };
const rl = await driveHosted({ answers: all, fail: readerless }, anchor).run();
ok("an answer whose body has no stream reader is read as text under the same cap", rl.cursor?.hash === blockAt(all, cap.to).hash && rl.lastError === null);
const badSeed = edit(all, 29_859, (b) => { b.header.nonce += 1; b.hash = headerHash(rpcHeaderToHeader(b.header as never)); });
const es0 = driveHosted({ answers: all, edge: badSeed }, anchor), es0s = await es0.run();
ok("a seed an edge holds wrong is read again past it before it is kept: on to the pinned hashes", es0s.cursor?.hash === blockAt(all, cap.to).hash && es0s.lastError === null &&
  es0.fr.reads(/^\/api\/headers\/29815\/45$/) === 2 && es0.fr.reads(/^\/api\/headers\/29815\/45$/, true) === 1);
const seedSrv: { answers: Answers } = { answers: { ...all, ...badSeed } }, sd = driveHosted(seedSrv, anchor), sd1 = await sd.run();
seedSrv.answers = all;
const sd2 = await sd.run();
ok("a seed wrong at the origin is refused and not kept: once the server serves the right one, the source syncs", sd1.lastError?.code === "HEADER_INVALID" && sd1.cursor === null &&
  sd2.cursor?.hash === blockAt(all, cap.to).hash && sd2.lastError === null);

const huge = (chunks: number) => new Response(new ReadableStream({ pull(c) { if (chunks-- > 0) c.enqueue(new Uint8Array(9 * 1024 * 1024)); else c.close(); } }), { status: 200 });
const big = await driveHosted({ answers: all, fail: (p) => (p.startsWith("/api/blocks/") ? huge(2) : null) }, anchor).run();
ok("a page streamed past 16 MiB: SOURCE_MALFORMED, refused before it is parsed", big.lastError?.code === "SOURCE_MALFORMED" && /over 16777216 bytes/.test(big.lastError.reason));
const short = (p: string) => (p.startsWith("/api/blocks/") ? new Response('{"ok":true,"blocks":[]}') : null);
const shortSeed = (p: string) => (p.startsWith("/api/headers/") ? new Response('{"ok":true,"headers":[]}') : null);
const [sp, ss] = [await driveHosted({ answers: all, fail: short }, anchor).run(), await driveHosted({ answers: all, fail: shortSeed }, anchor).run()];
ok("a page or a header answer with fewer rows than asked: SOURCE_MALFORMED", sp.lastError?.code === "SOURCE_MALFORMED" && ss.lastError?.code === "SOURCE_MALFORMED" &&
  /blocks/.test(sp.lastError.reason) && /rows/.test(ss.lastError.reason));
const high0 = await driveHosted({ answers: all }, { kind: "anchor", anchor: { height: 29_860, hash: blockAt(all, 29_860).hash } }).run();
ok("an anchor above the activation height less one: BELOW_FLOOR", high0.lastError?.code === "BELOW_FLOOR" && high0.cursor === null);

console.log("refusals, the store kept:");
const early = driveHosted({ answers: { ...all, ...edit(all, 30_209, (b) => { b.txs.splice(1, 1); }) } }, anchor), es = await early.run();
ok("a body wrong at 30,209, the second block of its page: BODY_MISMATCH, the cursor at 30,208 still in the window (no header read)",
  refused(es, "BODY_MISMATCH", 30_208) && early.fr.reads(/^\/api\/headers\//) === 1);
const pow = driveHosted({ answers: { ...all, ...reHeader(all, 30_100, (hd) => { hd.nonce += 1; }) } }, anchor);
await pow.run();
const pows = await pow.run();
ok("a header with bad proof of work: HEADER_INVALID, the cursor on the block below", refused(pows, "HEADER_INVALID", 30_099) && pow.bad.length === 0);
const unlinked = driveHosted({ answers: { ...all, ...reHeader(all, 30_150, (hd) => { hd.prev = `0x${"00".repeat(32)}`; }) } }, anchor);
await unlinked.run();
const uls = await unlinked.run();
ok("a page whose block does not link to the one before: HEADER_INVALID after a fresh read and a read of the server's headers, the cursor on 30,149",
  refused(uls, "HEADER_INVALID", 30_149) && unlinked.fr.reads(/^\/api\/headers\//) > 1 && unlinked.bad.length === 0);
for (const [fork, where] of [[30_296, "inside the window"], [30_200, "below the window, verified from workRoot"]] as const) {
  const served = { answers: all }, d = driveHosted(served, anchor);
  await d.run();
  served.answers = branch(fork);
  const before = d.fr.log.length, s1 = await d.run(), s2 = await d.run();
  const fromRoot = d.fr.log.slice(before).some((l) => l.path === `/api/headers/${ANCHOR.height + 1}/${cap.to - ANCHOR.height}`);
  ok(`a branch from ${fork} ${where}, its first mined-again header failing proof of work: HEADER_INVALID, nothing rolled back`,
    refused(s1, "HEADER_INVALID", cap.to) && refused(s2, "HEADER_INVALID", cap.to) && s2.lastReorg === null && s2.cursor?.hash === blockAt(all, cap.to).hash &&
    fromRoot === (fork === 30_200) && hashesOk(d.loop) && d.bad.length === 0);
}
const walked = (maxRequests: number, deadlineAt: number) => async () => {
  const fr = front({ answers: all }), sess = httpSessions(ORIGIN, { fetch: fr.f }, "/api/rpc"), root = anchorRoot(ANCHOR, 8, 64), top = blockAt(all, cap.to).hash;
  const c = ctx({ maxRequests, deadlineAt }, { cursor: { height: cap.to, hash: top }, hashAt: (x) => (x === cap.to ? top : null) }), out: string[] = [];
  for (let i = 0; i < 12 && out.at(-1) !== "go"; i++) {
    const r = await outcome(root.begin(sess(c.signal), c, { height: cap.to, hash: top }));
    out.push(r.e instanceof SourceError ? `${r.e.code}:${r.e.retryAfterMs}` : r.v !== null && "kind" in r.v ? r.v.kind : "go");
  }
  const batches = fr.log.filter((l) => l.path.startsWith("/api/headers/") && l.path !== "/api/headers/29815/45").map((l) => l.path);
  return { out, batches };
};
for (const [how, run] of [["1 request a step", walked(1, Number.POSITIVE_INFINITY)], ["its deadline passed", walked(100, 0)]] as const) {
  const { out, batches } = await run();
  ok(`a walk from workRoot to the cursor in batches of 64, ${how}: one batch a step, SOURCE_RATE_LIMITED with no wait between, done in 7 steps`,
    out.join() === `${Array(6).fill("SOURCE_RATE_LIMITED:0").join()},go` && batches.length === 7 && new Set(batches).size === 7, `${out.join()} ${batches.join()}`);
}

console.log("a store the window does not hold:");
const kept = memoryStore(), first = driveHosted({ answers: all }, anchor, { store: kept });
await first.run();
const again = driveHosted({ answers: all }, anchor, { store: kept }), ags = await again.run();
ok("a new source over a store at 30,300 that keeps the window: no header read, nothing rolled back, then idle",
  ags.lastError === null && ags.lastReorg === null && ags.cursor?.height === cap.to && again.fr.reads(/^\/api\/headers\//) === 0 && hashesOk(again.loop));
const withheld: Store = { ...kept, rows: (x) => kept.rows(x), headerWindow: async () => null };
const blind = driveHosted({ answers: all }, anchor, { store: withheld }), bls = await blind.run();
ok("the same store with its window withheld: verified from workRoot to the cursor, nothing rolled back, then idle",
  bls.lastError === null && bls.lastReorg === null && bls.cursor?.height === cap.to && blind.fr.reads(/^\/api\/headers\/29860\/441$/) === 1 && hashesOk(blind.loop));
// A store filled on the branch from 30,200 by nodeBlocks under the same store basis, then read by the anchor root from
// a server that serves the recorded chain.
const onBranch = memoryStore(), viaNode = nodeBlocks({ node: NODE, fetch: node({ answers: branchFrom(30_200) }).f });
const asAnchor: Source = { ...viaNode, basis: { kind: "blocks", root: { kind: "anchor", anchor: ANCHOR }, bodies: ORIGIN } };
await replicaLoop({ source: asAnchor, store: onBranch, maxRequests: 50 }).advance();
const back = driveHosted({ answers: all }, anchor, { store: onBranch }), bks = await back.run();
ok("a store on a branch the server no longer serves: verified from workRoot, rolled back to 30,180 (the highest held block below the fork), then read to the pinned hashes",
  bks.lastReorg?.from.hash === blockAt(branch(30_200), cap.to).hash && bks.lastReorg.to.height === 30_180 && bks.cursor?.hash === blockAt(all, cap.to).hash &&
  bks.lastError === null && hashesOk(back.loop) && back.bad.length === 0);

const low = { answers: all, tip: 30_250 }, lw = await driveHosted(low, anchor, { store: kept }).run();
ok("a new source over that store, its server's tip at 30,250: SOURCE_UNAVAILABLE, nothing rolled back", refused(lw, "SOURCE_UNAVAILABLE", cap.to) && lw.lastReorg === null &&
  /below the cursor/.test(lw.lastError?.reason ?? ""));

console.log("a server behind:");
for (const [tip, how] of [[30_295, "inside the window"], [30_200, "below the window"]] as const) {
  const behind: { answers: Answers; tip?: number } = { answers: all }, bh = driveHosted(behind, anchor);
  await bh.run();
  behind.tip = tip;
  const bs = await bh.run();
  behind.tip = cap.to;
  const on = await bh.run();
  ok(`its tip ${tip}, ${how}: SOURCE_UNAVAILABLE with nothing rolled back, then idle again`, refused(bs, "SOURCE_UNAVAILABLE", cap.to) && bs.lastReorg === null &&
    on.lastError === null && hashesOk(bh.loop));
}

done("cairnx-replica hostedBlocks");
