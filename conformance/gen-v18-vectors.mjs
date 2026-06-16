// Generator for the v1.8 (2-tier name fee) conformance vectors. Builds correct commit/reveal/renew
// events with the REAL resolver helpers (nameCommit + codec canonicalJson/payloadHash), derives the
// expectedState from the rebuilt JS resolver, and appends to cases.json. The cross-impl harness then
// proves the Python reference produces byte-identical state on the NEW fee regime. Re-runnable: it
// strips any existing "v18-*" cases first. Run: node conformance/gen-v18-vectors.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, payloadHash } from "@inversealtruism/csd-codec";
import { nameCommit, resolve, canonicalState } from "../packages/cairnx/dist/index.js";

const TREASURY = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
const OWNER = "0x" + "a1".repeat(20);
const SALT = "00ffee1122334455";
let idn = 0xf1800000;
const nextId = () => "0x" + (idn++).toString(16).padStart(64, "0");
const ev = (record, { height, pos = 1, proposer = OWNER, expiresEpoch = 5000, paidTo = {} }) => ({
  kind: "propose", id: nextId(), proposer, uri: canonicalJson(record), payloadHash: payloadHash(record),
  height, pos, expiresEpoch, paidTo,
});
// a full commit→reveal name registration: ncommit at cH, reveal at rH paying `fee` to treasury
const register = (name, cH, rH, fee) => [
  ev({ v: 1, t: "ncommit", commit: nameCommit(name, SALT, OWNER) }, { height: cH }),
  ev({ v: 1, t: "name", name, salt: SALT }, { height: rH, paidTo: fee != null ? { [TREASURY]: String(fee) } : {} }),
];

const built = [];
const add = (name, events, tipHeight) => built.push({ name, events, tipHeight, expectedState: JSON.parse(canonicalState(resolve(events, tipHeight))) });

// 1) ≤4-char name at/after V18 → premium 6.7 CSD, accepted
add("v18-short-name-premium-fee", register("abcd", 40005, 40007, 670_000_000), 40010);
// 2) ≥5-char name at/after V18 → flat 3 CSD, accepted
add("v18-normal-name-flat-fee", register("alice", 40005, 40007, 300_000_000), 40010);
// 3) at/after V18, paying the OLD (pre-V18) fee → REJECTED (new fee enforced), no name registered
add("v18-old-fee-underpaid-rejected", register("alice", 40005, 40007, 50_000_000), 40010);
// 4) BELOW the gate, the original ENS curve still applies (5-char = 1 CSD) → accepted at the old fee
add("v18-below-gate-uses-old-curve", register("alice", 39988, 39990, 100_000_000), 39995);
// 5) renewal at/after V18 pays the new flat fee; lease extends by a second term
add("v18-renewal-pays-new-fee", [
  ...register("alice", 40005, 40007, 300_000_000),
  ev({ v: 1, t: "nrenew", name: "alice" }, { height: 40009, paidTo: { [TREASURY]: "300000000" } }),
], 40012);

// report the headline numbers so a human can sanity-check the fee actually applied
for (const c of built) console.log(`  ${c.name}: feesPaid=${c.expectedState.feesPaid}  names=${Object.keys(c.expectedState.names).join(",") || "(none)"}`);

const path = new URL("../packages/cairnx/test/vectors/cases.json", import.meta.url);
const doc = JSON.parse(readFileSync(path, "utf8"));
doc.cases = doc.cases.filter((c) => !c.name.startsWith("v18-")).concat(built);
writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
console.log(`\nwrote ${built.length} v18-* vectors → cases.json (now ${doc.cases.length} total)`);
