// What the tuple suites share: cairnx-core's block fixture with an empty block at every epoch boundary it lacks (so the
// loop holds a row, and later a boundary, at each), cut or extended to a height; a source over such a fixture whose
// top moves; a stand-in block hash for heights the fixture does not record.
import { createHash } from "node:crypto";
import { EPOCH_LEN } from "@inversealtruism/cairnx-core";
import type { Source } from "../src/index.js";
import { fixtureSource, type BlockFixture } from "../src/testing.js";

export const standIn = (h: number, branch = "a"): string => "0x" + createHash("sha256").update(`stand-in:${branch}:${h}`).digest("hex");

/** `fx` cut or extended to `to`, with an empty block at every epoch boundary in its range that it lacks. */
export function withBoundaries(fx: BlockFixture, to: number): BlockFixture {
  const at = new Map(fx.blocks.filter((b) => b.height <= to).map((b) => [b.height, b] as const));
  const hashOf = (h: number) => (h === fx.to ? fx.toHash : standIn(h));
  for (let b = Math.ceil(fx.from / EPOCH_LEN) * EPOCH_LEN; b <= to; b += EPOCH_LEN) if (!at.has(b)) at.set(b, { height: b, hash: hashOf(b), txs: [] });
  return { ...fx, to, toHash: at.get(to)?.hash ?? hashOf(to), blocks: [...at.values()].sort((x, y) => x.height - y.height) };
}

/** A source over `fx` whose top is `top.now`: each step serves the blocks of `withBoundaries(fx, top.now)`. */
export function growing(fx: BlockFixture, top: { now: number }, o: { feed?: string } = {}): Source {
  const at = () => fixtureSource(withBoundaries(fx, top.now), o);
  return { basis: at().basis, floor: null, next: (ctx) => at().next(ctx), tip: (signal) => at().tip(signal) };
}
