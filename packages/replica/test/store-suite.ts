// The store conformance suite: what every Store does whatever holds its bytes. `make` returns a fresh, empty store;
// the suite uses the Store interface alone and no node: module, so a browser harness runs it as a Node test does.
// Covered here: whole commits, the compare of `expect` with the stored cursor, rollback, and open's refusals.
import { CAIRNX_EVENT_RULE, EVENTS_HASH_START, canonicalJson, eventsHashStep, type EventRule } from "@inversealtruism/cairnx-core";
import { ReplicaConfigError, type Basis, type BlockRow, type Boundary, type Commit, type Cursor, type Store, type StoreMeta } from "../src/index.js";
import { ROWS_HASH_START, rowsHashStep } from "../src/rowshash.js";
import { fixtures } from "../src/testing.js";

export type Check = { name: string; ok: boolean };

export const FEED: Basis = { kind: "feed", feed: "https://feed.example", inclusion: false };
export const BLOCKS: Basis = { kind: "blocks", root: { kind: "own-node", node: "http://127.0.0.1:8789" }, bodies: "http://127.0.0.1:8789" };
export const key = (basis: Basis) => ({ format: 1, rule: CAIRNX_EVENT_RULE, basis }) as const;
export const at = (height: number, c = "1"): Cursor => ({ height, hash: `0x${c.repeat(64 - String(height).length)}${height}` });
const f = fixtures();
// A row after `prev`, the row below it (null for the first), with both running hashes.
export const row = (height: number, prev: BlockRow | null, c = "1"): BlockRow => {
  const events = [f.prop({ v: 1, t: "nrenew", name: "alice" }, { proposer: `0x${"a1".repeat(20)}`, height, pos: 1 })], hash = at(height, c).hash;
  return { height, hash, events, eventsHash: eventsHashStep(prev?.eventsHash ?? EVENTS_HASH_START, height, events),
    rowsHash: rowsHashStep(prev?.rowsHash ?? ROWS_HASH_START, { height, hash, events }) };
};
export const bound = (height: number, stateHash: string | null = EVENTS_HASH_START): Boundary =>
  ({ height, hash: at(height).hash, eventsHash: EVENTS_HASH_START, rowsHash: ROWS_HASH_START, stateHash });
// A meta whose running hashes are those of `last`, the last row held after the commit.
export const meta = (cursor: Cursor | null, rows: BlockRow[], basis: Basis = FEED, rule: EventRule = CAIRNX_EVENT_RULE, last = rows.at(-1)): StoreMeta => ({
  format: 1, rule, basis, cursor, eventsHash: last?.eventsHash ?? EVENTS_HASH_START, rowsHash: last?.rowsHash ?? ROWS_HASH_START,
  eventCount: rows.reduce((n, r) => n + r.events.length, 0), witnessed: null, windowSha256: null, work: null, workRoot: null, gates: { V12_HEIGHT: 30_300 },
});
export type Extend = Exclude<Commit, { rollbackTo: unknown }>;
export const commit = (expect: Cursor | null, rows: BlockRow[], cursor: Cursor | null, more: Partial<Extend> = {}): Extend =>
  ({ expect, rows, boundaries: [], meta: meta(cursor, rows), ...more });
// A rollback to `to`, whose meta holds `kept`'s hashes: the last row kept.
export const rollback = (expect: Cursor | null, to: Cursor | null, kept: BlockRow | undefined): Commit =>
  ({ expect, rollbackTo: to, meta: meta(to, [], FEED, CAIRNX_EVENT_RULE, kept) });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Everything a store holds, read back through its interface; reopens it under FEED. */
async function held(s: Store) {
  const rows: BlockRow[] = [];
  for await (const r of s.rows(0)) rows.push(r);
  const o = await s.open(key(FEED));
  return { rows, boundaries: await s.boundaries(), window: [...((await s.headerWindow()) ?? [])], meta: o.ok ? o.meta : o.reset };
}

export async function storeSuite(make: () => Store | Promise<Store>): Promise<Check[]> {
  const out: Check[] = [];
  const check = (name: string, ok: boolean) => { out.push({ name, ok }); };
  const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

  const s = await make();
  check("a commit before open is refused", code(await s.commit(commit(null, [], at(30_000)))) === "STORE_FAILED");
  const first = await s.open(key(FEED));
  check("a fresh store opens with no meta", first.ok && first.meta === null);
  const r1 = row(30_001, null), r2 = row(30_050, r1), r3 = row(30_100, r2);
  const c1 = commit(null, structuredClone([r1, r2]), at(30_060), { boundaries: [bound(30_000)], headerWindow: new Uint8Array([1, 2, 3]) });
  check("the first commit is applied", (await s.commit(c1)).ok);
  const want1 = { rows: [r1, r2], boundaries: [bound(30_000)], window: [1, 2, 3], meta: c1.meta };
  check("the rows, boundaries, header window and meta are held as committed", same(await held(s), want1));
  const from: BlockRow[] = [];
  for await (const r of s.rows(30_002)) from.push(r);
  check("rows(from) yields the rows at or above it", same(from, [r2]));
  c1.rows[0]!.events.length = 0; from[0]!.events.length = 0;
  check("rows committed and rows read are copies, not the caller's objects", same(await held(s), want1));

  check("a commit whose expect is not the stored cursor is CURSOR_MOVED", code(await s.commit(commit(null, [r3], at(30_100)))) === "CURSOR_MOVED");
  check("expect at the stored height on another hash is CURSOR_MOVED", code(await s.commit(commit(at(30_060, "2"), [r3], at(30_100)))) === "CURSOR_MOVED");
  const elsewhere = [{ ...commit(at(30_060), [r3], at(30_100)), meta: meta(at(30_100), [r3], BLOCKS) },
    { ...commit(at(30_060), [r3], at(30_100)), meta: meta(at(30_100), [r3], FEED, { domain: "other:v1", activationHeight: 1 }) }];
  for (const c of elsewhere) check(`a commit under another ${c.meta.basis === FEED ? "rule" : "basis"} is refused`, code(await s.commit(c)) === "STORE_FAILED");
  const refused: [string, Commit][] = [
    ["a row at or below the stored cursor", commit(at(30_060), [row(30_060, r2), r3], at(30_100))],
    ["rows out of height order", commit(at(30_060), [r3, row(30_090, r2)], at(30_100))],
    ["a cursor below the last row", commit(at(30_060), [r3], at(30_099))],
    ["a boundary not above the last one kept", commit(at(30_060), [r3], at(30_100), { boundaries: [bound(30_000)] })],
    ["a rollback above the stored cursor", { ...rollback(at(30_060), at(30_070), r2), meta: meta(at(30_070), [r2]) }],
    ["a rollback whose meta's cursor is not where it rolls back to", { ...rollback(at(30_060), at(30_050), r2), meta: meta(at(30_060), [r2]) }],
    ["a rollback that also carries rows (outside the types)", { ...rollback(at(30_060), at(30_050), r2), rows: [r3], boundaries: [] } as unknown as Commit],
    ["a meta whose events hash is not the last row's", { ...commit(at(30_060), [r3], at(30_100)), meta: { ...meta(at(30_100), [r3]), eventsHash: r2.eventsHash } }],
    ["a meta whose rows hash is not the last row's", { ...commit(at(30_060), [r3], at(30_100)), meta: { ...meta(at(30_100), [r3]), rowsHash: r2.rowsHash } }],
    ["a meta with no new rows whose hashes are not those of the last row kept", commit(at(30_060), [], at(30_070))],
  ];
  for (const [name, c] of refused) {
    check(`a commit with ${name} is refused whole`, code(await s.commit(c)) === "STORE_FAILED" && same(await held(s), want1));
  }
  const c2 = commit(at(30_060), [r3], at(30_100), { boundaries: [bound(30_030, null)] });
  check("of two writers with the same expect, the second is CURSOR_MOVED", (await s.commit(c2)).ok && code(await s.commit(c2)) === "CURSOR_MOVED");
  check("a boundary without a state hash is held as committed", same(await s.boundaries(), [bound(30_000), bound(30_030, null)]));
  const still = await s.commit({ ...commit(at(30_100), [], at(30_110)), meta: meta(at(30_110), [], FEED, CAIRNX_EVENT_RULE, r3) });
  check("a commit with no new rows is taken with the last row's hashes in its meta", still.ok);

  const r2b = row(30_040, r1, "b");
  const onR1 = { height: r1.height, hash: r1.hash! }, back = rollback(at(30_110), onR1, r1);
  check("a rollback onto a held row keeps it and what lies below and drops the rows and boundaries above",
    (await s.commit(back)).ok && same(await held(s), { rows: [r1], boundaries: [bound(30_000)], window: [1, 2, 3], meta: back.meta }));
  const ahead = await s.commit(commit(onR1, [r2b], at(30_045)));
  check("the next extend appends after the rows kept", ahead.ok && same(await held(s), { rows: [r1, r2b], boundaries: [bound(30_000)], window: [1, 2, 3], meta: meta(at(30_045), [r2b]) }));
  const none = await s.commit(rollback(at(30_045), null, undefined));
  check("a rollback to nothing drops every row and boundary",
    none.ok && same(await held(s), { rows: [], boundaries: [], window: [1, 2, 3], meta: meta(null, []) }));

  const t = await make();
  await t.open(key(FEED));
  await t.commit(commit(null, [r1], at(30_010)));
  const before = await held(t);
  const reasons = [await t.open(key(BLOCKS)), await t.open({ ...key(FEED), rule: { domain: "other:v1", activationHeight: 1 } }),
    await t.open({ ...key(FEED), format: 2 as 1 })].map((o) => (o.ok ? "opened" : o.reset));
  check("open under another basis, rule or format is refused and names the difference", reasons.join() === "basis,rule,format");
  check("a refused open closes the store to commits", code(await t.commit(commit(at(30_010), [], at(30_020)))) === "STORE_FAILED");
  check("a refused open keeps what the store holds", same(await held(t), before));
  await t.reset();
  const pinOverFeed = { kind: "pinned", pin: at(30_000), logSha256: at(1).hash, above: FEED } as unknown as Basis;
  let error: unknown = null;
  try { await t.open(key(pinOverFeed)); } catch (e) { error = e; }
  check("an empty store refuses to open under a pin over a feed with ReplicaConfigError", error instanceof ReplicaConfigError);
  const fresh = await t.open(key(BLOCKS));
  check("after reset the store opens empty under another basis", fresh.ok && fresh.meta === null && (await t.boundaries()).length === 0);
  t.close();
  check("a closed store refuses a commit", code(await t.commit({ ...commit(null, [], at(30_000)), meta: meta(at(30_000), [], BLOCKS) })) === "STORE_FAILED");
  return out;
}
