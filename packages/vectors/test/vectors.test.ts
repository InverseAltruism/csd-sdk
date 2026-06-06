// Shape sanity for the golden fixtures (the real conformance gate is @csd/codec's test).
import { GOLDEN_HEADER, GOLDEN_TX, GOLDEN_POW, GOLDEN_GENESIS, TX_VECTORS, HEADER_VECTORS } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const isHex = (s: string, bytes: number) => new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(s);

ok("golden txid is 0x..64", isHex(GOLDEN_TX.expectedTxid, 32));
ok("golden sighash is 0x..64", isHex(GOLDEN_TX.expectedSighash, 32));
ok("golden header hash is 0x..64", isHex(GOLDEN_HEADER.expectedHeaderHash, 32));
ok("golden header bytes are 84 bytes", GOLDEN_HEADER.expectedConsensusBytes.length === 2 + 84 * 2);
ok("pow-limit target is 0x..64", isHex(GOLDEN_POW.expectedTargetBE, 32));
ok("genesis hash is 0x..64", isHex(GOLDEN_GENESIS.hash, 32));
ok("vector arrays are non-empty", TX_VECTORS.length > 0 && HEADER_VECTORS.length > 0);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
