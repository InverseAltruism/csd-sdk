// The reads of a block source, through csd-client (its byte cap and exact u64 parse) over a fetch that carries the
// step's signal, counts the step's requests and spaces their starts `paceMs` apart. Every request bypasses HTTP caches
// (cache mode no-store, which also sends Cache-Control: no-cache and Pragma: no-cache) and refuses redirects, so the
// address rule of the entry covers every host read. The request timeout starts after the pace wait; an abort ends the
// wait at once. A 429 is SOURCE_RATE_LIMITED and a 503 SOURCE_UNAVAILABLE, each with the wait its Retry-After asks for.
// An edge cache in front of a server may answer despite no-store, so `json` can name a fresh URL (a query parameter
// the routes ignore), which a cache keyed on the whole URL has not stored and passes to the origin; `twice` reads an
// answer once more that way when what was served is refused.
import { CsdClient, parseJsonExact } from "@inversealtruism/csd-client";
import { BACKOFF_MAX_MS, SourceError, messageOf } from "./errors.js";

/** How a block source reaches its node: `fetch` for a runtime without a global one, `paceMs` between request starts
 *  (default 0), `timeoutMs` per request from its start (default 10 s). */
export interface HttpOptions { readonly fetch?: typeof fetch; readonly paceMs?: number; readonly timeoutMs?: number }

/** One step's reads: `client` over the node's paths, `json` a GET of `path` below the base, `fresh` past caches. */
export interface Session { readonly client: CsdClient; requests(): number; json(path: string, fresh: boolean): Promise<unknown> }

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
export const either = (a: AbortSignal, b: AbortSignal): AbortSignal => (typeof AbortSignal.any === "function" ? AbortSignal.any([a, b]) : b);
// csd-client's own timeout would start before the pace wait, so it is set past any wait and ours is used instead.
const CLIENT_TIMEOUT_MS = 2 ** 31 - 1;

// A copy of csd-client's capped body read, which is private to its class (CHANGELOG, 2026-11-18), for a JSON answer
// that is not a node path: refuse a declared or streamed body over the cap before parsing, read a body without a
// stream reader as text and check its bytes, and parse u64 literals exactly. Unlike csd-client it throws
// SourceError SOURCE_MALFORMED, so a step reports a code. A body refused unread is cancelled, which lets its
// connection go; left unread, Node's fetch holds the connection until the response is garbage collected.
const MAX_BYTES = 16 * 1024 * 1024;
export async function cappedJson(r: Response, what: string, max = MAX_BYTES): Promise<unknown> {
  const over = () => new SourceError("SOURCE_MALFORMED", `${what}: the answer is over ${max} bytes`);
  if (Number(r.headers.get("content-length") ?? 0) > max) { await r.body?.cancel(); throw over(); }
  const parse = (text: string) => { try { return parseJsonExact(text); } catch (e) { throw new SourceError("SOURCE_MALFORMED", `${what}: ${messageOf(e)}`); } };
  const body = r.body as ReadableStream<Uint8Array> | null | undefined;
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    const text = await r.text();
    if (new TextEncoder().encode(text).length > max) throw over();
    return parse(text);
  }
  const reader = body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (let c = await reader.read(); !c.done; c = await reader.read()) {
    n += c.value.length;
    if (n > max) { await reader.cancel(); throw over(); }
    parts.push(c.value);
  }
  const all = new Uint8Array(n);
  parts.reduce((at, p) => { all.set(p, at); return at + p.length; }, 0);
  return parse(new TextDecoder().decode(all));
}

/** A factory of sessions over `base`, the client's paths below `base + rpc`; the pace holds across them. */
export function httpSessions(base: string, o: HttpOptions, rpc = ""): (signal: AbortSignal) => Session {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis), paceMs = o.paceMs ?? 0, timeoutMs = o.timeoutMs ?? 10_000;
  let nextAt = 0, fresh = 0;
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
    const json = async (path: string, bypass: boolean): Promise<unknown> => {
      const url = `${base}${path}${bypass ? `?fresh=${Date.now().toString(36)}.${(fresh++).toString(36)}` : ""}`, r = await paced(url);
      if (r.status !== 200) { await r.body?.cancel(); throw new SourceError("SOURCE_UNAVAILABLE", `${path} answered ${r.status}`); }
      return cappedJson(r, path);
    };
    return { client: new CsdClient({ baseUrl: `${base}${rpc}`, fetch: paced, timeoutMs: CLIENT_TIMEOUT_MS }), requests: () => n, json };
  };
}

/** Whether a refusal is of what a server served, which a read past caches may cure, rather than of its transport or
 *  of a source transaction read apart from the page. */
export const servedWrong = (e: unknown): boolean =>
  e instanceof SourceError && e.code !== "SOURCE_UNAVAILABLE" && e.code !== "SOURCE_RATE_LIMITED" && e.code !== "AUTHOR_UNBOUND";

/** `use` over the answer at `path`, read again past caches once when `use` refuses what was served. */
export async function twice<T>(s: Session, path: string, use: (v: unknown) => T | Promise<T>): Promise<T> {
  try { return await use(await s.json(path, false)); } catch (e) { if (!servedWrong(e)) throw e; }
  return use(await s.json(path, true));
}
