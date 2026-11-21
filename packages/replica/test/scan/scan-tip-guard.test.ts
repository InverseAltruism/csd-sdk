// The indexer tip is the scan's depth reference and its cache freeze horizon. Only a JSON integer or a decimal string
// is a tip: Number() would read null, "", [] and false as 0 and [7] as 7.
import assert from "node:assert/strict";
import { Scanner } from "../../src/scanner.js";
import { DOMAIN } from "@inversealtruism/cairnx-core";

const indexer = (tip: unknown) => (async (url: string) => {
  const p = decodeURIComponent(new URL(url).pathname);
  const J = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
  if (p === "/blocks/tip/height") return J(tip);
  if (p.startsWith("/block-height/")) return J("0x" + "00".repeat(32));
  if (p === `/domain/${DOMAIN}/proposals`) return J([]);
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as unknown as typeof fetch;
const scanAt = (tip: unknown) => new Scanner({ indexerUrl: "http://idx", fetch: indexer(tip) }).scan();

for (const bad of [null, "", [], [7], false, true, "0x10", " 7", "7.5", 7.5, -1, {}])
  await assert.rejects(scanAt(bad), /non-numeric\/negative tip height/, `tip ${JSON.stringify(bad)} is refused`);
console.log("  ok null, \"\", [], [7], booleans, hex, padded, fractional, negative and object tips are refused");

// Paired honest path: the indexer answers a JSON integer; a decimal string is read the same way.
assert.equal((await scanAt(120_000)).tipHeight, 120_000);
assert.equal((await scanAt("120000")).tipHeight, 120_000);
assert.equal((await scanAt(0)).tipHeight, 0);
console.log("  ok an integer tip, its decimal string and 0 are read");

console.log("\nscan-tip-guard: 2 passed");
