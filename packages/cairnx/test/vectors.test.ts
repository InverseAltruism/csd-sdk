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
