// The Scanner past its run's deadline (`due()` true) starts no wait and no retry: a 429 then ends the scan at once,
// a confirmation's read refused then ends it too, and a pull that meets no 429 stops at its next request after the
// deadline, with one read of its tip block to confirm what it read. A resumed pull names no event above its tip. The
// signal ends a chain-order feed's page read; a failure of what the indexer answered drops the memo even when the
// signal had aborted; `waitMaxMs` is a whole number from 0 to 300,000, and 0 waits out nothing.
import { DOMAIN } from "@inversealtruism/cairnx-core";
import { ReplicaConfigError, SourceError } from "../../src/errors.js";
import { httpSessions } from "../../src/http.js";
import { indexerFeed } from "../../src/indexer-feed.js";
import { STEP_UNIT, Scanner, branchRefusal } from "../../src/scanner.js";
import { done, ok } from "../check.js";
import { fx } from "../core-files.js";
import { captureIndexer } from "../indexer-capture.js";
import { HASH_READ, host } from "./resume-host.js";
import { H0, buildChain, defaultSpecs } from "./scan-chain.js";

const twice = (served: Map<string, number>) => [...served].filter(([p, n]) => n > 1 && !HASH_READ.test(p.split("?")[0]!));
const timed = async <T>(p: Promise<T>) => { const t0 = Date.now(); const v = await p.catch((e: unknown) => e); return { v, ms: Date.now() - t0 }; };

console.log("past the deadline, a 429 starts no wait:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  // the deadline passes at the 60th request, which is refused with a 1 s wait
  h.refuse = (n) => (n === 60 ? "1" : null);
  const { v, ms } = await timed(s.scan({ due: () => h.n >= 60 }));
  ok("the scan ends at the refusal as SOURCE_RATE_LIMITED, within 300 ms, with the wait asked", v instanceof SourceError && v.code === "SOURCE_RATE_LIMITED" && v.retryAfterMs === 1_000 && ms < 300,
    `${String(v)} after ${ms} ms`);
}

console.log("a confirmation's read refused past the deadline is not waited out:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  let late = false;
  // the 60th request is refused with a 1 s wait taken before the deadline; every read after it is refused
  h.refuse = (n) => (n === 60 ? "1" : n > 60 ? (late = true, "1") : null);
  const { v, ms } = await timed(s.scan({ due: () => late }));
  ok("one wait (1 s), then the confirming read refused: the scan ends at once, within 1.3 s in all", v instanceof SourceError && ms >= 1_000 && ms < 1_300 && h.n === 61, `${String(v)} after ${ms} ms, ${h.n} requests`);
}

console.log("the longest a scan outlasts its deadline: one wait begun before it, then one request's timeout");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000, timeoutMs: 300 });
  let deadline = 0;
  // the 60th request is refused with a 1 s wait just before the deadline; the confirming read after it never answers
  h.refuse = (n) => (n === 60 ? (deadline = Date.now() + 5, "1") : null);
  h.hangFrom = 61;
  // AbortSignal.timeout's timer does not hold the process, which a real socket would; this one stands in for it
  const hold = setInterval(() => undefined, 100);
  const v = await s.scan({ due: () => deadline > 0 && Date.now() >= deadline }).catch((e: unknown) => e), over = Date.now() - deadline;
  clearInterval(hold);
  console.log(`  (measured: ${over} ms past the deadline with a 1,000 ms wait and a 300 ms timeout)`);
  ok("the scan ends within the wait and one timeout of its deadline (1,300 ms, with 200 ms of slack)", v instanceof Error && over >= 1_000 && over <= 1_500, `${String(v)} after ${over} ms`);
}

console.log("a pull that meets no 429 stops at the deadline:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  let dueAt = 0;
  const { v } = await timed(s.scan({ due: () => { if (h.n >= 50 && dueAt === 0) dueAt = h.n; return h.n >= 50; } }));
  const after = h.n - dueAt;
  ok("it stops as SOURCE_UNAVAILABLE at the deadline, at most two requests after it (the one in flight and the confirming read)",
    v instanceof SourceError && v.code === "SOURCE_UNAVAILABLE" && after <= 2, `${String(v)}, ${after} requests after the deadline`);
  const r = await s.scan();
  ok("the next scan resumes: a fresh scanner's events, nothing it read before the deadline read twice", branchRefusal(r.anchor) === null && twice(h.served).length === 0,
    JSON.stringify(twice(h.served).slice(0, 3)));
}

console.log("a deadline that has passed before the scan begins:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  let scans = 0, last: unknown = null;
  for (; scans < 40; scans++) {
    last = await s.scan({ due: () => true }).catch((e: unknown) => e);
    if (!(last instanceof SourceError)) break;
  }
  const r = last as { events?: unknown[]; anchor?: Parameters<typeof branchRefusal>[0] };
  ok(`each scan reads its unit (${STEP_UNIT} new answers) before it stops, so the pull finishes in ${scans + 1} scans, nothing read twice`,
    scans > 1 && branchRefusal(r.anchor) === null && twice(h.served).length === 0, `${scans} stops, then ${String(last).slice(0, 80)}`);
}

console.log("a resumed pull names no event above its tip:");
{
  // at 40,000 some proposals carry attestations mined above it
  const AT = 40_000, { h, f } = host(AT), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  h.refuseAt = 60;
  await s.scan({ due: () => h.n > 60 }).catch(() => undefined);   // the deadline passes during the wait
  h.upTo(fx.to);   // blocks above TIP mined on the same chain: the hash at TIP unchanged, later attestations listed
  h.refuseAt = 0;
  const r = await s.scan();
  const above = r.events.filter((e) => e.height > r.tipHeight);
  const want = await new Scanner({ indexerUrl: "http://idx", fetch: captureIndexer(fx, AT) }).scan();
  ok(`resumed at ${r.tipHeight}: no event above it, the events a scanner at ${AT} gives`, r.tipHeight === AT && above.length === 0 && JSON.stringify(r.events) === JSON.stringify(want.events),
    `${above.length} above, e.g. ${JSON.stringify(above[0]?.height)}`);
  const plain = await new Scanner({ indexerUrl: "http://idx", fetch: captureIndexer(fx, AT) }).scan();
  ok("paired, unresumed: a scan of an unmoving indexer gives the same events as before", JSON.stringify(plain.events) === JSON.stringify(want.events));
}

console.log("the signal ends a chain-order feed's page read:");
{
  const chain = buildChain(defaultSpecs()), idx = chain.indexer({ tip: H0 + 40 });
  let hangPages = false, fullPulls = 0;
  const stop = new AbortController();
  const f: typeof fetch = async (input, init) => {
    const p = decodeURIComponent(new URL(String(input)).pathname);
    if (p === `/domain/${DOMAIN}/proposals` && new URL(String(input)).searchParams.get("from") === "0") fullPulls++;
    if (init?.signal?.aborted) throw init.signal.reason;
    if (hangPages && p === "/proposals") {
      const enc = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('{"at":')); init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason), { once: true }); } }), { status: 200 });
    }
    const r = (await idx(input, init)) as unknown as { status: number; json(): Promise<unknown> };
    return r instanceof Response ? r : new Response(JSON.stringify(await r.json()), { status: r.status });
  };
  const s = new Scanner({ indexerUrl: "http://idx", fetch: f, pageSize: 3, waitMaxMs: 60_000 });
  ok("setup: the first scan is accepted, a full pull", branchRefusal((await s.scan()).anchor) === null && fullPulls === 1);
  const warm = await s.scan();
  ok("setup: the next scan reads the chain-order feed, no full pull", branchRefusal(warm.anchor) === null && fullPulls === 1, `${fullPulls} full pulls`);
  const before = fullPulls;
  hangPages = true;
  const scanning = s.scan({ signal: stop.signal });
  await new Promise((x) => setTimeout(x, 50));
  stop.abort(new Error("the step's deadline"));
  const v = await scanning.catch((e: unknown) => e);
  ok("aborted mid-page: the scan rejects with the signal's reason, and no full pull follows", v instanceof Error && v.message === "the step's deadline" && fullPulls === before,
    `${v instanceof Error ? v.message : JSON.stringify(v)?.slice(0, 120)}, ${fullPulls - before} full pulls`);
}

console.log("a failure of what the indexer answered drops the memo, the signal aborted or not:");
{
  const { h, f } = host(), stop = new AbortController(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  h.refuseAt = 60;
  // at the 80th request the signal aborts and the answer is an attestation list out of form
  h.swap = (p) => (h.n >= 80 && /^\/proposal\//.test(p) ? (stop.abort(new Error("deadline")), { not: "a list" }) : undefined);
  const v = await s.scan({ signal: stop.signal }).catch((e: unknown) => e);
  ok("setup: the scan throws what the list broke, with the signal aborted", v instanceof Error && /non-array attestations page/.test(v.message) && stop.signal.aborted, String(v));
  h.swap = null;
  const before = new Map(h.served), r = await s.scan();
  const again = [...h.served].filter(([p, n]) => /^\/tx\//.test(p) && n > (before.get(p) ?? 0) && (before.get(p) ?? 0) > 0 && (h.firstAt.get(p) ?? 0) < 61);
  ok("the next scan reads the confirmed part again: the memo was dropped", branchRefusal(r.anchor) === null && again.length > 0, `${again.length} confirmed answers read again`);
}

console.log("waitMaxMs where it enters:");
for (const bad of [-1, 1.5, Number.NaN, 300_001, Number.POSITIVE_INFINITY]) {
  const s = (() => { try { new Scanner({ indexerUrl: "http://idx", waitMaxMs: bad }); return null; } catch (e) { return e; } })();
  const fd = (() => { try { indexerFeed({ indexerUrl: "http://idx", waitMaxMs: bad }); return null; } catch (e) { return e; } })();
  ok(`waitMaxMs ${bad}: ReplicaConfigError from the Scanner and from indexerFeed`, s instanceof ReplicaConfigError && fd instanceof ReplicaConfigError, `${String(s)} | ${String(fd)}`);
}
{
  ok("paired: 0 and 300,000 are taken", (() => { new Scanner({ indexerUrl: "http://idx", waitMaxMs: 0 }); indexerFeed({ indexerUrl: "http://idx", waitMaxMs: 300_000 }); return true; })());
  let sent = 0;
  const refusing: typeof fetch = async () => { sent++; return new Response("{}", { status: 429, headers: { "retry-after": "0" } }); };
  const step = await indexerFeed({ indexerUrl: "http://idx", fetch: refusing, waitMaxMs: 0 }).next({
    rule: { domain: DOMAIN, activationHeight: 0 } as never, cursor: null, sofar: { eventIds: new Set(), proposeIds: new Set() }, hashAt: () => null, eventsHashAt: () => null,
    budget: { deadlineAt: Number.POSITIVE_INFINITY, maxRequests: 100, maxBlocks: 100 }, signal: new AbortController().signal, now: () => 1_700_000_000_000,
  });
  ok("indexerFeed with waitMaxMs 0 against a 429 with Retry-After 0: one request, no wait", step.kind === "cannot" && sent === 1, `${JSON.stringify(step)} after ${sent}`);
  sent = 0;
  const e = await httpSessions("http://idx", { fetch: refusing, waitMaxMs: 0 })(new AbortController().signal).json("/block-height/1", false).catch((x: unknown) => x);
  ok("a feed's session with waitMaxMs 0: one request, the 429 thrown, no wait", e instanceof SourceError && e.code === "SOURCE_RATE_LIMITED" && sent === 1, `${String(e)} after ${sent}`);
}

done("scan-deadline");
