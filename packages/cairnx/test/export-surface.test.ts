// B6 rider (REBIND): executable pins on the pieces of the public export surface that downstream
// re-vendors depend on. The wallet re-vendor consumes dist/index.d.ts; a symbol silently dropped from
// the surface (an index.ts refactor, a tsup config change) would ship a vendor bundle whose .d.ts no
// longer carries it, and the miss would surface only at the consumer's compile - far from the cause.
//
// CONF_TOKEN_FILL is the one this rider was opened for: the 1_000_000 token-fill confidence sentinel
// (resolve.ts requires ev.confidence === CONF_TOKEN_FILL for a token-debiting fill). Verified already
// exported at authoring time (types.ts `export *`); this test PINS it so it cannot regress unnoticed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CONF_TOKEN_FILL } from "../src/index.js";

assert.equal(CONF_TOKEN_FILL, 1_000_000, "CONF_TOKEN_FILL must be the 1_000_000 sentinel (a different value forks token-fill acceptance)");

// The built artifact the re-vendor actually consumes must carry it too (dist freshness is separately
// enforced by check-lockstep; this reads the artifact, not the source).
const dts = readFileSync(new URL("../dist/index.d.ts", import.meta.url), "utf8");
assert.ok(/\bCONF_TOKEN_FILL\b/.test(dts), "dist/index.d.ts must export CONF_TOKEN_FILL (the wallet re-vendor picks the surface up from the built .d.ts)");
assert.ok(/CONF_TOKEN_FILL = 1000000/.test(dts), "dist/index.d.ts must pin CONF_TOKEN_FILL's literal value");

console.log("cairnx-core export surface: 3 passed (CONF_TOKEN_FILL pinned in src and dist .d.ts)");
