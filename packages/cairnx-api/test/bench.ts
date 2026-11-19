// Cost of prepareView and of one page of each list, on the corpus state and on its rows replicated 10 and 100 times
// under fresh keys (names, bids, tokens and offers under new keys; each ticker's holders under new addresses; log
// entries at new positions); best of 7 runs, in milliseconds. Not part of `pnpm test`: run `tsx test/bench.ts` after
// the build.
import type { CairnXState } from "@inversealtruism/cairnx-core";
import { answer, prepareView } from "../src/handlers/index.js";
import { state, tipHeight } from "./corpus.js";

const best = (f: () => unknown): number => {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 7; i++) { const t = performance.now(); f(); min = Math.min(min, performance.now() - t); }
  return min;
};
const times = <V>(m: Record<string, V>, k: number, rename: (key: string, i: number) => string, patch: (v: V, key: string) => V): Record<string, V> =>
  Object.fromEntries(Array.from({ length: k }, (_, i) => Object.entries(m).map(([key, v]) => {
    const fresh = i === 0 ? key : rename(key, i);
    return [fresh, patch(v, fresh)];
  })).flat());
/** A fresh hex key of the same length: the copy number in four hex digits, then the key's first digits. */
const hexId = (id: string, i: number) => `0x${i.toString(16).padStart(4, "0")}${id.slice(2, -4)}`;
const POS_STRIDE = 1_000_000;
const owner = Object.values(state.names)[0]!.owner;
const READS: [string, string][] = [["names", "limit=200"], ["names", "order=newest&limit=200"], ["names", "status=held&limit=200"],
  [`names`, `owner=${owner}&limit=200`], ["bids", "limit=200"], ["bids", "status=open&limit=200"], ["tokens", "limit=200"],
  ["events", "limit=500"], ["events", "after=60000:0&limit=500"], ["holders", "ticker=CAIRN&limit=200"], ["offers", "limit=200"],
  ["offers", "kind=name&status=open&limit=200"]];

console.log(`node ${process.version}; rows: names, bids, tokens, offers, holders, log entries; ms, best of 7`);
for (const k of [1, 10, 100]) {
  const s: CairnXState = {
    ...state,
    names: times(state.names, k, (n, i) => `${n}-${i}`, (v, name) => ({ ...v, name })),
    bids: times(state.bids, k, hexId, (v, id) => ({ ...v, id })),
    tokens: times(state.tokens, k, (t, i) => `${t}${i}`, (v, ticker) => ({ ...v, ticker })),
    offers: times(state.offers, k, hexId, (v, id) => ({ ...v, id })),
    balances: Object.fromEntries(Object.entries(state.balances).map(([t, m]) => [t, times(m, k, hexId, (v) => v)])),
    events: Array.from({ length: k }, (_, i) => state.events.map((e) => ({ ...e, id: i === 0 ? e.id : hexId(e.id, i), pos: e.pos + i * POS_STRIDE }))).flat(),
  };
  const src = { height: tipHeight, hash: `0x${"ab".repeat(32)}`, input: `x${k}`, core: "0.2.7" };
  const view = prepareView(s, src);
  const holders = Object.values(s.balances).reduce((n, m) => n + Object.keys(m).length, 0);
  const pages = READS.map(([r, q]) => `${r}?${q.replace(`owner=${owner}`, "owner=<a>")} ${best(() => answer([view], r, q)).toFixed(3)}`);
  console.log(`x${k}: ${Object.keys(s.names).length}, ${Object.keys(s.bids).length}, ${Object.keys(s.tokens).length}, ${Object.keys(s.offers).length}, ${holders}, ${s.events.length} rows; `
    + `prepareView ${best(() => prepareView(s, src)).toFixed(2)}; ${pages.join("; ")}`);
}
