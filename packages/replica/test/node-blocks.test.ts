// nodeBlocks over the recorded capture (node-harness.ts). Driven through the loop it must give both hashes cairnx-core
// pins at 30,300 (test/vectors/hashes.json); copies edited with csd-codec and csd-crypto must be refused with the code
// each check owns, the blocks bound before the refused one kept; and the HTTP rules (no cache, no redirect, pacing,
// timeouts, aborts, Retry-After) must hold for every request. The node's chain moving is node-fork.test.ts.
import { createHash } from "node:crypto";
import { stateHash, type ChainEvent } from "@inversealtruism/cairnx-core";
import { headerHash, merkleRoot, sighash, txid } from "@inversealtruism/csd-codec";
import { rpcHeaderToHeader, rpcTxToTx } from "@inversealtruism/csd-client";
import { buildScriptSig, keygen, signDigest } from "@inversealtruism/csd-crypto";
import { nodeBlocks } from "../src/browser.js";
import { retryAfterMs } from "../src/http.js";
import { levelOf, memoryStore, readBlocks, replicaLoop, SourceError, type AuthorScope, type BoundBlock, type Source, type StepContext } from "../src/index.js";
import { done, ok } from "./check.js";
import { corpus, pinned } from "./core-files.js";
import { NODE, blockAt, branchFrom, bytes, cap, ctx, drive, edit, hashesOk, json, node, refused, type Answers, type Block, type Served } from "./node-harness.js";

const SHA256 = "440b51afdba22cab5141eee7bf57c3dcb82c83ef40b19560ff98aa770cb85836";
const outcome = <T>(p: Promise<T>) => p.then((v) => ({ v, e: null as unknown }), (e: unknown) => ({ v: null, e }));

console.log("the capture through the loop:");
ok(`the capture's sha256 is pinned (${bytes.length} bytes)`, createHash("sha256").update(bytes).digest("hex") === SHA256);
ok("every recorded answer round-trips through JSON, so an edit below changes only the field it names",
  Object.values(cap.answers).every((t) => JSON.stringify(JSON.parse(t)) === t));
const honest = drive({ answers: cap.answers }), hs = await honest.run();
ok("it ends at 30,300 on the recorded hash, at level 3, with nothing refused", hs.cursor?.height === cap.to &&
  hs.cursor.hash === blockAt(cap.answers, cap.to).hash && hs.lastError === null && levelOf(honest.source.basis) === 3);
ok("both hashes equal hashes.json at 29,860, 29,960 and 30,300", hashesOk(honest.loop));
ok("each block is read once (the tip's once more, for its header time), a source transaction only for a member",
  honest.n.reads(/^\/block\//) === cap.to - cap.from + 2 && honest.n.reads(new RegExp(`/block/height/${cap.to}$`)) === 2 && honest.n.reads(/^\/tx\//) <= hs.eventCount);
ok("every request bypasses HTTP caches and refuses redirects", honest.n.log.every((l) => l.init?.cache === "no-store" && l.init.redirect === "error"));

console.log("refusals, the blocks bound before them kept:");
const EV = 30_228, b0 = blockAt(cap.answers, EV), member = b0.txs[2]!;
const run = (a: Answers, o: Partial<Served> = {}) => drive({ answers: { ...cap.answers, ...a }, ...o }).run();
ok("a block with one transaction removed: BODY_MISMATCH, the cursor on the block below",
  refused(await run(edit(cap.answers, EV, (b) => { b.txs.splice(3, 1); })), "BODY_MISMATCH", EV - 1));
const sig = signDigest(sighash(rpcTxToTx(member)), keygen().priv);
ok("an event signed by another key (same txid, same merkle root): AUTHOR_UNBOUND", member.app.type === "Propose" &&
  refused(await run(edit(cap.answers, EV, (b) => { b.txs[2]!.inputs[0]!.script_sig = buildScriptSig(sig.sig64, sig.pub33); })), "AUTHOR_UNBOUND", EV - 1));
const spentPath = `/tx/${member.inputs[0]!.prev_txid}`, bump = (t: string) => t.replace(/"value":(\d+)/, (_, v) => `"value":${Number(v) + 1}`);
ok("a source transaction served with a changed output (another txid): AUTHOR_UNBOUND", refused(await run({ [spentPath]: bump(cap.answers[spentPath]!) }), "AUTHOR_UNBOUND", EV - 1));
const notFound = (p: string) => (p.startsWith("/tx/") ? json(JSON.stringify({ ok: false, err: "not found" })) : null);
ok("a source transaction the node does not have ({ok:false}): SOURCE_UNAVAILABLE before the first member, at 29,865",
  refused(await run({}, { fail: notFound }), "SOURCE_UNAVAILABLE", 29_864));
ok("a block whose header does not hash to the hash served: HEADER_INVALID",
  refused(await run(edit(cap.answers, 30_100, (b) => { b.hash = `${b.hash.slice(0, -1)}${b.hash.endsWith("0") ? "1" : "0"}`; })), "HEADER_INVALID", 30_099));
ok("the answer for 29,861 naming another height (the header does not commit one): SOURCE_MALFORMED",
  refused(await run(edit(cap.answers, 29_861, (b) => { b.height = 29_999; })), "SOURCE_MALFORMED", 29_860));
const coinbased = edit(cap.answers, cap.to, (b) => {
  const cb = b.txs[0]!;
  cb.app = { type: "Attest", proposal_id: `0x${"11".repeat(32)}`, score: 1, confidence: 1 };
  cb.txid = txid(rpcTxToTx(cb));
  b.header.merkle = merkleRoot(b.txs.map((t) => t.txid));
  b.hash = headerHash(rpcHeaderToHeader(b.header as never));
});
ok("a bound block whose coinbase carries an app payload, refused by the rule of section 33: SOURCE_MALFORMED", refused(await run(coinbased), "SOURCE_MALFORMED", cap.to - 1));
const redirected = drive({ answers: cap.answers, fail: (p) => (p === "/tip" ? new Response("", { status: 302, headers: { location: "http://example.com/elsewhere" } }) : null) });
const rds = await redirected.run();
ok("a redirect is refused: SOURCE_UNAVAILABLE, and nothing is read from its target", rds.lastError?.code === "SOURCE_UNAVAILABLE" && rds.cursor === null &&
  redirected.n.reads(/elsewhere/) === 0);

console.log("the spent transaction in the block answer (P3):");
const withSpent = (forge: boolean): Answers => Object.fromEntries(Object.entries(cap.answers).map(([p, t]) => {
  if (!p.startsWith("/block/")) return [p, t];
  const b = JSON.parse(t) as Block;
  for (const x of b.txs) {
    const s = x.app.type === "None" ? undefined : cap.answers[`/tx/${x.inputs[0]!.prev_txid}`];
    if (s !== undefined) x.spent_tx = (JSON.parse(forge ? bump(s) : s) as { tx: unknown }).tx;
  }
  return [p, JSON.stringify(b)];
}));
const p3 = drive({ answers: withSpent(false), fail: (p) => (p.startsWith("/tx/") ? json("{}", 500) : null) }), p3s = await p3.run();
ok("with the field present no source transaction is read, to the pinned hashes", p3s.lastError === null && hashesOk(p3.loop) && p3.n.reads(/^\/tx\//) === 0);
const p3f = drive({ answers: withSpent(true) }), p3fs = await p3f.run();
ok("a field that does not hash to the spent id is replaced by /tx/:id, to the pinned hashes", p3fs.lastError === null && hashesOk(p3f.loop) && p3f.n.reads(/^\/tx\//) > 0);

console.log("rate limits and waits:");
const at1000 = () => 1_000;
const r429 = await drive({ answers: cap.answers, fail: (p) => (p === "/tip" ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : null) }, { clock: at1000 }).run();
ok("a 429 is SOURCE_RATE_LIMITED and the loop waits its Retry-After", r429.lastError?.code === "SOURCE_RATE_LIMITED" && r429.retryAt === 8_000);
const shed = (p: string) => (p.startsWith("/tx/") ? json(JSON.stringify({ ok: false }), 503, { "retry-after": "2" }) : null);
const r503 = await drive({ answers: cap.answers, fail: shed }, { clock: at1000 }).run();
ok("a 503 with Retry-After is SOURCE_UNAVAILABLE and the loop waits it, the blocks before kept", refused(r503, "SOURCE_UNAVAILABLE", 29_864) && r503.retryAt === 3_000);
const now0 = Date.parse("Wed, 18 Nov 2026 12:00:00 GMT"), parsed = (v: string) => retryAfterMs(v, now0);
ok("Retry-After: seconds or an IMF-fixdate, capped at 300 s; a fraction, a sign, a list or a word is absent",
  parsed("7") === 7_000 && parsed(" 12 ") === 12_000 && parsed("Wed, 18 Nov 2026 12:00:10 GMT") === 10_000 && parsed("99999999999999999999") === 300_000 &&
  parsed("Wed, 18 Nov 2099 12:00:10 GMT") === 300_000 && parsed("Wed, 18 Nov 2020 12:00:10 GMT") === 0 &&
  ["7.5", "-5", "12, 13", "1e3", "soon", ""].every((v) => parsed(v) === null));
const asking = (retryAfterMs: number): Source => ({ ...honest.source, next: async () => ({ kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "test", retryAfterMs }) });
const waits = await Promise.all([1e12, -5, Number.NaN].map(async (w) => (await replicaLoop({ source: asking(w), store: memoryStore(), clock: at1000 }).advance()).retryAt));
ok("the loop takes a source's wait up to 300 s and doubles from 1 s for one that is not a number >= 0", waits.join() === "301000,2000,2000", waits.join());
let window = 0;
const limiter = drive({ answers: cap.answers, fail: () => (++window > 50 ? ((window = 0), new Response("", { status: 429, headers: { "retry-after": "1" } })) : null) },
  { clock: (() => { let t = 0; return () => (t += 2_000); })() });
let ls = await limiter.run();
for (let i = 0; i < 30 && ls.cursor?.height !== cap.to; i++) ls = await limiter.run();
ok("a limiter allowing 50 requests a window still lets each step keep the blocks it bound, to the pinned hashes",
  ls.cursor?.height === cap.to && hashesOk(limiter.loop), `${ls.cursor?.height} after ${limiter.n.log.length} requests`);

console.log("budgets, pacing, timeouts, aborts:");
const stepWith = async (budget: Partial<StepContext["budget"]>, now = 0) => {
  const n = node({ answers: cap.answers }), s = await nodeBlocks({ node: NODE, fetch: n.f }).next(ctx(budget, { now: () => now }));
  return { blocks: s.kind === "blocks" ? s.blocks.length : -1, requests: n.log.length };
};
const [byReq, byBlocks, byTime] = await Promise.all([stepWith({ maxRequests: 6 }), stepWith({ maxBlocks: 3 }), stepWith({ deadlineAt: 0 }, 1)]);
ok("a step stops at its request budget (the tip, five blocks, then the tip's header), its block budget and its deadline, always one block",
  byReq.blocks === 5 && byReq.requests === 7 && byBlocks.blocks === 3 && byTime.blocks === 1, JSON.stringify([byReq, byBlocks, byTime]));
const paced = node({ answers: cap.answers }), pacedSrc = nodeBlocks({ node: NODE, fetch: paced.f, paceMs: 40 });
await pacedSrc.tip(new AbortController().signal);
await pacedSrc.tip(new AbortController().signal);
const gaps = paced.log.slice(1).map((l, i) => l.at - paced.log[i]!.at);
ok("paceMs spaces the starts of requests, within a session and across two", paced.log.length === 3 && gaps.every((g) => g >= 35), gaps.join());
const slowPace = await outcome(nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f, paceMs: 600, timeoutMs: 500 }).tip(new AbortController().signal));
ok("the pace wait does not count against the request timeout", slowPace.v?.height === cap.to, String(slowPace.e));
const cut = new AbortController(), t0 = performance.now();
setTimeout(() => cut.abort(), 100);
const cutWait = await outcome(nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f, paceMs: 1_500 }).tip(cut.signal));
ok("an abort ends a pace wait at once", cutWait.e !== null && performance.now() - t0 < 1_000);
const hung: typeof fetch = (_i, init) => new Promise((_go, stop) => init?.signal?.addEventListener("abort", () => stop(init.signal?.reason)));
// AbortSignal.timeout's timer does not keep a process alive, and this fetch holds no socket that would.
const alive = setInterval(() => undefined, 1_000), t1 = performance.now(), hs2 = await nodeBlocks({ node: NODE, fetch: hung, timeoutMs: 200 }).next(ctx({}));
clearInterval(alive);
ok("timeoutMs ends a request that never answers: SOURCE_UNAVAILABLE", hs2.kind === "cannot" && hs2.code === "SOURCE_UNAVAILABLE" && performance.now() - t1 < 2_000);
const stop = new AbortController(), seen: AbortSignal[] = [];
const aborting = node({ answers: cap.answers, fail: (_p, n) => { if (n === 5) stop.abort(); return null; } });
const watched: typeof fetch = (i, init) => { if (init?.signal) seen.push(init.signal); return aborting.f(i, init); };
const mid = await outcome(nodeBlocks({ node: NODE, fetch: watched }).next(ctx({}, { signal: stop.signal })));
ok("an abort mid-step reaches the request's signal and rejects the step instead of returning one", mid.v === null && mid.e !== null && seen.at(-1)?.aborted === true);
const late = new AbortController(), blind = node({ answers: cap.answers, tip: 29_863 });
const deaf: typeof fetch = async (i, init) => { const r = await blind.f(i, { ...init, signal: null }); if (blind.log.length === 5) late.abort(); return r; };
const after = await outcome(nodeBlocks({ node: NODE, fetch: deaf }).next(ctx({}, { signal: late.signal })));
ok("an abort after the last read still rejects the step", after.v === null && after.e !== null);
const early = new AbortController(), deafAll = node({ answers: cap.answers });
const deaf3: typeof fetch = async (i, init) => { const r = await deafAll.f(i, { ...init, signal: null }); if (deafAll.log.length === 3) early.abort(); return r; };
const stopped = await outcome(nodeBlocks({ node: NODE, fetch: deaf3 }).next(ctx({}, { signal: early.signal })));
ok("after an abort no request starts, even through a fetch that ignores its signal", stopped.e !== null && deafAll.log.length === 3, String(deafAll.log.length));
const badTips = [{ tip: blockAt(cap.answers, cap.to).hash, height: 1.5 }, { tip: blockAt(cap.answers, cap.to).hash.slice(2), height: cap.to },
  { tip: blockAt(cap.answers, cap.to).hash.toUpperCase(), height: cap.to }, { tip: blockAt(cap.answers, cap.to).hash, height: -5 }, null, [],
  { tip: blockAt(cap.answers, cap.to).hash, height: String(cap.to) }];
const tipSteps = await Promise.all(badTips.map((t) => nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers, tipOf: () => t }).f }).next(ctx({}))));
ok(`a /tip out of form is SOURCE_MALFORMED (${badTips.length} forms)`, tipSteps.every((s) => s.kind === "cannot" && s.code === "SOURCE_MALFORMED"));

console.log("readBlocks:");
const authorsOf = new Map(corpus.events.map((e: ChainEvent) => (e.kind === "propose" ? [e.id, e.proposer] : [e.txid, e.attester])));
const read = async (s: Served, from: number, to: number, authors: AuthorScope) => {
  const n = node(s), out: BoundBlock[] = [], source = nodeBlocks({ node: NODE, fetch: n.f });
  try { for await (const b of readBlocks({ source, from, to, authors })) out.push(b); } catch (e) { return { out, n, e }; }
  return { out, n, e: null };
};
const rm = await read({ answers: cap.answers }, 29_873, 29_875, "members"), rn = await read({ answers: cap.answers }, 29_873, 29_875, "none");
ok("members: three linked blocks with the authors of their two Proposes and two Attests bound as the corpus records them",
  rm.e === null && rm.out.map((b) => b.authors.size).join() === "2,0,2" && rm.out.every((b) => [...b.authors].every(([id, a]) => authorsOf.get(id) === a)));
ok("none: the same blocks without a source transaction read", rn.out.map((b) => b.hash).join() === rm.out.map((b) => b.hash).join() && rn.n.reads(/^\/tx\//) === 0);
const ra = await read({ answers: cap.answers }, 29_873, 29_873, "all"), b29873 = ra.out[0];
const bound = b29873?.authors.size, others = (b29873?.txs.length ?? 0) - 1;
ok("all: every transaction but the coinbase", ra.e === null && b29873 !== undefined && bound === others && !b29873.authors.has(b29873.txs[0]!.txid));
const branch = branchFrom(30_290);
const rl = await read({ answers: { ...cap.answers, "/block/height/30291": branch["/block/height/30291"]! } }, 30_289, 30_291, "none");
ok("a block that does not link to the one before throws SourceError BRANCH_MOVED", rl.out.length === 2 && rl.e instanceof SourceError && rl.e.code === "BRANCH_MOVED");
ok("the state at 30,300 after every case above is still the pinned one", stateHash(honest.loop.stateAt(cap.to, 0)!) === pinned[String(cap.to)]!.stateHash);

done("cairnx-replica nodeBlocks");
