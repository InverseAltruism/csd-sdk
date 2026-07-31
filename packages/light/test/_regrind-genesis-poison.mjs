// Regrind the baked min-difficulty poison nonce for the MF-02 genesis-rooted snapshot-poison test,
// should the committed genesis fixture ever change. Prints a nonce N such that a FORGED header at
// height 44 (prev = real h43 hash, merkle = real h44 merkle, time = real h43 time + 120, bits forced
// to POW_LIMIT) hashes below the POW_LIMIT target (a valid min-difficulty PoW an attacker would
// grind). Paste N into POISON_NONCE_44 in test/light-offline.test.ts. Mirrors _regrind-poison-nonce.mjs.
//   node test/_regrind-genesis-poison.mjs           (from packages/light)
import { POW_LIMIT_BITS, headerHashBytes, powOk, headerHash } from "@inversealtruism/csd-codec";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures-genesis.json"), "utf8"));
const byH = new Map(FX.headers.map((h) => [h.height, h]));
const h43 = byH.get(43);
const h44 = byH.get(44);
const base = { version: 1, prev: h43.hash, merkle: h44.header.merkle, time: h43.header.time + 120, bits: POW_LIMIT_BITS };
const t0 = Date.now();
for (let nonce = 0; nonce < 200_000_000; nonce++) {
  if (powOk(headerHashBytes({ ...base, nonce }), POW_LIMIT_BITS)) {
    console.log(`POISON_NONCE_44 = ${nonce}   (forged h44, hash ${headerHash({ ...base, nonce })}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    process.exit(0);
  }
}
console.error("no nonce found in 200M tries; widen the search");
process.exit(1);
