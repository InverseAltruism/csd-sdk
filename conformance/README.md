# Cross-implementation conformance (audit META-1)

CairnX/CSD's trust model is **"two honest resolvers, different code, converge byte-for-byte."** That
only holds if a *second, independent* implementation actually reproduces the byte-contract — until
this directory, only the JS implementation existed, so the contract was asserted, never co-signed.

- **`cairnx_ref.py`** — an INDEPENDENT Python reference for the determinism-critical primitives,
  written from the spec (not transliterated from the JS): canonical JSON (UTF-16-code-unit key sort,
  `MAX_DEPTH`, scalar emit), payload hash, the record-validation gate (`onlyKeys` per record type incl.
  the `name` record + well-formed/lone-surrogate rejection), and the registry **RES-H4** decay
  fixed-point (`0.97^age` in exact integer arithmetic).
- **`crosscheck.mjs`** — feeds the shipping JS (`csd-codec` / `cairnx-core` / the registry math) and
  the Python reference the SAME corpus of fork-prone shapes (astral keys, the U+FFFF↔U+10000 sort
  boundary, lone surrogates, decoy keys, near-tie weights) and asserts byte-identity on every
  primitive. A JS-only fork — a UTF-16-vs-codepoint key sort, a dropped `onlyKeys` decoy guard, a
  `Math.pow` ranking — diverges HERE.

- **`cairnx_ref.py`** (resolve half) — now ALSO a full INDEPENDENT `resolve()` ledger port:
  `parse_record` (every `onlyKeys` allow-set + shape rule) and `resolve()` (tokens / names with
  commit-reveal + lease / offers / bids / fills / fees) producing a byte-identical `canonical_state`.
- **`crosscheck-resolve.mjs`** — feeds the shipping JS resolver and the Python port the SAME
  language-neutral vectors (`packages/cairnx/test/vectors/cases.json`) and asserts
  `canonicalState(JS.resolve) === Python.resolve === JSON.stringify(expectedState)` for every case.
  Real-chain co-sign: `cairnx/scripts/conformance-crosslang.mjs` scans the live indexer and replays
  the ACTUAL on-chain event stream through both impls at every pinned height.

Run: `npm run test:crosslang` (primitives + resolve); in `cairnx`, `npm run test:integration` (real chain).

**Status:** META-1 is co-signed across the determinism-critical primitives AND the complete `resolve()`
ledger — byte-identical `canonicalState` across two independent languages on the pinned vectors AND the
real on-chain event stream (sha256 == the pinned `replay-hashes` at every activation height). Coverage now
includes **v1.9/nprofile** (`nprofile-crosslang.mjs` — parse + resolve + dormancy + cross-impl constant
PARITY) and the **raw regex-vs-regex differential** (`crosscheck-regex.mjs`, 2301 control-char cases over
7 fields) + the full parse gate (the trailing-control-char fork class, audit C1). A drift on any of these
fails CI.

**Fork the port caught (2026-06-15):** `canonicalState` = JS `JSON.stringify(sortKeys(...))`, and
ECMAScript object enumeration emits **integer-index keys (`"0".."4294967294"`) ascending-numeric
FIRST, then string keys in code-unit order** — overriding the code-unit sort. So a NUMERIC name
(`"1"`,`"2"`,`"10"`) sorts ahead of a string name (`"0xinverse"`) in the canonical bytes. A naive
third-party resolver that sorts every key purely by code-unit FORKS here. The pinned hashes encode the
JS ordering; the Python port replicates it (`_js_stringify` / `_is_array_index`), and vector
`determinism-numeric-name-integer-key-order` locks it into the portable fixtures. (Records are
unaffected — record keys are never integer-like.) This is precisely the latent fork a second
implementation exists to surface.
