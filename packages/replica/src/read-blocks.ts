import { CAIRNX_EVENT_RULE, type EventRule } from "@inversealtruism/cairnx-core";
import type { AuthorScope, BlocksSource, BoundBlock } from "./types.js";

/** Every block from `from` to `to` in height order, each bound to its header and linked to the one before, with the
 *  authors of `authors` bound (`members` by `rule`, default CairnX's). Throws SourceError on the first block that
 *  cannot be read or bound; a refusal of served data is final only after a re-read with the cache bypassed. */
export async function* readBlocks(o: {
  source: BlocksSource; from: number; to: number; authors: AuthorScope; rule?: EventRule; signal?: AbortSignal;
}): AsyncGenerator<BoundBlock> {
  const signal = o.signal ?? new AbortController().signal, rule = o.rule ?? CAIRNX_EVENT_RULE;
  let prev: string | null = null;
  for (let height = o.from; height <= o.to; height++) {
    const b = await o.source.block(height, { authors: o.authors, rule, prev, signal });
    prev = b.hash;
    yield b;
  }
}
