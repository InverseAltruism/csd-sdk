// A feed's first sync against a host that limits requests as our front door does: a fixed window per client, a 429
// with Retry-After the whole seconds to the window's reset (cairn src/server.ts rateLimiter). The window here is 1 s,
// not 60 s, so the run takes seconds. Each advance has a budget shorter than the cold pull, so the pull must stop and
// resume across advances: the sync completes, its requests stay within a factor of the same run unlimited, and no
// answer of the pull is read twice. Without the kept pull (the mutation that drops the memo at a stop) every advance
// starts the pull over and the run does not finish by its deadline.
import { eventsHash, resolve, stateHash, type ChainEvent } from "@inversealtruism/cairnx-core";
import { applyOrder } from "../src/order.js";
import { indexerFeed, memoryStore, open } from "../src/server.js";
import { done, ok } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { captureIndexer } from "./indexer-capture.js";

const WINDOW_MS = 1_000, PER_WINDOW = 500, BUDGET_MS = 1_500, DEADLINE_MS = 90_000, FACTOR = 1.05;
const STEP = { maxBlocks: 512, maxRequests: 600 } as const;

/** The capture behind a limiter (`per` requests a window, none when 0), each answer `latencyMs` late, counting every
 *  request and each path's 200s. */
function host(per: number, latencyMs = 0) {
  const base = captureIndexer(fx), served = new Map<string, number>();
  let requests = 0, refused = 0, windowAt = 0, used = 0;
  const f: typeof fetch = async (input, init) => {
    requests++;
    const now = Date.now();
    if (now - windowAt >= WINDOW_MS) { windowAt = now; used = 0; }
    if (per > 0 && ++used > per) {
      refused++;
      return new Response(JSON.stringify({ ok: false, error: "rate limit exceeded" }), { status: 429, headers: { "retry-after": String(Math.ceil((windowAt + WINDOW_MS - now) / 1000)) } });
    }
    if (latencyMs > 0) await new Promise((x) => setTimeout(x, latencyMs));
    const r = await base(input, init), u = new URL(String(input));
    if (r.status === 200) served.set(u.pathname + u.search, (served.get(u.pathname + u.search) ?? 0) + 1);
    return r;
  };
  return { f, served, counts: () => ({ requests, refused }) };
}

async function sync(per: number, o: { budgetMs?: number; latencyMs?: number } = {}) {
  const h = host(per, o.latencyMs), t0 = Date.now(), budgetMs = o.budgetMs ?? BUDGET_MS;
  const r = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: h.f }), store: memoryStore(), step: STEP });
  let s = r.status(), advances = 0;
  try {
    while (Date.now() - t0 < DEADLINE_MS) {
      s = await r.advance({ budgetMs });
      advances++;
      if (s.cursor !== null && s.at !== null && s.lastError === null && s.cursor.height >= s.at.tipHeight) break;
      const retry = r.status().lastError === null ? 0 : 50;
      await new Promise((x) => setTimeout(x, retry));
    }
  } finally { await r.close(); }
  return { s, advances, ms: Date.now() - t0, ...h.counts(), served: h.served };
}

console.log("a cold sync of the capture (29,860 to 117,000):");
const free = await sync(0);
const t = free.s.tuple, ev = corpus.events.filter((e: ChainEvent) => e.height <= (t?.height ?? -1)).sort(applyOrder);
ok("unlimited: the sync completes at 117,000, its newest tuple's events and state hashes a replay of the corpus's",
  free.s.cursor?.height === 117_000 && free.s.cursor.hash === fx.toHash && t !== null && t.eventsHash === eventsHash(ev) && t.stateHash === stateHash(resolve(ev, t.height)), JSON.stringify(t));
const lim = await sync(PER_WINDOW);
ok(`limited to ${PER_WINDOW} a ${WINDOW_MS} ms window, advances of ${BUDGET_MS} ms: the sync completes at 117,000 by its ${DEADLINE_MS / 1000} s deadline`,
  lim.s.cursor?.height === 117_000 && lim.s.cursor.hash === fx.toHash, `cursor ${lim.s.cursor?.height ?? null} after ${lim.ms} ms, ${lim.advances} advances, last error ${JSON.stringify(lim.s.lastError)}`);
ok("its newest tuple is the unlimited run's", JSON.stringify(lim.s.tuple) === JSON.stringify(free.s.tuple), JSON.stringify(lim.s.tuple));
ok(`it took more than one advance (${lim.advances}), so the pull stopped and resumed`, lim.advances > 1 && lim.refused > 0, `${lim.advances} advances, ${lim.refused} refused`);
ok(`its requests, refused ones included (${lim.requests}), are within ${FACTOR} of the unlimited run's (${free.requests})`, lim.requests <= free.requests * FACTOR,
  `${lim.requests} against ${free.requests}`);
// The tip, its hash and its time are read again by design; every other answer is a page or a record of the pull.
const repeated = [...lim.served].filter(([p, n]) => n > 1 && !/^\/(blocks\/tip\/height|block-height\/\d+|block\/0x[0-9a-f]{64})$/.test(p));
ok("no page, attestation list or transaction of the pull is answered twice", repeated.length === 0, repeated.slice(0, 5).map(([p, n]) => `${p} x${n}`).join(", "));
console.log(`  (unlimited ${free.requests} requests in ${free.ms} ms; limited ${lim.requests} requests, ${lim.refused} refused, ${lim.advances} advances, ${lim.ms} ms)`);

// Every step moves the pull by at least STEP_UNIT answers (or boundaries) before it honours its deadline, so a budget
// shorter than one request still finishes the sync.
const SHORT = { budgetMs: 1, latencyMs: 2 }, SHORT_FACTOR = 1.3;
const short = await sync(0, SHORT);
ok(`advances of 1 ms against answers 2 ms late: the sync completes at 117,000 by its deadline, its newest tuple the unlimited run's (${short.advances} advances)`,
  short.s.cursor?.height === 117_000 && JSON.stringify(short.s.tuple) === JSON.stringify(free.s.tuple), `cursor ${short.s.cursor?.height ?? null} after ${short.ms} ms, ${short.advances} advances, last error ${JSON.stringify(short.s.lastError)}`);
ok(`its requests (${short.requests}) are within ${SHORT_FACTOR} of the unlimited run's (${free.requests})`, short.requests <= free.requests * SHORT_FACTOR, `${short.requests} against ${free.requests}`);

done("feed-cold");
