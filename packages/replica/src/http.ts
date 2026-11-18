// The reads of a block source, through csd-client (its byte cap and exact u64 parse) over a fetch that carries the
// step's signal, counts the step's requests and spaces their starts `paceMs` apart. Every request bypasses HTTP caches
// (cache mode no-store, which also sends Cache-Control: no-cache and Pragma: no-cache) and refuses redirects, so the
// address rule of the entry covers every host read. The request timeout starts after the pace wait; an abort ends the
// wait at once. A 429 is SOURCE_RATE_LIMITED and a 503 SOURCE_UNAVAILABLE, each with the wait its Retry-After asks for.
import { CsdClient } from "@inversealtruism/csd-client";
import { BACKOFF_MAX_MS, SourceError } from "./errors.js";

/** How a block source reaches its node: `fetch` for a runtime without a global one, `paceMs` between request starts
 *  (default 0), `timeoutMs` per request from its start (default 10 s). */
export interface HttpOptions { readonly fetch?: typeof fetch; readonly paceMs?: number; readonly timeoutMs?: number }

/** One step's reads. */
export interface Session { readonly client: CsdClient; requests(): number }

const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
/** The wait a Retry-After value asks for, in milliseconds, at most BACKOFF_MAX_MS: delta seconds or an IMF-fixdate.
 *  Null for anything else (a fraction, a sign, a list), so the caller's own backoff applies. */
export function retryAfterMs(v: string | null, now: number): number | null {
  const s = v?.trim() ?? "";
  const ms = /^[0-9]+$/.test(s) ? Number(s) * 1000 : HTTP_DATE.test(s) ? Date.parse(s) - now : Number.NaN;
  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), BACKOFF_MAX_MS) : null;
}

const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((go, stop) => {
  const done = () => { signal.removeEventListener("abort", quit); go(); };
  const quit = () => { clearTimeout(t); stop(signal.reason); };
  const t = setTimeout(done, ms);
  signal.addEventListener("abort", quit, { once: true });
});
// Without AbortSignal.any (Node before 20.3) a request keeps only its timeout, and an abort waits for that.
const either = (a: AbortSignal, b: AbortSignal): AbortSignal => (typeof AbortSignal.any === "function" ? AbortSignal.any([a, b]) : b);
// csd-client's own timeout would start before the pace wait, so it is set past any wait and ours is used instead.
const CLIENT_TIMEOUT_MS = 2 ** 31 - 1;

/** A factory of sessions over `base`; the pace holds across them. */
export function httpSessions(base: string, o: HttpOptions): (signal: AbortSignal) => Session {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis), paceMs = o.paceMs ?? 0, timeoutMs = o.timeoutMs ?? 10_000;
  let nextAt = 0;
  return (signal) => {
    let n = 0;
    const paced: typeof fetch = async (input, init) => {
      signal.throwIfAborted();
      const now = Date.now(), wait = nextAt - now;
      nextAt = Math.max(nextAt, now) + paceMs;
      if (wait > 0) await pause(wait, signal);
      n++;
      const r = await f(input, { ...init, cache: "no-store", redirect: "error", signal: either(signal, AbortSignal.timeout(timeoutMs)) });
      const after = () => retryAfterMs(r.headers.get("retry-after"), Date.now());
      if (r.status === 429) throw new SourceError("SOURCE_RATE_LIMITED", `${String(input)} answered 429`, after());
      if (r.status === 503) throw new SourceError("SOURCE_UNAVAILABLE", `${String(input)} answered 503`, after());
      return r;
    };
    return { client: new CsdClient({ baseUrl: base, fetch: paced, timeoutMs: CLIENT_TIMEOUT_MS }), requests: () => n };
  };
}
