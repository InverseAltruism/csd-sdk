// The capture behind a stub that counts each path's answers, for the Scanner's resume and deadline tests.
import { fx } from "../core-files.js";
import { captureIndexer } from "../indexer-capture.js";

/** The capture to 31,000: a pull of some hundred requests. */
export const TIP = 31_000;
export const HASH_READ = /^\/(blocks\/tip\/height|block-height\/\d+)$/;

/** The capture to `tip` (default TIP), which refuses the `refuseAt`-th request with 429 `retry-after` (once), and every
 *  request `refuse(n, path)` names with the Retry-After it returns, counting each path's 200s; `swap` replaces an
 *  answer; from the `hangFrom`-th request on, none is answered until its signal aborts; `upTo` moves the capture's tip;
 *  `fail(n, path)` answers a request with a status of its own, or rejects it ("reject", a connection reset). */
export function host(tip = TIP) {
  let base = captureIndexer(fx, tip);
  const served = new Map<string, number>(), firstAt = new Map<string, number>();
  const h = {
    refuseAt: 0, retryAfter: "0", n: 0, swap: null as ((path: string) => unknown) | null, served, firstAt, hangFrom: 0,
    refuse: null as ((n: number, path: string) => string | null) | null, upTo(t: number) { base = captureIndexer(fx, t); },
    fail: null as ((n: number, path: string) => number | "reject" | null) | null,
  };
  const f: typeof fetch = async (input, init) => {
    h.n++;
    const u = new URL(String(input));
    if (h.n === h.refuseAt) return new Response("{}", { status: 429, headers: { "retry-after": h.retryAfter } });
    const after = h.refuse?.(h.n, u.pathname) ?? null;
    if (after !== null) return new Response("{}", { status: 429, headers: { "retry-after": after } });
    const failed = h.fail?.(h.n, u.pathname) ?? null;
    if (failed === "reject") throw new TypeError("fetch failed");
    if (failed !== null) return new Response("{}", { status: failed });
    if (h.hangFrom > 0 && h.n >= h.hangFrom) return new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(init.signal!.reason), { once: true }));
    const swapped = h.swap?.(u.pathname);
    const r = swapped === undefined ? await base(input, init) : Response.json(swapped);
    if (r.status === 200) { const k = u.pathname + u.search; served.set(k, (served.get(k) ?? 0) + 1); if (!firstAt.has(k)) firstAt.set(k, h.n); }
    return r;
  };
  return { h, f };
}
