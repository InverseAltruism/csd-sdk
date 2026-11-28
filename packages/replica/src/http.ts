// The reads of a block source, through csd-client (its byte cap and exact u64 parse) over a fetch that carries the
// step's signal, counts the step's requests and spaces their starts `paceMs` apart. Every request bypasses HTTP caches
// (cache mode no-store, which also sends Cache-Control: no-cache and Pragma: no-cache) and refuses redirects, so the
// address rule of the entry covers every host read. The request timeout starts after the pace wait; an abort ends the
// wait at once. A 429 is SOURCE_RATE_LIMITED and a 503 SOURCE_UNAVAILABLE, each with the wait its Retry-After asks for.
// An edge cache in front of a server may answer despite no-store, so `json` can name a fresh URL (a query parameter
// the routes ignore), which a cache keyed on the whole URL has not stored and passes to the origin; `twice` reads an
// answer once more that way when what was served is refused.
import { CsdClient, parseJsonExact } from "@inversealtruism/csd-client";
import { BACKOFF_MAX_MS, ReplicaConfigError, SourceError, messageOf } from "./errors.js";

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

/** A wait of `ms` that the signal ends at once, rejecting with its reason. */
export const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((go, stop) => {
  if (signal.aborted) { stop(signal.reason); return; }
  const done = () => { signal.removeEventListener("abort", quit); go(); };
  const quit = () => { clearTimeout(t); stop(signal.reason); };
  const t = setTimeout(done, ms);
  signal.addEventListener("abort", quit, { once: true });
});

/** The longest Retry-After a feed waits out before it sends the same request again: our front door's limiter is a
 *  fixed one-minute window whose Retry-After is the seconds to its reset. */
export const RETRY_WAIT_MAX_MS = 60_000;
/** How many refusals of one request in a row are waited out; the next ends the wait. */
export const RETRY_TRIES = 3;

/** `waitMaxMs` as a Scanner or a feed takes it: a whole number of milliseconds from 0 (no wait) to BACKOFF_MAX_MS, the
 *  longest Retry-After any wait takes; else ReplicaConfigError. */
export function waitMaxOf(v: unknown, what: string): number {
  if (!(Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= BACKOFF_MAX_MS)) {
    throw new ReplicaConfigError(`${what}: waitMaxMs is a whole number of milliseconds from 0 to ${BACKOFF_MAX_MS}`);
  }
  return v as number;
}

/** `send()`, sent again after each 429 or 503 whose Retry-After asks at most `maxMs` (RETRY_TRIES times in a row at
 *  most), with `waited()` run after each wait and before the request goes again; any other answer is returned. A
 *  refusal it does not wait out (a `maxMs` of 0, no Retry-After, one out of form or over `maxMs`, one refusal too
 *  many, or `late()` true, a step past its deadline) throws SourceError SOURCE_RATE_LIMITED for a 429 and
 *  SOURCE_UNAVAILABLE for a 503, with the wait asked. The signal ends a wait at once. */
export async function waitingOut(send: () => Promise<Response>, what: string, maxMs: number, signal: AbortSignal, waited?: () => Promise<void>, late?: () => boolean): Promise<Response> {
  for (let tries = 0; ; tries++) {
    const r = await send();
    if (r.status !== 429 && r.status !== 503) return r;
    const ms = retryAfterMs(r.headers.get("retry-after"), Date.now());
    await r.body?.cancel();
    if (maxMs <= 0 || ms === null || ms > maxMs || tries >= RETRY_TRIES || late?.() === true) {
      throw new SourceError(r.status === 429 ? "SOURCE_RATE_LIMITED" : "SOURCE_UNAVAILABLE", `${what} answered ${r.status}`, ms);
    }
    await pause(ms, signal);
    await waited?.();
  }
}
// Without AbortSignal.any (Node before 20.3) a request keeps only its timeout, and an abort waits for that.
export const either = (a: AbortSignal, b: AbortSignal): AbortSignal => (typeof AbortSignal.any === "function" ? AbortSignal.any([a, b]) : b);
// csd-client's own timeout would start before the pace wait, so it is set past any wait and ours is used instead.
const CLIENT_TIMEOUT_MS = 2 ** 31 - 1;

// A copy of csd-client's capped body read, which is private to its class (CHANGELOG, 2026-11-18), for a JSON answer
// that is not a node path: refuse a declared or streamed body over the cap before parsing, read a body without a
// stream reader as text and check its bytes, and parse u64 literals exactly. Unlike csd-client it throws
// SourceError SOURCE_MALFORMED, so a step reports a code. A body refused unread is cancelled, which lets its
// connection go; left unread, Node's fetch holds the connection until the response is garbage collected.
export const MAX_BYTES = 16 * 1024 * 1024;
export async function cappedJson(r: Response, what: string, max = MAX_BYTES): Promise<unknown> {
  const text = await cappedText(r, what, max);
  try { return parseJsonExact(text); } catch (e) { throw new SourceError("SOURCE_MALFORMED", `${what}: ${messageOf(e)}`); }
}
/** The body of `r` as text, read under the cap of cappedJson. */
export async function cappedText(r: Response, what: string, max = MAX_BYTES): Promise<string> {
  const over = () => new SourceError("SOURCE_MALFORMED", `${what}: the answer is over ${max} bytes`);
  if (Number(r.headers.get("content-length") ?? 0) > max) { await r.body?.cancel(); throw over(); }
  const body = r.body as ReadableStream<Uint8Array> | null | undefined;
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    const text = await r.text();
    if (new TextEncoder().encode(text).length > max) throw over();
    return text;
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
  return new TextDecoder().decode(all);
}

/** A factory of sessions over `base`, the client's paths below `base + rpc`; the pace holds across them. `waitMaxMs`
 *  (internal, a feed's) is the longest Retry-After waited out (waitingOut); without it every 429 and 503 throws. A
 *  session's `late()`, when given, is the step's deadline: past it no wait starts. */
export function httpSessions(base: string, o: HttpOptions & { readonly waitMaxMs?: number }, rpc = ""): (signal: AbortSignal, late?: () => boolean) => Session {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis), paceMs = o.paceMs ?? 0, timeoutMs = o.timeoutMs ?? 10_000;
  let nextAt = 0, fresh = 0;
  return (signal, late) => {
    let n = 0;
    const paced: typeof fetch = async (input, init) => {
      signal.throwIfAborted();
      const now = Date.now(), wait = nextAt - now;
      nextAt = Math.max(nextAt, now) + paceMs;
      if (wait > 0) await pause(wait, signal);
      const send = () => { n++; return f(input, { ...init, cache: "no-store", redirect: "error", signal: either(signal, AbortSignal.timeout(timeoutMs)) }); };
      return waitingOut(send, String(input), o.waitMaxMs ?? 0, signal, undefined, late);
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
