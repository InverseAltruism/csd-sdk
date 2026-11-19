// GATE_HEIGHTS, the gate table a reader compares: equal to the individual exports, complete (no exported ACTIVATION_HEIGHT
// or V<n>_HEIGHT left out, nothing else in it), frozen, and the same in the built dist.
import assert from "node:assert/strict";
import * as root from "../src/index.js";
import { GATE_HEIGHTS } from "../src/index.js";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
};
const GATE = /^(ACTIVATION|V[0-9]+)_HEIGHT$/;
const exported = Object.entries(root as Record<string, unknown>).filter(([k]) => GATE.test(k));
const order = (k: string) => (k === "ACTIVATION_HEIGHT" ? 0 : Number(k.slice(1, -"_HEIGHT".length)));

t("every exported gate constant is a safe integer", () => {
  assert.ok(exported.length > 0);
  for (const [k, v] of exported) assert.ok(Number.isSafeInteger(v), k);
});
t("the table holds exactly the exported gate constants", () =>
  assert.deepEqual(Object.keys(GATE_HEIGHTS).sort(), exported.map(([k]) => k).sort()));
t("each entry equals its individual export", () => {
  for (const [k, v] of exported) assert.equal((GATE_HEIGHTS as Record<string, number>)[k], v, k);
});
t("the keys run ACTIVATION_HEIGHT, then V<n> ascending", () => {
  const keys = Object.keys(GATE_HEIGHTS);
  assert.deepEqual(keys, [...keys].sort((a, b) => order(a) - order(b)));
});
t("the table is frozen", () => {
  assert.ok(Object.isFrozen(GATE_HEIGHTS));
  assert.throws(() => { (GATE_HEIGHTS as Record<string, number>).V29_HEIGHT = 0; }, TypeError);
});
const dist = (await import(new URL("../dist/index.js", import.meta.url).href)) as { GATE_HEIGHTS?: unknown };
t("the built dist exports the same table", () => assert.deepEqual(dist.GATE_HEIGHTS, GATE_HEIGHTS));

console.log(`cairnx-core gate table: ${pass} passed, ${fail} failed (${Object.keys(GATE_HEIGHTS).length} gates)`);
if (fail) process.exit(1);
