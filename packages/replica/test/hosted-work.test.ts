// The anchor root's work rule at the source, on the two-branch chain (two-branch.ts) through the real loop: a lighter
// branch refused with the store unchanged; a heavier one adopted with a rollback to its fork block; a fork below the
// window verified from workRoot, refused with less work (the refusal kept until the server's tip moves) and adopted
// with more; a reorg found on a later read of one step drops the blocks it orphaned; a rollback whose commit failed is
// returned again, never repaired by a walk without a work bar; a walk that fails starts afresh; and a store filled
// before the source started keeps the window's work as the bar, unless its window is withheld or is another branch's
// than its cursor. Every emitted step keeps the contract.
import { createHash } from "node:crypto";
import { LightClient } from "@inversealtruism/csd-light";
import { anchorRoot } from "../src/anchor-root.js";
import { httpSessions } from "../src/http.js";
import { memoryStore, replicaLoop, type Store } from "../src/index.js";
import { done, ok } from "./check.js";
import { ORIGIN, driveHosted, front, kinds, type Hosted } from "./hosted-harness.js";
import { ctx } from "./node-harness.js";
import { A, ANCHOR, B, RULE, chain, chainBytes, headerAnswer, onA, onB } from "./two-branch.js";

const anchor = (window = 8) => ({ kind: "anchor", anchor: ANCHOR, window }) as const;
const drive = (s: Hosted, window = 8, o: { maxBlocks?: number; store?: Store } = {}) => driveHosted(s, anchor(window), { rule: RULE, ...o });
const headerReads = (d: ReturnType<typeof drive>, from = 0) => d.fr.log.slice(from).filter((l) => l.path.startsWith("/api/headers/")).length;
const settle = async (d: ReturnType<typeof drive>, n = 6) => { let s = await d.run(); for (let i = 0; i < n && s.lastError !== null; i++) s = await d.run(); return s; };

console.log("the fixture:");
const work = (rows: typeof chain.A) => { const lc = new LightClient(); lc.seedTrusted(chain.seed, ANCHOR.hash); const w0 = lc.chainwork; for (const r of rows) lc.ingest(r.height, r.header, r.hash); return lc.chainwork - w0; };
ok("its sha256 is pinned, and csd-light accepts both branches from the seed with the stated work",
  createHash("sha256").update(chainBytes).digest("hex") === "266e14d2d1c0dc6366efe97a31aaeb9c92b02ea7b0c1a0d937962e47bba63324" &&
  work(chain.A) === 69_661_988n && work(chain.B.slice(0, 4)) === 67_109_888n && work(chain.B.slice(0, 5)) === 83_887_360n);

console.log("a fork inside the window (window 8):");
const served: Hosted = { answers: onA, tip: 1089 }, d = drive(served), s0 = await d.run();
const tipA = { height: 1089, hash: A(1089), time: Number(chain.A[3]!.header.time) };
ok("A to 1089: the cursor on A1089, the tip that block's height, hash and header time, from the loop and from source.tip()",
  s0.cursor?.hash === A(1089) && s0.lastError === null && JSON.stringify(s0.tip) === JSON.stringify(tipA) && JSON.stringify(await d.inner.tip(new AbortController().signal)) === JSON.stringify(tipA));
served.answers = onB;
const s1 = await d.run();
ok("B to 1089, the same height with less work: LESS_WORK, the store unchanged", s1.lastError?.code === "LESS_WORK" && s1.cursor?.hash === A(1089) && s1.lastReorg === null);
served.tip = 1091;
const s2 = await settle(d);
ok("B to 1091, more work: rolled back to the fork block 1085, then B read to 1091", s2.lastReorg?.from.hash === A(1089) && s2.lastReorg.to.height === 1085 &&
  s2.lastReorg.to.hash === ANCHOR.hash && s2.cursor?.hash === B(1091) && s2.lastError === null && s2.tip?.hash === B(1091) && d.bad.length === 0, d.bad.join("; "));

console.log("a fork below the window (window 1), verified from workRoot:");
const below: Hosted = { answers: onA, tip: 1089 }, bw = drive(below, 1);
await bw.run();
below.answers = onB;
const m0 = bw.fr.log.length, b1 = await bw.run();
ok("B to 1089: LESS_WORK after a walk from workRoot (a header read from 1086), the store unchanged",
  b1.lastError?.code === "LESS_WORK" && b1.cursor?.hash === A(1089) && bw.fr.log.slice(m0).some((l) => l.path === "/api/headers/1086/4"));
const m1 = bw.fr.log.length, b2 = await settle(bw, 3);
ok("asked again with the same tip: LESS_WORK at once, with no header read (the refusal is kept)", b2.lastError?.code === "LESS_WORK" && headerReads(bw, m1) === 0);
below.tip = 1091;
const b3 = await settle(bw);
ok("B to 1091: adopted, rolled back to the fork block 1085, then B read to 1091", b3.lastReorg?.to.height === 1085 && b3.cursor?.hash === B(1091) && b3.lastError === null && bw.bad.length === 0);

// The anchor root alone, reading headers 4 at a time, so the walk from workRoot needs more than one read.
const fr4: Hosted = { answers: onA, tip: 1089 }, f4 = front(fr4), sess = httpSessions(ORIGIN, { fetch: f4.f }, "/api/rpc"), root4 = anchorRoot(ANCHOR, 1, 4);
const rowsOf = (rows: typeof chain.A) => rows.map((r) => ({ height: r.height, header: r.header, hash: r.hash }));
const c0 = ctx({}, { rule: RULE }), headA = { height: 1089, hash: A(1089) }, headB = { height: 1091, hash: B(1091) };
const c1 = ctx({}, { rule: RULE, cursor: headA, hashAt: (x) => (x === 1089 ? A(1089) : null) });
// The window extended under a cursor at A1089 keeps 46 headers (window 1), so a fork at 1086 lies below it.
const g0 = await root4.begin(sess(c0.signal), c0, headA), k0 = await root4.check(sess(c1.signal), c1, headA, rowsOf(chain.A), true);
fr4.answers = onB; fr4.tip = 1091;
const k1 = await root4.check(sess(c1.signal), c1, headB, rowsOf(chain.B.slice(4)), true).catch((e: unknown) => ({ verified: -1, error: e }));
ok("the walk from workRoot in reads of 4 goes past the cursor (B to 1089 is lighter) until B has more work, then rolls back to 1085",
  !("kind" in g0) && "verified" in k0 && k0.verified === 4 && "kind" in k1 && k1.kind === "reorg" && k1.to.height === 1085 && f4.log.filter((l) => l.path.startsWith("/api/headers/1090/")).length === 1,
  `${JSON.stringify(g0)} ${JSON.stringify(k0)} ${JSON.stringify(k1, (_k, v) => (typeof v === "bigint" ? String(v) : v))} ${f4.log.map((l) => l.path).join(" ")}`);

console.log("a reorg between two page reads of one step (maxBlocks 128):");
let switched = false;
const mid: Hosted = { answers: onA, tip: 1089, fail: (p) => { if (!switched && p.startsWith("/api/blocks/1088/")) { switched = true; mid.answers = onB; mid.tip = 1091; } return null; } };
const md = drive(mid, 8, { maxBlocks: 128 }), ms = await md.run(), firstStep = md.steps[0]!.step;
ok("the step that bound A1086 and A1087 before the server moved to B commits none of them", switched && firstStep.kind === "idle" && ms.cursor === null);
const ms2 = await settle(md);
ok("the next step reads B to 1091", ms2.cursor?.hash === B(1091) && ms2.lastError === null && md.bad.length === 0);
mid.answers = onA; mid.tip = 1087;
const ms3 = await md.run();
ok("the server then names A to 1087, lighter than the B held: LESS_WORK, the store on B", ms3.lastError?.code === "LESS_WORK" && ms3.cursor?.hash === B(1091));

console.log("a rollback whose commit failed:");
let failed = false;
const inner = memoryStore(), failing: Store = { ...inner, commit: async (c) => ("rollbackTo" in c && !failed && (failed = true) ? { ok: false, code: "STORE_FAILED" } : inner.commit(c)) };
const fc: Hosted = { answers: onA, tip: 1089 }, fd = drive(fc, 8, { store: failing });
await fd.run();
fc.answers = onB; fc.tip = 1091;
const f1 = await fd.run();
ok("B to 1091 adopted, its rollback's commit refused: STORE_FAILED, the store still on A1089", failed && f1.lastError?.code === "STORE_FAILED" && f1.cursor?.hash === A(1089));
fc.answers = onA; fc.tip = 1087;
const f2 = await settle(fd);
ok("the server then names A to 1087: the rollback to 1085 is returned again, then LESS_WORK, never A", f2.lastReorg?.to.height === 1085 && f2.cursor?.height === 1085 &&
  f2.lastError?.code === "LESS_WORK" && fd.bad.length === 0);

console.log("a walk that fails:");
let mixedOnce = true;
const wf: Hosted = { answers: onA, tip: 1089 }, wd = drive(wf, 1);
await wd.run();
Object.assign(wf, { answers: onB, tip: 1091, fail: (p: string) => (p === "/api/headers/1086/6" && mixedOnce && !(mixedOnce = false)
  ? new Response(headerAnswer([...chain.A.slice(0, 2), ...chain.B.slice(2)]), { headers: { "content-type": "application/json" } }) : null) });
const w1 = await wd.run(), w2 = await settle(wd);
ok("one mixed header answer during the walk: HEADER_INVALID, then the walk starts afresh and B is adopted", w1.lastError?.code === "HEADER_INVALID" && !mixedOnce &&
  w2.cursor?.hash === B(1091) && w2.lastError === null);

console.log("a source that holds a window, given a store it did not fill:");
const twice: Hosted = { answers: onA, tip: 1089 }, tw = drive(twice, 8);
await tw.run();
const otherStore = memoryStore();
await drive({ answers: onB, tip: 1089 }, 8, { store: otherStore }).run();
twice.answers = onB;
let tt = 0;
const second = replicaLoop({ source: tw.inner, store: otherStore, rule: RULE, clock: () => (tt += 1_000), maxRequests: 50 }), sc = await second.advance({ budgetMs: 600_000 });
ok("its window on A to 1089, the store on B to 1089: the walk from workRoot must beat the window's work, so LESS_WORK and the store kept",
  sc.lastError?.code === "LESS_WORK" && sc.cursor?.hash === B(1089) && sc.lastReorg === null);

console.log("a store filled before the source started, which keeps the source's window (a restart, or a reorg while closed):");
const kept = memoryStore();
await drive({ answers: onA, tip: 1089 }, 8, { store: kept }).run();
const aWindow = await kept.headerWindow();
const rs = drive({ answers: onB, tip: 1089 }, 8, { store: kept }), r1 = await settle(rs);
ok("a new source over a store on A to 1089, its server on the lighter B to 1089: the kept window's work is the bar, so LESS_WORK and the store kept",
  r1.lastError?.code === "LESS_WORK" && r1.cursor?.hash === A(1089) && r1.lastReorg === null, `${kinds(rs.steps).join()} ${r1.cursor?.hash}`);
const heavier = drive({ answers: onB, tip: 1091 }, 8, { store: kept }), r2 = await settle(heavier), fresh = await settle(drive({ answers: onB, tip: 1091 }, 8));
ok("the server on B to 1091, more work: rolled back to 1085 and B read to 1091, the fresh replica's cursor and events hash",
  r2.lastReorg?.to.height === 1085 && r2.cursor?.hash === B(1091) && r2.lastError === null && r2.eventsHash === fresh.eventsHash && fresh.cursor?.hash === B(1091) && heavier.bad.length === 0);
const onlyB = memoryStore();
await drive({ answers: onB, tip: 1089 }, 8, { store: onlyB }).run();
// The store on B to 1089 handed A's window, whose work and workRoot it does not carry: it does not hold the cursor's block.
const crossed: Store = { ...onlyB, rows: (x) => onlyB.rows(x), headerWindow: async () => aWindow };
const xs = drive({ answers: onB, tip: 1089 }, 8, { store: crossed }), x1 = await settle(xs);
ok("a store on B to 1089 given a window of A (another branch than its cursor): dropped, the walk from workRoot, the store on B as a fresh replica's",
  x1.lastError === null && x1.cursor?.hash === B(1089) && x1.lastReorg === null && headerReads(xs) >= 2, `${kinds(xs.steps).join()} ${x1.lastError?.code}`);
const on2 = memoryStore();
await drive({ answers: onA, tip: 1089 }, 8, { store: on2 }).run();
const blindStore: Store = { ...on2, rows: (x) => on2.rows(x), headerWindow: async () => null };
const bl = drive({ answers: onB, tip: 1089 }, 8, { store: blindStore }), b9 = await settle(bl);
ok("the same restart with the window withheld: no work to beat, so it rolls back to 1085 and follows the lighter B",
  b9.lastReorg?.to.height === 1085 && b9.cursor?.hash === B(1089) && b9.lastError === null, `${kinds(bl.steps).join()} ${b9.cursor?.hash}`);

done("cairnx-replica hosted work");
