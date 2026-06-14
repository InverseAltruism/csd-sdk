// Regrind the baked min-difficulty poison nonce for the SG-2 snapshot-poison test, should the
// committed fixture's tip header ever change. Prints a nonce N such that the fixture's NON-trusted
// tip header, with bits forced to POW_LIMIT, hashes below the POW_LIMIT target (a valid min-difficulty
// PoW the attacker would grind). Paste N into POISON_NONCE in test/light-offline.test.ts.
//   node test/_regrind-poison-nonce.mjs           (from packages/light; ~1-2 min)
import { POW_LIMIT_BITS, headerHashBytes, powOk, headerHash } from "@inversealtruism/csd-codec";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures-headers.json"), "utf8"));
const tip = FX.headers[FX.headers.length - 1];
const base = { ...tip.header, bits: POW_LIMIT_BITS };
const t0 = Date.now();
for (let nonce = 0; nonce < 200_000_000; nonce++) {
  if (powOk(headerHashBytes({ ...base, nonce }), POW_LIMIT_BITS)) {
    console.log(`POISON_NONCE = ${nonce}   (tip @${tip.height}, hash ${headerHash({ ...base, nonce })}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    process.exit(0);
  }
}
console.error("no nonce found in 200M tries — widen the search");
process.exit(1);
