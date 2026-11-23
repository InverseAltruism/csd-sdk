// A source that has been failing: once its steps have failed, with none settled, for more than FAILING_MS (30
// minutes) from the first failure after the last settled step, every answer carries the note SOURCE_FAILING and a
// replica's server withholds it (503). The honest neighbours: an idle replica whose next step fails once, a failed
// step right after a good one, failing for 29 minutes, and a good step after the note, each withhold nothing; a
// resume() starts no failure clock.
import type { Source } from "../src/index.js";
import { indexerFeed, memoryStore, open, replicaLoop, replicaReads } from "../src/server.js";
import { FAILING_MS } from "../src/verdict.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { CAPTURE_TIME, captureIndexer } from "./indexer-capture.js";
import { cap } from "./node-harness.js";
import { nodeSource, timeAt } from "./reader-harness.js";

const MIN = 60_000, TIP = cap.to;
ok("FAILING_MS is 30 minutes", FAILING_MS === 30 * MIN);
let down = false, now = timeAt(TIP) * 1000 + MIN;
const node = nodeSource();
// The recorded node, or a node that refuses every step (a host restart, an outage).
const source: Source = { ...node, next: (ctx) => (down ? Promise.resolve({ kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "the node is down", retryAfterMs: 0 }) : node.next(ctx)) };
const r = await open({ source, clock: () => now });
const reads = replicaReads(r);
const notes = () => r.status().notes.map((n) => n.code);
const resolve = async () => (await reads("/cairnx/state"))!;

const good = await r.advance();
ok("setup: synced at the recorded tip, served", good.cursor?.height === TIP && good.lastError === null && (await resolve()).status === 200);

now += 31 * MIN;
ok("no step for 31 minutes and none failed (nothing advanced): no SOURCE_FAILING", r.status().lastError === null && !notes().includes("SOURCE_FAILING"), notes().join(","));
down = true;
await r.advance();
ok("idle for 31 minutes, then one failed step: no SOURCE_FAILING, served", r.status().lastError?.code === "SOURCE_UNAVAILABLE" && !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200,
  notes().join(","));
down = false;
await r.advance();

down = true;
await r.advance();
ok("a failed step right after a good one: no SOURCE_FAILING, served", r.status().lastError?.code === "SOURCE_UNAVAILABLE" && !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200);

now += 29 * MIN;
await r.advance();
ok("failing for 29 minutes: no SOURCE_FAILING, served", !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200, notes().join(","));

now += 2 * MIN;
await r.advance();
const withheld = await resolve(), note = r.status().notes.find((n) => n.code === "SOURCE_FAILING");
ok("failing for 31 minutes: SOURCE_FAILING with its detail, 503", note?.detail === "steps failing for 31 minutes; the last error SOURCE_UNAVAILABLE" &&
  withheld.status === 503 && withheld.headers["x-cairnx-notes"]?.split(",").includes("SOURCE_FAILING") === true, `${withheld.status} ${withheld.headers["x-cairnx-notes"]} ${JSON.stringify(note)}`);

down = false;
await r.advance();
ok("a good step after it: the note gone, served again", !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200, notes().join(","));
down = true;
await r.advance();
ok("then one failed step: a new failure clock, no SOURCE_FAILING, served", r.status().lastError !== null && !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200, notes().join(","));
await r.close();

console.log("a step its own deadline ends inside a pull is no failure:");
{
  // A synced feed, then the chain 30 blocks on and every request answered 12 s of the clock apart: each advance of 60 s
  // stops its pull at the deadline and the next resumes it. Then the source really fails.
  const T1 = 116_970;
  let t = CAPTURE_TIME * 1000 + MIN, tick = 0, base = captureIndexer(fx, T1), broken = false, sent = 0;
  const f: typeof fetch = async (input, init) => {
    sent++; t += tick;
    if (broken) throw new TypeError("fetch failed");
    return base(input, init);
  };
  const rd = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: f }), clock: () => t, step: { maxBlocks: 512, maxRequests: 600 } });
  const synced = await rd.advance();
  ok("setup: the feed synced at 116,970", synced.cursor?.height === T1, JSON.stringify(synced.lastError));
  base = captureIndexer(fx); tick = 12_000;
  const start = t, stops: (string | null)[] = [];
  while (t - start < 38 * MIN) { const st = await rd.advance({ budgetMs: 60_000 }); stops.push(st.lastError?.code ?? null); }
  const at38 = (await replicaReads(rd)("/cairnx/state"))!;
  ok(`${stops.length} advances of 60 s over 38 minutes, each stopped at its deadline: no error recorded, no SOURCE_FAILING, served`,
    stops.length > 5 && stops.every((c) => c === null) && !rd.status().notes.some((n) => n.code === "SOURCE_FAILING") && at38.status === 200,
    `${stops.join(",")} | ${at38.status} ${at38.headers["x-cairnx-notes"]}`);
  tick = 0; broken = true;
  await rd.advance();
  const failedAt = t, n0 = sent;
  t = failedAt + 500; await rd.advance();
  const early = sent - n0;
  t = failedAt + 1_001; await rd.advance();
  ok("a real failure after them backs off 1 s: no request half a second later, one a second later", rd.status().lastError?.code === "SOURCE_UNAVAILABLE" && early === 0 && sent - n0 > 0,
    `${early} then ${sent - n0} requests`);
  for (let k = 0; k < 32; k++) { t += MIN; await rd.advance(); }
  const down = (await replicaReads(rd)("/cairnx/state"))!;
  ok("paired: the source then failing for 32 minutes is withheld, 503 SOURCE_FAILING", down.status === 503 && down.headers["x-cairnx-notes"]?.split(",").includes("SOURCE_FAILING") === true,
    `${down.status} ${down.headers["x-cairnx-notes"]}`);
  await rd.close();
}

console.log("resume() starts no failure clock:");
{
  let t = timeAt(TIP) * 1000 + MIN, fail = false;
  const src: Source = { ...node, next: (ctx) => (fail ? Promise.resolve({ kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "down", retryAfterMs: 0 }) : node.next(ctx)) };
  const loop = replicaLoop({ source: src, store: memoryStore(), clock: () => t, maxBlocks: 100_000, maxRequests: 100_000 });
  await loop.open();
  const s = await loop.advance();
  t += 40 * MIN;
  ok("a resume takes the tip and starts no failure clock", loop.resume(s.tip!) && loop.status().failingSince === null);
  t += 31 * MIN;
  fail = true;
  await loop.advance();
  ok("the first failed step 31 minutes after it starts the clock there", loop.status().failingSince === t, String(loop.status().failingSince));
  await loop.close();
}

done("failing");
