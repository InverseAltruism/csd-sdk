// Conformance: replay every language-neutral vector and require byte-identical canonical state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalState, resolve } from "../src/index.js";

const { format, cases } = JSON.parse(readFileSync(new URL("./vectors/cases.json", import.meta.url), "utf8"));
assert.equal(format, 2);
// v2.9 (§32, V29): the M4+M5 gate vectors live in their OWN file so cases.json (the B6-era pinned corpus, which
// the B6 seal differential freezes) stays byte-frozen. They exercise the cap-relaxation + event-dedup at/above
// AND just-below 88,000; below the gate they are byte-identical to v2.8, which the B6-era corpus above proves.
// DEFERRED (post-crossing runbook, per CONSENSUS_CHANGES.md): the V29 replay-hash RE-PIN in replay-hashes.json is
// NOT done here and is deliberately NOT faked. replay-hashes.json still pins only heights <= 45,959, all far below
// 88,000; a V29-region hash needs the live-indexer generator reachable into the V29 tip region (chain ~58.3k
// today) and is pinned when the tip approaches 88,000. Do NOT invent a V29 replay hash.
const v29 = JSON.parse(readFileSync(new URL("./vectors/cases-v29.json", import.meta.url), "utf8"));
assert.equal(v29.format, 2);
let pass = 0;
for (const c of [...cases, ...v29.cases]) {
  assert.equal(canonicalState(resolve(c.events, c.tipHeight)), JSON.stringify(c.expectedState), `vector ${c.name} diverged`);
  pass++;
}
console.log(`cairnx-core conformance: ${pass}/${cases.length + v29.cases.length} vectors byte-identical (${cases.length} B6-era + ${v29.cases.length} v29)`);
