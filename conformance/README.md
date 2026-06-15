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

Run: `npm run test:crosslang` (requires `python3`; build the packages first).

**Status:** this is the *structural half* of META-1 — the determinism-critical surface (canonical
form, record gate, decay ranking) is now co-signed by a second language. The remaining half is a
full `resolve()` port (the token/name/offer/bid/fill/fee ledger) producing a byte-identical
`canonicalState`; the language-neutral vectors in `packages/cairnx/test/vectors/cases.json` are the
fixtures it would consume.
