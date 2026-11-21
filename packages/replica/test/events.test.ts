// The cursor of events() (cursor.ts): a page resumes after the event its cursor names in the apply order of CONVENTION
// section 33.3, where a block's Proposes precede its Attests whatever their positions. A block with an Attest at a
// lower position than a Propose of its block, read through open() and openLog() in every page size, must give every
// event once, in that order, each page verified; generated blocks of mixed orders must page to the unpaged read. Then
// the refusals: a cursor of the old form, a cursor from another branch, a position that names no held event. Last, a
// replica behind its tip by more than minDepth (a catch-up, a rollback before the blocks after it) and a closed one:
// no page, the code of the state, never a throw.
import { applyOrder, eventId, FINAL_DEPTH, TREASURY_ADDR, type ChainEvent } from "@inversealtruism/cairnx-core";
import { local } from "../src/browser.js";
import { open, openLog, type Answer, type BlockEvents, type BoundCursor, type EventLog, type Page, type Reader, type Source, type Step } from "../src/index.js";
import { fixtures } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, moveVectors as vectors } from "./core-files.js";
import { cap, NODE, node } from "./node-harness.js";
import { OWN, scripted, synth, timeAt } from "./reader-harness.js";

const TIME = 1_800_000_000, clock = () => TIME * 1000 + 60_000;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const asBlocks = (events: ChainEvent[]): BlockEvents[] => [...new Set(events.map((e) => e.height))].sort((a, b) => a - b)
  .map((h) => ({ height: h, hash: synth(h), events: events.filter((e) => e.height === h).sort(applyOrder) }));
const sourceOf = (events: ChainEvent[], tip: number): Source => scripted(asBlocks(events), { height: tip, hash: synth(tip), time: TIME });
const ids = (es: readonly ChainEvent[]) => es.map(eventId).join();

// Every page from null at `limit`, the way a log consumer reads: each page's `next` is the next page's cursor.
async function paged(log: EventLog, limit: number): Promise<{ items: ChainEvent[]; pages: number; verified: boolean }> {
  const items: ChainEvent[] = [];
  let c: BoundCursor | null = null, pages = 0;
  for (;;) {
    const p = await log.events(c, { minDepth: 0, limit });
    pages++;
    if (!p.verified || pages > 1_000) return { items, pages, verified: false };
    items.push(...p.value.items); c = p.value.next;
    if (!p.value.more) return { items, pages, verified: true };
  }
}

console.log("an Attest at a lower position than a Propose of its block:");
// The fill (an Attest) at position 0 of its block, two transfers (Proposes) at positions 1 and 2 of the same block.
const tft = vectors.cases.find((k) => k.name === "token-fill-token")!, fillAt = tft.events.at(-1)!, BUYER = `0x${"b2".repeat(20)}`, SENDER = `0x${"a1".repeat(20)}`;
const f = fixtures({ lower: true });
const x1 = f.prop({ v: 1, t: "transfer", ticker: "DUST", to: BUYER, amount: "5" }, { proposer: SENDER, height: fillAt.height, pos: 1 });
const x2 = f.prop({ v: 1, t: "transfer", ticker: "DUST", to: BUYER, amount: "6" }, { proposer: SENDER, height: fillAt.height, pos: 2 });
const events = [...tft.events, x1, x2], want = [...events].sort(applyOrder);
const r = await open({ source: sourceOf(events, tft.tipHeight), clock });
const lg = await openLog({ source: sourceOf(events, tft.tipHeight), clock, rule: { domain: "cairnx:v1", activationHeight: 29_860 } });
await r.advance(); await lg.advance();
const block = want.filter((e) => e.height === fillAt.height);
ok(`the block at ${fillAt.height} in apply order: ${block.map((e) => `${e.kind}@${e.pos}`).join(", ")}`, block.at(-1)?.kind === "attest" && block.at(-1)!.pos === 0);
for (const [name, log] of [["open", r], ["openLog", lg]] as const) {
  const whole = await log.events(null, { minDepth: 0, limit: 1_000 });
  ok(`${name}: one page gives the ${want.length} events in apply order`, whole.verified && ids(whole.value.items) === ids(want));
  const sizes = Array.from({ length: want.length }, (_, i) => i + 1), runs = await Promise.all(sizes.map((n) => paged(log, n)));
  const bad = sizes.filter((n, i) => !runs[i]!.verified || ids(runs[i]!.items) !== ids(want));
  ok(`${name}: pages of 1 to ${want.length} each give every event once, in apply order, each page verified`, bad.length === 0, `wrong at ${bad.join(", ")}`);
}
const p2 = await r.events(null, { minDepth: 0, limit: want.indexOf(block[0]!) + 1 }), p3 = await r.events(p2.verified ? p2.value.next : null, { minDepth: 0, limit: 1 });
ok("a page cut after the block's first Propose names it: the next page starts at the second Propose", p2.verified &&
  p2.value.next.startsWith(`${fillAt.height}:1:0x`) && p3.verified && p3.value.items[0]?.pos === 2);

console.log("generated blocks, Proposes and Attests at mixed positions, against the unpaged read:");
let seed = 7;
const rand = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
let chains = 0, failed = 0, attestBelow = 0, reads = 0;
for (let k = 0; k < 40; k++) {
  const g = fixtures({ lower: true }), evs: ChainEvent[] = [], proposed: string[] = [];
  let h = 30_000;
  for (let b = 0, blocks = 2 + rand(5); b < blocks; b++) {
    h += 1 + rand(3);
    const positions = [...new Set(Array.from({ length: 1 + rand(6) }, () => rand(12)))];
    const kinds = positions.map((pos) => ({ pos, attest: rand(2) === 0 }));
    if (proposed.length === 0 && kinds.every((x) => x.attest)) kinds[0]!.attest = false;
    // A block's Proposes first, so an Attest may name a Propose of its own block at any position.
    for (const { pos } of kinds.filter((x) => !x.attest)) {
      const e = g.prop({ v: 1, t: "transfer", ticker: "DUST", to: BUYER, amount: "1" }, { proposer: SENDER, height: h, pos });
      evs.push(e); proposed.push(e.id);
    }
    for (const { pos } of kinds.filter((x) => x.attest)) evs.push(g.att({ proposalId: proposed[rand(proposed.length)]!, attester: SENDER, score: 1, height: h, pos }));
    const atts = evs.filter((e) => e.height === h && e.kind === "attest"), props = evs.filter((e) => e.height === h && e.kind === "propose");
    attestBelow += atts.filter((a) => props.some((p) => p.pos > a.pos)).length;
  }
  const x = await open({ source: sourceOf(evs, h + 1), clock });
  await x.advance();
  const whole = await x.events(null, { minDepth: 0, limit: 1_000 }), unpaged = whole.verified ? whole.value.items : [];
  const okChain = whole.verified && ids(unpaged) === ids([...evs].sort(applyOrder));
  for (const n of [1, 2, 3, 5]) { const p = await paged(x, n); reads += p.pages; if (!okChain || !p.verified || ids(p.items) !== ids(unpaged)) failed++; }
  chains++;
  await x.close();
}
ok(`${chains} chains (${attestBelow} Attests below a Propose of their block), pages of 1, 2, 3 and 5 in ${reads} reads: each equals the unpaged read`,
  failed === 0 && attestBelow > 0, `${failed} wrong`);

console.log("the refusals:");
const whole0 = await r.events(null, { minDepth: 0, limit: 1_000 }), first = await r.events(null, { minDepth: 0, limit: 3 }), cur = first.verified ? first.value.next : null;
const [hh, pp, hash] = (cur ?? "::").split(":");
const cases: [string, string][] = [["the old form, height:pos", `${hh}:${pp}`], ["a position that names no held event at a height held", `${hh}:9:${hash}`],
  ["a position at a height that holds no event", `${tft.tipHeight}:0:${(whole0.verified ? whole0.value.next : "").split(":")[2]}`]];
for (const [what, c] of cases) {
  const a = await r.events(c as BoundCursor, { minDepth: 0 });
  ok(`events, ${what}: INPUT_INVALID alone, nothing shown`, codes(a) === "INPUT_INVALID" && !a.verified && a.shown === null, codes(a));
}
const t = await r.transfers(BUYER, `${hh}:9:${hash}` as BoundCursor, { minDepth: 0 }), tOk = await r.transfers(BUYER, cur as BoundCursor, { minDepth: 0 });
ok("transfers takes the same cursor: a position naming no held event INPUT_INVALID, a cursor events handed out accepted", codes(t) === "INPUT_INVALID" && tOk.verified, `${codes(t)} / ${codes(tOk)}`);
// Another branch: the same blocks with one more Propose at the deploy's height, below the cursor's.
const extra = f.prop({ v: 1, t: "transfer", ticker: "DUST", to: BUYER, amount: "1" }, { proposer: SENDER, height: tft.events[0]!.height, pos: 9 });
const other = await open({ source: sourceOf([...events, extra], tft.tipHeight), clock });
await other.advance();
const off = await other.events(cur as BoundCursor, { minDepth: 0 });
ok("a cursor from another branch, naming an event both branches hold: CURSOR_OFF_BRANCH alone, nothing shown", codes(off) === "CURSOR_OFF_BRANCH" && !off.verified && off.shown === null, codes(off));
const mine = await other.events(null, { minDepth: 0, limit: 3 }), go = await other.events(mine.verified ? mine.value.next : null, { minDepth: 0, limit: 1_000 });
ok("control: that replica's own cursor at the same place reads on", go.verified && go.value.items.length === want.length + 1 - 3);
// A feed's answer is never verified (LEVEL_FEED); the cursor's refusal still comes alone, as every input's does.
const feed = await open({ source: { ...sourceOf(events, tft.tipHeight), basis: { kind: "feed", feed: "https://feed.example", inclusion: false } }, clock });
await feed.advance();
const fa = await feed.events(`${hh}:9:${hash}` as BoundCursor, { minDepth: 0 }), fb = await feed.events(cur as BoundCursor, { minDepth: 0 });
ok("under a feed: a position naming no held event is INPUT_INVALID alone; the cursor handed out is LEVEL_FEED with its page shown",
  codes(fa) === "INPUT_INVALID" && fa.at === null && codes(fb) === "LEVEL_FEED" && !fb.verified && fb.shown !== null, `${codes(fa)} / ${codes(fb)}`);
for (const x of [r, lg, other, feed]) await x.close();

console.log("behind the tip by more than minDepth, and after close():");
// The production call shape: open(local({ node })) over the recorded capture, the node answering a turn later, read
// with the defaults from the first moment, the way a consumer started with the replica polls it. While the replica
// catches up the deep height lies above its cursor, where it holds no events hash for a cursor to be made at.
const DEEP = cap.to - FINAL_DEPTH, now = (timeAt(cap.to) + 60) * 1_000;
async function poll(read: (x: Reader) => Promise<Answer<Page<unknown>>>) {
  const inner = node({ answers: cap.answers }).f, slow: typeof fetch = async (i, init) => { await new Promise((go) => setImmediate(go)); return inner(i, init); };
  const x = await open({ ...local({ node: NODE, fetch: slow }), clock: () => now }), seen = new Map<string, number>();
  let threw = "", last: Answer<Page<unknown>> | null = null;
  for (let n = 0; n < 20_000 && last?.verified !== true; n++) {
    try { last = await read(x); const k = last.verified ? "verified" : `${codes(last)}${last.shown === null ? "" : " shown"}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
    catch (e) { threw ||= e instanceof Error ? e.message : String(e); break; }
    await new Promise((go) => setImmediate(go));
  }
  return { x, seen, threw, keys: [...seen.keys()].sort().join(", "), tally: [...seen].map(([k, n]) => `${k} ${n}`).join("; ") };
}
const ev = await poll((x) => x.events(null)), want12 = corpus.events.filter((e) => e.height <= DEEP).sort(applyOrder);
const evPages: ChainEvent[] = [];
for (let c: BoundCursor | null = null; ev.threw === "";) { const p = await ev.x.events(c); if (!p.verified) break; evPages.push(...p.value.items); c = p.value.next; if (!p.value.more) break; }
// Behind with the deep height above the cursor: nothing shown; at or below it, a page shown (BEHIND shown).
const catchUp = "BEHIND, BEHIND shown, NOT_SYNCED, verified";
ok(`events() polled through a catch-up: no throw, NOT_SYNCED or BEHIND until verified (${ev.tally}), then it pages the ${want12.length} events at the deep height`,
  ev.threw === "" && ev.keys === catchUp && ids(evPages) === ids(want12), ev.threw || ev.keys);
await ev.x.close();
const tr = await poll((x) => x.transfers(TREASURY_ADDR, null));
ok(`transfers() polled the same way: NOT_SYNCED or BEHIND until verified (${tr.tally})`, tr.threw === "" && tr.keys === catchUp, tr.threw || tr.keys);
await tr.x.close();

// A rollback to 30,200 whose step names the other branch's tip 30,300, the blocks of that branch held back until
// released: between the two the replica's cursor is 30,200 and the deep height 30,288.
const g = fixtures({ lower: true }), hashB = (h: number) => `0x${"d".repeat(58)}${h.toString(16).padStart(6, "0")}`;
const send = (h: number) => g.prop({ v: 1, t: "transfer", ticker: "DUST", to: BUYER, amount: "1" }, { proposer: SENDER, height: h });
const onA = [30_010, 30_100, 30_200, 30_250].map(send), onB = [...onA.slice(0, 3), ...[30_260, 30_280].map(send)], TOP = 30_300;
let mode: "fill" | "reorg" | "hold" | "idle" = "fill", release = () => undefined as void;
const held = new Promise<void>((go) => { release = go; }), tipB = { height: TOP, hash: hashB(TOP), time: now / 1_000 };
const forked: Source = { basis: OWN, floor: null, tip: async () => tipB, async next(ctx): Promise<Step> {
  if (mode === "fill") { mode = "idle"; return { kind: "blocks", blocks: asBlocks(onA), cursor: { height: TOP, hash: synth(TOP) }, tip: { height: TOP, hash: synth(TOP), time: now / 1_000 } }; }
  if (mode === "reorg") { mode = "hold"; return { kind: "reorg", to: { height: 30_200, hash: synth(30_200) }, tip: tipB }; }
  if (mode === "hold") { await held; mode = "idle"; return { kind: "blocks", blocks: asBlocks(onB).filter((b) => b.height > 30_200).map((b) => ({ ...b, hash: hashB(b.height) })), cursor: { height: TOP, hash: hashB(TOP) }, tip: tipB }; }
  return { kind: "idle", tip: ctx.cursor === null ? tipB : { height: ctx.cursor.height, hash: ctx.cursor.hash, time: now / 1_000 } };
} };
const rb = await open({ source: forked, clock: () => now });
await rb.advance();
const before = await rb.events(null, { minDepth: 0, limit: 1 }), kept = before.verified ? before.value.next : null;
await rb.advance();   // the run the read started, so that the next advance is a run of its own
mode = "reorg";
const stepping = rb.advance();
for (let i = 0; i < 50 && rb.status().cursor?.height !== 30_200; i++) await new Promise((go) => setImmediate(go));
const between = rb.status().cursor?.height === 30_200 ? await Promise.all([rb.events(null), rb.events(null, { limit: 1_000 }), rb.events(kept), rb.transfers(BUYER, null), rb.transfers(BUYER, kept)].map((p) => p.then(codes, (e: unknown) => `threw ${String(e)}`))) : ["the rollback was not reached"];
ok(`between a rollback and the blocks after it: events() from null and from a cursor below the fork, and transfers(), each BEHIND (${[...new Set(between)].join(", ")})`,
  between.length === 5 && between.every((c) => c === "BEHIND"), between.join(" | "));
release(); await stepping;
const after = await rb.events(null, { minDepth: 0, limit: 1_000 });
ok("once the blocks after it are held, the other branch's events, verified", after.verified && ids(after.value.items) === ids([...onB].sort(applyOrder)));
const cutB = await rb.events(null, { minDepth: 0, limit: 2 }), cursorB = cutB.verified ? cutB.value.next : null;
await rb.close();
const closed = [await rb.events(cursorB), await rb.transfers(BUYER, cursorB)];
ok("after close(): events() and transfers() with a cursor a read handed out, NOT_SYNCED alone, nothing shown",
  cursorB !== null && closed.every((a) => codes(a) === "NOT_SYNCED" && !a.verified && a.shown === null), closed.map(codes).join(" | "));

done("cairnx-replica events");
