// transfers (transfers.ts, through the reader's verified rule). The honest path is a replica of the pinned corpus at
// level 3 with a live witness, read the way a crediting server reads it: every address that received a move, in pages,
// each with its stored cursor, while the replica grows to 117,000. The rows must equal the moves of cairnx-core's
// applied log at the deep height, each exactly once. Then cairnx-core's hand-written move vectors as rows (a capped
// mint, a transfer, a token-priced fill with its fee, a partial fill), the memo, the inputs, and the cursor rule.
import { rpcHeaderToHeader } from "@inversealtruism/csd-client";
import { applyOrder, CAIRNX_EVENT_RULE, resolve, type ChainEvent, type ProposeEvent, type TokenMove } from "@inversealtruism/cairnx-core";
import { open, type BlockEvents, type BlocksBasis, type BoundCursor, type Source, type Transfer, type Witness } from "../src/index.js";
import { fixtureSource, fixtures, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx, moveVectors as vectors } from "./core-files.js";
import { blockAt, cap } from "./node-harness.js";
import { scripted, synth } from "./reader-harness.js";

const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const TIME = 1_800_000_000, clock = () => TIME * 1000 + 60_000, DEPTH = 72;
const key = (t: { txid: string; leg: string }) => `${t.txid}:${t.leg}`;
const same = (r: Transfer, m: TokenMove & { txid: string; height: number; pos: number }) =>
  r.txid === m.txid && r.height === m.height && r.pos === m.pos && r.leg === m.leg && r.ticker === m.ticker && r.from === m.from && r.to === m.to && r.amount === m.amount;

// A level 3 basis under a caller root over the recorded blocks, so the witness rule applies as it does in production.
const CALLER: BlocksBasis = { kind: "blocks", root: { kind: "caller", floor: CAIRNX_EVENT_RULE.activationHeight - 1, origin: "https://headers.example" }, bodies: "https://bodies.example" };
const hashOf = new Map<number, string>([...fx.blocks.map((b) => [b.height, b.hash] as const), [fx.to, fx.toHash]]);
const cut = (h: number): BlockFixture => ({ ...fx, to: h, toHash: hashOf.get(h)!, blocks: fx.blocks.filter((b) => b.height <= h) });
const grow = { top: 0 };
const source: Source = { ...fixtureSource(fx), basis: CALLER, next: (ctx) => fixtureSource(cut(grow.top), { tipTime: TIME }).next(ctx) };
const header = rpcHeaderToHeader(blockAt(cap.answers, cap.to).header as never);
const witness: Witness = {
  id: "witness", origin: "https://witness.example",
  async tip() { return { height: grow.top, hash: hashOf.get(grow.top)!, time: TIME, header }; },
  async hashAt(h) { return h <= grow.top ? hashOf.get(h) ?? null : null; },
};
// The log's moves at the deep height of `top`, each with its entry's txid, height and position.
const logMoves = (top: number) => {
  const deep = top - DEPTH, s = resolve(corpus.events.filter((e) => e.height <= deep), deep);
  return { s, moves: s.events.flatMap((e) => (e.moves ?? []).map((m) => ({ ...m, txid: e.id, height: e.height, pos: e.pos }))) };
};

console.log("the honest path: the corpus, a caller root and a live witness, minDepth 72, pages of 2 with a stored cursor per address:");
const final = logMoves(fx.to), receivers = [...new Set(final.moves.map((m) => m.to))];
const r = await open({ source, witnesses: [witness], clock });
const cursors = new Map<string, BoundCursor | null>(receivers.map((a) => [a, null])), credited = new Map<string, Transfer[]>(receivers.map((a) => [a, []]));
const tops = [45_000, 70_000, 95_000, fx.to].map((h) => fx.blocks.filter((b) => b.height <= h).at(-1)!.height);
tops[tops.length - 1] = fx.to;
let reads = 0, allVerified = true, prefixOk = true, pageOk = true;
for (const top of tops) {
  grow.top = top;
  // A read starts an advance when none runs, and advance() joins a run in flight, which may predate the new tip.
  for (let k = 0; k < 3 && r.status().cursor?.height !== top; k++) await r.advance();
  for (const a of receivers) {
    for (;;) {
      const p = await r.transfers(a, cursors.get(a)!, { minDepth: DEPTH, limit: 2 });
      reads++;
      if (!p.verified) { allVerified = false; break; }
      pageOk &&= p.value.items.length <= 2 && p.value.items.every((x) => x.to === a && x.height <= top - DEPTH && x.applied) && p.at?.deepHeight === top - DEPTH;
      credited.get(a)!.push(...p.value.items);
      cursors.set(a, p.value.next);
      if (!p.value.more) break;
    }
  }
  const want = logMoves(top).moves;
  prefixOk &&= receivers.every((a) => { const got = credited.get(a)!, w = want.filter((m) => m.to === a); return got.length === w.length && got.every((x, i) => same(x, w[i]!)); });
}
const rows = [...credited.values()].flat();
ok(`every read verified (${reads} reads over ${tops.length} tips), each page at most 2 rows, each row to its address and at the deep height or below`, allVerified && pageOk);
ok(`after each tip the rows credited equal the log's moves to each address at that deep height, in order (${receivers.length} addresses)`, prefixOk);
ok(`at 117,000 every move of the log to an address appears exactly once: ${final.moves.length} moves, ${rows.length} rows, ${new Set(rows.map(key)).size} distinct (txid, leg)`,
  rows.length === final.moves.length && new Set(rows.map(key)).size === rows.length && final.moves.every((m) => rows.some((x) => same(x, m))));
ok("each row's deployId is the state's for its ticker, its code the entry's", rows.every((x) => x.deployId === final.s.tokens[x.ticker]!.deployId &&
  x.code === final.s.events.find((e) => e.id === x.txid && e.height === x.height)!.code));
const legs = new Set(rows.map((x) => x.leg));
ok(`the legs met on the corpus: ${[...legs].sort().join(", ")}`, ["fee", "fill", "mint", "sale", "xfer"].every((l) => legs.has(l as never)));
const ends = await Promise.all(receivers.map((a) => r.transfers(a, cursors.get(a)!, { minDepth: DEPTH })));
ok("read again from each stored cursor: empty, verified, the cursor unchanged", ends.every((p, i) => p.verified && p.value.items.length === 0 && p.value.next === cursors.get(receivers[i]!)));
const CAIRN = final.moves.filter((m) => m.ticker === "CAIRN");
let all: Transfer[] = [], c: BoundCursor | null = null;
for (;;) { const p = await r.transfers(null, c, { ticker: "CAIRN", minDepth: DEPTH, limit: 7 }); if (!p.verified) break; all = all.concat(p.value.items); c = p.value.next; if (!p.value.more) break; }
ok(`every address, one ticker: the ${CAIRN.length} CAIRN moves of the log, in order`, all.length === CAIRN.length && all.every((x, i) => same(x, CAIRN[i]!)));
let split = false, widest = 0;
for (const a of receivers) {
  const seen = new Set<string>();
  for (let c: BoundCursor | null = null; ;) {
    const p = await r.transfers(a, c, { minDepth: DEPTH, limit: 1 });
    if (!p.verified) { split = true; break; }
    const here = new Set(p.value.items.map((x) => `${x.height}:${x.pos}`));
    for (const k of here) { if (seen.has(k)) split = true; seen.add(k); }
    widest = Math.max(widest, p.value.items.length);
    c = p.value.next;
    if (!p.value.more) break;
  }
}
ok(`pages of 1: no entry's rows split over two pages; the one entry with two moves to one address comes whole (widest page ${widest})`, !split && widest === 2);
const e0 = await r.transfers(receivers[0]!, null, { minDepth: DEPTH, limit: 1000 }), e1 = await r.transfers(receivers[0]!, null, { minDepth: DEPTH, limit: 1000 });
ok("two reads hand out separate rows: a change to one answer is not seen in the next", e0.verified && e1.verified && ((e0.value.items[0] as { amount: string }).amount = "0", e1.value.items[0]!.amount !== "0"));
await r.close();

console.log("cairnx-core's move vectors as rows (a level 3 replica of each case at depth 0):");
const asBlocks = (events: ChainEvent[]): BlockEvents[] => [...new Set(events.map((e) => e.height))].sort((a, b) => a - b)
  .map((h) => ({ height: h, hash: synth(h), events: events.filter((e) => e.height === h).sort(applyOrder) }));
async function rowsOf(events: ChainEvent[], tip: number) {
  const x = await open({ source: scripted(asBlocks(events), { height: tip, hash: synth(tip), time: TIME }), clock });
  await x.advance();
  const to = [...new Set(resolve(events, tip).events.flatMap((e) => (e.moves ?? []).map((m) => m.to)))];
  const pages = await Promise.all(to.map((a) => x.transfers(a, null, { minDepth: 0, limit: 1000 })));
  await x.close();
  return { ok: pages.every((p) => p.verified), rows: pages.flatMap((p) => (p.verified ? p.value.items : [])) };
}
for (const [name, what] of [["mint-remaining", "a mint capped at the remaining supply"], ["transfer", "transfers"], ["token-fill-token", "a token-priced fill: its sale, its fee to the treasury, its give"],
  ["csd-partial-fill", "three partial fills, each its floor's amount"]] as const) {
  const v = vectors.cases.find((k) => k.name === name);
  const got = v === undefined ? null : await rowsOf(v.events, v.tipHeight);
  const want = v?.moves.flatMap((e) => e.moves.map((m) => ({ id: e.id, ...m }))) ?? [];
  ok(`${name}, ${what}: the rows are the vector's moves (${want.length})`, got !== null && got.ok && got.rows.length === want.length &&
    want.every((m) => got.rows.some((x) => x.txid === m.id && x.leg === m.leg && x.ticker === m.ticker && x.from === m.from && x.to === m.to && x.amount === m.amount)),
    JSON.stringify(got?.rows.map((x) => [x.leg, x.to, x.amount])));
}

// A block whose Propose applies before its Attest at a lower position (CONVENTION section 33.3): the fill at
// position 0 and a transfer at position 1, both to the buyer. Pages of 1 must give both, by position.
const tft = vectors.cases.find((k) => k.name === "token-fill-token")!, fillAt = tft.events.at(-1)!, BUYER = `0x${"b2".repeat(20)}`;
const xfer = fixtures({ lower: true }).prop({ v: 1, t: "transfer", ticker: "DUST", to: BUYER, amount: "5" }, { proposer: `0x${"a1".repeat(20)}`, height: fillAt.height, pos: 1 });
const ord = await open({ source: scripted(asBlocks([...tft.events, xfer]), { height: tft.tipHeight, hash: synth(tft.tipHeight), time: TIME }), clock });
await ord.advance();
const o1 = await ord.transfers(BUYER, null, { minDepth: 0, limit: 1, ticker: "DUST" }), o2 = await ord.transfers(BUYER, o1.verified ? o1.value.next : null, { minDepth: 0, limit: 1, ticker: "DUST" });
ok("an Attest at position 0 applied after a Propose at position 1 of its block: pages of 1 give the fill, then the transfer",
  o1.verified && o1.value.items[0]?.leg === "fill" && o1.value.more && o2.verified && o2.value.items.length === 1 && o2.value.items[0]?.leg === "xfer" && !o2.value.more);
await ord.close();

console.log("the memo, refused records, and the cursor:");
// The deploy of DUST, its fee paid, and a mint of 100 to its author, from the transfer case; then transfers of ours.
const base = vectors.cases.find((k) => k.name === "transfer")!.events.slice(0, 2) as ProposeEvent[];
const { prop } = fixtures({ lower: true }), A = base[1]!.proposer, B = `0x${"b2".repeat(20)}`, H = base[1]!.height + 1;
const evs: ChainEvent[] = [...base,
  prop({ v: 1, t: "transfer", ticker: "DUST", to: B, amount: "7", memo: "order 41" }, { proposer: A, height: H, pos: 1 }),
  prop({ v: 1, t: "transfer", ticker: "DUST", to: B, amount: "5000" }, { proposer: A, height: H, pos: 2 }),
  prop({ v: 1, t: "transfer", ticker: "DUST", to: B, amount: "3" }, { proposer: A, height: H + 1, pos: 1 })];
const m = await open({ source: scripted(asBlocks(evs), { height: H + 2, hash: synth(H + 2), time: TIME }), clock });
await m.advance();
const mp = await m.transfers(B, null, { minDepth: 0 });
ok("a transfer's memo is its record's; one without a memo null; a transfer refused for its amount gives no row", mp.verified && mp.value.items.length === 2 &&
  mp.value.items[0]!.memo === "order 41" && mp.value.items[1]!.memo === null && mp.value.items.every((x) => x.amount !== "5000"));
const ma = await m.transfers(A, null, { minDepth: 0 });
ok("the mint's row: from null, no memo (a mint record has none)", ma.verified && ma.value.items.length === 1 && ma.value.items[0]!.leg === "mint" && ma.value.items[0]!.from === null && ma.value.items[0]!.memo === null);
const p1 = await m.transfers(B, null, { minDepth: 0, limit: 1 }), p2 = await m.transfers(B, p1.verified ? p1.value.next : null, { minDepth: 0, limit: 1 });
ok("pages of 1: the first row, more, then the second from the cursor, which names its height, position and the events hash there",
  p1.verified && p1.value.more && p1.value.next.startsWith(`${H}:1:0x`) && p2.verified && p2.value.items.length === 1 && p2.value.items[0]!.height === H + 1 && !p2.value.more);
const deep2 = await m.transfers(B, null, { minDepth: 2 });
ok(`minDepth 2 at tip ${H + 2}: only rows at ${H} or below; next at ${H} with the largest position`, deep2.verified && deep2.value.items.length === 1 &&
  deep2.value.next.startsWith(`${H}:${Number.MAX_SAFE_INTEGER}:0x`));
const next1 = p1.verified ? p1.value.next : null, [h1, q1] = (next1 ?? "").split(":");
const forged = `${h1}:${q1}:0x${"e".repeat(64)}` as BoundCursor, off = await m.transfers(B, forged, { minDepth: 0 });
ok("a cursor whose events hash is not the replica's at its height: CURSOR_OFF_BRANCH alone, nothing shown", codes(off) === "CURSOR_OFF_BRANCH" && !off.verified && off.shown === null);
const ahead = `${H + 7}:1:0x${"e".repeat(64)}` as BoundCursor, ab = await m.transfers(B, ahead, { minDepth: 0 });
ok("a cursor above the replica's cursor: an empty page that keeps it, noted CURSOR_ABOVE_TIP (it cannot be checked yet)",
  ab.verified && ab.value.items.length === 0 && ab.value.next === ahead && ab.notes.some((n) => n.code === "CURSOR_ABOVE_TIP"));
const bad = [
  ["an address out of form", m.transfers("0x12", null)], ["no address and no ticker", m.transfers(null, null)], ["a ticker in lower case", m.transfers(B, null, { ticker: "dust" })],
  ["a cursor without its hash", m.transfers(B, `${H}:1` as BoundCursor)], ["a hash in upper case", m.transfers(B, `${H}:1:0x${"E".repeat(64)}` as BoundCursor)],
  ["limit 0", m.transfers(B, null, { limit: 0 })], ["limit 1,001", m.transfers(B, null, { limit: 1001 })], ["minDepth above the tip", m.transfers(B, null, { minDepth: H + 3 })],
] as const;
for (const [what, p] of bad) { const a = await p; ok(`${what}: INPUT_INVALID alone, nothing shown`, codes(a) === "INPUT_INVALID" && !a.verified && a.shown === null); }
const tk = await m.transfers(B, null, { minDepth: 0, ticker: "DUST" }), none = await m.transfers(B, null, { minDepth: 0, ticker: "CAIRN" });
ok("an address narrowed to a ticker: its rows of that ticker only", tk.verified && tk.value.items.length === 2 && none.verified && none.value.items.length === 0);
await m.close();

console.log("the verified rule (the same as every read's):");
const feed = await open({ source: fixtureSource(cut(tops[0]!), { tipTime: TIME }), clock });
const fb = await feed.transfers(receivers[0]!, null);
await feed.advance();
const fa = await feed.transfers(receivers[0]!, null, { minDepth: DEPTH });
ok("a feed before any step: LEVEL_FEED and NOT_SYNCED, nothing shown; after it LEVEL_FEED alone, its rows in shown", codes(fb) === "LEVEL_FEED,NOT_SYNCED" && !fb.verified && fb.shown === null &&
  codes(fa) === "LEVEL_FEED" && !fa.verified && fa.shown !== null);
await feed.close();
grow.top = tops[0]!;
const lone = await open({ source, clock });
await lone.advance();
ok("a caller root without a witness: NOT_WITNESSED alone", codes(await lone.transfers(receivers[0]!, null, { minDepth: DEPTH })) === "NOT_WITNESSED");
await lone.close();

done("cairnx-replica transfers");
