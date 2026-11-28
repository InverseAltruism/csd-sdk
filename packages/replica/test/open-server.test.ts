// The open server's answers (openServer, ./server), against a stub node and stub name reads, no socket.
// (1) cairn's wallet contract for the routes it serves (test/fixtures/wallet-contract-subset.json, copied from cairn with
// the sha256 of each source file): each case's status, media type, CORS headers and every field the wallet reads, the
// node request made, and the body as cairn relays it (the node's bytes, or its JSON sent again); the header range
// byte-equal to cairn's own rows for the same blocks. (2) What the contract lacks and the wallet's design note needs:
// the submit's preflight, Retry-After exposed on every answer, no 3xx on any path with a trailing or doubled slash or
// when the node redirects. (3) The wallet's reading of each failure: a node that is busy, down, malformed or redirects
// never gives a 200 the wallet takes for an answer. (4) Each refusal with its honest pair: a parameter out of shape
// reaches no node, a body over the cap is refused unsent, the gates answer busy only when full and a submit never
// waits behind reads. (5) The name routes over a replica of the recorded node: bodies byte-equal to replicaReads.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { open } from "../src/index.js";
import { OPEN_LIMITS, READ_HEADERS, ReplicaConfigError, openServer, replicaReads, type OpenAnswer, type ReadResponse } from "../src/server.js";
import { done, ok, thrown } from "./check.js";
import { shapeErrors, walk } from "./contract-shape.js";
import { cap } from "./node-harness.js";
import { nodeSource, timeAt } from "./reader-harness.js";

type Ans = { status: number; contentType: string; body: string; when?: Record<string, unknown>; indexer?: Record<string, unknown> };
type Case = { name: string; request: { path: string; body?: unknown }; status: number; contentType: string; shape: Record<string, string>; lengths?: Record<string, number>; cairn?: { upstream?: string; relay?: string } };
type Route = { id: string; versions: string; method: string; cors: Record<string, string> | null; preflight?: boolean; cases: Case[] };
const sub = JSON.parse(readFileSync(new URL("./fixtures/wallet-contract-subset.json", import.meta.url), "utf8")) as { routes: Route[]; node: Record<string, Ans | Ans[]>; resolver: Record<string, Ans> };
const NODE = "http://127.0.0.1:8789", ORIGIN = "chrome-extension://cairnwalletcontracttestorigin";
const media = (ct: string | undefined) => String(ct ?? "").split(";")[0]!.trim().toLowerCase();
const at = (o: unknown, p: string) => p.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | null | undefined)?.[k], o);

type Fail = (key: string, signal: AbortSignal | undefined) => Response | Promise<Response> | null;
function stubNode(fail?: Fail) {
  const log: { key: string; body: string | null }[] = [];
  const f: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), key = `${init?.method ?? "GET"} ${u.pathname}${u.search}`, body = typeof init?.body === "string" ? init.body : null;
    log.push({ key, body });
    const failed = (await fail?.(key, init?.signal ?? undefined)) ?? null;
    if (failed !== null) return failed;
    let a = sub.node[key];
    if (Array.isArray(a)) { const j = JSON.parse(body ?? "null"); a = a.find((x) => Object.entries(x.when ?? {}).every(([p, v]) => isDeepStrictEqual(at(j, p), v))); }
    return a === undefined ? new Response('{"ok":false,"error":"stub: no answer"}', { status: 404, headers: { "content-type": "application/json" } })
      : new Response(a.body, { status: a.status, headers: { "content-type": a.contentType } });
  };
  return { f, log, asked: (re: RegExp) => log.filter((l) => re.test(l.key)).length };
}
// The resolver's recorded answers as replicaReads frames them; a name with none is a replica not caught up.
const stubReads = async (path: string): Promise<ReadResponse | null> => {
  if (!/^\/cairnx\/(name|resolve|name-history)\/[a-z0-9-]+$/.test(path)) return null;
  const a = sub.resolver[`GET ${path}`], headers = { ...READ_HEADERS, "x-cairnx-at": `146829:0x${"ab".repeat(32)}`, "x-cairnx-why": a ? "" : "NOT_SYNCED", "x-cairnx-notes": "" };
  return a ? { status: a.status, headers, body: a.body } : { status: 503, headers, body: '{"ok":false,"error":"not ready: NOT_SYNCED; retry shortly"}' };
};
const serverOf = (f: typeof fetch, reads = stubReads) => openServer({ node: NODE, reads, fetch: f });
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const get = (srv: ReturnType<typeof serverOf>, url: string, method = "GET") => srv({ method, url, headers: { origin: ORIGIN }, body: null });
const post = (srv: ReturnType<typeof serverOf>, url: string, body: Uint8Array | "over", headers: Record<string, string> = { "content-type": "application/json" }) =>
  srv({ method: "POST", url, headers: { origin: ORIGIN, ...headers }, body });
const exposes = (a: OpenAnswer) => (a.headers["access-control-expose-headers"] ?? "").toLowerCase().split(/\s*,\s*/).includes("retry-after");
const seen: OpenAnswer[] = [];

console.log("cairn's wallet contract, the open server's subset:");
const SUBMIT = sub.routes.find((r) => r.id === "rpc-submit")!.cases[0]!.request.body;
{
  let cases = 0;
  for (const route of sub.routes) for (const c of route.cases) {
    cases++;
    const n = stubNode(), srv = serverOf(n.f), body = c.request.body === undefined ? null : enc(c.request.body);
    const a = body === null ? await get(srv, c.request.path) : await post(srv, c.request.path, body);
    seen.push(a);
    const errs: string[] = [];
    if (a.status !== c.status) errs.push(`status ${a.status}, wanted ${c.status}`);
    if (media(a.headers["content-type"]) !== c.contentType) errs.push(`content type ${a.headers["content-type"]}`);
    for (const [h, v] of Object.entries(route.cors ?? {})) if (a.headers[h] !== v) errs.push(`${h} ${a.headers[h]}`);
    let j: unknown;
    try { j = JSON.parse(a.body); } catch { errs.push(`not JSON: ${a.body.slice(0, 60)}`); }
    errs.push(...shapeErrors(j, c.shape));
    for (const [p, len] of Object.entries(c.lengths ?? {})) { const v = walk(j, p)[0]?.v; if (!Array.isArray(v) || v.length !== len) errs.push(`${p}: not ${len} rows`); }
    const [who, method, path] = (c.cairn?.upstream ?? "").split(" ");
    if (who === "node") {
      const ans = sub.node[`${method} ${path}`], hit = n.log.find((l) => l.key === `${method} ${path}`);
      const picked = Array.isArray(ans) ? ans.find((x) => Object.entries(x.when ?? {}).every(([p, v]) => isDeepStrictEqual(at(c.request.body, p), v))) : ans;
      if (!hit) errs.push(`no node request ${method} ${path}`);
      if (hit && body !== null && !isDeepStrictEqual(JSON.parse(hit.body ?? "null"), c.request.body)) errs.push("the node got another body");
      if (c.cairn?.relay === "bytes" && a.body !== picked?.body) errs.push("not the node's bytes");
      if (c.cairn?.relay === "json" && !isDeepStrictEqual(j, JSON.parse(picked?.body ?? "null"))) errs.push("not the node's JSON");
    } else if (who === "resolver") {
      if (a.body !== sub.resolver[`${method} ${path}`]?.body) errs.push("not the resolver's bytes");
    } else if (who === "indexer") {
      // cairn's row for each height: { height, pickHeader(block), hash } over the indexer's block, here the node's.
      const want = { ok: true, from: 145408, count: 2, headers: [145408, 145409].map((h) => {
        const b = (sub.node[`GET /block/height/${h}`] as Ans).indexer!;
        return { height: h, header: { version: b.version, prev: b.prev, merkle: b.merkle, time: b.time, bits: b.bits, nonce: b.nonce }, hash: b.hash };
      }) };
      if (a.body !== JSON.stringify(want)) errs.push(`not cairn's header rows: ${a.body.slice(0, 120)}`);
      if (n.asked(/^GET \/block\/height\/14540[89]$/) !== 2) errs.push("not one node read per height");
    }
    ok(`${route.id}@${route.versions} ${route.method} ${c.name}: ${c.status} ${c.contentType}, ${Object.keys(c.shape).length} fields`, errs.length === 0, errs.join("; "));
  }
  ok(`the subset holds 23 cases of the 12 routes the open server serves (${cases})`, cases === 23);
}

console.log("the preflight, Retry-After exposed, no redirect:");
{
  const srv = serverOf(stubNode().f);
  const p = await get(srv, "/api/rpc/tx/submit", "OPTIONS");
  const methods = (p.headers["access-control-allow-methods"] ?? "").split(/\s*,\s*/), allowed = (p.headers["access-control-allow-headers"] ?? "").split(/\s*,\s*/);
  ok("the submit's preflight: 204, origin *, POST and content-type allowed", p.status === 204 && p.headers["access-control-allow-origin"] === "*" && methods.includes("POST") && allowed.includes("content-type"), JSON.stringify(p));
  const paths = sub.routes.flatMap((r) => r.cases.map((c) => ({ method: r.method, path: c.request.path, body: c.request.body })));
  const bent: string[] = [];
  for (const { method, path, body } of paths) {
    for (const v of [path, `${path}/`, `/${path}`, path.replace(/\/([^/]*)$/, "//$1"), `${path}?fresh=1`]) {
      const a = method === "POST" ? await post(srv, v, enc(body)) : await get(srv, v), plain = method === "POST" ? await post(srv, path, enc(body)) : await get(srv, path);
      seen.push(a);
      if ((a.status >= 300 && a.status < 400) || a.status !== plain.status) bent.push(`${v} ${a.status}`);
    }
  }
  ok(`no 3xx, and the same answer, with a trailing, a leading or an inner doubled slash or a query (${paths.length * 5} requests)`, bent.length === 0, bent.join(", "));
  const moved = serverOf(stubNode(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/" } })).f);
  const r = await Promise.all([get(moved, "/api/rpc/tip"), get(moved, "/api/headers/145408/2"), post(moved, "/api/rpc/tx/submit", enc(SUBMIT))]);
  ok("a node that redirects: 502 on a relay, a header range and a submit, never a 3xx", r.every((a) => a.status === 502), r.map((a) => a.status).join(","));
  seen.push(p, ...r, await get(srv, "/nothing/here"), await get(srv, "/api/rpc/utxos/0x12"));
  ok(`access-control-expose-headers names retry-after on every answer, the name routes' x-cairnx-at too (${seen.length})`,
    seen.every(exposes) && seen.filter((a) => a.headers["x-cairnx-at"] !== undefined).every((a) => a.headers["access-control-expose-headers"]!.includes("x-cairnx-at")));
}

console.log("the wallet's reading of each failure:");
{
  const notJson = (s: string) => { try { JSON.parse(s); return false; } catch { return true; } };
  const faults: Record<string, Fail> = {
    busy: () => new Response('{"ok":false,"code":"SCAN_BUSY","err":"too many chain scans in flight"}', { status: 503, headers: { "content-type": "application/json", "retry-after": "5" } }),
    down: () => { throw new TypeError("fetch failed"); },
    malformed: () => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
  };
  const RELAYED = ["/api/rpc/tip", "/api/rpc/utxos/0x44d92872a5b65d37d60ed532f41efe7c5aed59ec", "/api/rpc/utxos-all/0x44d92872a5b65d37d60ed532f41efe7c5aed59ec",
    `/api/rpc/tx/0x${"ed".repeat(32)}`, `/api/rpc/block/0x${"00".repeat(32)}`, `/api/rpc/proposal/0x${"d9".repeat(32)}`];
  for (const [what, fail] of Object.entries(faults)) {
    const srv = serverOf(stubNode(fail).f);
    const relayed = await Promise.all(RELAYED.map((p) => get(srv, p)));
    // core/node.ts get(): a non-2xx throws; a 2xx that is not JSON throws at r.json(): neither is an answer.
    ok(`node ${what}: every relayed read is a 5xx or a body the wallet cannot parse`, relayed.every((a) => a.status >= 500 || notJson(a.body)), relayed.map((a) => a.status).join(","));
    const h = await get(srv, "/api/headers/145408/2");
    ok(`node ${what}: a header range is 502, which core/namespv.ts retries and then fails`, h.status === 502);
    const s = JSON.parse((await get(srv, `/api/rpc/tx/0x${"ed".repeat(32)}/status`)).body);
    ok(`node ${what}: a status is unknown and not definite, which core/node.ts txInclusion reads as no reading`, s.state === "unknown" && s.definite === false);
    const sent = await post(srv, "/api/rpc/tx/submit", enc(SUBMIT));
    ok(`node ${what}: a submit is a 5xx, which core/submitverdict.ts reads as "may already be in flight"`, sent.status >= 500, `${sent.status}`);
  }
  const srv = serverOf(stubNode().f);
  const miss = await get(srv, `/api/rpc/tx/0x${"b2".repeat(32)}`), missStatus = JSON.parse((await get(srv, `/api/rpc/tx/0x${"b2".repeat(32)}/status`)).body);
  ok("a transaction the node does not have: /tx is 200 without tx (notfound), its status unknown and definite", miss.status === 200 && JSON.parse(miss.body).tx === null && missStatus.state === "unknown" && missStatus.definite === true);
  const unreg = await Promise.all(["resolve", "name"].map((r) => get(srv, `/trade/api/cairnx/${r}/zzcontracttest`)));
  ok("a name that is not registered: 404 from the replica's reads, the route-defined answer", unreg.every((a) => a.status === 404));
  const behind = await get(srv, "/trade/api/cairnx/name-history/zzcontracttest");
  ok("a name the replica has not caught up to: 503, no party, never a 404", behind.status === 503 && behind.headers["x-cairnx-why"] === "NOT_SYNCED");
}

console.log("each refusal, and the honest request beside it:");
{
  const n = stubNode(), srv = serverOf(n.f);
  const ATTACKS = ["/api/rpc/utxos/0x44d92872a5b65d37d60ed532f41efe7c5aed59ec%2F..%2F..%2Ftip", "/api/rpc/tx/..%2Fmempool", `/api/rpc/block/0x${"00".repeat(32)}%3Fx`,
    "/api/rpc/proposal/%2E%2E", "/api/rpc/tx/abc/status", "/api/headers/-1/2", "/api/headers/1e3/2", "/trade/api/cairnx/resolve/UPPER"];
  const r = await Promise.all(ATTACKS.map((p) => get(srv, p)));
  ok(`a parameter out of shape: 400 and no node request (${ATTACKS.length} paths)`, r.every((a) => a.status === 400) && n.log.length === 0, r.map((a) => a.status).join(",") + ` ${n.log.map((l) => l.key)}`);
  const honest = await get(srv, "/api/rpc/utxos/0x44d92872a5b65d37d60ed532f41efe7c5aed59ec");
  ok("paired: the wallet's address reaches the node at /utxos/<addr>?available=true", honest.status === 200 && n.asked(/^GET \/utxos\/0x44d92872a5b65d37d60ed532f41efe7c5aed59ec\?available=true$/) === 1);
  const before = n.log.length;
  const over = await post(srv, "/api/rpc/tx/submit", "over"), gz = await post(srv, "/api/rpc/tx/submit", enc(SUBMIT), { "content-type": "application/json", "content-encoding": "gzip" });
  const notObject = await post(srv, "/api/rpc/tx/submit", enc(5)), text = await post(srv, "/api/rpc/tx/submit", enc(SUBMIT), { "content-type": "text/plain" });
  ok("a body over the cap, compressed, not a JSON object, or not JSON: 400 invalid request body, nothing sent",
    [over, gz, notObject, text].every((a) => a.status === 400 && JSON.parse(a.body).error === "invalid request body") && n.log.length === before);
  const sent = await post(srv, "/api/rpc/tx/submit", enc(SUBMIT));
  ok("paired: the wallet's submit (its body, content-type application/json) is sent and answered", sent.status === 200 && JSON.parse(sent.body).ok === true && n.log.length === before + 1);
  ok("the cap is cairn's 512 KiB", OPEN_LIMITS.submitBytes === 512 * 1024);
}
{
  // A node whose /tx reads hang until released: the read gate fills, then its queue, then the next is busy.
  const held: (() => void)[] = [];
  const n = stubNode((key) => (key.startsWith("GET /tx/") ? new Promise((go) => held.push(() => go(new Response('{"ok":false,"err":"not found"}', { status: 200, headers: { "content-type": "application/json" } })))) : null));
  const srv = serverOf(n.f), full = OPEN_LIMITS.reads + OPEN_LIMITS.queued;
  const waiting = Array.from({ length: full }, (_, i) => get(srv, `/api/rpc/tx/0x${i.toString(16).padStart(64, "0")}`));
  await new Promise((r) => setTimeout(r, 50));
  ok(`${OPEN_LIMITS.reads} node reads in flight while ${OPEN_LIMITS.queued} wait`, held.length === OPEN_LIMITS.reads, `${held.length}`);
  const t0 = Date.now(), refused = await get(srv, `/api/rpc/tx/0x${"ff".repeat(32)}`);
  ok("the next read: 503 at once with Retry-After 1, exposed", refused.status === 503 && refused.headers["retry-after"] === "1" && exposes(refused) && Date.now() - t0 < 1000);
  const sent = await post(srv, "/api/rpc/tx/submit", enc(SUBMIT));
  ok("paired: a submit while the reads are full is sent at once (its own gate)", sent.status === 200 && JSON.parse(sent.body).ok === true);
  let released = 0;
  for (let spins = 0; released < full && spins < 1000; spins++) { const now = held.splice(0); released += now.length; now.forEach((go) => go()); await new Promise((r) => setTimeout(r, 5)); }
  const all = await Promise.all(waiting);
  ok(`paired: every queued read is answered once the node answers (${all.length})`, all.every((a) => a.status === 200));
  const eight = await Promise.all(Array.from({ length: 8 }, (_, i) => get(serverOf(stubNode().f), `/api/rpc/tx/0x${i.toString(16).padStart(64, "0")}`)));
  ok("paired: the wallet's eight concurrent input reads (core/node.ts VERIFY_CONCURRENCY) all get the node's answer", eight.every((a) => a.status === 404 && a.body.includes("stub: no answer")));
}
{
  // A read that waits for a slot past its timeout is busy, not a node failure: the slots here stay held until released.
  const held: (() => void)[] = [];
  const n = stubNode((key) => (key.startsWith("GET /tx/") ? new Promise((go) => held.push(() => go(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })))) : null));
  // AbortSignal.timeout's timer does not hold the process; a listening server does, this interval stands in for it.
  const alive = setInterval(() => undefined, 1000), srv = serverOf(n.f), t0 = Date.now();
  const busyAt = Array.from({ length: OPEN_LIMITS.reads }, (_, i) => get(srv, `/api/rpc/tx/0x${i.toString(16).padStart(64, "0")}`));
  const late = await get(srv, `/api/rpc/tx/0x${"ee".repeat(32)}`), waited = Date.now() - t0;
  ok(`a read that waits for a slot ${OPEN_LIMITS.readMs} ms: 503 busy with Retry-After, not a node failure`,
    late.status === 503 && late.headers["retry-after"] === "1" && waited >= OPEN_LIMITS.readMs - 50 && waited < OPEN_LIMITS.readMs + 2000, `${late.status} ${waited}`);
  held.splice(0).forEach((go) => go());
  await Promise.all(busyAt);
  clearInterval(alive);
}

console.log("the node address rule, and the name routes over a replica of the recorded node:");
{
  const e = thrown(() => openServer({ node: "https://node.example", reads: stubReads }));
  ok("a node outside the server's rule throws ReplicaConfigError", e instanceof ReplicaConfigError);
  ok("paired: loopback and a private address are admitted", thrown(() => openServer({ node: NODE, reads: stubReads })) === null && thrown(() => openServer({ node: "http://10.0.0.5:8789", reads: stubReads })) === null);
  const reader = await open({ source: nodeSource(), clock: () => timeAt(cap.to) * 1000 + 60_000 });
  await reader.advance();
  const snap = await reader.snapshot();
  const reads = replicaReads(reader), srv = serverOf(stubNode().f, reads);
  const names = snap.verified ? [...Object.keys(snap.value.state.names), "zzcontracttest"] : [];
  const differ: string[] = [];
  for (const name of names) for (const route of ["name", "resolve", "name-history"]) {
    const a = await get(srv, `/trade/api/cairnx/${route}/${name}`), want = (await reads(`/cairnx/${route}/${name}`))!;
    if (a.status !== want.status || a.body !== want.body || a.headers["x-cairnx-at"] !== want.headers["x-cairnx-at"]) differ.push(`${route}/${name}`);
  }
  ok(`each name's three routes and an unregistered one: status, body and x-cairnx-at equal to replicaReads (${names.length * 3}), 0 differ`, names.length > 1 && differ.length === 0, differ.join(", "));
  await reader.close();
}
done("open-server");
