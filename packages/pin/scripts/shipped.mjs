// What the package ships, derived from data the repo holds: cairnx-core's committed block fixture (29,860 to
// 117,000) and this package's deltas, each the blocks above the one before that hold an event, with every payload
// transaction of each such block. The build, the package test and the generator all derive the log here, through the
// replica's derivePin.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { derivePin } from "@inversealtruism/cairnx-replica/server";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PIN_FILE = join(ROOT, "pin.json"), DELTAS = join(ROOT, "fixtures");
const DELTA = /^delta-([0-9]+)-([0-9]+)\.json$/;

/** cairnx-core's committed block fixture, found through its resolved entry in the workspace. */
export function baseFixture() {
  const core = join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..");
  return JSON.parse(readFileSync(join(core, "test/fixtures/events-blocks.json"), "utf8"));
}

/** The deltas in `dir`, ascending, each named for the range it holds; throws on a name that does not match its range. */
export function readDeltas(dir = DELTAS) {
  return readdirSync(dir).filter((f) => f.startsWith("delta-")).map((f) => {
    const m = DELTA.exec(f), d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (m === null || d.format !== 1 || d.from !== Number(m[1]) || d.to !== Number(m[2])) throw new Error(`${f} is not named for the range it holds`);
    return d;
  }).sort((a, b) => a.from - b.from);
}

/** One fixture from `base` and the deltas above it; throws unless each starts at the height above the one before. */
export function fixtureOf(base, deltas) {
  let top = base;
  for (const d of deltas) {
    if (d.from !== top.to + 1) throw new Error(`the delta from ${d.from} does not start above ${top.to}`);
    top = d;
  }
  return { format: 1, from: base.from, to: top.to, toHash: top.toHash, blocks: [base, ...deltas].flatMap((f) => f.blocks) };
}

/** The pin and log derived from `base` and `deltas` (default: the committed ones). */
export const derive = (base = baseFixture(), deltas = readDeltas()) => derivePin(fixtureOf(base, deltas));

/** The fields of `want` that `got` does not repeat: every field but `core`, which is information only. */
export function differing(got, want) {
  return ["format", "rule", "height", "blockHash", "logSha256", "eventsHash", "stateHash", "gates"]
    .filter((k) => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
}
