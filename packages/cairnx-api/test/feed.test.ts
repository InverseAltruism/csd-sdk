// The `events` feed. It is the applied log: every entry once, in (height, pos) order, though the log array is in apply
// order (the corpus log has one inversion, at height 44,682, where a claim at pos 2 is logged before the deferred
// cancel at pos 1). A page never ends between two entries of one key: below V29 a repeated event is logged twice at
// one (height, pos), and a cursor naming that key would skip the second. The feed at height h equals the tip feed
// cut at h (no handler of the replay reads the tip), on the corpus at every pinned height of replay-hashes.json, on
// the cross-language fuzzer's sequences and on the growth streams.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@inversealtruism/cairnx-core";
import { V29_HEIGHT, resolve, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";
import { growthStreams, resolverAt } from "../../../conformance/growth-streams.mjs";
import { deepFreeze } from "../src/freeze.js";
import { answer, prepareView, type View } from "../src/handlers/index.js";
import type { EventRow, Page } from "../src/index.js";
import { done, ok, show } from "./check.js";
import { eventRow as row, events, feedOrder as ordered, state, stateAt, tipHeight } from "./corpus.js";

const H = `0x${"ab".repeat(32)}`;
const viewOf = (s: CairnXState, input = "feed") => prepareView(deepFreeze(structuredClone(s)), { height: s.tipHeight, hash: H, input, core: "0.2.7" });
/** A pinned walk of `events` at `limit`: its pages' rows. */
function pages(view: View, limit: number, query = ""): EventRow[][] {
  const out: EventRow[][] = [];
  let next: string | null = null, at = "";
  do {
    const q = [query, `limit=${limit}`, at, next === null ? "" : `after=${next}`].filter(Boolean).join("&");
    const body = answer([view], "events", q).body as Page<EventRow>;
    if (!body.ok) throw new Error(`events?${q}: ${show(body)}`);
    out.push(body.rows);
    at = `at=${body.at.height}:${body.at.hash}:${body.at.rev}`;
    next = body.next;
  } while (next !== null && out.length <= 100_000);
  return out;
}
const feed = (view: View, limit = 500) => pages(view, limit).flat();
const key = (r: EventRow) => `${r.height}:${r.pos}`;
/** Page boundaries where the last row of a page and the first of the next share a key. */
const splits = (ps: EventRow[][]) => ps.slice(1).filter((p, i) => p.length > 0 && ps[i]!.length > 0 && key(p[0]!) === key(ps[i]!.at(-1)!)).length;
const LIMITS = [1, 2, 7, 100, 200, 500];

console.log("the feed is the log:");
const log = state.events;
const tip = viewOf(state, "corpus");
const inversions = log.flatMap((e, i) => (i > 0 && (e.height < log[i - 1]!.height || (e.height === log[i - 1]!.height && e.pos < log[i - 1]!.pos)) ? [e] : []));
ok("the corpus log has exactly one inversion, at height 44,682 (pos 2 logged before pos 1)",
  inversions.length === 1 && inversions[0]!.height === 44682 && inversions[0]!.pos === 1);
for (const limit of LIMITS) {
  const ps = pages(tip, limit), got = ps.flat();
  const counts = new Map<string, number>();
  for (const r of got) counts.set(show(r), (counts.get(show(r)) ?? 0) + 1);
  const once = log.length === got.length && log.every((e) => counts.get(show(row(e))) === 1);
  const ascending = got.every((r, i) => i === 0 || r.height > got[i - 1]!.height || (r.height === got[i - 1]!.height && r.pos > got[i - 1]!.pos));
  const at44682 = got.filter((r) => r.height === 44682).map((r) => r.pos);
  ok(`limit ${limit}: ${ps.length} pages hold each of the ${log.length} log entries once, (height, pos) strictly ascending, 44,682 as pos ${at44682.join(", ")}`,
    once && ascending && show(at44682) === show([...at44682].sort((a, b) => a - b)) && at44682.length >= 2 && show(got) === show(ordered(log)));
}

console.log("a repeated key is never split:");
// Three corpus records below V29 fed twice and one fed three times: the replay applies each copy and logs it again
// at the same (height, pos).
const fed = events.filter((e) => e.height < V29_HEIGHT && e.height > 30000).filter((_, i) => i % 97 === 5).slice(0, 4);
const dup: ChainEvent[] = [...events, ...fed, fed[0]!];
const dupState = JSON.parse(JSON.stringify(resolve(dup, tipHeight))) as CairnXState;
const dupView = viewOf(dupState, "dup");
const runs = new Map<string, number>();
for (const r of dupState.events) runs.set(`${r.height}:${r.pos}`, (runs.get(`${r.height}:${r.pos}`) ?? 0) + 1);
const repeated = [...runs.values()].filter((n) => n > 1);
ok(`the doubled feed logs ${repeated.length} repeated keys, one of them 3 times`, repeated.length === fed.length && repeated.includes(3) && dupState.events.length === log.length + repeated.reduce((a, n) => a + n - 1, 0));
for (const limit of LIMITS) {
  const ps = pages(dupView, limit), got = ps.flat();
  ok(`limit ${limit}: ${ps.length} pages concatenate to the ${dupState.events.length} entries in order, no key split across pages`,
    show(got) === show(ordered(dupState.events)) && splits(ps) === 0 && (limit > 3 || ps.some((p) => p.length > limit)));
}
const fedId = core.eventId(fed[0]!);
const byKeys = answer([dupView], "events", `keys=${fedId},${core.eventId(fed[1]!)}`).body as Page<EventRow>;
ok("keys returns every entry of a repeated transaction id (3 and 2), in feed order, total their count",
  byKeys.rows.length === 5 && byKeys.total === 5 && byKeys.rows.filter((r) => r.txid === fedId).length === 3 && show(byKeys.rows) === show(ordered(dupState.events).filter((r) => r.txid === fedId || r.txid === core.eventId(fed[1]!))));
const one = answer([tip], "events", `keys=${log[0]!.id}`).body as Page<EventRow>;
ok("keys of a transaction logged once returns its one entry", one.rows.length === 1 && show(one.rows[0]) === show(row(log[0]!)) && one.total === 1);

console.log("the prefix property:");
const pinned = Object.keys((JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..", "test/vectors/replay-hashes.json"), "utf8")) as { hashes: Record<string, string> }).hashes)
  .map(Number).filter((h) => h <= tipHeight).sort((a, b) => a - b);
const tipFeed = feed(tip);
const cut = (rows: EventRow[], h: number) => rows.filter((r) => r.height <= h);
const pinnedBad = pinned.filter((h) => show(feed(viewOf(stateAt(h), `h${h}`))) !== show(cut(tipFeed, h)));
ok(`at each of the ${pinned.length} pinned heights (${pinned[0]} to ${pinned.at(-1)}) the feed equals the tip feed cut there`, pinned.length >= 21 && pinnedBad.length === 0, show(pinnedBad));
ok("the cuts are proper and reach the inversion: entries above every pinned height below the tip, 44,682 between two of them",
  pinned.filter((h) => h < tipHeight).every((h) => cut(tipFeed, h).length < tipFeed.length) && pinned.some((h) => h < 44682) && pinned.some((h) => h > 44682 && h < tipHeight));

/** Streams whose feed at every height h of `heights` must equal their tip feed cut at h, read at limits 1 and 500. */
function prefixes(label: string, streams: { events: ChainEvent[]; tipHeight: number; heights: number[]; at: (h: number) => CairnXState }[]): void {
  const bad: string[] = [];
  let checked = 0, repeatedKeys = 0;
  for (const [i, s] of streams.entries()) {
    const top = viewOf(s.at(s.tipHeight), `${label}${i}`), ps = pages(top, 1), full = feed(top);
    if (show(ps.flat()) !== show(full) || splits(ps) > 0) bad.push(`${label} ${i}: the walk at limit 1 differs from limit 500 or splits a key`);
    if (new Set(full.map(key)).size < full.length) repeatedKeys++;
    for (const h of s.heights) {
      checked++;
      if (show(feed(viewOf(s.at(h), `${label}${i}@${h}`))) !== show(cut(full, h))) bad.push(`${label} ${i} at ${h}`);
    }
  }
  ok(`${label}: ${streams.length} streams, ${checked} heights, each feed the tip feed cut at its height (${repeatedKeys} streams with a repeated key, walked unsplit)`,
    checked > streams.length && bad.length === 0, bad.slice(0, 3).join("; "));
}

const dir = mkdtempSync(join(tmpdir(), "cairnx-api-feed-"));
try {
  const file = join(dir, "fuzz.json");
  const fuzz = spawnSync(process.execPath, [fileURLToPath(new URL("../../../conformance/fuzz-resolve.mjs", import.meta.url)), "300", "12345", "--emit", file], { encoding: "utf8" });
  if (fuzz.status !== 0) throw new Error(`fuzz-resolve --emit: ${fuzz.stderr}`);
  const seqs = JSON.parse(readFileSync(file, "utf8")) as { events: ChainEvent[]; tipHeight: number }[];
  prefixes("fuzz-resolve 300, seed 12345", seqs.map((s) => ({
    ...s, heights: [...new Set(s.events.map((e) => e.height))].filter((h) => h <= s.tipHeight),
    at: (h: number) => JSON.parse(JSON.stringify(resolve(s.events.filter((e) => e.height <= h), h))) as CairnXState,
  })));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// The edge streams with NaN heights are left out: a NaN height is outside the replay's domain (applyOrder) and has no
// decimal spelling, so no feed can place it. The streams' declaration types the core by its source; this is the same
// module built, whose declared unique symbols tsc does not equate with the source's.
const streams = growthStreams(core as unknown as Parameters<typeof growthStreams>[0], 40);
const grown = streams.filter((s) => s.events.every((e) => Number.isInteger(e.height)));
prefixes(`growth streams at 40 (${streams.length - grown.length} of ${streams.length} left out for NaN heights)`, grown.map((s) => {
  const at = resolverAt(resolve, s), heights = [...new Set(s.events.map((e) => e.height))].sort((a, b) => a - b);
  const sample = heights.filter((_, i) => i % Math.max(1, Math.floor(heights.length / 8)) === 0);
  return { ...s, at: (h: number) => JSON.parse(JSON.stringify(h === s.tipHeight ? at() : at(h))) as CairnXState, heights: [...new Set([...s.tips, ...sample])].filter((h) => h <= s.tipHeight) };
}));

done("cairnx-api feed");
