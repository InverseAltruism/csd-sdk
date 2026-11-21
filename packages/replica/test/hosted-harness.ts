// Our front door (front-door.ts) served from the recorded node answers of 29,815 to 30,300 (two captures by
// scripts/capture-node-blocks.mjs), the tip by default 30,300, for the tests of hostedBlocks.
import { readFileSync } from "node:fs";
import { CAIRNX_EVENT_RULE, EVENTS_HASH_START, type EventRule } from "@inversealtruism/cairnx-core";
import { checkStep, reorgBreak } from "../src/contract.js";
import { hostedBlocks, type HostedBlocksOptions } from "../src/browser.js";
import { memoryStore, replicaLoop, type BlocksSource, type Source, type Step, type Store, type VerifiedHeaders } from "../src/index.js";
import { ROWS_HASH_START } from "../src/rowshash.js";
import { frontDoor, type Hosted } from "./front-door.js";
import { blockAt, cap, type Answers } from "./node-harness.js";

export const BELOW = new URL("./fixtures/node-blocks-29815-29859.json", import.meta.url), belowBytes = readFileSync(BELOW);
export const all: Answers = { ...(JSON.parse(belowBytes.toString("utf8")) as { answers: Answers }).answers, ...cap.answers };
export const ORIGIN = "https://front.example";
export const ANCHOR = { height: 29_859, hash: blockAt(all, 29_859).hash };
export type { Hosted } from "./front-door.js";

export const front = (s: Hosted) => frontDoor(s, cap.to);

/** The loop over hostedBlocks with a memory store. Every step the source emits is checked against the contract's own
 *  functions (checkStep for blocks, reorgBreak for a reorg) and kept with the cursor it was asked from. */
export function driveHosted(s: Hosted, root: HostedBlocksOptions["root"], o: { maxRequests?: number; maxBlocks?: number; store?: Store; rule?: EventRule } = {}) {
  const fr = front(s), inner: BlocksSource = hostedBlocks({ origin: ORIGIN, root, fetch: fr.f }), steps: { step: Step; from: number | null }[] = [], bad: string[] = [];
  const rule = o.rule ?? CAIRNX_EVENT_RULE;
  const source: Source = { ...inner, async next(ctx) {
    const step = await inner.next(ctx), after = ctx.cursor?.height ?? rule.activationHeight - 1;
    steps.push({ step, from: ctx.cursor?.height ?? null });
    const why = step.kind === "reorg" ? reorgBreak(step.to, ctx.cursor, rule.activationHeight - 1, ctx.hashAt)
      : step.kind === "blocks" ? ((c) => (c.ok ? null : c.reason))(checkStep(step, { after, eventsHash: EVENTS_HASH_START, rowsHash: ROWS_HASH_START, sofar: ctx.sofar, rule })) : null;
    if (why !== null) bad.push(why);
    return step;
  } };
  let t = 0;
  const store = o.store ?? memoryStore();
  const loop = replicaLoop({ source, store, rule, clock: () => (t += 1_000), maxBlocks: o.maxBlocks ?? 64, maxRequests: o.maxRequests ?? 50 });
  // The clock moves 1 s a read, so an advance ends after 600 reads of it: a source that never settles fails its check.
  return { fr, inner, loop, steps, bad, store, run: () => loop.advance({ budgetMs: 600_000 }) };
}
export const kinds = (steps: { step: Step }[]) => steps.map((x) => (x.step.kind === "cannot" ? x.step.code : x.step.kind));

/** A caller's verified headers over `answers` from 29,859 up to `tip` (null: the tip unknown), holding only the heights
 *  `holds` accepts (default all), counting its calls. */
export function callerHeaders(c: { answers: Answers; tip: number | null; holds?: (h: number) => boolean }) {
  const n = { syncs: 0, offers: 0 };
  const held = (h: number) => (c.tip !== null && h >= 29_859 && h <= c.tip && (c.holds?.(h) ?? true) ? blockAt(c.answers, h) : null);
  const headers: VerifiedHeaders = {
    floor: 29_859, origin: "https://headers.example",
    async sync(to) { n.syncs++; if (c.tip === null) return null; const b = blockAt(c.answers, Math.min(to ?? c.tip, c.tip)); return { height: b.height, hash: b.hash, time: Number(b.header.time) }; },
    async at(h) { const b = held(h); return b === null ? null : { hash: b.hash, merkle: String(b.header.merkle) }; },
    async offer() { n.offers++; return true; },
  };
  return { c, n, headers };
}
