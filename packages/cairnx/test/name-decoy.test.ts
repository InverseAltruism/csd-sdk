// Regression for the FORK-1 / M1 fix (audit cli-bridge review §C): the value-bearing `name` record
// must reject a decoy key, exactly like every other value record. A decoy astral-codepoint key
// canonicalizes differently under UTF-16 (JS) vs codepoint/byte sort (Rust/Go/Py), so a `name`
// record that one impl ACCEPTS and another NO-OPS is a cross-language consensus fork on NAME
// OWNERSHIP. The `onlyKeys(r, NAME_KEYS)` guard in records.ts closes it; this pins that it stays.
import assert from "node:assert/strict";
import { parseRecord } from "../src/index.js";
import { canonicalJson, payloadHash } from "@inversealtruism/csd-codec";

// parseRecord requires uri to be canonical AND payloadHashHex to match — mirror an on-chain record.
const mk = (obj: unknown) => { const uri = canonicalJson(obj); return parseRecord(uri, payloadHash(obj)); };

let pass = 0;
const ok = (n: string, c: boolean) => { if (!c) { console.error("  ✗ " + n); process.exitCode = 1; } else { pass++; console.log("  ✓ " + n); } };

// a clean name claim parses
const clean = { v: 1, t: "name", name: "alice", salt: "00112233445566778899aabbccddeeff" };
ok("clean name record parses", mk(clean) !== null && (mk(clean) as any).name === "alice");

// the SAME record + an astral-codepoint DECOY key must be rejected (no-op), not silently accepted
const astralKey = "\u{1D7D8}"; // U+1D7D8 MATHEMATICAL DOUBLE-STRUCK DIGIT ZERO (non-BMP → surrogate pair in UTF-16)
ok("name record with an astral decoy key is REJECTED (onlyKeys/NAME_KEYS)", mk({ ...clean, [astralKey]: 1 }) === null);
// a lone-surrogate decoy key is also rejected (isWellFormedDeep, before onlyKeys)
ok("name record with a lone-surrogate decoy key is REJECTED", mk({ ...clean, "\uD800x": 1 }) === null);
// a plain extra key is rejected too (onlyKeys is strict)
ok("name record with any extra key is REJECTED", mk({ ...clean, extra: 1 }) === null);
// and the sibling name ops keep their strict shape
ok("nset rejects an extra decoy key", mk({ v: 1, t: "nset", name: "alice", addr: "0x" + "11".repeat(20), [astralKey]: 1 }) === null);

console.log(`cairnx-core name-decoy regression: ${pass}/5`);
assert.equal(process.exitCode ?? 0, 0, "name-decoy regression failed");
