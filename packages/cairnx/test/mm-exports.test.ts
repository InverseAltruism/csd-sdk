// The ./mm subpath resolves through the package exports map for both module systems, carries the
// same math as src, and stays out of the root export (the wallet bundle re-exports the root).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as root from "../src/index.js";
import { rfqBuyAllIn, sizeBid, sunriseAnswerPrice } from "../src/mm/index.js";

const SUBPATH = "@inversealtruism/cairnx-core/mm";
const esm = await import(SUBPATH) as typeof import("../src/mm/index.js");
const cjs = createRequire(import.meta.url)(SUBPATH) as typeof import("../src/mm/index.js");

const params = { p0: 1_000_000n, rateBps: 2, kScaled: 693_147n, E: 420_000_000_000_000n, capMult: 3 };
const ladder = [{ bps: 0, size: "2000", pricePerUnit: "1010000" }];

for (const [name, mod] of [["esm", esm], ["cjs", cjs]] as const) {
  assert.equal(mod.rfqBuyAllIn(200_000_000n), rfqBuyAllIn(200_000_000n), `${name} rfqBuyAllIn`);
  assert.equal(
    mod.sunriseAnswerPrice(params, 27_252_900_000_000n, 5_000_000_000_000n, 18, 200, 1_000_000n),
    sunriseAnswerPrice(params, 27_252_900_000_000n, 5_000_000_000_000n, 18, 200, 1_000_000n), `${name} answer price`);
  assert.deepEqual(
    mod.sizeBid({ csdBase: 250_000_000n, decimals: 8, levels: ladder }),
    sizeBid({ csdBase: 250_000_000n, decimals: 8, levels: ladder }), `${name} sizeBid`);
}

for (const name of ["sizeBid", "acceptBid", "tierFor", "tradeNotional", "sunriseCurve", "sunriseOrderCost", "rfqBuyAllIn"]) {
  assert.equal(name in root, false, `${name} must not be in the root export`);
  assert.equal(name in esm, true, `${name} must be in ./mm`);
}

console.log("mm-exports: ok (esm + cjs subpath, root export untouched)");
