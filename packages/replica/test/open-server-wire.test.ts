// listen()'s socket limits over a real loopback socket, against a stub node: a POST to another path, or a submit whose
// headers the server does not read a body for, is answered at once and its connection closed, its body unread; a
// declared body over the cap is refused before a byte of it is read; a slow writer is cut off by the request timeout,
// a reader that does not read by the response bound; sockets past the connection cap are closed. Paired: the wallet's
// submit (application/json, its body byte for byte, a number above 2^53 included) and its GETs answer as before.
import { createConnection, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { OPEN_LIMITS, listen, openServer, type ReadResponse } from "../src/server.js";
import { done, ok } from "./check.js";

const sent: string[] = [];
const BIG = 15 * 1024 * 1024;
const f: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path === "/tx/submit") { sent.push(String(init?.body)); return new Response('{"ok":true,"txid":"0x77"}', { status: 200, headers: { "content-type": "application/json" } }); }
  if (path.startsWith("/block/")) return new Response(`{"ok":true,"pad":"${"a".repeat(BIG)}"}`, { status: 200, headers: { "content-type": "application/json" } });
  return new Response('{"tip":"0x01","height":7,"chainwork":"1"}', { status: 200, headers: { "content-type": "application/json" } });
};
const reads = async (): Promise<ReadResponse | null> => null;
const server = await listen(openServer({ node: "http://127.0.0.1:8789", reads, fetch: f }), { port: 0 });
const port = (server.address() as AddressInfo).port;
const count = () => new Promise<number>((r) => server.getConnections((_e, n) => r(n)));

/** A raw connection: what it was answered, when it closed, in ms from its start. */
function raw(write: (s: Socket) => void, o: { read?: boolean; waitMs?: number } = {}) {
  const t0 = Date.now(), s = createConnection(port, "127.0.0.1");
  let text = "", closedAt: number | null = null;
  if (o.read === false) s.pause(); else s.on("data", (d) => (text += d.toString("latin1")));
  s.on("error", () => undefined);
  const closed = new Promise<void>((r) => s.on("close", () => { closedAt = Date.now() - t0; r(); }));
  s.on("connect", () => write(s));
  return { s, closed, get text() { return text; }, get closedAt() { return closedAt; },
    until: (ms: number) => Promise.race([closed, new Promise<void>((r) => setTimeout(r, ms))]) };
}
const head = (method: string, path: string, h: Record<string, string>) => `${method} ${path} HTTP/1.1\r\nHost: x\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;

console.log("a body the server does not read:");
{
  const other = raw((s) => s.write(`${head("POST", "/does-not-exist", { "content-type": "text/plain", "content-length": "500000" })}hello12345`));
  const plain = raw((s) => s.write(`${head("POST", "/api/rpc/tx/submit", { "content-type": "text/plain", "content-length": "500000" })}hello12345`));
  const gz = raw((s) => s.write(`${head("POST", "/api/rpc/tx/submit", { "content-type": "application/json", "content-encoding": "gzip", "content-length": "500000" })}hello12345`));
  const over = raw((s) => s.write(head("POST", "/api/rpc/tx/submit", { "content-type": "application/json", "content-length": String(OPEN_LIMITS.submitBytes + 1) })));
  await Promise.all([other, plain, gz, over].map((c) => c.until(2_000)));
  ok("a POST to another path with 500,000 bytes declared and 10 sent: 404 at once, the connection closed", other.text.startsWith("HTTP/1.1 404") && other.closedAt !== null && other.closedAt < 1_000, `${other.text.split("\r\n")[0]} ${other.closedAt}`);
  ok("a submit as text/plain, or gzip, with its body unsent: 400 at once, closed", [plain, gz].every((c) => c.text.startsWith("HTTP/1.1 400") && c.closedAt !== null && c.closedAt < 1_000), `${plain.closedAt} ${gz.closedAt}`);
  ok("a submit declaring one byte over the cap and sending none: 400 at once, closed", over.text.startsWith("HTTP/1.1 400") && over.text.includes("invalid request body") && over.closedAt !== null && over.closedAt < 1_000, `${over.closedAt}`);
}

console.log("paired, the wallet's own requests:");
{
  const body = '{"tx":{"version":1,"locktime":0,"app":{"Propose":{"domain":"cairnx:v1","expires_epoch":9007199254740993}},"inputs":[],"outputs":[]}}';
  const r = await fetch(`http://127.0.0.1:${port}/api/rpc/tx/submit`, { method: "POST", headers: { "content-type": "application/json" }, body });
  ok("the wallet's submit: 200, the node given its bytes exactly, the number above 2^53 included", r.status === 200 && (await r.json()).ok === true && sent.at(-1) === body, String(sent.at(-1)).slice(0, 120));
  const tip = await fetch(`http://127.0.0.1:${port}/api/rpc/tip`);
  ok("a GET: 200, the node's bytes", tip.status === 200 && (await tip.text()) === '{"tip":"0x01","height":7,"chainwork":"1"}');
}

console.log("a slow writer, a reader that does not read, and the connection cap:");
{
  const t0 = Date.now();
  const writer = raw((s) => s.write(`${head("POST", "/api/rpc/tx/submit", { "content-type": "application/json", "content-length": "1000" })}{"tx":`));
  const reader = raw((s) => s.write(head("GET", `/api/rpc/block/0x${"00".repeat(32)}`, {})), { read: false });
  await new Promise((r) => setTimeout(r, 500));
  const held = await count();
  // The cap: sockets past it are closed at once, while the ones under it stay open.
  const extra = Array.from({ length: OPEN_LIMITS.connections - held + 1 }, () => raw(() => undefined));
  await new Promise((r) => setTimeout(r, 1_000));
  const shut = extra.filter((c) => c.closedAt !== null).length;
  ok(`past ${OPEN_LIMITS.connections} connections the next is closed at once, the others stay open`, shut === 1, `closed ${shut} of ${extra.length}`);
  for (const c of extra) c.s.destroy();
  const wait = OPEN_LIMITS.requestMs + 3_000;
  await Promise.all([writer.until(wait), new Promise<void>((r) => { const t = setInterval(async () => { if ((await count()) === 0 || Date.now() - t0 > wait) { clearInterval(t); r(); } }, 200); })]);
  ok(`a writer that stops mid-body is cut off within ${OPEN_LIMITS.requestMs} ms and a second`, writer.closedAt !== null && writer.closedAt <= OPEN_LIMITS.requestMs + 2_000, `${writer.closedAt} ${writer.text.split("\r\n")[0]}`);
  ok(`a reader that never reads a ${BIG}-byte answer loses its socket within ${OPEN_LIMITS.responseMs} ms and a second`, (await count()) === 0 && Date.now() - t0 <= OPEN_LIMITS.responseMs + 3_000,
    `${reader.closedAt} open ${await count()}`);
  reader.s.destroy();
}
server.closeAllConnections();
await new Promise<void>((r) => server.close(() => r()));
done("open-server-wire");
