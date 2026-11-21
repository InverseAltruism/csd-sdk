// The replay's check mode over the seal's inputs: the case files, the replay corpus at every pinned and event height,
// the resolve cases of codes.json, the fuzz sequences of the files named on the command line, the growth streams at
// full size and the sweep streams. Every indexed read is compared with the plain walk and each expiry checked to land
// at the first height it is due; the index invariants are asserted after every event, or every 64th event on a stream
// of more than 1,000 events. Run by scripts/seal-differential.mjs step 4(g):
//   tsx test/support/check-replay.ts <fuzz.json> [<more fuzz.json> ...]
import { readFileSync } from "node:fs";
import { fullGrowthStreams } from "../../../../conformance/growth-streams.mjs";
import { parseNumbers, sweepStreams } from "../../../../conformance/sweep-streams.mjs";
import * as R from "../../src/index.js";
import { replay } from "../../src/resolve.js";
import type { ChainEvent } from "../../src/index.js";

const VEC = new URL("../vectors/", import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(new URL(f, VEC), "utf8"));
let inputs = 0, events = 0;
const run = (name: string, evs: ChainEvent[], tip: number) => {
  try {
    const checked = replay(evs, tip, { check: true, checkEvery: evs.length > 1_000 ? 64 : 1 });
    if (JSON.stringify(checked) !== JSON.stringify(R.resolve(evs, tip))) throw new Error("check mode's result differs from resolve()");
  } catch (e) {
    console.error(`CHECK FAILED ${name}: ${(e as Error).message}`);
    process.exit(1);
  }
  inputs++; events += evs.length;
};

for (const f of ["cases.json", "cases-rules.json", "cases-v29.json", "cases-convention.json"]) for (const c of read(f).cases) run(`${f}:${c.name}`, c.events, c.tipHeight);
const corpus = read("replay-corpus.json"), pins = Object.keys(read("replay-hashes.json").hashes).map(Number);
const byHeight = [...corpus.events].sort((a: ChainEvent, b: ChainEvent) => a.height - b.height);
let upto = 0;
for (const h of [...new Set([...pins, ...corpus.events.map((e: ChainEvent) => e.height)])].sort((a, b) => a - b)) {
  while (upto < byHeight.length && byHeight[upto].height <= h) upto++;
  run(`corpus@${h}`, byHeight.slice(0, upto), h);
}
for (const c of read("codes.json").resolve) run(`codes.json:${c.name}`, c.events, c.tipHeight);
const fuzzFiles = process.argv.slice(2);
if (!fuzzFiles.length) { console.error("usage: check-replay.ts <fuzz.json> [<more fuzz.json> ...]"); process.exit(2); }
let threw = 0;
for (const [f, file] of fuzzFiles.entries()) {
  const seqs = parseNumbers(readFileSync(file, "utf8")) as { events: ChainEvent[]; tipHeight: number }[];
  seqs.forEach((s, i) => {
    let plain: unknown = null;
    try { R.resolve(s.events, s.tipHeight); } catch (e) { plain = e; }
    if (plain !== null) { threw++; return; }                       // a sequence resolve() refuses is the seal's step (d)
    run(`fuzz${f}#${i}`, s.events, s.tipHeight);
  });
}
for (const s of fullGrowthStreams(R)) for (const tip of [s.tipHeight, ...s.tips]) run(`${s.key} ${s.label}@${tip}`, s.events, tip);
for (const s of sweepStreams(R)) run(`sweep ${s.key}@${s.tipHeight}`, s.events, s.tipHeight);
console.log(`check mode clean on ${inputs} inputs (${events} events)${threw ? `; ${threw} fuzz sequences that resolve() itself throws on were skipped` : ""}`);
