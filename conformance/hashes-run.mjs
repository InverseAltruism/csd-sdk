// Runs packages/cairnx/test/vectors/hashes.json (CONVENTION §34.4) through the JS functions: the generator records the
// results, hashes-crosslang.mjs compares them with the Python reference's. `lib` is the cairnx-core module (built dist).

/** {steps, list}: the step folded over the case's blocks, and the whole-list function over their events. */
export function runHashCase(lib, c) {
  let steps = "prev" in c ? c.prev : lib.EVENTS_HASH_START;
  for (let i = 0; i < c.blocks.length; i++) {
    try { steps = lib.eventsHashStep(steps, c.blocks[i].height, c.blocks[i].events); }
    catch { steps = { error: i }; break; }
  }
  if ("prev" in c) return { steps };
  let list;
  try { list = lib.eventsHash(c.blocks.flatMap((b) => b.events)); } catch { list = "error"; }
  return { steps, list };
}

/** Both hashes at each height: the events at heights <= h, in a stable sort by height for the events hash and as
 *  given for resolve(), which sorts its input itself. */
export function corpusHashes(lib, events, heights) {
  const byHeight = [...events].sort((a, b) => a.height - b.height);
  return Object.fromEntries(heights.map((h) => [String(h), {
    eventsHash: lib.eventsHash(byHeight.filter((e) => e.height <= h)),
    stateHash: lib.stateHash(lib.resolve(events.filter((e) => e.height <= h), h)),
  }]));
}
