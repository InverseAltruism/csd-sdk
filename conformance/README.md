# Cross-implementation conformance (audit META-1)

CairnX/CSD's trust model is **"two honest resolvers, different code, converge byte-for-byte."** That
only holds if a *second, independent* implementation actually reproduces the byte-contract, until
this directory, only the JS implementation existed, so the contract was asserted, never co-signed.

- **`cairnx_ref.py`:** an INDEPENDENT Python reference for the determinism-critical primitives,
  written from the spec (not transliterated from the JS): canonical JSON (UTF-16-code-unit key sort,
  `MAX_DEPTH`, scalar emit), payload hash, the record-validation gate (`onlyKeys` per record type incl.
  the `name` record + well-formed/lone-surrogate rejection).
- **`crosscheck.mjs`:** feeds the shipping JS (`csd-codec` / `cairnx-core`) and
  the Python reference the SAME corpus of fork-prone shapes (astral keys, the U+FFFF↔U+10000 sort
  boundary, lone surrogates, decoy keys) and asserts byte-identity on every
  primitive. A JS-only fork, a UTF-16-vs-codepoint key sort or a dropped `onlyKeys` decoy guard,
  diverges HERE. In the full parse-gate job (`parseFull`) a record Python cannot
  canonicalize (a float, a lone surrogate) is one rejected record, logged to stderr, as an unparseable
  record is in `resolve()`; the rest of the batch still runs.

- **`cairnx_ref.py`** (resolve half), now ALSO a full INDEPENDENT `resolve()` ledger port:
  `parse_record` (every `onlyKeys` allow-set + shape rule) and `resolve()` (tokens / names with
  commit-reveal + lease / offers / bids / fills / fees) producing a byte-identical `canonical_state`.
- **`crosscheck-resolve.mjs`:** feeds the shipping JS resolver and the Python port the SAME
  language-neutral vectors (`packages/cairnx/test/vectors/cases.json`, `cases-rules.json` and
  `cases-convention.json`) and asserts
  `canonicalState(JS.resolve) === Python.resolve === JSON.stringify(expectedState)` for every case.
  `cases-rules.json` (`gen-rule-vectors.mjs`, its own file so the frozen `cases.json` keeps its bytes) pins, in
  five vectors, three rules nothing else decided: a fill or a seller cancel in the block of the record it attests applies after it
  (proposals before attests), a uri that is not its canonical JSON is invalid even with the canonical hash, and a
  token offer cannot give and want one ticker. `cases-convention.json` (`gen-convention-vectors.mjs`, its own file for
  the same reason) pins, in twelve vectors, the rules CONVENTION.md states since its 2026-11-19 correction (the
  pending reservation, the closing sweep, the zero-delivery partial fill, the commit height, the salt and hash forms,
  the bid link, the contest key, the zero token price, the recapture premium, the same-block re-post after an
  `ocancel`, `feesPaid` and a whole fill's `paid`); an implementation of the earlier text fails each.
  Real-chain co-sign: `cairnx/scripts/conformance-crosslang.mjs` scans the live indexer and replays
  the ACTUAL on-chain event stream through both impls at every pinned height.
- **`replay-corpus-crosslang.mjs`:** the same co-sign offline, over the committed on-chain corpus
  (`packages/cairnx/test/vectors/replay-corpus.json`, fclaim and V29 included): JS == Python and
  sha256(JS) == `replay-hashes.json` at every pinned height.
- **`events-crosslang.mjs`:** the rule from a block to events (CONVENTION section 33): every case of
  `packages/cairnx/test/vectors/events.json` through the JS rule and `cairnx_ref.py`'s `event_of_tx`,
  `block_members` and `block_events`, byte-identical to the recorded result. `gen-events-vectors.mjs` writes the
  file after checking each case's hand-written facts; `events-run.mjs` is the case runner both share. It also runs
  the recorded blocks of `packages/cairnx/test/fixtures/events-blocks.json` through both and requires the events to
  be the pinned replay corpus sorted into the order of section 33.3 (height, then Proposes by position, then Attests
  by position), as canonicalJson bytes of the whole list. Cases sent as literal JSON text check that an integer in
  another spelling (`100000.0`, `1e5`) reads as the integer and a fraction or a boolean is refused, since
  `JSON.stringify` erases those spellings from the vector file.
- **`hashes-crosslang.mjs`:** the state hash and the events hash (CONVENTION section 34): every case of
  `packages/cairnx/test/vectors/hashes.json` and both hashes over the replay corpus at every pinned height, through
  the JS functions and `cairnx_ref.py`'s `events_hash_step`, `events_hash` and `state_hash`. `gen-hashes-vectors.mjs`
  writes the file after checking its facts (three values rebuilt byte by byte, the corpus state hashes equal to
  `replay-hashes.json`); `hashes-run.mjs` is the runner both share. It also hashes complete `resolve()` results
  (diagnostic fields included) at three corpus heights and for the empty state, and runs literal JSON cases as the
  events job does.
- **`gen-codes-vectors.mjs`** (JavaScript only, not a cross-language job): writes
  `packages/cairnx/test/vectors/codes.json`, the reason codes of CONVENTION section 40, from expectations written by
  hand per event and per record, after checking each against the built dist; it writes nothing when one fails.
  `cairnx_ref.py` writes no codes, so the file is checked by `test/codes.test.ts` and `test/records-explain.test.ts`.
- **`growth-streams.mjs`** (JavaScript only, not a cross-language job): synthetic streams that load the replay's
  expiry and per-address work (16,000 registrations; 20,000 open bids, offers with holds, live reservations and live
  recaptures; bulk cancels and displacements over 20,000 offers; the V21 crossing; edge cases), each with the
  expectations it was built to meet, read from the reason codes. `scripts/seal-differential.mjs` step 4(f) runs them
  at full size against the baseline; `packages/cairnx/test/growth.test.ts` at 500 and 1,000 against pinned states.

Block scripts (read a node, never in CI; `test/ci-workflow.test.ts` pins that no CI step or package script runs
them, `test/live-opt-in.test.ts` that each refuses by name with no node named and fails by name when the node does
not answer). Each reads complete blocks through `chain-read.mjs`: headers checked by csd-light from a seed (the LWMA
window below the first height, read from the same node), each body bound to its header's merkle root, authors bound by
csd-crypto `authorOf`, at most 8 requests in flight. Compare the end hash each prints with a node you trust.

- **`capture-events-fixture.mjs`:** `--rpc <node> --to <height> [--from 29860] [--out FILE]` writes the block
  fixture: every transaction with an app payload (any domain) of every block in the range, in the `events.json` tx
  form with its author, one block per line in canonicalJson form, blocks without one left out. The bytes depend on
  the chain alone, so two captures of one range are identical. Prints blocks read and kept, transactions kept, bytes
  and sha256. Recapture with `--to 117000` (the corpus height) and re-pin the sha256 in `packages/cairnx/test/events.test.ts`
  in the same commit; a corpus extension moves both.
- **`events-live-differential.mjs`:** `CSD_RPC=<node> CSD_INDEXER=<indexer> ... [--to <height>]` (default the tip
  less 48): the cairnx:v1 events from 29,860 derived from blocks through the rule and from csd-indexer's chain-order
  feeds (`/proposals` and `/attestations`, `domain=cairnx:v1`, walked at the snapshot block `--to`, which must be the
  node's block), required equal event by event and as one list. The feed rows carry no outputs, so the feed side's
  `paidTo` is read from the node's `/tx/<txid>` with the txid recomputed. Prints both sides' counts and the first
  difference; exits 1 on any.
- **`scan-repeated-txids.mjs`:** `--rpc <node> [--from 29860] [--to <height>]`: every transaction id (recomputed
  from its body) that occurs at more than one height or position, split by coinbase and app payload, with the end
  block's hash; exits 1 when any repeats. The fact cited for cairnx-core 0.2.5 in `CONSENSUS_CHANGES.md`.

Run: `pnpm test:crosslang` (primitives + resolve); in `cairnx`, `npm run test:integration` (real chain).

**Status:** META-1 is co-signed across the determinism-critical primitives AND the complete `resolve()`
ledger, byte-identical `canonicalState` across two independent languages on the pinned vectors AND the
real on-chain event stream (sha256 == the pinned `replay-hashes` at every activation height). Coverage now
includes **v1.9/nprofile** (`nprofile-crosslang.mjs`, parse + resolve + dormancy + cross-impl constant
PARITY) and the **raw regex-vs-regex differential** (`crosscheck-regex.mjs`, 2301 control-char cases over
7 fields) + the full parse gate (the trailing-control-char fork class, audit C1). A drift on any of these
fails CI.

**Money-safety audit tooling (report-only, on-demand):** beyond fork detection, `money-safety.mjs`
and `race-harness.mjs` hunt the honest-user-burn class (a fee anchored then rejected). CI's conformance
job runs them through `audit:all` with report-only findings (they print and exit 0); run them on demand with `pnpm run audit:money-safety` / `audit:race` /
`audit:all`. See `AUDIT.md` for the tools, the fan-out method, and the observability-gap review.

**Fork the port caught (2026-06-15):** `canonicalState` = JS `JSON.stringify(sortKeys(...))`, and
ECMAScript object enumeration emits **integer-index keys (`"0".."4294967294"`) ascending-numeric
FIRST, then string keys in code-unit order:** overriding the code-unit sort. So a NUMERIC name
(`"1"`,`"2"`,`"10"`) sorts ahead of a string name (`"0xinverse"`) in the canonical bytes. A naive
third-party resolver that sorts every key purely by code-unit FORKS here. The pinned hashes encode the
JS ordering; the Python port replicates it (`_js_stringify` / `_is_array_index`), and vector
`determinism-numeric-name-integer-key-order` locks it into the portable fixtures. (Records are
unaffected, record keys are never integer-like.) This is precisely the latent fork a second
implementation exists to surface.
