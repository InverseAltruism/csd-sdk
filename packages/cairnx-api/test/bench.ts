// Cost of prepareView and of one page of each list, on the corpus state and on its rows replicated 10 and 100 times
// under fresh keys; best of 7 runs, in milliseconds. Not part of `pnpm test`: run `tsx test/bench.ts` after the build.
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
const owner = Object.values(state.names)[0]!.owner;
const READS: [string, string][] = [["names", "limit=200"], ["names", "order=newest&limit=200"], ["names", "status=held&limit=200"],
  [`names`, `owner=${owner}&limit=200`], ["bids", "limit=200"], ["bids", "status=open&limit=200"], ["tokens", "limit=200"]];

console.log(`node ${process.version}; rows: names, bids, tokens; ms, best of 7`);
for (const k of [1, 10, 100]) {
  const s: CairnXState = {
    ...state,
    names: times(state.names, k, (n, i) => `${n}-${i}`, (v, name) => ({ ...v, name })),
    bids: times(state.bids, k, (id, i) => `0x${i.toString(16).padStart(4, "0")}${id.slice(6)}`, (v, id) => ({ ...v, id })),
    tokens: times(state.tokens, k, (t, i) => `${t}${i}`, (v, ticker) => ({ ...v, ticker })),
  };
  const src = { height: tipHeight, hash: `0x${"ab".repeat(32)}`, input: `x${k}`, core: "0.2.7" };
  const view = prepareView(s, src);
  const pages = READS.map(([r, q]) => `${r}?${q.replace(`owner=${owner}`, "owner=<a>")} ${best(() => answer([view], r, q)).toFixed(3)}`);
  console.log(`x${k}: ${Object.keys(s.names).length}, ${Object.keys(s.bids).length}, ${Object.keys(s.tokens).length} rows; prepareView ${best(() => prepareView(s, src)).toFixed(2)}; ${pages.join("; ")}`);
}
