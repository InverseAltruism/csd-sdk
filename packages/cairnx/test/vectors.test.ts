// Conformance: replay every language-neutral vector and require byte-identical canonical state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalState, resolve } from "../src/index.js";

const { format, cases } = JSON.parse(readFileSync(new URL("./vectors/cases.json", import.meta.url), "utf8"));
assert.equal(format, 2);
// v2.9 (§32, V29): the M4+M5 gate vectors live in their OWN file so cases.json (the B6-era pinned corpus, which
// the B6 seal differential freezes) stays byte-frozen. They exercise the cap-relaxation + event-dedup at/above
// AND just-below 88,000; below the gate they are byte-identical to v2.8, which the B6-era corpus above proves.
const v29 = JSON.parse(readFileSync(new URL("./vectors/cases-v29.json", import.meta.url), "utf8"));
assert.equal(v29.format, 2);
let pass = 0;
for (const c of [...cases, ...v29.cases]) {
  assert.equal(canonicalState(resolve(c.events, c.tipHeight)), JSON.stringify(c.expectedState), `vector ${c.name} diverged`);
  pass++;
}
console.log(`cairnx-core conformance: ${pass}/${cases.length + v29.cases.length} vectors byte-identical (${cases.length} B6-era + ${v29.cases.length} v29)`);

// The replay-hash artifact is LOAD-BEARING, not mirror-only. replay-corpus.json is the real on-chain
// event sequence truncated at a finalized height (capturedAt/tipHeight in the file); recompute
// sha256(canonicalState(resolve(corpus<=H, H))) for EVERY pinned height in replay-hashes.json and
// assert byte-identity. Reds on ANY consensus drift with no indexer needed. The tip-of-record entry
// asserts strictly too: the corpus is frozen, so it is exactly reproducible here (only the live
// cairnx generator treats it as aging out). The coverage floors below keep the corpus from being
// swapped for one that cannot see the V28 fclaim lane or the V29 rules.
{
  const { createHash } = await import("node:crypto");
  const corpus = JSON.parse(readFileSync(new URL("./vectors/replay-corpus.json", import.meta.url), "utf8"));
  const pinned = JSON.parse(readFileSync(new URL("./vectors/replay-hashes.json", import.meta.url), "utf8"));
  assert.equal(corpus.format, 1);
  assert.equal(pinned.format, 2);
  assert.equal(corpus.tipHeight, pinned.tipHeight, "replay corpus and pinned hashes must share one capture tip");
  const { V28_HEIGHT, V29_HEIGHT } = await import("../src/index.js");
  const evs = corpus.events as Array<{ kind: string; uri?: string; height: number }>;
  const fclaims = evs.filter((e) => e.kind === "propose" && typeof e.uri === "string" && e.uri.includes('"t":"fclaim"'));
  assert.ok(fclaims.length >= 4, `replay corpus must carry the chain's fclaim records, got ${fclaims.length}`);
  assert.ok(fclaims.some((e) => e.height >= V29_HEIGHT), "replay corpus must carry an fclaim at or above V29");
  assert.ok(evs.filter((e) => e.height >= V29_HEIGHT).length >= 700, "replay corpus must reach well past V29");
  for (const g of [V28_HEIGHT, V29_HEIGHT]) assert.ok(String(g) in pinned.hashes, `replay-hashes.json must pin the gate height ${g}`);
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  let replayed = 0;
  for (const [H, want] of Object.entries(pinned.hashes)) {
    const h = Number(H);
    const got = sha(canonicalState(resolve(corpus.events.filter((e: { height: number }) => e.height <= h), h)));
    assert.equal(got, want, `replay hash @${H} diverged from the pinned baseline`);
    replayed++;
  }
  assert.ok(replayed >= 21, `expected the full pin set, got ${replayed}`);
  console.log(`cairnx-core replay-hash baseline: ${replayed}/${replayed} pinned heights recomputed byte-identical from the committed corpus (${evs.length} events, ${fclaims.length} fclaim, tip ${pinned.tipHeight})`);
}
