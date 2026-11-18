// B6 rider (REBIND): executable pins on the pieces of the public export surface that downstream
// re-vendors depend on. The wallet re-vendor consumes dist/index.d.ts; a symbol silently dropped from
// the surface (an index.ts refactor, a tsup config change) would ship a vendor bundle whose .d.ts no
// longer carries it, and the miss would surface only at the consumer's compile - far from the cause.
//
// CONF_TOKEN_FILL is the one this rider was opened for: the 1_000_000 token-fill confidence sentinel
// (`applyTokenFill` in src/resolve/attest.ts requires ev.confidence === CONF_TOKEN_FILL for a token-debiting fill). Verified already
// exported at authoring time (types.ts `export *`); this test PINS it so it cannot regress unnoticed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAIRNX_EVENT_RULE, CONF_TOKEN_FILL, EVENTS_HASH_START, FCLAIM_MAX_HOLD_SPAN, blockEvents, blockMembers, eventOfTx, eventsHash,
  eventsHashStep, fillEndorsement, offerFillTooLate, stateHash,
} from "../src/index.js";

assert.equal(CONF_TOKEN_FILL, 1_000_000, "CONF_TOKEN_FILL must be the 1_000_000 sentinel (a different value forks token-fill acceptance)");

// The built artifact the re-vendor actually consumes must carry it too (dist freshness is separately
// enforced by check-lockstep; this reads the artifact, not the source).
const dts = readFileSync(new URL("../dist/index.d.ts", import.meta.url), "utf8");
assert.ok(/\bCONF_TOKEN_FILL\b/.test(dts), "dist/index.d.ts must export CONF_TOKEN_FILL (the wallet re-vendor picks the surface up from the built .d.ts)");
assert.ok(/CONF_TOKEN_FILL = 1000000/.test(dts), "dist/index.d.ts must pin CONF_TOKEN_FILL's literal value");

// cairn-sdk's preverifyOffer runs these two over the served offer for a caller's address and tip (one home, no SDK copy
// of the taker, routing, delivery or expiry rules).
assert.equal(typeof fillEndorsement, "function", "fillEndorsement is a root export");
assert.equal(typeof offerFillTooLate, "function", "offerFillTooLate is a root export");
// The site's refusal before the reservation fee reads which listed fills may lie below the fill check's window with it.
assert.equal(FCLAIM_MAX_HOLD_SPAN, 89, "FCLAIM_MAX_HOLD_SPAN is a root export (89)");
// The rule from a block to events (CONVENTION §33): the scanner, the wallet, the site and the replica's sources call it.
for (const [name, fn] of [["eventOfTx", eventOfTx], ["blockMembers", blockMembers], ["blockEvents", blockEvents]] as const)
  assert.equal(typeof fn, "function", `${name} is a root export`);
assert.deepEqual(CAIRNX_EVENT_RULE, { domain: "cairnx:v1", activationHeight: 29_860 }, "CAIRNX_EVENT_RULE is cairnx:v1 from 29,860");
// The hashes two replicas compare (CONVENTION §34): the service, the replica and the comparator call them.
for (const [name, fn] of [["stateHash", stateHash], ["eventsHashStep", eventsHashStep], ["eventsHash", eventsHash]] as const)
  assert.equal(typeof fn, "function", `${name} is a root export`);
assert.equal(EVENTS_HASH_START, "0x" + "00".repeat(32), "EVENTS_HASH_START is 32 zero bytes");
const names = ["fillEndorsement", "offerFillTooLate", "FCLAIM_MAX_HOLD_SPAN", "eventOfTx", "blockMembers", "blockEvents", "CAIRNX_EVENT_RULE",
  "stateHash", "eventsHashStep", "eventsHash", "EVENTS_HASH_START"];
for (const name of names) assert.ok(new RegExp(`\\b${name}\\b`).test(dts), `dist/index.d.ts must export ${name}`);

console.log(`cairnx-core export surface: ${10 + 4 + names.length} passed (CONF_TOKEN_FILL, fillEndorsement, offerFillTooLate, FCLAIM_MAX_HOLD_SPAN, the §33 rule's four names and the §34 hashes' four pinned in src and dist .d.ts)`);
