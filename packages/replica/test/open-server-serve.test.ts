// `cairnx-replica serve` (cli.ts runServe) over the recorded node of blocks 29,860 to 30,300, through a real socket:
// loopback is the default bind; the header range it serves is accepted by csd-light's LightClient (proof of work, links
// and LWMA bits, from a checkpoint inside the range); the submit's preflight and body cap hold on the wire, a body over
// the cap unread past it and refused, the honest submit relayed; a doubled or trailing slash is no 3xx; the replica
// over a capture whose tip is months old says so with a 503, which the wallet reads as no party; stop ends with 0.
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LightClient, rpcHeaderToHeader } from "@inversealtruism/csd-light";
import { OPEN_LIMITS } from "../src/server.js";
import { SERVE_USAGE, parseServe, runServe } from "../src/cli.js";
import { done, ok, thrown } from "./check.js";
import { blockAt, cap, json, node } from "./node-harness.js";

const NODE = "http://127.0.0.1:8789";
const root = mkdtempSync(join(tmpdir(), "cairnx-replica-serve-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

console.log("serve's options:");
{
  const a = parseServe(["serve", "--node", NODE, "--dir", "rel"]);
  ok("loopback by default: --listen 127.0.0.1, --port 8796, --dir made absolute", a.host === "127.0.0.1" && a.port === 8796 && a.dir === join(process.cwd(), "rel"), JSON.stringify(a));
  ok("a public bind is an explicit --listen", parseServe(["serve", "--node", NODE, "--dir", root, "--listen", "0.0.0.0", "--port", "0"]).host === "0.0.0.0");
  for (const bad of [["serve", "--dir", root], ["serve", "--node", NODE, "--dir", root, "--port", "70000"], ["serve", "--node", NODE, "--dir", root, "--tls"], ["serve", "--node", NODE, "--node", NODE, "--dir", root]]) {
    ok(`refused: ${bad.slice(1).join(" ")}`, thrown(() => parseServe(bad)) !== null);
  }
  const lines: string[] = [];
  ok("a node outside the server's rule exits 2 before anything listens", (await runServe(["serve", "--node", "https://node.example", "--dir", root], { out: (l) => lines.push(l) })) === 2 && lines.some((l) => l.includes("not one's own node")));
  const usage: string[] = [];
  ok("a usage error exits 2 and prints serve's usage", (await runServe(["serve"], { out: (l) => usage.push(l) })) === 2 && usage.slice(1).join("\n") === SERVE_USAGE);
}

// The recorded node, and a submit it accepts.
const n = node({ answers: cap.answers });
const f: typeof fetch = async (input, init) => (new URL(String(input)).pathname === "/tx/submit" ? json('{"ok":true,"txid":"0x77","mempool_len":1}') : n.f(input, init));
type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
let base = "";
const call = (path: string, o: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {}) => new Promise<Got>((go, fail) => {
  const req = request(`${base}${path}`, { method: o.method ?? "GET", headers: o.headers }, (res) => {
    let body = "";
    res.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => go({ status: res.statusCode ?? 0, headers: res.headers, body }));
  });
  req.on("error", fail);
  req.end(o.body);
});

const out: string[] = [];
const code = runServe(["serve", "--node", NODE, "--dir", join(root, "store"), "--port", "0"], { out: (l) => out.push(l), fetch: f, ready: async (server, stop) => {
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  console.log("the server on a socket:");
  ok("it listens on 127.0.0.1 only, and says where", addr.address === "127.0.0.1" && addr.family === "IPv4" && out.some((l) => l.startsWith(`serving http://127.0.0.1:${addr.port}`)), JSON.stringify(addr));

  const lc = new LightClient({ headersBatchProvider: async (from, count) => {
    const r = await call(`/api/headers/${from}/${count}`);
    return (JSON.parse(r.body).headers as { header: never; hash: string }[]).map((row) => ({ header: rpcHeaderToHeader(row.header), hash: row.hash }));
  } });
  const cp = cap.from + 45;
  await lc.syncFromCheckpoint(cp, blockAt(cap.answers, cp).hash);
  const tip = await lc.sync(cap.to);
  ok(`csd-light verifies the served headers ${cp + 1} to ${cap.to} from a checkpoint at ${cp}`, tip.height === cap.to && tip.hash === blockAt(cap.answers, cap.to).hash);

  const pre = await call("/api/rpc/tx/submit", { method: "OPTIONS", headers: { origin: "chrome-extension://x", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  ok("the submit's preflight on the wire: 204, origin *, POST, content-type", pre.status === 204 && pre.headers["access-control-allow-origin"] === "*" && String(pre.headers["access-control-allow-methods"]).includes("POST") && String(pre.headers["access-control-allow-headers"]).includes("content-type"));
  const big = new Uint8Array(OPEN_LIMITS.submitBytes + 1).fill(0x20), asked = n.log.length;
  const over = await call("/api/rpc/tx/submit", { method: "POST", headers: { "content-type": "application/json" }, body: big });
  ok("a body one byte over 512 KiB: 400 invalid request body, the connection closed, nothing sent", over.status === 400 && JSON.parse(over.body).error === "invalid request body" && over.headers.connection === "close" && n.log.length === asked);
  const fine = await call("/api/rpc/tx/submit", { method: "POST", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(`{"tx":{"version":1}}${" ".repeat(OPEN_LIMITS.submitBytes - 20)}`) });
  ok("paired: a body of exactly 512 KiB is sent and the node's answer relayed", fine.status === 200 && JSON.parse(fine.body).ok === true);
  const slashes = await Promise.all(["//api/rpc/tip", "/api/rpc/tip/", "/api//rpc/tip"].map((p) => call(p)));
  ok("a doubled or trailing slash: the tip, no 3xx", slashes.every((r) => r.status === 200 && JSON.parse(r.body).height === cap.to), slashes.map((r) => r.status).join(","));
  let names: Got | null = null;
  for (let i = 0; i < 200 && (names === null || names.headers["x-cairnx-at"] === undefined); i++) { names = await call("/trade/api/cairnx/name-history/zzcontracttest"); await new Promise((r) => setTimeout(r, 50)); }
  ok("names over a months-old capture: 503 naming TIP_STALE_LONG, never a 404", names?.status === 503 && String(names.headers["x-cairnx-notes"]).includes("TIP_STALE_LONG") && String(names.headers["access-control-expose-headers"]).includes("retry-after"), `${names?.status} ${JSON.stringify(names?.headers)}`);
  await stop();
} });
ok("stop ends serve with exit 0", (await code) === 0);
done("open-server-serve");
