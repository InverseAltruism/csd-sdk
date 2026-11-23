// indexerFeed across steps: an advance aborted while the scan waits on the indexer ends at once as aborted, leaves the
// store as it was and the next advance reads on; a step that ends short of its scan's top hands the scan to the next
// step, which reads it again only when the indexer no longer gives its tip hash; a step whose deadline passes ends
// once it has read its unit of boundaries and starts no wait.
import { CAIRNX_EVENT_RULE, DOMAIN } from "@inversealtruism/cairnx-core";
import { memoryStore, open, replicaLoop } from "../src/index.js";
import { STEP_UNIT } from "../src/scanner.js";
import { indexerFeed } from "../src/server.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { captureIndexer } from "./indexer-capture.js";

const WIDE = { maxBlocks: 100_000, maxRequests: 100_000 };
const settle = (ms: number) => new Promise((x) => setTimeout(x, ms));

console.log("an advance aborted mid-scan:");
{
  let now: typeof fetch = captureIndexer(fx, 60_000), hang = false;
  const f: typeof fetch = (input, init) => hang
    ? new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(init.signal!.reason), { once: true }))
    : now(input, init);
  const r = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: f }), store: memoryStore(), step: WIDE });
  const before = await r.advance();
  ok("setup: synced at 60,000", before.cursor?.height === 60_000 && before.lastError === null, JSON.stringify(before.lastError));
  now = captureIndexer(fx); hang = true;
  const stop = new AbortController(), running = r.advance({ signal: stop.signal });
  await settle(100);
  const t0 = Date.now();
  stop.abort(new Error("the caller's deadline"));
  const ended = await Promise.race([running.then(() => Date.now() - t0), settle(2_000).then(() => null)]);
  ok("the advance ends within 200 ms of the abort", ended !== null && ended < 200, `ended ${ended === null ? "not within 2 s" : `after ${ended} ms`}`);
  const s = r.status();
  ok("the store is as before the step: the cursor and the newest tuple unchanged, no error recorded",
    JSON.stringify(s.cursor) === JSON.stringify(before.cursor) && JSON.stringify(s.tuple) === JSON.stringify(before.tuple) && s.lastError === null,
    JSON.stringify({ cursor: s.cursor, lastError: s.lastError }));
  hang = false;
  const after = await r.advance();
  ok("the next advance reads on to 117,000", after.cursor?.height === 117_000 && after.cursor.hash === fx.toHash && after.lastError === null, JSON.stringify(after.lastError));
  await r.close();
}

console.log("a scan carried from a step that ended short of its top:");
const TIP = 31_000, OTHER = `0x${"ab".repeat(32)}`;
for (const moved of [false, true]) {
  let swap = false, pulls = 0;
  const base = captureIndexer(fx, TIP);
  const f: typeof fetch = async (input, init) => {
    const p = new URL(String(input)).pathname;
    if (p === `/domain/${encodeURIComponent(DOMAIN)}/proposals` || p === `/domain/${DOMAIN}/proposals`) pulls++;
    if (swap && p === `/block-height/${TIP}`) return Response.json(OTHER);
    if (swap && p === `/block/${OTHER}`) return Response.json({ height: TIP, hash: OTHER, time: 1_700_000_000 });
    return base(input, init);
  };
  // The loop's clock passes the first advance's deadline at the feed's first own read (cache no-store), after the scan.
  let late = false;
  const g: typeof fetch = (input, init) => { if (init?.cache === "no-store") late = true; return f(input, init); };
  const loop = replicaLoop({ source: indexerFeed({ indexerUrl: "http://idx", fetch: g }), store: memoryStore(), maxBlocks: 100_000, maxRequests: 10, clock: () => (late ? 10 : 0) });
  await loop.open();
  const first = await loop.advance({ budgetMs: 1 });
  if (first.cursor === null || first.cursor.height >= TIP) { ok("setup: the first advance ends short of the scan's top", false, JSON.stringify(first.cursor)); continue; }
  swap = moved;
  const end = (await loop.advance()).cursor;
  if (!moved) ok(`the indexer still gives the scan's tip hash: the next steps read on from the same scan to ${TIP}, no second pull`, pulls === 1 && end?.height === TIP, `${pulls} pulls, ${JSON.stringify(end)}`);
  else ok("the tip block changed: the next step scans again and ends on the new block", pulls === 2 && end?.height === TIP && end.hash === OTHER, `${pulls} pulls, ${JSON.stringify(end)}`);
  await loop.close();
}

console.log("a step past its deadline:");
{
  // `late` turns true at the feed's first own read (its session sends cache no-store; the Scanner does not), so the
  // deadline passes after the scan; `refuse` answers that read 429 with a 1 s wait.
  let late = false, refuse = false;
  const base = captureIndexer(fx, TIP);
  const f: typeof fetch = async (input, init) => {
    if (init?.cache === "no-store") {
      late = true;
      if (refuse) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    }
    return base(input, init);
  };
  const src = indexerFeed({ indexerUrl: "http://idx", fetch: f });
  const at = (deadlineAt: number, now = () => (late ? 1 : 0)) => src.next({
    rule: CAIRNX_EVENT_RULE, cursor: null, sofar: { eventIds: new Set(), proposeIds: new Set() }, hashAt: () => null, eventsHashAt: () => null,
    budget: { deadlineAt, maxRequests: 100_000, maxBlocks: 100_000 }, signal: new AbortController().signal, now,
  });
  const after = await at(1);
  ok(`the deadline passing after the scan: the step ends at the ${STEP_UNIT}th boundary it read (its unit), the scan's top its reach`,
    after.kind === "blocks" && after.cursor.height === 29_880 + (STEP_UNIT - 1) * 30 && after.reach === TIP,
    JSON.stringify(after.kind === "blocks" ? after.cursor : after));
  late = false; refuse = true;
  const t0 = Date.now(), refused = await at(1), ms = Date.now() - t0;
  ok("its first own read refused past the deadline: no wait, the step ends at once as SOURCE_RATE_LIMITED", refused.kind === "cannot" && refused.code === "SOURCE_RATE_LIMITED" && ms < 300,
    `${JSON.stringify(refused)} after ${ms} ms`);
  refuse = false;
  const before = await at(0, () => 1);
  ok(`a step past its deadline before its scan: the scan stops once it has read its unit (${STEP_UNIT} answers)`, before.kind === "cannot" && before.code === "SOURCE_UNAVAILABLE",
    JSON.stringify(before));
  const paired = await at(Number.POSITIVE_INFINITY);
  ok("paired: before its deadline the same step reads to the top", paired.kind === "blocks" && paired.cursor.height === TIP && paired.reach === undefined);
}

console.log("a boundary read refused and not waited out:");
{
  // waitMaxMs 0: no refusal is waited out; the feed's second own boundary read is refused
  let own = 0;
  const base = captureIndexer(fx, TIP);
  const f: typeof fetch = async (input, init) => {
    if (init?.cache === "no-store" && /\/block-height\//.test(String(input)) && ++own === 2) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return base(input, init);
  };
  const st = await indexerFeed({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 0 }).next({
    rule: CAIRNX_EVENT_RULE, cursor: null, sofar: { eventIds: new Set(), proposeIds: new Set() }, hashAt: () => null, eventsHashAt: () => null,
    budget: { deadlineAt: Number.POSITIVE_INFINITY, maxRequests: 100_000, maxBlocks: 100_000 }, signal: new AbortController().signal, now: () => 1_700_000_000_000,
  });
  ok("the step keeps what it read: it ends at the boundary before the refused one, the scan's top its reach", st.kind === "blocks" && st.cursor.height === 29_880 && st.reach === TIP,
    JSON.stringify(st.kind === "blocks" ? { cursor: st.cursor, reach: st.reach } : st));
}

console.log("a host that refuses every request:");
{
  let sent = 0;
  const refusing: typeof fetch = async () => { sent++; return new Response("{}", { status: 429, headers: { "retry-after": "0" } }); };
  const st = await indexerFeed({ indexerUrl: "http://idx", fetch: refusing }).next({
    rule: CAIRNX_EVENT_RULE, cursor: null, sofar: { eventIds: new Set(), proposeIds: new Set() }, hashAt: () => null, eventsHashAt: () => null,
    budget: { deadlineAt: Number.POSITIVE_INFINITY, maxRequests: 100, maxBlocks: 100 }, signal: new AbortController().signal, now: () => 1_700_000_000_000,
  });
  ok("each Retry-After 0: one request sent four times (three refusals waited out), then the step ends as SOURCE_RATE_LIMITED",
    st.kind === "cannot" && st.code === "SOURCE_RATE_LIMITED" && st.retryAfterMs === 0 && sent === 4, `${JSON.stringify(st)} after ${sent} requests`);
}

done("feed-steps");
