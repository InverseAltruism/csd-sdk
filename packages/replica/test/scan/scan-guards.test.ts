// The scanner's pagination guards, through a mock indexer: a feed that never ends, a cursor that does not advance, a
// feed without cursor support and a page that is not a list each fail the scan with their own message, pinned whole
// (a resolver serves it as its health `error`), and complete multi-page feeds are read whole.
// Wrong state is worse than no state: each refusal stops the scan before resolve() sees a partial history.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const TIP = 50_000;
const hex = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const prop = (n: number, height: number) => ({ txid: hex(n), payload_hash: "0x" + "00".repeat(32), uri: "x", expires_epoch: 10, proposer: "0x" + "aa".repeat(20), height });
type Att = { txid: string; attester: string; score: number; confidence: number; height: number };

/** A mock indexer: `proposals(from, limit)` and `attestations(pid, limit, afterH, afterT)` answer the two list routes. */
function indexer(o: {
  proposals: (from: number, limit: number) => unknown;
  attestations?: (pid: string, limit: number, afterH: number | null, afterT: string | null) => unknown;
}) {
  const hits = { proposals: 0, attestations: 0, tx: 0 };
  const f = (async (url: string) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname), q = u.searchParams;
    const J = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (p === "/blocks/tip/height") return J(TIP);
    if (p.startsWith("/block-height/")) return J("0x" + "11".repeat(32));
    if (p === `/domain/${DOMAIN}/proposals`) { hits.proposals++; return J(o.proposals(Number(q.get("from") ?? 0), Number(q.get("limit")))); }
    const m = /^\/proposal\/(0x[0-9a-f]{64})\/attestations$/.exec(p);
    if (m) {
      hits.attestations++;
      const ah = q.get("after_height");
      return J(o.attestations ? o.attestations(m[1]!, Number(q.get("limit")), ah === null ? null : Number(ah), q.get("after_txid")) : []);
    }
    const t = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
    if (t) { hits.tx++; return J({ txid: t[1], height: 100, pos: 1, outputs: [] }); }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { f, hits };
}
const scanner = (f: typeof fetch, extra: Record<string, number> = {}) => new Scanner({ indexerUrl: "http://idx", fetch: f, ...extra });

// proposals: a feed that keeps serving full pages of new rows at rising heights is refused after the page guard
{
  let n = 0;
  const { f, hits } = indexer({ proposals: (from, limit) => Array.from({ length: limit }, () => prop(++n, from + 1)) });
  await assert.rejects(scanner(f, { pageSize: 2 }).scan(), { message: "proposal pull exceeded the pagination guard (>10M proposals); refusing to resolve from a truncated history" });
  assert.equal(hits.proposals, 1_000);
  console.log("  ok a proposal feed that never ends is refused after 1,000 full pages");
}

// proposals: a full page of new rows that does not move the height cursor is refused on that page
{
  let n = 0;
  const { f, hits } = indexer({ proposals: (from, limit) => Array.from({ length: limit }, () => prop(++n, from)) });
  await assert.rejects(scanner(f, { pageSize: 3 }).scan(), { message: "indexer proposal feed did not advance the height cursor on a full page: stale/hostile feed (replace csd-indexer)" });
  assert.equal(hits.proposals, 1, "refused at the first page, not after the page guard");
  console.log("  ok a full proposal page that does not advance the cursor is refused at once");
}

// proposals: a full page with no row the pull has not seen (a pre-cursor indexer re-serving its clamp window) is
// refused on that page
{
  const rows = [prop(1, 100), prop(2, 101)];
  const { f, hits } = indexer({ proposals: () => rows });
  await assert.rejects(scanner(f, { pageSize: 2 }).scan(), { message: "indexer proposal feed saturated at the 10k clamp without cursor support: upgrade csd-indexer (?from= pagination) before trusting resolved state" });
  assert.equal(hits.proposals, 2, "refused at the second page, the first with nothing new");
  console.log("  ok a full proposal page with nothing new is refused as a feed without cursor support");
}

// a page that is not a list is refused by name
{
  const { f } = indexer({ proposals: () => ({ rows: [] }) });
  await assert.rejects(scanner(f).scan(), { message: "indexer returned a non-array proposals page; refusing to resolve from a malformed feed" });
  const { f: g } = indexer({ proposals: (from) => (from === 0 ? [prop(1, 100)] : []), attestations: () => ({ error: "busy" }) });
  await assert.rejects(scanner(g).scan(), { message: `indexer returned a non-array attestations page for ${hex(1)}; refusing to resolve from a malformed feed` });
  console.log("  ok a proposals or attestations page that is not a list is refused by name");
}

// attestations: the keyset cursor reads a list whose pages split rows of one height, each row once
{
  const all: Att[] = [10, 10, 10, 11, 11].map((h, i) => ({ txid: hex(0x100 + i), attester: "0x" + "bb".repeat(20), score: 7, confidence: 0, height: h }));
  const after = (a: Att, h: number | null, t: string | null) => h === null || a.height > h || (a.height === h && a.txid > String(t));
  const { f, hits } = indexer({
    proposals: (from) => (from === 0 ? [prop(1, 100)] : []),
    attestations: (_p, limit, h, t) => all.filter((a) => after(a, h, t)).slice(0, limit),
  });
  const { events } = await scanner(f, { attPageSize: 2 }).scan();
  assert.deepEqual(events.filter((e) => e.kind === "attest").map((e) => (e as { txid: string }).txid), all.map((a) => a.txid));
  assert.equal(hits.attestations, 3, "two full pages and a short one");
  console.log("  ok the attestation cursor reads 5 rows over pages of 2, same-height rows split across pages, each once");
}

// attestations: a list that keeps serving full pages is refused after the page guard
{
  let n = 0;
  const { f, hits } = indexer({
    proposals: (from) => (from === 0 ? [prop(1, 100)] : []),
    attestations: (_p, limit, h) => Array.from({ length: limit }, () => ({ txid: hex(0x1000 + ++n), attester: "0x" + "bb".repeat(20), score: 7, confidence: 0, height: (h ?? 100) + 1 })),
  });
  await assert.rejects(scanner(f, { attPageSize: 2 }).scan(), { message: `attestation feed for ${hex(1)} exceeded the pagination guard (>5M attests); refusing to resolve from a truncated list` });
  assert.equal(hits.attestations, 1_000);
  console.log("  ok an attestation list that never ends is refused after 1,000 full pages");
}

// pageSize: the default page is the indexer's 10,000-row clamp, so a domain larger than one page is read whole
{
  const rows = Array.from({ length: 10_003 }, (_, i) => prop(i + 1, 1_000 + i));
  const { f, hits } = indexer({ proposals: (from, limit) => rows.filter((r) => r.height >= from).slice(0, Math.min(limit, 10_000)) });
  const { events } = await scanner(f).scan();
  assert.equal(events.filter((e) => e.kind === "propose").length, 10_003);
  assert.equal(hits.proposals, 2);
  console.log("  ok the default page reads 10,003 proposals from an indexer that clamps pages at 10,000");
}

console.log("\nscan-guards: 7 passed");
