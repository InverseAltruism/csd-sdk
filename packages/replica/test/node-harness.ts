// A node served from the recorded capture of blocks 29,860 to 30,300 (scripts/capture-node-blocks.mjs), for the tests
// of nodeBlocks: /tip answers the block at `tip` (default the capture's end) unless `tipOf` names one; `fail` answers in
// place of the node; a redirect is followed as fetch follows one unless the request refuses redirects. Every request
// is logged with what it asked of fetch.
import { readFileSync } from "node:fs";
import { CAIRNX_EVENT_RULE, stateHash } from "@inversealtruism/cairnx-core";
import { headerHash } from "@inversealtruism/csd-codec";
import { rpcHeaderToHeader, type RpcTxJson } from "@inversealtruism/csd-client";
import { nodeBlocks } from "../src/browser.js";
import { memoryStore, replicaLoop, type Loop, type StepContext } from "../src/index.js";
import { pinned } from "./core-files.js";

export const FILE = new URL("./fixtures/node-blocks-29860-30300.json", import.meta.url), bytes = readFileSync(FILE);
export const cap = JSON.parse(bytes.toString("utf8")) as { format: 1; from: number; to: number; answers: Record<string, string> };
export const NODE = "http://127.0.0.1:8789";
export type Answers = Record<string, string>;
export type Block = { height: number; hash: string; chainwork: string; header: Record<string, unknown> & { prev: string; nonce: number; merkle: string };
  txs: (RpcTxJson & { spent_tx?: unknown })[] };
export type Served = { answers: Answers; tip?: number; tipOf?: () => unknown; fail?: (path: string, n: number) => Response | Promise<Response> | null };
export const blockAt = (a: Answers, h: number) => JSON.parse(a[`/block/height/${h}`]!) as Block;
export const edit = (a: Answers, h: number, f: (b: Block) => void): Answers => { const b = blockAt(a, h); f(b); return { [`/block/height/${h}`]: JSON.stringify(b) }; };
export const json = (text: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "content-type": "application/json", ...headers } });

export function node(s: Served) {
  const log: { path: string; at: number; init: RequestInit | undefined }[] = [];
  const f: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    log.push({ path, at: performance.now(), init });
    init?.signal?.throwIfAborted();
    let r = (await s.fail?.(path, log.length)) ?? null;
    if (r !== null && r.status >= 300 && r.status < 400) {
      if (init?.redirect === "error") throw new TypeError("fetch failed: redirect mode is error");
      return f(r.headers.get("location") ?? "", init);
    }
    if (r !== null) return r;
    if (path === "/tip") {
      if (s.tipOf) return json(JSON.stringify(s.tipOf()));
      const b = blockAt(s.answers, s.tip ?? cap.to);
      return json(JSON.stringify({ tip: b.hash, height: b.height, chainwork: b.chainwork }));
    }
    r = s.answers[path] === undefined ? json("{}", 404) : json(s.answers[path]!);
    return r;
  };
  return { f, log, reads: (p: RegExp) => log.filter((l) => p.test(l.path)).length };
}

/** The capture with every block from `fork` up mined again: another nonce, so another hash, linked to the block
 *  below; the transactions, and so the events, are the same. */
export function branchFrom(fork: number): Answers {
  const branch: Answers = { ...cap.answers };
  for (let h = fork, prev = blockAt(cap.answers, fork - 1).hash; h <= cap.to; h++) {
    Object.assign(branch, edit(cap.answers, h, (b) => { b.header.nonce += 1; b.header.prev = prev; prev = b.hash = headerHash(rpcHeaderToHeader(b.header as never)); }));
  }
  return branch;
}

/** The loop over a served node with a memory store; `budget` defaults to the loop's own. */
export function drive(s: Served, o: { clock?: () => number; maxRequests?: number; maxBlocks?: number; paceMs?: number } = {}) {
  const n = node(s), source = nodeBlocks({ node: NODE, fetch: n.f, ...(o.paceMs === undefined ? {} : { paceMs: o.paceMs }) });
  const loop = replicaLoop({ source, store: memoryStore(), maxBlocks: o.maxBlocks ?? 64, maxRequests: o.maxRequests ?? 200, ...(o.clock ? { clock: o.clock } : {}) });
  return { n, source, loop, run: () => loop.advance() };
}

export function ctx(budget: Partial<StepContext["budget"]>, o: Partial<StepContext> = {}): StepContext {
  return { rule: CAIRNX_EVENT_RULE, cursor: null, sofar: { eventIds: new Set(), proposeIds: new Set() }, hashAt: () => null, eventsHashAt: () => null,
    budget: { deadlineAt: Number.POSITIVE_INFINITY, maxRequests: 100, maxBlocks: 64, ...budget }, signal: new AbortController().signal, now: () => 0, ...o };
}

const want = (h: number) => pinned[String(h)]!;
export const heights = [29_860, 29_960, 30_300];
/** Both hashes of hashes.json at 29,860, 29,960 and 30,300, read with the tip at `tip`. */
export const hashesOk = (loop: Loop, tip = cap.to) =>
  heights.every((h) => loop.eventsHashAt(h) === want(h).eventsHash && stateHash(loop.stateAt(tip, tip - h)!) === want(h).stateHash);
export const refused = (s: { cursor: { height: number } | null; lastError: { code: string } | null }, code: string, at: number) =>
  s.lastError?.code === code && s.cursor?.height === at;
