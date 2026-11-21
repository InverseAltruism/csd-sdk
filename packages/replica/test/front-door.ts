// Our front door served from recorded node answers, without reading a file, so the browser rig bundles it too
// (hosted-harness.ts serves the captures with it): /api/rpc/tip answers the block at `tip` (default `defaultTip`),
// /api/blocks/:from/:count the node's block bodies inside {ok, from, count, blocks} and a 502 for a range past the tip,
// /api/headers/:from/:count {height, header, hash} rows, /api/rpc/tx/:id the source transactions. A request without
// the `fresh` parameter is answered from `edge` first, as an edge cache holding stale pages would answer it. Every
// request is logged.
import type { RpcTxJson } from "@inversealtruism/csd-client";

export type Answers = Record<string, string>;
export type Block = { height: number; hash: string; chainwork: string; header: Record<string, unknown> & { prev: string; nonce: number; merkle: string };
  txs: (RpcTxJson & { spent_tx?: unknown })[] };
export const blockAt = (a: Answers, h: number) => JSON.parse(a[`/block/height/${h}`]!) as Block;
export const json = (text: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "content-type": "application/json", ...headers } });

export type Hosted = { answers: Answers; tip?: number; edge?: Answers; fail?: (path: string, fresh: boolean) => Response | null };

export function frontDoor(s: Hosted, defaultTip: number) {
  const log: { path: string; fresh: boolean; init: RequestInit | undefined }[] = [];
  const f: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), path = u.pathname, fresh = u.searchParams.has("fresh");
    log.push({ path, fresh, init });
    init?.signal?.throwIfAborted();
    const failed = s.fail?.(path, fresh) ?? null;
    if (failed !== null) return failed;
    const a = fresh ? s.answers : { ...s.answers, ...s.edge }, tip = s.tip ?? defaultTip;
    if (path === "/api/rpc/tip") { const b = blockAt(a, tip); return json(JSON.stringify({ tip: b.hash, height: b.height, chainwork: b.chainwork })); }
    if (path.startsWith("/api/rpc/tx/")) { const t = a[path.slice("/api/rpc".length)]; return t === undefined ? json('{"ok":false,"err":"not found"}') : json(t); }
    const m = /^\/api\/(blocks|headers)\/([0-9]+)\/([0-9]+)$/.exec(path);
    if (m === null) return json("{}", 404);
    const from = Number(m[2]), count = Number(m[3]), hs = Array.from({ length: count }, (_, i) => from + i);
    if (hs.some((h) => h > tip || a[`/block/height/${h}`] === undefined)) return json('{"ok":false,"error":"unavailable"}', 502);
    if (m[1] === "blocks") return json(`{"ok":true,"from":${from},"count":${count},"blocks":[${hs.map((h) => a[`/block/height/${h}`]).join(",")}]}`);
    return json(JSON.stringify({ ok: true, from, count, headers: hs.map((h) => { const b = blockAt(a, h); return { height: h, header: b.header, hash: b.hash }; }) }));
  };
  return { f, log, reads: (p: RegExp, fresh?: boolean) => log.filter((l) => p.test(l.path) && (fresh === undefined || l.fresh === fresh)).length };
}

