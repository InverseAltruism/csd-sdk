// The anchor root while a rollback is outstanding, on the two-branch chain (two-branch.ts): no tip is reported, and no
// step ends other than in that rollback, while the store's cursor is off the chain the tip belongs to; the rollback is
// returned without a server answer; a fork block below the loop's floor rolls back to the floor; a walk from workRoot
// survives a transport error; and a fork's header answer that fails verification is read again past caches.
import { CAIRNX_EVENT_RULE } from "@inversealtruism/cairnx-core";
import { anchorRoot } from "../src/anchor-root.js";
import { httpSessions } from "../src/http.js";
import { memoryStore, replicaLoop, SourceError, type Source, type Store } from "../src/index.js";
import { done, ok } from "./check.js";
import { all, ANCHOR as CAP_ANCHOR, driveHosted, front, ORIGIN, type Hosted } from "./hosted-harness.js";
import { blockAt, cap, ctx } from "./node-harness.js";
import { A, ANCHOR, B, RULE, chain, headerAnswer, onA, onB } from "./two-branch.js";

const anchor = { kind: "anchor", anchor: ANCHOR, window: 8 } as const;
const down = () => new Response("{}", { status: 503 });
const viewOf = (h: number, hash: string, time: number) => JSON.stringify({ height: h, hash, time });
const timeOf = (rows: typeof chain.A, h: number) => Number(rows.find((r) => r.height === h)!.header.time);
const seedTime = Number(chain.seed.at(-1)!.header.time);

console.log("a stale page that orphans the step's blocks (default maxBlocks):");
const served: Hosted = { answers: onA, tip: 1087 }, d = driveHosted(served, anchor, { rule: RULE });
await d.run();
const bad = JSON.parse(onA["/block/height/1089"]!) as { txs: unknown[] };
bad.txs = [];
const stale = `{"ok":true,"from":1088,"count":4,"blocks":[${[onA["/block/height/1088"], JSON.stringify(bad), onB["/block/height/1090"], onB["/block/height/1091"]].join(",")}]}`;
let tipDown = false;
Object.assign(served, { answers: onB, tip: 1091, fail: (p: string, fresh: boolean) =>
  (tipDown && p === "/api/rpc/tip" ? down() : !fresh && p === "/api/blocks/1088/4" ? new Response(stale, { headers: { "content-type": "application/json" } }) : null) });
const n0 = d.steps.length, s1 = await d.run(), first = d.steps.slice(n0).map((x) => x.step.kind);
ok("A1088 bound, then A1089 empty and B above: the same advance rolls back to 1085 and reads B, never idle on A",
  first[0] === "reorg" && !first.includes("idle") && s1.lastReorg?.to.height === 1085 && s1.cursor?.hash === B(1091) && s1.lastError === null && d.bad.length === 0, first.join());

console.log("a rollback not committed (the advance aborted after the adopting step):");
const ab: Hosted = { answers: onA, tip: 1089 }, inner = driveHosted(ab, anchor, { rule: RULE }).inner;
let abortNext = false, t = 0;
const cut = new AbortController();
const src: Source = { ...inner, async next(c) { const st = await inner.next(c); if (abortNext && st.kind === "reorg") { abortNext = false; cut.abort(); } return st; } };
const store: Store = memoryStore(), loop = replicaLoop({ source: src, store, rule: RULE, clock: () => (t += 1_000), maxRequests: 50 });
await loop.advance({ budgetMs: 600_000 });
Object.assign(ab, { answers: onB, tip: 1091 });
abortNext = true;
const a1 = await loop.advance({ signal: cut.signal, budgetMs: 600_000 });
const capped = await inner.tip(new AbortController().signal);
ok("the store still on A1089: source.tip() reports the fork block 1085, not B1091", a1.cursor?.hash === A(1089) && JSON.stringify(capped) === viewOf(1085, ANCHOR.hash, seedTime));
Object.assign(ab, { fail: (p: string) => (p === "/api/rpc/tip" ? down() : null) });
const a2 = await loop.advance({ budgetMs: 600_000 });
ok("with /tip answering 503, the next advance still returns the rollback to 1085, and reports no tip above it",
  a2.lastReorg?.to.height === 1085 && a2.cursor?.height === 1085 && a2.tip !== null && a2.tip.height <= 1085);
Object.assign(ab, { fail: undefined });
const a3 = await loop.advance({ budgetMs: 600_000 });
ok("once /tip answers, B is read to 1091 and the tip is B1091 again", a3.cursor?.hash === B(1091) && JSON.stringify(a3.tip) === viewOf(1091, B(1091), timeOf(chain.B, 1091)));

console.log("a fork block below the floor:");
const rule88 = { ...CAIRNX_EVENT_RULE, activationHeight: 1088 }, fl: Hosted = { answers: onA, tip: 1089 }, fd = driveHosted(fl, anchor, { rule: rule88 });
await fd.run();
Object.assign(fl, { answers: onB, tip: 1091 });
let fs = await fd.run();
for (let i = 0; i < 4 && fs.cursor?.hash !== B(1091); i++) fs = await fd.run();
ok("activation 1088, anchor 1085, B forking at 1085: rolled back to the floor 1087, then B read to 1091", fs.lastReorg?.to.height === 1087 &&
  fs.lastReorg.to.hash === B(1087) && fs.cursor?.hash === B(1091) && fs.lastError === null && fd.bad.length === 0, `${fs.lastError?.reason}`);

console.log("a walk from workRoot and a transport error:");
const top = blockAt(all, cap.to).hash;
let n = 0;
const tw: Hosted = { answers: all, fail: (p) => { if (p.startsWith("/api/headers/") && p !== "/api/headers/29815/45" && ++n === 5) throw new TypeError("fetch failed"); return null; } };
const tf = front(tw), sess = httpSessions(ORIGIN, { fetch: tf.f }, "/api/rpc"), root = anchorRoot(CAP_ANCHOR, 8, 64);
const c = ctx({ maxRequests: 100 }, { cursor: { height: cap.to, hash: top }, hashAt: (x) => (x === cap.to ? top : null) }), out: string[] = [];
for (let i = 0; i < 6 && out.at(-1) !== "go"; i++) {
  const r = await root.begin(sess(c.signal), c, { height: cap.to, hash: top }).then((v) => ("kind" in v ? v.kind : "go"), (e: unknown) => (e instanceof SourceError ? e.code : (e as Error).name));
  out.push(r);
}
const batches = tf.log.filter((l) => l.path.startsWith("/api/headers/") && l.path !== "/api/headers/29815/45").map((l) => l.path);
ok("one rejected fetch at the fifth of 7 batches: the walk resumes where it stopped (8 batch requests, the fifth range twice), then completes",
  out.join() === "TypeError,go" && batches.length === 8 && new Set(batches).size === 7 && batches[4] === batches[5], `${out.join()} ${batches.join(" ")}`);

console.log("a fork's header answer that fails verification:");
const mixedRows = [chain.seed.at(-1)!, chain.B[0]!, chain.B[1]!, chain.A[2]!, chain.B[3]!, chain.B[4]!, chain.B[5]!];
const mh: Hosted = { answers: onA, tip: 1089 }, md = driveHosted(mh, anchor, { rule: RULE });
await md.run();
Object.assign(mh, { answers: onB, tip: 1091, fail: (p: string, fresh: boolean) =>
  (!fresh && p === "/api/headers/1085/7" ? new Response(headerAnswer(mixedRows), { headers: { "content-type": "application/json" } }) : null) });
const m1 = await md.run();
ok("a mixed non-fresh /api/headers/1085/7 (A1088 among B): read again past caches, B adopted with the rollback to 1085",
  m1.lastReorg?.to.height === 1085 && m1.cursor?.hash === B(1091) && m1.lastError === null && md.fr.reads(/^\/api\/headers\/1085\/7$/, true) === 1, `${m1.lastError?.code}`);

done("cairnx-replica hosted pending");
