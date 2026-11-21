// The service worker of the test extension (idb-store.test.ts bundles it): the store suite over idbStore, fills of a
// stub chain through the loop and the reader, a fill held at a point of a commit, and the store-level cases, each one
// command a control page sends with chrome.runtime.sendMessage.
import * as core from "@inversealtruism/cairnx-core";
import { CAIRNX_EVENT_RULE, EVENTS_HASH_START, canonicalJson, eventsHashStep, payloadHash, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { rpcHeaderToHeader } from "@inversealtruism/csd-client";
import { gatesOf } from "../../src/gates.js";
import { pinned } from "../../src/pinned.js";
import { idbStore, idbStoreWith, sessionSlot } from "../../src/idb-store.js";
import { open, replicaLoop, type Boundary, type BlockRow, type BlocksSource, type Commit, type Pin, type Step, type Store, type TrustedSlot, type Witness } from "../../src/index.js";
import { rowsHashStep } from "../../src/rowshash.js";
import { boundsHashStep, BOUNDS_HASH_START } from "../../src/store-format.js";
import { fixtures } from "../../src/testing.js";
import { FEED, at, commit, key, row, storeSuite } from "../store-suite.js";
import below from "../fixtures/node-blocks-29815-29859.json";

type Chrome = {
  runtime: { onMessage: { addListener(f: (m: { cmd?: string; args?: Args }, s: unknown, reply: (v: unknown) => void) => boolean): void } };
  storage: { session: { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void>; remove(k: string): Promise<void> } };
};
type Args = Record<string, unknown> & { name?: string; top?: number; nth?: number; point?: string };
const chrome = (globalThis as unknown as { chrome: Chrome }).chrome;
const ACT = CAIRNX_EVENT_RULE.activationHeight, TOP = ACT + 2_000, f = fixtures();

// The stub chain: a block at every height from activation, `dense` Proposes at every 37th, a hash a height. Under a
// caller root (`caller`) a reader needs a witness; `offline` refuses every step, as a source with no network.
const hashOf = (h: number) => `0x${h.toString(16).padStart(8, "0")}${"ab".repeat(28)}`;
const eventsAt = (h: number, dense: number) => (h % 37 !== 0 ? [] : Array.from({ length: dense }, (_, i) =>
  f.prop({ v: 1, t: "nrenew", name: "alice" }, { proposer: `0x${"a1".repeat(20)}`, height: h, pos: i + 1, id: `0x${h.toString(16).padStart(56, "0")}${(i + 1).toString(16).padStart(8, "0")}` })));
type Kind = { readonly caller?: boolean; readonly offline?: boolean; readonly dense?: number };
const calls = { next: 0, tip: 0 };
function source(top: number, k: Kind = {}): BlocksSource {
  const tip = () => ({ height: top, hash: hashOf(top), time: Math.floor(Date.now() / 1000) });
  const root = k.caller === true ? { kind: "caller", floor: ACT - 1, origin: "https://headers.example" } as const : { kind: "own-node", node: "http://127.0.0.1:8789" } as const;
  return {
    basis: { kind: "blocks", root, bodies: k.caller === true ? "https://bodies.example" : "http://127.0.0.1:8789" }, floor: null,
    tip: async () => tip(), block: async () => { throw new Error("the stub source serves steps only"); },
    async next(ctx): Promise<Step> {
      calls.next++;
      if (k.offline === true) return { kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "offline", retryAfterMs: null };
      const after = ctx.cursor?.height ?? ACT - 1;
      if (after >= top) return { kind: "idle", tip: tip() };
      const blocks = [];
      for (let h = after + 1; h <= Math.min(top, after + ctx.budget.maxBlocks); h++) blocks.push({ height: h, hash: hashOf(h), events: eventsAt(h, k.dense ?? 1) });
      return { kind: "blocks", blocks, cursor: { height: blocks.at(-1)!.height, hash: blocks.at(-1)!.hash }, tip: tip() };
    },
  };
}
const slotKey = (name: string) => `slot:${name}`;
// A witness on another origin at the stub chain's top; `offline` throws, as a witness with no network.
const witness = (offline: boolean): Witness => ({
  id: "w1", origin: "https://witness.example",
  async tip() { calls.tip++; if (offline) throw new Error("offline"); return { height: TOP, hash: hashOf(TOP), time: Math.floor(Date.now() / 1000), header: {} as never }; },
  async hashAt(h) { if (offline) throw new Error("offline"); return hashOf(h); },
});
// The reader of the production call shape over `name`'s store: open() with idbStore and sessionSlot.
const viewReader = (name: string, k: Kind, clock?: () => number) => open({ source: source(TOP, k), store: idbStore({ name, slot: sessionSlot(slotKey(name)) }),
  witnesses: k.caller === true ? [witness(k.offline === true)] : [], ...(clock === undefined ? {} : { clock }) });
const codesOf = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code);
// A store recording each open's answer and each commit's cursor once taken.
function watched(s: Store, opens: string[], cursors: (number | null)[]): Store {
  return { ...s, rows: (h) => s.rows(h), async open(e) { const o = await s.open(e); opens.push(o.ok ? "ok" : o.reset); return o; },
    async commit(c: Commit) { const r = await s.commit(c); if (r.ok) cursors.push(c.meta.cursor?.height ?? null); return r; } };
}
const never = new Promise<void>(() => undefined);
let reached: ((p: string) => void) | null = null;

// The loop over the stub chain on `name`'s store: the answers of its opens, where it opened, and the cursor and events
// hash it ran on to.
async function state(name: string, top = TOP) {
  const opens: string[] = [], cursors: (number | null)[] = [];
  const loop = replicaLoop({ source: source(top), store: watched(idbStore({ name, slot: sessionSlot(slotKey(name)) }), opens, cursors), resetRefused: true });
  await loop.open();
  const openedAt = loop.status().cursor?.height ?? null, s = await loop.advance({ budgetMs: 120_000 });
  await loop.close();
  return { opens, openedAt, cursor: s.cursor?.height ?? null, eventsHash: s.eventsHash, lastError: s.lastError?.reason ?? null, commits: cursors };
}
// The raw content of `name`'s database.
async function raw(name: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => { const q = indexedDB.open(`cairnx-replica:${name}`); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
const all = <T>(db: IDBDatabase, s: string): Promise<T[]> => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result as T[]); });
const one = <T>(db: IDBDatabase, s: string, k: string): Promise<T> => new Promise((res) => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => res(q.result as T); });
function put(db: IDBDatabase, writes: [string, unknown, IDBValidKey][], clear: string[] = []): Promise<void> {
  const tx = db.transaction(["meta", "rows", "bounds", "window"], "readwrite");
  for (const s of clear) tx.objectStore(s).clear();
  for (const [s, v, k] of writes) tx.objectStore(s).put(v, k);
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); });
}
const reasonOf = async (s: Store) => { const o = await s.open(key(FEED)); return o.ok ? "ok" : o.reset; };
const fresh = (p: string) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

// A world the tests set: the chain's top and the time of its tip, the clock, and what the witness answers.
const MIN = 60_000;
// `lead`: how far the source's tip lies above the last block it serves (a source still catching up).
const env = { top: TOP, lead: 0, now: 0, tipAge: 0, wit: "online" as "online" | "offline" | "other", ahead: false, rules: null as Record<string, number> | null };
const resetEnv = () => Object.assign(env, { top: TOP, lead: 0, now: Date.now(), tipAge: 0, wit: "online", ahead: false, rules: null });
// A real header that meets its own bits, so a witness naming it higher is a peer ahead (csd-light tipHeaderPowOk).
const peer = (() => { const b = JSON.parse((below as { answers: Record<string, string> }).answers["/block/height/29859"]!); return { hash: b.hash as string, header: rpcHeaderToHeader(b.header) }; })();
function envSource(k: { caller?: boolean; offline?: boolean; feed?: boolean } = {}): BlocksSource {
  const tip = () => ({ height: env.top + env.lead, hash: hashOf(env.top + env.lead), time: Math.floor((env.now - env.tipAge) / 1000) });
  const root = k.caller === false ? { kind: "own-node", node: "http://127.0.0.1:8789" } as const : { kind: "caller", floor: ACT - 1, origin: "https://headers.example" } as const;
  return {
    basis: (k.feed === true ? { kind: "feed", feed: "https://feed.example", inclusion: false } : { kind: "blocks", root, bodies: "https://bodies.example" }) as BlocksSource["basis"],
    floor: null, tip: async () => tip(), block: async () => { throw new Error("the stub source serves steps only"); },
    async next(ctx): Promise<Step> {
      if (k.offline === true) return { kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "offline", retryAfterMs: null };
      const after = ctx.cursor?.height ?? ACT - 1;
      if (after >= env.top) return { kind: "idle", tip: tip() };
      const blocks = [];
      for (let h = after + 1; h <= Math.min(env.top, after + ctx.budget.maxBlocks); h++) blocks.push({ height: h, hash: k.feed === true ? null : hashOf(h), events: eventsAt(h, 1) });
      return { kind: "blocks", blocks, cursor: { height: blocks.at(-1)!.height, hash: hashOf(blocks.at(-1)!.height) }, tip: tip() } as Step;
    },
  };
}
const envWitness = (offline = false): Witness => ({
  id: "w1", origin: "https://witness.example",
  async tip() {
    if (offline || env.wit === "offline") throw new Error("offline");
    return env.ahead ? { height: env.top + 1, hash: peer.hash, time: Math.floor(env.now / 1000), header: peer.header }
      : { height: env.top, hash: env.wit === "other" ? `0x${"cd".repeat(32)}` : hashOf(env.top), time: Math.floor(env.now / 1000), header: {} as never };
  },
  async hashAt(h) { if (offline || env.wit === "offline") throw new Error("offline"); return env.wit === "other" ? `0x${"cd".repeat(32)}` : hashOf(h); },
  async rules() { return env.rules === null ? null : { gates: env.rules }; },
});
// A pin of the stub chain at `p`, an epoch boundary: its log, events hash, state hash and gate table as a release cuts them.
function pinAt(p: number, o: { stateHash?: string } = {}): Pin {
  const events = [];
  for (let h = ACT; h <= p; h++) events.push(...eventsAt(h, 1));
  let eh = EVENTS_HASH_START;
  for (let h = ACT; h <= p; h++) { const e = eventsAt(h, 1); if (e.length > 0) eh = eventsHashStep(eh, h, e); }
  const text = canonicalJson(events), gates = Object.fromEntries(Object.entries(gatesOf(core)).filter(([, g]) => g <= p));
  return { format: 1, rule: CAIRNX_EVENT_RULE, height: p, blockHash: hashOf(p), logSha256: payloadHash(events), eventsHash: eh,
    stateHash: o.stateHash ?? stateHash(resolve(events, p)), gates, core: "test", log: async () => new TextEncoder().encode(text) };
}
type EnvKind = { offline?: boolean; pin?: Pin; feed?: boolean; slot?: TrustedSlot };
const envReader = (name: string, k: EnvKind = {}) => {
  const then = envSource({ offline: k.offline, feed: k.feed });
  return open({ source: k.pin === undefined ? then : pinned({ pin: k.pin, then }), store: idbStore({ name, slot: k.slot ?? sessionSlot(slotKey(name)) }),
    witnesses: k.feed === true ? [] : [envWitness(k.offline)], clock: () => env.now });
};
const heldIn = async (name: string) => (JSON.parse(((await chrome.storage.session.get(slotKey(name)))[slotKey(name)] as string | undefined) ?? "{}") as { held?: unknown }).held !== undefined;
// The first read of a worker that just started, offline, at the world's clock.
async function firstRead(name: string, k: EnvKind = {}) {
  const r = await envReader(name, { ...k, offline: true }), st = r.status(), n = await r.name("alice");
  await r.close();
  return { status: codesOf(st), read: codesOf(n), verified: n.verified };
}
async function filled(name: string, k: EnvKind = {}) {
  const r = await envReader(name, k);
  let s = await r.advance({ budgetMs: 120_000 });
  for (let i = 0; i < 5 && !s.verified; i++) s = await r.advance({ budgetMs: 120_000 });
  return { r, verified: s.verified };
}
// Drives a verified reader to hold one denial at the end of an advance: what it answered, and whether a view was kept.
const denials: Record<string, (name: string) => Promise<{ codes: string[]; filled: boolean }>> = {
  TIP_BEHIND_PEER: async (n) => { const f = await filled(n); env.ahead = true; const s = await f.r.advance(); await f.r.close(); return { codes: codesOf(s), filled: f.verified }; },
  RULES_DIFFER: async (n) => { const f = await filled(n); env.rules = { ...gatesOf(core), V99_HEIGHT: ACT + 10 }; const s = await f.r.advance(); await f.r.close(); return { codes: codesOf(s), filled: f.verified }; },
  NOT_WITNESSED: async (n) => { const f = await filled(n); env.wit = "other"; const s = await f.r.advance(); await f.r.close(); return { codes: codesOf(s), filled: f.verified }; },
  WITNESS_SILENT: async (n) => { const f = await filled(n); env.wit = "offline"; env.now += 31 * MIN; const s = await f.r.advance(); await f.r.close(); env.now -= 31 * MIN; return { codes: codesOf(s), filled: f.verified }; },
  TIP_STALE: async (n) => { const f = await filled(n); env.tipAge = 31 * MIN; const s = await f.r.advance(); await f.r.close(); env.tipAge = 0; return { codes: codesOf(s), filled: f.verified }; },
  BEHIND: async (n) => { const f = await filled(n); env.lead = 200; const s = await f.r.advance(); await f.r.close(); env.lead = 0; return { codes: codesOf(s), filled: f.verified }; },
  BRANCH_UNRESOLVED: async (n) => { const f = await filled(n); env.top -= 5; const s = await f.r.advance(); await f.r.close(); env.top += 5; return { codes: codesOf(s), filled: f.verified }; },
  // A start whose view the clock refuses, offline: no tip, NOT_SYNCED; at the earlier clock that view would have restored.
  NOT_SYNCED: async (n) => {
    const f = await filled(n); await f.r.close();
    env.now += 31 * MIN; const r = await envReader(n, { offline: true }), s = await r.advance(); await r.close(); env.now -= 31 * MIN;
    return { codes: codesOf(s), filled: f.verified };
  },
  // A browser start: the slot emptied, the store reset, its refill's first step.
  STORE_UNCONFIRMED: async (n) => {
    const f = await filled(n); await f.r.close(); await chrome.storage.session.remove(slotKey(n));
    env.lead = 200; const r = await envReader(n), s = await r.advance(); await r.close(); env.lead = 0;
    return { codes: codesOf(s), filled: f.verified };
  },
  // The same pin with a wrong state hash: the store is the same basis and its view restores, then the bind refuses it.
  PIN_MISMATCH: async (n) => {
    const p = pinAt(30_450), f = await filled(n, { pin: p }); await f.r.close();
    const r = await envReader(n, { pin: pinAt(30_450, { stateHash: `0x${"ab".repeat(32)}` }) }), s = await r.advance(); await r.close();
    return { codes: codesOf(s), filled: f.verified };
  },
  LEVEL_FEED: async (n) => { const r = await envReader(n, { feed: true }), s = await r.advance(); await r.close(); return { codes: codesOf(s), filled: true }; },
};

const cmds: Record<string, (a: Args) => Promise<unknown>> = {
  async denyKeep(a) { resetEnv(); const name = fresh(`deny-${a.code!.toString().toLowerCase().replaceAll("_", "-")}`), d = await denials[String(a.code)]!(name);
    return { name, ...d, held: await heldIn(name), now: env.now }; },
  // After a worker stop: the first read with the view the slot holds, and with it removed (a fresh reader).
  async afterWake(a) {
    env.now = Number(a.now); env.top = TOP; env.lead = 0; env.tipAge = 0; env.wit = "online"; env.ahead = false; env.rules = null;
    const k: EnvKind = a.code === "PIN_MISMATCH" ? { pin: pinAt(30_450) } : a.code === "LEVEL_FEED" ? { feed: true } : {};
    const restored = await firstRead(String(a.name), k), key = slotKey(String(a.name)), v = (await chrome.storage.session.get(key))[key] as string | undefined;
    if (v !== undefined) await chrome.storage.session.set({ [key]: JSON.stringify({ hashes: JSON.parse(v).hashes }) });
    return { restored, fresh: await firstRead(String(a.name), k), origin: performance.timeOrigin };
  },
  // The honest path across a stop, in this world: verified at the keep.
  async keepHonest(a) { resetEnv(); const f = await filled(String(a.name)); await f.r.close(); return { filled: f.verified, held: await heldIn(String(a.name)), now: env.now }; },
  // A clock set back by `back` ms (or on by `on`), after a verified keep; the first read then.
  async clockCase(a) { env.now = Number(a.now) - Number(a.back ?? 0) + Number(a.on ?? 0); return firstRead(String(a.name)); },
  // The 30-minute rule across a keep and a restore: confirmed at T; at T+29 the witness silent, the source fresh: restored
  // and kept again; at T+31 that reader is WITNESS_SILENT, and a new one restores nothing.
  async ages() {
    resetEnv(); const name = fresh("ages"), T = env.now, f = await filled(name); await f.r.close();
    env.now = T + 29 * MIN; env.wit = "offline";
    const a = await envReader(name), s29 = await a.advance();
    env.now = T + 31 * MIN;
    const s31 = a.status(); await a.close();
    const b = await firstRead(name);
    env.wit = "online"; const key = slotKey(name), v = (await chrome.storage.session.get(key))[key] as string;
    await chrome.storage.session.set({ [key]: JSON.stringify({ hashes: JSON.parse(v).hashes }) });
    return { filled: f.verified, at29: codesOf(s29), at31: codesOf(s31), restarted31: b, fresh31: await firstRead(name) };
  },
  // The pin moved in the session, the store kept by the newer-pin rule: before the new pin's bind nothing is restored.
  async pinMoved() {
    resetEnv(); const name = fresh("pin-moved"), f = await filled(name, { pin: pinAt(30_450) }); await f.r.close();
    const r = await envReader(name, { pin: pinAt(30_900) }), before = r.status(), offline = await firstRead(name, { pin: pinAt(30_900) });
    const s = await r.advance(); await r.close();
    return { filled: f.verified, before: codesOf(before), firstRead: offline, after: codesOf(s), verifiedAfter: s.verified };
  },
  // A slot that throws on every write that carries a view: the advances go on, the listeners are told, reads stay
  // verified, the error is on status(), and a later start restores nothing.
  async slotThrows() {
    resetEnv(); const name = fresh("slot-throws"), inner = sessionSlot(slotKey(name));
    const slot: TrustedSlot = { get: () => inner.get(), async set(v) { if (v.includes('"held"')) throw new Error("the session area refused the write"); await inner.set(v); } };
    const r = await envReader(name, { slot });
    let told = 0, rejected = 0, last = null as null | { verified: boolean; keepError: string | null };
    r.subscribe(() => { told++; });
    for (let i = 0; i < 3; i++) { try { const s = await r.advance({ budgetMs: 120_000 }); last = { verified: s.verified, keepError: s.keepError }; } catch { rejected++; } }
    const n = await r.name("alice");
    await r.close();
    return { told, rejected, last, read: n.verified, held: await heldIn(name), later: await firstRead(name) };
  },
  // The store's own keep: it writes nothing while the slot does not name the stored record alone.
  async keepSlotCheck() {
    const name = fresh("keep-check"), s = idbStore({ name, slot: sessionSlot(slotKey(name)) }), r1 = row(30_001, null), other = JSON.stringify({ hashes: [`0x${"ee".repeat(32)}`] });
    await s.open(key(FEED)); await s.commit(commit(null, [r1], at(30_010)));
    await chrome.storage.session.set({ [slotKey(name)]: other });
    await s.keep!({ at: Date.now(), tip: { height: 30_010, hash: at(30_010).hash, time: Math.floor(Date.now() / 1000) }, witnessed: null });
    const kept = (await chrome.storage.session.get(slotKey(name)))[slotKey(name)] === other;
    s.close();
    return { kept };
  },
  // A boundary whose null state hash is changed to NaN or Infinity in the profile: the chain cannot see it; the form can.
  async boundaryForm() {
    const out: Record<string, string> = {};
    for (const bad of ["NaN", "Infinity"]) {
      const name = fresh(`form-${bad.toLowerCase()}`), s = idbStore({ name, slot: sessionSlot(slotKey(name)) }), r1 = row(30_001, null);
      const b0: Boundary = { height: 30_000, hash: at(30_000).hash, eventsHash: r1.eventsHash, rowsHash: r1.rowsHash, stateHash: null };
      await s.open(key(FEED)); await s.commit(commit(null, [r1], at(30_040), { boundaries: [b0] })); s.close();
      const db = await raw(name);
      await put(db, [["bounds", { ...b0, stateHash: bad === "NaN" ? Number.NaN : Number.POSITIVE_INFINITY }, b0.height]]);
      db.close();
      const t = idbStore({ name, slot: sessionSlot(slotKey(name)) });
      out[bad] = await reasonOf(t); t.close();
    }
    return out;
  },
  async suite() {
    const checks = await storeSuite(() => { const name = fresh("suite"); return idbStore({ name, slot: sessionSlot(slotKey(name)) }); });
    return { total: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) };
  },
  async refusals() {
    const name = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return (e as Error).name; } };
    return { badName: name(() => idbStore({ name: "Wallet Store", slot: sessionSlot("x") })), noSlot: name(() => idbStore({ name: "w" } as never)),
      emptyKey: name(() => sessionSlot("")) };
  },
  state: (a) => state(a.name!, a.top),
  // The production call shape: open() over idbStore and sessionSlot; verified, and how the store opened.
  async reader(a) {
    const opens: string[] = [];
    const r = await open({ source: source(TOP), store: watched(idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }), opens, []) });
    const s = await r.advance({ budgetMs: 120_000 });
    await r.close();
    return { verified: s.verified, why: s.why.map((w) => w.code), cursor: s.cursor?.height ?? null, opens, origin: performance.timeOrigin };
  },
  // A fill whose `nth` commit stops at `point`: it answers once the point is reached and never finishes there.
  async fillHeld(a) {
    let commits = 0;
    const got = new Promise<string>((res) => { reached = res; });
    const store = idbStoreWith({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }, {
      // "issued" is not awaited (the transaction would commit), so that commit is held at its next point instead: the
      // fill stops there and the worker is stopped with the transaction in flight or just landed, never a later commit.
      point(p) {
        if (commits === a.nth && a.point === "issued" && p === "slot new") return never;
        if (commits !== a.nth || p !== a.point) return undefined;
        reached?.(p);
        return p === "issued" ? undefined : never;
      },
    });
    const counted: Store = { ...store, rows: (h) => store.rows(h), commit(c) { commits++; return store.commit(c); } };
    const loop = replicaLoop({ source: source(TOP), store: counted, resetRefused: true });
    void loop.open().then(() => loop.advance({ budgetMs: 120_000 }));
    return { reached: await Promise.race([got, new Promise((res) => setTimeout(() => res(null), 30_000))]) };
  },
  async fillAsync(a) {
    const loop = replicaLoop({ source: source(TOP), store: idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }), resetRefused: true });
    void loop.open().then(() => loop.advance({ budgetMs: 120_000 }));
    return { started: true };
  },
  async emptySlot(a) { await chrome.storage.session.remove(slotKey(a.name!)); return { emptied: true }; },
  // A consistent forgery, as a program writing the profile makes it: a Propose added to the last row and every running
  // value after it recomputed (the rows, the meta, the boundaries at or above it, the chain, the record). With
  // `slotToo`, the slot is made to name the forged record, as if check (2) were not made.
  async forge(a) {
    const db = await raw(a.name!), rows = await all<BlockRow>(db, "rows"), bounds = await all<Boundary>(db, "bounds");
    const record = await one<{ meta: { eventCount: number; eventsHash: string; rowsHash: string } }>(db, "meta", "meta"), last = rows.at(-1)!, below = rows.at(-2);
    last.events.push(f.prop({ v: 1, t: "nrenew", name: "forged" }, { proposer: `0x${"f1".repeat(20)}`, height: last.height, pos: 9, id: `0x${"f".repeat(64)}` }));
    const eventsHash = eventsHashStep(below!.eventsHash, last.height, last.events), rowsHash = rowsHashStep(below!.rowsHash, last);
    Object.assign(last, { eventsHash, rowsHash });
    let chain = BOUNDS_HASH_START;
    for (const b of bounds) { if (b.height >= last.height) Object.assign(b, { eventsHash, rowsHash }); chain = boundsHashStep(chain, b); }
    const forged = { ...record, meta: { ...record.meta, eventsHash, rowsHash, eventCount: record.meta.eventCount + 1 }, boundsHash: chain };
    await put(db, [["rows", last, last.height], ["meta", forged, "meta"], ...bounds.map((b): [string, unknown, IDBValidKey] => ["bounds", b, b.height])]);
    db.close();
    if (a.slotToo === true) await chrome.storage.session.set({ [slotKey(a.name!)]: JSON.stringify({ hashes: [payloadHash(forged)] }) });
    return { forgedAt: last.height };
  },
  // The view a reader keeps: online until verified (under a caller root with its witness), then closed.
  async fillView(a) {
    const r = await viewReader(a.name!, { caller: true, dense: Number(a.dense ?? 1) });
    let s = await r.advance({ budgetMs: 120_000 });
    for (let i = 0; i < 5 && !s.verified; i++) s = await r.advance({ budgetMs: 120_000 });
    await r.close();
    return { verified: s.verified, why: codesOf(s), cursor: s.cursor?.height ?? null, slotBytes: await (chrome.storage.session as unknown as { getBytesInUse(k: string): Promise<number> }).getBytesInUse(slotKey(a.name!)) };
  },
  // A worker's first read, offline (every step and witness refused): from the worker's start and from the open.
  async readView(a) {
    calls.next = 0; calls.tip = 0;
    const t0 = performance.now(), r = await viewReader(a.name!, { caller: true, offline: true }), t1 = performance.now();
    const n = await r.name("alice"), t2 = performance.now();
    await r.close();
    return { verified: n.verified, why: codesOf(n), sinceStart: t2, openMs: t1 - t0, readMs: t2 - t1, nextCalls: calls.next, tipCalls: calls.tip, origin: performance.timeOrigin };
  },
  // Each binding of a kept view broken alone: the reader answers as one with no view does (`fresh`), offline.
  async bindings() {
    const out: Record<string, unknown> = {};
    const other = `0x${"cd".repeat(32)}`, old = 31 * 60;
    const cases: Record<string, (held: { record: string; tip: { height: number; hash: string; time: number }; witnessed: { height: number; hash: string; by: string; at: number; tip: string } }) => void> = {
      honest: () => undefined,
      record: (v) => { v.record = other; },
      tipAbove: (v) => { v.tip.height += 5; },
      tipBlock: (v) => { v.tip.hash = other; v.witnessed.tip = other; },   // the confirmation moved with it: only the block binds
      tipOld: (v) => { v.tip.time -= old; },
      witBlock: (v) => { v.witnessed.hash = other; },
      witOld: (v) => { v.witnessed.at -= old * 1000; },
      witBy: (v) => { v.witnessed.by = "w2"; },
      witTip: (v) => { v.witnessed.tip = other; },
    };
    for (const [c, mutate] of Object.entries(cases)) {
      const name = fresh(`bind-${c.toLowerCase()}`), filled = await cmds.fillView!({ name }) as { verified: boolean };
      const key = slotKey(name), slot = JSON.parse((await chrome.storage.session.get(key))[key] as string);
      mutate(slot.held);
      await chrome.storage.session.set({ [key]: JSON.stringify(slot) });
      const restored = await cmds.readView!({ name }) as { verified: boolean; why: string[] };
      await chrome.storage.session.set({ [key]: JSON.stringify({ hashes: slot.hashes }) });
      const freshRead = await cmds.readView!({ name }) as { verified: boolean; why: string[] };
      out[c] = { filled: filled.verified, restored: restored.why, verified: restored.verified, fresh: freshRead.why };
    }
    return out;
  },
  // A browser start: the slot empty, the store reset and refilled; STORE_UNCONFIRMED until the refill reaches the tip.
  async unconfirmedRefill(a) {
    await state(a.name!);
    await chrome.storage.session.remove(slotKey(a.name!));
    const r = await open({ source: source(TOP), store: idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }) });
    const during = r.status(), firstStep = await r.advance({ budgetMs: 1 });
    let s = firstStep;
    for (let i = 0; i < 50 && !s.verified; i++) s = await r.advance({ budgetMs: 120_000 });
    await r.close();
    return { during: codesOf(during), firstStep: codesOf(firstStep), after: codesOf(s), verified: s.verified, cursor: s.cursor?.height ?? null };
  },
  // A loop that keeps the store open, so it holds the lock, until the worker stops.
  async hold(a) {
    const loop = replicaLoop({ source: source(TOP), store: idbStore({ name: a.name!, slot: sessionSlot(slotKey(a.name!)) }), resetRefused: true });
    return { open: await loop.open() };
  },
  // A stolen lock (the package never steals one; a caller could). Each case holds a commit of store A at a point, steals
  // A's lock, lets store B take the store, then lets A go on.
  async steal() {
    const out: Record<string, unknown> = {};
    const make = (name: string) => idbStore({ name, slot: sessionSlot(slotKey(name)) });
    const steal = (name: string) => navigator.locks.request(`cairnx-replica:${name}`, { steal: true }, async () => undefined);
    const r1 = row(30_001, null), r2 = row(30_050, r1), r3 = row(30_100, r2);
    // Store A whose `nth` commit waits at `point` until released.
    function held(name: string, point: string, nth: number) {
      let count = 0, go = () => undefined as void, hit = () => undefined as void;
      const gate = new Promise<void>((r) => { go = r; }), reached = new Promise<void>((r) => { hit = r; });
      const store = idbStoreWith({ name, slot: sessionSlot(slotKey(name)) }, {
        point(p) { if (p === "slot pair") count++; if (count !== nth || p !== point) return undefined; hit(); return gate; } });
      return { store, reached, go };
    }
    const snapshot = async (name: string) => { const db = await raw(name), v = { record: await one(db, "meta", "meta"), rows: await all<BlockRow>(db, "rows") }; db.close(); return v; };
    const putBack = async (name: string, v: { record: unknown; rows: BlockRow[] }) => {
      const db = await raw(name);
      await put(db, [["meta", v.record, "meta"], ...v.rows.map((r): [string, unknown, IDBValidKey] => ["rows", r, r.height])], ["rows", "meta"]);
      db.close();
    };

    // The review's sequence: A's 2nd commit lands and waits before its last slot write; the lock is stolen and released;
    // B opens, commits and confirms; A goes on.
    let n = fresh("steal-last"), a = held(n, "slot new", 2);
    await a.store.open(key(FEED));
    await a.store.commit(commit(null, [r1], at(30_010)));
    let pending = a.store.commit(commit(at(30_010), [r2], at(30_060)));
    await a.reached;
    await steal(n);
    let b = make(n);
    const bOpen = await reasonOf(b), older = await snapshot(n), bCommit = await b.commit(commit(at(30_060), [r3], at(30_110)));
    a.go();
    const aCommit = await pending;
    b.close();
    const reopened = await reasonOf(b = make(n));
    b.close();
    await putBack(n, older);
    out.last = { bOpen, bCommit: bCommit.ok, aCommit: aCommit.ok ? "ok" : aCommit.code, reopened, older: await reasonOf(b = make(n)),
      aOpen: await reasonOf(a.store), aAgain: (await a.store.commit(commit(at(30_110), [], at(30_120)))).ok };
    b.close();

    // Stolen before the slot's first write: A must not write its pair over B's confirmation.
    n = fresh("steal-first"); a = held(n, "slot pair", 2);
    await a.store.open(key(FEED));
    await a.store.commit(commit(null, [r1], at(30_010)));
    pending = a.store.commit(commit(at(30_010), [r2], at(30_060)));
    await a.reached;
    await steal(n);
    b = make(n);
    const bOpen2 = await reasonOf(b), bCommit2 = await b.commit(commit(at(30_010), [row(30_040, r1, "b")], at(30_045)));
    a.go();
    const aCommit2 = await pending;
    b.close();
    out.first = { bOpen: bOpen2, bCommit: bCommit2.ok, aCommit: aCommit2.ok ? "ok" : aCommit2.code, reopened: await reasonOf(b = make(n)) };
    b.close();

    // No steal: the slot changed under A before its last write. A leaves the other value as it is.
    n = fresh("slot-changed"); a = held(n, "slot new", 1);
    await a.store.open(key(FEED));
    pending = a.store.commit(commit(null, [r1], at(30_010)));
    await a.reached;
    const other = JSON.stringify([`0x${"ee".repeat(32)}`]);
    await chrome.storage.session.set({ [slotKey(n)]: other });
    a.go();
    const aCommit3 = await pending;
    out.changed = { aCommit: aCommit3.ok ? "ok" : aCommit3.code, slotKept: (await chrome.storage.session.get(slotKey(n)))[slotKey(n)] === other };
    a.store.close();

    // Stolen past the commit's last check before its transaction: the transaction itself refuses, nothing is written.
    n = fresh("steal-write"); a = held(n, "write", 2);
    await a.store.open(key(FEED));
    await a.store.commit(commit(null, [r1], at(30_010)));
    pending = a.store.commit(commit(at(30_010), [r2], at(30_060)));
    await a.reached;
    await steal(n);
    a.go();
    const aCommit4 = await pending, db = await raw(n), rec = await one<{ meta: { cursor: { height: number } } }>(db, "meta", "meta");
    db.close();
    out.write = { aCommit: aCommit4.ok ? "ok" : aCommit4.code, storedCursor: rec.meta.cursor.height };
    return out;
  },
  // The store-level cases, each on a store of its own.
  async cases() {
    const out: Record<string, unknown> = {};
    const make = (name: string) => idbStore({ name, slot: sessionSlot(slotKey(name)) });
    const r1 = row(30_001, null), r2 = row(30_050, r1), b0: Boundary = { height: 30_000, hash: at(30_000).hash, eventsHash: r1.eventsHash, rowsHash: r1.rowsHash, stateHash: null };

    let n = fresh("older"), s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_010)));
    let db = await raw(n);
    const before = { record: await one(db, "meta", "meta"), rows: await all<BlockRow>(db, "rows") };
    db.close();
    const second = await s.commit(commit(at(30_010), [r2], at(30_060)));
    s.close();
    db = await raw(n);
    await put(db, [["meta", before.record, "meta"], ...before.rows.map((r): [string, unknown, IDBValidKey] => ["rows", r, r.height])], ["rows", "meta"]);
    db.close();
    out.olderCopy = { secondCommit: second.ok, reopened: await reasonOf(make(n)) };

    n = fresh("bound"); s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_040), { boundaries: [b0] }));
    s.close();
    out.boundOpensFirst = await reasonOf(s = make(n));
    s.close();
    db = await raw(n);
    await put(db, [["bounds", { ...b0, stateHash: `0x${"cd".repeat(32)}` }, b0.height]]);
    db.close();
    out.boundEdited = await reasonOf(s = make(n));
    s.close();

    n = fresh("deleted"); s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_010)));
    await new Promise<void>((res, rej) => { const q = indexedDB.deleteDatabase(`cairnx-replica:${n}`); q.onsuccess = () => res(); q.onerror = () => rej(q.error); });
    const afterDelete = await s.commit(commit(at(30_010), [r2], at(30_060)));
    out.deleted = { commit: afterDelete.ok ? "ok" : afterDelete.code, reopened: await reasonOf(s) };
    s.close();

    n = fresh("two"); s = make(n);
    const t = make(n), first = await reasonOf(s), held = await reasonOf(t);
    s.close();
    out.twoStores = { first, second: held, afterClose: await reasonOf(t) };
    t.close();

    n = fresh("newer");
    await new Promise<void>((res) => { const q = indexedDB.open(`cairnx-replica:${n}`, 2); q.onupgradeneeded = () => q.result.createObjectStore("later"); q.onsuccess = () => { q.result.close(); res(); }; });
    s = make(n);
    const newer = await reasonOf(s);
    await s.reset();
    out.newer = { open: newer, afterReset: await reasonOf(s) };
    s.close();

    n = fresh("garbage"); s = make(n);
    await s.open(key(FEED));
    await s.commit(commit(null, [r1], at(30_010)));
    s.close();
    await chrome.storage.session.set({ [slotKey(n)]: "not a list" });
    out.slotOutOfForm = await reasonOf(s = make(n));
    s.close();
    return out;
  },
};

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  const run = m?.cmd === undefined ? undefined : cmds[m.cmd];
  if (run === undefined) return false;
  run(m.args ?? {}).then(reply, (e: unknown) => reply({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
  return true;
});
