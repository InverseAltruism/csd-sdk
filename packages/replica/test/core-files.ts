// cairnx-core's recorded files that this package's tests read, found through cairnx-core's resolved entry in the
// workspace: the block fixture (29,860 to 117,000), the replay corpus and the hashes pinned over it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ChainEvent } from "@inversealtruism/cairnx-core";
import type { BlockFixture } from "../src/testing.js";

const core = join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..");
const read = (path: string): unknown => JSON.parse(readFileSync(join(core, path), "utf8"));
export const fx = read("test/fixtures/events-blocks.json") as BlockFixture;
export const corpus = read("test/vectors/replay-corpus.json") as { tipHeight: number; events: ChainEvent[] };
type Pinned = { corpus: { heights: Record<string, { eventsHash: string; stateHash: string }> } };
/** Both hashes at each height test/vectors/hashes.json pins over the corpus. */
export const pinned = (read("test/vectors/hashes.json") as Pinned).corpus.heights;
/** cairnx-core's forward-resolution cases (CONVENTION section 35.4): events, a tip and each name's nameView there. */
export const forward = read("test/vectors/forward.json") as {
  cases: { name: string; tipHeight: number; events: ChainEvent[]; asks: { query: string; nameView: unknown }[] }[];
};
