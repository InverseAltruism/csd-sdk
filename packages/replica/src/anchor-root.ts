// The anchor root of hostedBlocks (design section 2): headers the source verifies itself from a release's anchor,
// workRoot, in a window (window.ts). The window is seeded from the server's /api/headers (the LWMA_WINDOW headers
// ending at the anchor, kept only once they verify) and moves with the pages: each page's headers extend it, and
// the window keeps the store's cursor at or above its `low`. When a page does not link, or the server's tip is
// another block at a held height, the server's headers from `low` up to 256 above the window's tip are read: a
// branch that forks at or above `low` is csd-light's tryReorg (adopted only with more work, else LESS_WORK), and
// the store rolls back to its fork block. A branch that forks lower is verified from workRoot: a fresh window from
// the same seed walks the server's headers to the cursor and on until it has more work than the held window (at the
// server's tip without more work, LESS_WORK, kept until that tip moves), comparing the hash of each held block it
// passes, and is adopted at the highest held block on its chain, where the store rolls back. A store whose cursor
// this source's window holds no header for (a store filled before the source started) is walked the same way to
// the cursor with no work to beat, since the store keeps none (README, "What a store must keep"). Each fork block
// adopted is remembered until the store's cursor is back on the window, so a rollback that was not committed is
// returned again, never repaired by a walk without a work bar. A walk that fails is dropped and starts afresh.
import { LWMA_WINDOW } from "@inversealtruism/csd-codec";
import { headerOf } from "./block-read.js";
import { SourceError } from "./errors.js";
import type { Head } from "./fork.js";
import { twice, type Session } from "./http.js";
import type { Root } from "./roots.js";
import type { Cursor, StepContext, Step, TipView } from "./types.js";
import { HeaderWindow, type HeaderRow } from "./window.js";

const BATCH = 512;
type Walk = { fresh: HeaderWindow; bar: bigint | null; need: number; matched: { at: Cursor; work: bigint } | null; diverged: boolean; refusedAt: string | null };
const rowsOf = (from: number, count: number) => (v: unknown): HeaderRow[] => {
  const rows = (v as { ok?: unknown; headers?: unknown } | null)?.headers;
  if (!Array.isArray(rows) || rows.length !== count) throw new SourceError("SOURCE_MALFORMED", `the headers from ${from} are not ${count} rows`);
  return rows.map((r, i) => headerOf(r, from + i, null));
};
const readRows = (s: Session, from: number, count: number) => twice(s, `/api/headers/${from}/${count}`, rowsOf(from, count));
const lower = (a: Cursor | null, b: Cursor): Cursor => (a !== null && a.height <= b.height ? a : b);
// A walk resumes after a step's budget, a server behind the cursor or a refusal for less work; anything else drops it.
const resumable = (e: unknown) => e instanceof SourceError && ["SOURCE_RATE_LIMITED", "SOURCE_UNAVAILABLE", "LESS_WORK"].includes(e.code);

/** `batch`: the most headers one /api/headers read asks for, the route's cap (a parameter for tests only). */
export function anchorRoot(anchor: Cursor, depth: number, batch = BATCH): Root {
  let w: HeaderWindow | null = null, seed: HeaderRow[] | null = null, walk: Walk | null = null, pending: Cursor | null = null;
  const tipView = (): TipView | null => (w === null ? null : { height: w.tip.height, hash: w.tip.hash.toLowerCase(), time: Number(w.tip.header.time) });
  const reorg = (to: Cursor): Step => ({ kind: "reorg", to, tip: tipView()! });
  // The window never drops the store's cursor, or a fork block still to be rolled back to, below `low`.
  const keepOf = (ctx: StepContext) => Math.min(ctx.cursor?.height ?? ctx.rule.activationHeight - 1, pending?.height ?? Number.POSITIVE_INFINITY);
  const seedOf = (s: Session) => twice(s, `/api/headers/${anchor.height - LWMA_WINDOW + 1}/${LWMA_WINDOW}`, (v) => {
    const rows = rowsOf(anchor.height - LWMA_WINDOW + 1, LWMA_WINDOW)(v);
    HeaderWindow.seed(rows, anchor, depth);
    return rows;
  });

  async function walkOn(s: Session, ctx: StepContext, server: Head, r: Walk): Promise<Step | null> {
    const floor = ctx.rule.activationHeight - 1, f = r.fresh;
    for (let batches = 0; f.tip.height < r.need || (r.bar !== null && !f.outworks(r.bar) && f.tip.height < server.height); batches++) {
      if (f.tip.height >= server.height) throw new SourceError("SOURCE_UNAVAILABLE", `the server's tip ${server.height} is below the cursor ${r.need}`);
      if (batches > 0 && (s.requests() >= ctx.budget.maxRequests || ctx.now() >= ctx.budget.deadlineAt)) {
        throw new SourceError("SOURCE_RATE_LIMITED", `verifying the server's chain from workRoot ${anchor.height} reached ${f.tip.height}; it resumes at the next step`, 0);
      }
      const from = f.tip.height + 1;
      for (const row of await readRows(s, from, Math.min(batch, server.height - from + 1))) {
        if (row.height <= f.tip.height) continue;
        f.extend([row]);
        const held = row.height === floor ? row.hash : ctx.hashAt(row.height);
        if (held !== null && !r.diverged) { if (held === row.hash) r.matched = { at: { height: row.height, hash: row.hash }, work: f.work }; else r.diverged = true; }
      }
    }
    if (r.bar !== null && !f.outworks(r.bar)) {
      r.refusedAt = server.hash;
      throw new SourceError("LESS_WORK", `the server's chain verified from workRoot ${anchor.height} to ${f.tip.height} has no more work than the held one`);
    }
    const m = r.matched ?? { at: anchor, work: 0n }, at = ctx.cursor;
    if (m.at.height >= f.low) f.rewind(m.at.height);
    w = m.at.height >= f.low ? f : m.at.height === anchor.height ? HeaderWindow.seed(seed!, anchor, depth)
      : HeaderWindow.seed(await readRows(s, m.at.height - LWMA_WINDOW + 1, LWMA_WINDOW), m.at, depth, { root: anchor, work: m.work });
    walk = null;
    if (at === null || m.at.height >= at.height) return null;
    pending = lower(pending, m.at);
    return reorg(m.at);
  }
  async function walking(s: Session, ctx: StepContext, server: Head, r: Walk): Promise<Step | null> {
    try { return await walkOn(s, ctx, server, r); } catch (e) { if (!resumable(e)) walk = null; throw e; }
  }
  const walkFrom = (s: Session, ctx: StepContext, server: Head, bar: bigint | null, need: number) => {
    const matched = anchor.height === ctx.rule.activationHeight - 1 ? { at: anchor, work: 0n } : null;
    return walking(s, ctx, server, (walk = { fresh: HeaderWindow.seed(seed!, anchor, depth), bar, need, matched, diverged: false, refusedAt: null }));
  };

  // The server's headers around the window, after a page that does not link: a branch from `low` up, or a walk.
  // A reorg is returned only below the store's cursor; blocks a step bound above a fork are dropped by the step.
  async function fork(s: Session, ctx: StepContext, server: Head, win: HeaderWindow): Promise<Step | null> {
    const top = Math.min(server.height, win.tip.height + 256), rows: HeaderRow[] = [];
    for (let p = win.low; p <= top; p += BATCH) rows.push(...await readRows(s, p, Math.min(BATCH, top - p + 1)));
    const k = rows.findIndex((r) => r.hash !== win.hashAt(r.height)), first = rows[k];
    if (first === undefined) return null;
    if (k === 0) return walkFrom(s, ctx, server, win.work, ctx.cursor?.height ?? ctx.rule.activationHeight - 1);
    if (first.height === win.tip.height + 1 && first.header.prev.toLowerCase() === win.tip.hash) { win.extend(rows.slice(k), keepOf(ctx)); return null; }
    win.branch(rows.slice(k));
    const a = { height: first.height - 1, hash: win.hashAt(first.height - 1)! }, at = ctx.cursor;
    pending = lower(pending, a);
    return at !== null && a.height < at.height ? reorg(a) : null;
  }

  return {
    root: { kind: "anchor", anchor },
    tipView,
    tip: async () => tipView(),
    hashAt: async (height) => w?.hashAt(height) ?? null,
    async begin(s, ctx, server) {
      const floor = ctx.rule.activationHeight - 1, at = ctx.cursor, h = at?.height ?? floor;
      if (anchor.height > floor) throw new SourceError("BELOW_FLOOR", `the anchor ${anchor.height} lies above the activation height less one`);
      seed ??= await seedOf(s);
      const win = (w ??= HeaderWindow.seed(seed, anchor, depth));
      if (walk !== null && walk.refusedAt === server.hash) throw new SourceError("LESS_WORK", `the server's chain still has no more work than the held one at its tip ${server.height}`);
      if (walk !== null && walk.refusedAt === null) return (await walking(s, ctx, server, walk)) ?? { to: server.height };
      walk = null;
      const mine = win.hashAt(h);
      if (mine === null || (at !== null && mine !== at.hash)) {
        if (at !== null && pending !== null && pending.height < at.height) return reorg(pending);
        return (await walkFrom(s, ctx, server, win.tip.height > anchor.height ? win.work : null, h)) ?? { to: server.height };
      }
      pending = null;
      const theirs = win.hashAt(server.height), st = theirs !== null && theirs !== server.hash ? await fork(s, ctx, server, win) : null;
      if (st !== null) return st;
      if (server.height < h) throw new SourceError("SOURCE_UNAVAILABLE", `the server's tip ${server.height} is below the cursor ${h} on the chain the store holds`);
      return { to: server.height };
    },
    async check(s, ctx, server, rows, final) {
      for (let forked = false, i = 0; i < rows.length; i++) {
        const win = w!, r = rows[i]!;
        if (win.hashAt(r.height) === r.hash) continue;
        if (r.height === win.tip.height + 1 && r.header.prev.toLowerCase() === win.tip.hash) {
          try { win.extend(rows.slice(i), keepOf(ctx)); } catch (e) {
            if (!(e instanceof SourceError)) throw e;
            return { verified: win.tip.height - rows[0]!.height + 1, error: e };
          }
          break;
        }
        if (!final) throw new SourceError("BRANCH_MOVED", `the block served at ${r.height} is not on the held chain`);
        if (forked) return { verified: i, error: new SourceError("HEADER_INVALID", `the block served at ${r.height} is not the server's header there`) };
        const st = await fork(s, ctx, server, win);
        if (st !== null) return st;
        forked = true;
        i--;
      }
      return { verified: rows.length, error: null };
    },
  };
}
