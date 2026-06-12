// Conformance: replay every language-neutral vector and require byte-identical canonical state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalState, resolve } from "../src/index.js";

const { format, cases } = JSON.parse(readFileSync(new URL("./vectors/cases.json", import.meta.url), "utf8"));
assert.equal(format, 2);
let pass = 0;
for (const c of cases) {
  assert.equal(canonicalState(resolve(c.events, c.tipHeight)), JSON.stringify(c.expectedState), `vector ${c.name} diverged`);
  pass++;
}
console.log(`cairnx-core conformance: ${pass}/${cases.length} vectors byte-identical`);
