// The open server (./server openServer, `cairnx-replica serve`): the paths cairn-wallet sends to a server its user
// adds, on one origin, from the runner's own node and a replica of it. The node routes answer as our front door does
// (cairn src/routes/rpc.ts, chain.ts and lib/txstatus.ts with one backend): /api/rpc/* relays the node's status, content
// type and bytes; /api/rpc/tx/:id/status and /api/headers/:from/:count are built from node reads; POST
// /api/rpc/tx/submit sends the body on and the node's JSON back. The three name routes are replicaReads's answers. It
// signs nothing and holds no key. Every answer carries CORS and no-store, and none is a 3xx: a node redirect is a 502.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cappedText, either } from "./http.js";
import type { ReadResponse } from "./read-routes.js";

/** Node requests of the GET routes in flight (`reads`) and waiting (`queued`), and of submits apart, so a send never
 *  waits behind reads; per request timeouts from the moment it queues, each under the wallet's own (12 s GET, 20 s
 *  POST) so the server answers first; a header range's deadline, size and fan-out, cairn's; the submit's body cap,
 *  cairn's. The socket's: a request's headers within `requestHeadersMs` and the whole request within `requestMs`, the
 *  wallet's POST timeout, past which it has given up; an answer handed to the reader within `responseMs`, likewise; a
 *  socket idle for `idleMs` closed, above the longest node wait (`submitMs`); at most `connections` sockets. */
export const OPEN_LIMITS = Object.freeze({
  reads: 16, queued: 256, submits: 4, submitsQueued: 64,
  readMs: 10_000, submitMs: 15_000, headersMs: 10_000, headersMax: 512, fanout: 8, submitBytes: 512 * 1024,
  requestHeadersMs: 10_000, requestMs: 20_000, responseMs: 20_000, idleMs: 30_000, keepAliveMs: 5_000, connections: 256,
});
export const SUBMIT_PATH = "/api/rpc/tx/submit";
/** The default listen address and port: loopback, so a public bind is the runner's explicit choice. */
export const OPEN_HOST = "127.0.0.1";
export const OPEN_PORT = 8796;

export interface OpenServerOptions {
  /** The replica's reads (replicaReads), asked with `/cairnx/<route>/<name>`. */
  readonly reads: (path: string) => Promise<ReadResponse | null>;
  readonly fetch?: typeof fetch;
}
/** One request: its body read under OPEN_LIMITS.submitBytes, "over" when it was larger, null when none was read. */
export interface OpenRequest { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string | undefined>>; readonly body: Uint8Array | "over" | null }
export interface OpenAnswer { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }

// cairn's corsPublic headers, on every answer and on every preflight.
const CORS = { "access-control-allow-origin": "*", vary: "Origin", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const BASE = { ...CORS, "access-control-expose-headers": "retry-after", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const JSON_TYPE = "application/json; charset=utf-8";
const json = (status: number, value: unknown, extra: Record<string, string> = {}): OpenAnswer =>
  ({ status, headers: { ...BASE, "content-type": JSON_TYPE, ...extra }, body: JSON.stringify(value) });
const UNREACHABLE = json(502, { ok: false, error: "node unreachable" });
const busy = (status: 429 | 503) => json(status, { ok: false, error: "busy: too many requests to the node in flight; retry shortly" }, { "retry-after": "1" });
const bad = (error: string) => json(400, { ok: false, error });
const INVALID_BODY = bad("invalid request body");

/** The server's own overload: a full queue, or a wait for a slot past the request's timeout. */
class Busy extends Error {}
function gate(limit: number, queued: number): (signal: AbortSignal) => Promise<() => void> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => { const next = waiting.shift(); if (next === undefined) active--; else next(); };
  return async (signal) => {
    if (active < limit) { active++; return release; }
    if (waiting.length >= queued || signal.aborted) throw new Busy();
    await new Promise<void>((go, stop) => {
      const turn = () => { signal.removeEventListener("abort", quit); go(); };
      const quit = () => { waiting.splice(waiting.indexOf(turn), 1); stop(new Busy()); };
      waiting.push(turn);
      signal.addEventListener("abort", quit, { once: true });
    });
    return release;
  };
}

const ADDR = "(?:0x)?[0-9a-fA-F]{40}", HASH = "(?:0x)?[0-9a-fA-F]{64}";
// Each relayed path and the node path it reads, cairn's; a parameter outside its shape never reaches the node.
const RELAY: readonly (readonly [RegExp, (p: string) => string])[] = [
  [/^\/api\/rpc\/tip$/, () => "/tip"],
  [new RegExp(`^/api/rpc/utxos/(${ADDR})$`), (a) => `/utxos/${a}?available=true`],
  [new RegExp(`^/api/rpc/utxos-all/(${ADDR})$`), (a) => `/utxos/${a}`],
  [new RegExp(`^/api/rpc/tx/(${HASH})$`), (id) => `/tx/${id}`],
  [new RegExp(`^/api/rpc/block/(${HASH})$`), (h) => `/block/${h}`],
  [new RegExp(`^/api/rpc/proposal/(${HASH})$`), (id) => `/proposal/${id}`],
];
const FAMILY = /^\/api\/rpc\/(?:utxos|utxos-all|tx|block|proposal)\/[^/]+$/;
const TX_STATUS = /^\/api\/rpc\/tx\/([^/]+)\/status$/, HEADERS = /^\/api\/headers\/([^/]+)\/([^/]+)$/;
const NAMES = /^\/trade\/api\/cairnx\/(name|resolve|name-history)\/([^/]+)$/;
const TXID = /^(?:0x)?([0-9a-fA-F]{64})$/;
const MEMPOOL_LIST_CAP = 1000;
type Headers = Readonly<Record<string, string | undefined>>;
/** A submit body this server reads: `application/json` (any parameters), no content encoding, as cairn's parser. */
const submitHeadersOk = (h: Headers): boolean =>
  (h["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json" && (h["content-encoding"] ?? "identity").trim().toLowerCase() === "identity";
/** Whether `listen` reads a request's body: a POST to the submit path whose headers pass; any other body is not read. */
export const readsBody = (method: string, url: string, h: Headers): boolean => method === "POST" && routedPath(url) === SUBMIT_PATH && submitHeadersOk(h);

/** The path routed on: no query, each run of slashes one slash and no trailing slash. The front door answers a
 *  trailing slash as Express reads it and a doubled slash 404; here both answer as the plain path, never a 3xx. */
export const routedPath = (url: string): string => {
  const p = url.split(/[?#]/, 1)[0]!.replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/$/, "") : p;
};
// cairn's safeInt.
const clamp = (v: string, def: number, lo: number, hi: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : def; };
const withCharset = (t: string): string => `${t.replace(/;\s*charset=[^;]*/i, "")}; charset=utf-8`;
const parsed = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const pickHeader = (h: Record<string, unknown>) => ({ version: h.version, prev: h.prev, merkle: h.merkle, time: h.time, bits: h.bits, nonce: h.nonce });

/** The open server's answer to each request, over the node at `node` (a base the caller has held to its address rule). */
export function openServerAt(node: string, o: OpenServerOptions): (q: OpenRequest) => Promise<OpenAnswer> {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis), L = OPEN_LIMITS;
  const reads = gate(L.reads, L.queued), submits = gate(L.submits, L.submitsQueued);
  const ask = async (g: typeof reads, path: string, ms: number, init: RequestInit = {}, stop?: AbortSignal) => {
    const own = AbortSignal.timeout(ms), signal = stop === undefined ? own : either(stop, own);
    const release = await g(signal);
    try {
      const r = await f(`${node}${path}`, { ...init, redirect: "manual", cache: "no-store", signal });
      if (r.status >= 300 && r.status < 400) { await r.body?.cancel(); throw new Error(`${path} answered ${r.status}`); }
      return { status: r.status, type: r.headers.get("content-type"), text: await cappedText(r, path) };
    } finally { release(); }
  };

  async function relay(path: string): Promise<OpenAnswer> {
    try {
      const r = await ask(reads, path, L.readMs);
      return { status: r.status, headers: { ...BASE, "content-type": withCharset(r.type ?? "application/json") }, body: r.text };
    } catch (e) { return e instanceof Busy ? busy(503) : UNREACHABLE; }
  }

  // cairn's readTxStatus over one node: its pool before its /tx, under one deadline for both; a node failure is a read
  // that knows nothing, the server's own full gate the busy answer.
  async function txStatus(txid: string): Promise<OpenAnswer> {
    const deadline = AbortSignal.timeout(L.readMs);
    const get = (path: string) => ask(reads, path, L.readMs, {}, deadline).then((r) => ({ status: r.status, j: parsed(r.text) as Record<string, unknown> | undefined }),
      (e: unknown) => { if (e instanceof Busy) throw e; return null; });
    try { return await statusOf(txid, get); } catch (e) { if (e instanceof Busy) return busy(503); throw e; }
  }
  async function statusOf(txid: string, get: (path: string) => Promise<{ status: number; j: Record<string, unknown> | undefined } | null>): Promise<OpenAnswer> {
    const p = await get("/mempool/txids");
    const pool = p?.status === 200 && p.j?.ok === true && Array.isArray(p.j.txids)
      ? { ids: new Set((p.j.txids as { txid?: unknown }[]).map((x) => String(x?.txid).toLowerCase())), complete: p.j.txids.length < MEMPOOL_LIST_CAP } : null;
    const m = await get(`/tx/${txid}`);
    if (m?.status === 200 && m.j?.ok === true && Number.isSafeInteger(m.j.height)) return json(200, { ok: true, txid, state: "mined", height: m.j.height });
    if (pool?.ids.has(txid)) return json(200, { ok: true, txid, state: "pending" });
    const definite = m?.status === 200 && m.j?.ok === false && m.j.complete === true && pool !== null && pool.complete;
    return json(200, { ok: true, txid, state: "unknown", definite });
  }

  // cairn's /api/headers from the node's /block/height/:h: dense and ascending, or a 502, never partial.
  async function headers(fromText: string, countText: string): Promise<OpenAnswer> {
    if (!/^\d+$/.test(fromText) || !/^\d+$/.test(countText)) return bad("from/count must be non-negative integers");
    const from = clamp(fromText, 0, 0, 1e9), count = clamp(countText, 1, 1, L.headersMax);
    // The deadline, or the first row that failed, ends every row still asked or waiting.
    const failed = new AbortController(), stop = either(failed.signal, AbortSignal.timeout(L.headersMs)), rows: unknown[] = new Array(count);
    let next = 0;
    const row = async (h: number) => {
      const b = parsed((await ask(reads, `/block/height/${h}`, L.readMs, {}, stop)).text) as { ok?: unknown; height?: unknown; header?: Record<string, unknown>; hash?: unknown } | undefined;
      if (!b?.ok || Number(b.height) !== h || !b.header || !b.hash) throw new Error(`no header at ${h}`);
      return { height: h, header: pickHeader(b.header), hash: b.hash };
    };
    const worker = async () => {
      while (next < count && !stop.aborted) {
        const i = next++;
        try { rows[i] = await row(from + i); } catch (e) { failed.abort(); throw e; }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(L.fanout, count) }, worker));
      if (stop.aborted) throw new Error("the deadline passed");
      return json(200, { ok: true, from, count, headers: rows });
    } catch { return json(502, { ok: false, error: "headers unavailable" }); }
  }

  async function submit(q: OpenRequest): Promise<OpenAnswer> {
    if (q.body === null || q.body === "over" || !submitHeadersOk(q.headers)) return INVALID_BODY;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(q.body); } catch { return INVALID_BODY; }
    const tx = parsed(text);
    if (tx === null || typeof tx !== "object") return INVALID_BODY;
    try {
      const r = await ask(submits, "/tx/submit", L.submitMs, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      const j = parsed(r.text);
      return j === undefined ? UNREACHABLE : json(r.status, j);
    } catch (e) { return e instanceof Busy ? busy(429) : UNREACHABLE; }
  }

  async function names(route: string, name: string): Promise<OpenAnswer> {
    const r = await o.reads(`/cairnx/${route}/${name}`);
    if (r === null) return bad("the name is not written as a .csd name is (lower case, no .csd)");
    return { status: r.status, headers: { ...BASE, ...r.headers, "access-control-expose-headers": `${r.headers["access-control-expose-headers"]}, retry-after`, "cache-control": "no-store" }, body: r.body };
  }

  return async (q) => {
    const path = routedPath(q.url);
    if (q.method === "OPTIONS") return { status: 204, headers: BASE, body: "" };
    try {
      if (q.method === "POST" && path === SUBMIT_PATH) return await submit(q);
      if (q.method !== "GET") return json(404, { ok: false, error: "no such route" });
      for (const [re, to] of RELAY) { const m = re.exec(path); if (m !== null) return await relay(to(m[1] ?? "")); }
      let m = TX_STATUS.exec(path);
      if (m !== null) { const id = TXID.exec(m[1]!); return id === null ? bad("txid must be 64 hex characters") : await txStatus(`0x${id[1]!.toLowerCase()}`); }
      if ((m = HEADERS.exec(path)) !== null) return await headers(m[1]!, m[2]!);
      if ((m = NAMES.exec(path)) !== null) return await names(m[1]!, m[2]!);
      if (FAMILY.test(path)) return bad("the parameter is not an address (0x and 40 hex) or a hash (0x and 64 hex)");
      return json(404, { ok: false, error: "no such route" });
    } catch { return json(500, { ok: false, error: "server error" }); }
  };
}

/** Starts an HTTP server answering with `answer` at `host` (default OPEN_HOST) and `port` (default OPEN_PORT; 0 picks a
 *  free one), under OPEN_LIMITS's socket limits. Only a submit's body is read (readsBody), at most
 *  OPEN_LIMITS.submitBytes of it; a request whose body is not read, or is over the cap, is answered at once and its
 *  connection closed. */
export function listen(answer: (q: OpenRequest) => Promise<OpenAnswer>, o: { readonly host?: string; readonly port?: number } = {}): Promise<Server> {
  const L = OPEN_LIMITS;
  // connectionsCheckingInterval: how often Node enforces the header and request timeouts (its default is 30 s).
  const server = createServer({ headersTimeout: L.requestHeadersMs, requestTimeout: L.requestMs, keepAliveTimeout: L.keepAliveMs, connectionsCheckingInterval: 1_000 },
    (req, res) => { void handle(answer, req, res); });
  server.setTimeout(L.idleMs);
  server.maxConnections = L.connections;
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(o.port ?? OPEN_PORT, o.host ?? OPEN_HOST, () => { server.off("error", fail); done(server); });
  });
}

function bodyOf(req: IncomingMessage, cap: number): Promise<Uint8Array | "over"> {
  if (Number(req.headers["content-length"] ?? 0) > cap) return Promise.resolve("over");
  return new Promise((done, fail) => {
    const parts: Uint8Array[] = [];
    let n = 0;
    const data = (c: Uint8Array) => {
      n += c.length;
      if (n > cap) { req.off("data", data); req.pause(); done("over"); } else parts.push(c);
    };
    req.on("data", data);
    req.once("end", () => {
      const all = new Uint8Array(n);
      parts.reduce((at, p) => { all.set(p, at); return at + p.length; }, 0);
      done(all);
    });
    req.once("error", fail);
    req.once("close", () => { if (!req.complete) fail(new Error("the request ended before its body")); });
  });
}

async function handle(answer: (q: OpenRequest) => Promise<OpenAnswer>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
  const method = req.method ?? "GET", url = req.url ?? "/";
  const declared = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
  let body: Uint8Array | "over" | null = null;
  if (readsBody(method, url, headers)) {
    try { body = await bodyOf(req, OPEN_LIMITS.submitBytes); } catch { res.destroy(); return; }
  }
  const a = await answer({ method, url, headers, body });
  if (body === "over" || (body === null && declared)) { res.setHeader("connection", "close"); res.once("finish", () => req.destroy()); }
  // A reader that does not take the answer within responseMs loses its socket.
  const late = setTimeout(() => res.destroy(), OPEN_LIMITS.responseMs);
  res.once("close", () => clearTimeout(late));
  res.writeHead(a.status, a.headers);
  res.end(a.body);
}
