# csd-sdk

> Onboarding briefing for coding agents and contributors. `AGENTS.md` is the canonical briefing; `CLAUDE.md` imports it, so edit `AGENTS.md` only. Production and operations specifics (hosts, services, deploy cadence) are intentionally out of scope here and maintained privately.

The L0 SDK monorepo for the CSD (Compute Substrate) chain: a pnpm + tsup TypeScript workspace publishing 10 npm packages under `@inversealtruism/*` (public repo InverseAltruism/csd-sdk). It is the single canonical TypeScript implementation of the chain's byte-level consensus surface (serialization, txid, sighash, header/PoW/LWMA math, merkle) AND of the CairnX application convention (tokens, .csd names / CNS, DvP trades) via `cairnx-core`. Everything it produces must be byte-for-byte identical to the official Rust node (`compute-substrate`), checked against the node's golden vectors and real mainnet data.

Since the 2026-06-24 shared-core deduplication the target architecture is "TWO implementations, period": this shipped TS core, imported or deterministically vendored by every consumer (wallet, website UI, cairnx service, cli, indexer, second-source resolvers), plus ONE independent Python oracle (`conformance/cairnx_ref.py`) used only for cross-language differential testing. Runtime deps are only @noble/curves + @noble/hashes; zero Buffer (MV3/browser-safe).

## The stack around it

The chain is the only source of truth; every layer above is a deterministic replay. This repo IS the consensus mirror the whole app layer runs on: the cairn web front end (https://cairn-substrate.com) vendors its browser bundles, the cairnx trading service pins cairnx-core, the wallet vendors an SPV bundle, cairn-cli/cairn-sdk/csd-indexer pin packages, and clarvis runs a second-source resolver on the same core. The Rust node is the upstream oracle; the node never depends on the SDK.

## Architecture (packages)

Workspace: `pnpm-workspace.yaml` = packages/*. Root package.json is private; `packageManager: pnpm@10.32.1`. All packages build with tsup (esm+cjs+dts). Current versions live in the dated State snapshot below, not here.

| Package | Purpose |
|---|---|
| csd-codec | Consensus codec: bincode fixint-LE, txid, sighash CSD_SIG_V1 (sha256d over taggedHash + CHAIN_ID_HASH), 84-byte header, bits<->target, merkle root/branch/proof, canonicalJson/payloadHash. Only dep: @noble/hashes. |
| csd-crypto | secp256k1 keygen/signDigest (low-S, RFC-6979)/verifyDigest (fail-closed), hash160 addresses, buildScriptSig. Thin noble wrappers, NO hand-rolled crypto. |
| csd-tx | Tx builder: selectInputs (dedupe, unconfirmed-drop, 512 cap), buildSend/buildSendVerified (wires verifyInputValues, the fund-burn cure)/buildPropose/buildAttest (DvP value outputs), signTx, txToNodeJson, feeCap helpers. |
| csd-client | Typed HTTP RPC client; 4xx doesn't spend retry budget; hostile-boundary tested. Transport only. |
| csd-light | Light client: headers-first sync, client-side PoW + LWMA-45 bits re-derivation + chainwork + MTP/timestamp rules, verifyTxInclusion, syncFromCheckpoint, honest trustLevel on every read (balance is rpc-trusted). |
| csd-vectors | Golden conformance vectors from the node's frozen golden_vectors.rs + real on-chain data. Zero deps. |
| cairnx-core (packages/cairnx) | THE crown jewel: `resolve(events, tipHeight) -> canonical state`, pure deterministic replay (tokens, names+lease+commit-reveal, offers, bids, fills, fees). resolve.ts, types.ts (ALL gate heights + fee constants + regexes + RESERVED_NAMES + the pure client selectors incl. claimWindowOf), records.ts (parseRecord/onlyKeys), preflight.ts (previewFill, requiredFillOutputs, buildFeeHeight, fillIsSafe, finalizeWinnerCheck, fillEndorsement, fillOutputPlan), verifyfill.ts (verifyFillSpv + bindOfferTerms, the shared fail-closed fill fund boundary), primary.ts (pickPrimaryName). Ships the normative CONVENTION.md (v2.9: section 32 is the M4/M5 normative write-up, pending activation at V29 = 88,000) + portable vectors + replay-hashes. |
| csd-registry | L3 registries: peer/gateway/identity discovery; deterministic resolvers + commit-reveal identity; integer fixed-point decay. |
| csd-siwc | Sign in with CSD: audience-bound, replay-resistant wallet auth; own Python ref (siwc_ref.py). |
| csd-indexwire | csd-indexer REST wire contract as types + runtime guards. Published; no consumer pins it yet. |

`conformance/`: cairnx_ref.py + siwc_ref.py (independent Python oracles, written from spec, KEEP independent), crosscheck*.mjs, fuzz-resolve.mjs, per-gate v2x-*-crosslang.mjs, and the report-only audit tooling: invariants.mjs (7 ledger-soundness invariants), money-safety.mjs (anchored-then-rejected burn detector), race-harness.mjs (adversarial multi-actor races; P4 JS==Python byte-identity alone exits 1), AUDIT.md (method doc).

## Consensus gates (all in packages/cairnx/src/types.ts; height-pure, non-retroactive)

V16 = 33,600 (fee 1% -> 1.5% + maker rebate) | V17 = 34,000 (claim-to-fill) | V19 = 36,700 (nprofile) | V20 = 38,400 (late-fill fund-loss fix, claim window 15 -> 40 + 5 grace) | V18 = 40,000 (2-tier name fee) | V21 = 40,100 (offer duration cap 168 epochs) | V22 = 41,300 (cap removed for offers >= V22) | V24 = 46,400 (4-tier name fee 15/10/5/3 CSD) | V25 = 46,440 (sealed reservation: payment-free reveal, winner-only nfinalize) | V26 = 46,480 (sealed recapture) | V27 = 46,520 (young-name sale embargo 240 -> 8 blocks) | V23 = 52,000 (nset-clear to zero addr; crossed ~2026-07-11). All ACTIVE. V28 = 60,000 (fclaim open-lane settlement atomicity, section 31) is AT THE CROSSING (tip ~58.3k on 2026-07-21, crosses ~07-22/23; every primary replayer runs the v2.8 core). V29 = 88,000 (M4 event de-dup + M5 concurrent-hold status filter, v2.9) is the only GATED-pending height, adoption-gated on the cairnx-core 0.1.40 fan-out; see CONSENSUS_CHANGES.md for both.

RESERVED_NAMES (csd, treasury, admin, official, root, www, support) is CONSENSUS and lives here: defined in packages/cairnx/src/types.ts, enforced by records.ts isName, mirrored in conformance/cairnx_ref.py. It is the chain's ONLY name blocklist (no profanity filter exists anywhere); changing it is a fork, same rules as a gate.

Adoption-gate discipline: fee increases hurt STALE verifiers (attacker pays the old fee, stale wallet accepts); relaxations hurt stale replayers (they reject what the chain accepts). Both mean EVERY replayer upgraded before the height, never "publish and hope". The V28+ rollout checklist at the bottom of CONSENSUS_CHANGES.md is the normative procedure (core change -> vectors -> bump/publish -> re-pin npm consumers -> re-vendor bundled consumers -> grep raw height literals -> CDN cache purge).

## Invariants and red lines

- Byte-identity with the Rust node is the prime invariant. Any change to tx/sighash/header bytes, LWMA/chainwork math, merkle acceptance, or the CairnX replay MUST be recorded in CONSENSUS_CHANGES.md, pinned by a golden vector BEFORE landing, and gated on an activation height. Reject-more hardening is allowed; accept-different never silently.
- Every pre-existing canonical-state replay hash must stay byte-identical across ANY refactor (prove via test/vectors/replay-hashes.json). If a hash moves, something forked.
- Intra-workspace deps MUST be `workspace:*` (pnpm rewrites to exact versions at pack time). No carets ever ship. Enforced by scripts/check-lockstep.mjs (+ dist-freshness: dist/ must not be older than src/).
- pnpm publish, NEVER npm publish. Every package's prepublishOnly runs scripts/publish-guard.mjs which hard-refuses a non-pnpm client. Reason: the 0.1.22 incident (raw npm shipped unresolved workspace:* specifiers).
- Independent versioning (strict lockstep deliberately abandoned; do not re-litigate): bump ONLY the packages you changed. Coherence comes from workspace:* exact-pinning, not shared numbers.
- Consumers must pin exact versions; never let a lockfile resolve two different csd-codec copies (sign with one encoding, verify with another).
- The Python oracle is independent by design, written from the spec, never transliterated from the JS. It exists to catch exactly the C1 class.
- Numeric-key trap (CONVENTION 5.1 A2): canonicalJson sorts keys pure code-unit ("10" before "2") but canonicalState inherits JSON.stringify enumeration (integer keys ascending-numeric FIRST). Both must be reproduced; pinned by vector.
- claimWindowOf is a depth HINT, never a sole fund gate (published npm surface; FU-8). For an fclaim hold (claimTxid passed) it returns FCLAIM_WINDOW_MIN = 46, the MINIMUM span an fclaimEpochFor-requested hold can carry, so the derived grant is normally never earlier than the true grant and depth is UNDER-stated (fail-safe). But an EXPIRY-CAPPED hold (E clamped to the offer's expiry) can carry a true span < 46; there the derived grant is EARLIER than the true grant and claimWindowOf-derived depth OVER-states burial by (46 - true span) blocks, early in the hold (vs the legacy 40-block inverse this adds at most 6 blocks of over-statement; spans < 40 over-stated under the legacy constant too). Consumers MUST gate funds on verifyFillSpv's independently computed merkle burial (verifyfill.ts derives depth from the proven events and never imports claimWindowOf), exactly as the site swapguard and wallet do.
- npm tokens are NEVER stored: a maintainer supplies a one-time token per publish (temp gitignored .npmrc, deleted/revoked immediately; redact npm_* in any output).
- Do not republish for docs alone (the 0.1.36 stale-docs republish was DECLINED; it rides the next real release).

## How we work (contributor ground rules)

1. Consumers of this repo run live services, so consensus changes are the most dangerous edits in the whole ecosystem: write up the design and get maintainer sign-off first, always.
2. Security fixes must not regress UX (no hot-path latency/declines; warn over hard-block).
3. No em dashes in READMEs/user-facing docs; grep for the character before committing, count must be zero.
4. Run `pnpm run audit:all` before merging ANY change to packages/cairnx/src/* or a new gate. test:crosslang only proves the two impls AGREE; they can agree and both be unsound.
5. Releases are maintainer-only: tags and `pnpm publish` happen on maintainer say-so, never speculatively.

## Dev workflow

```bash
pnpm install                     # pnpm@10.32.1 pinned
pnpm -r build                    # BUILD BEFORE TESTING (tsx tests import sibling dists)
pnpm -r test                     # per-package suites
pnpm test:e2e                    # oracle/edge/security (oracle needs CSD_RPC, else skips)
pnpm test:crosslang              # full JS<->Python differential: the REAL fork gate
pnpm run audit:all               # invariants + money-safety + race harness (report-only)
node scripts/check-lockstep.mjs
node scripts/check-consumer-pins.mjs   # cross-repo pin coherence; expects sibling consumer
                                       # checkouts under the same parent dir, skips absent ones
```

Gotchas: pnpm blocks esbuild postinstall unless onlyBuiltDependencies (already set; `pnpm rebuild esbuild` if dist missing). Pre-commit gitleaks hook via .githooks/install.sh. Node 22.

## Testing

- Unit: `pnpm -r test`. cairnx runs vectors, name-decoy, client-helpers, paidto, preflight (gate +/- margin grid), primary.
- Golden vectors: csd-vectors pins the node's golden_vectors.rs + real on-chain data; cairnx pins cases.json + replay-hashes.json (canonical-state sha256 at every activation height).
- Root e2e (independent oracles, never self-grading): test/oracle.test.ts (47+ real on-chain signatures vs SDK-computed sighash, node /tx/template match, live mempool acceptance, chainwork-from-genesis match), edge.test.ts, security.test.ts (hostile RPC/counterparty).
- Cross-language differential (CI fork gate): crosscheck.mjs + crosscheck-regex.mjs (2301-case raw regex differential, the C1 class) + crosscheck-resolve.mjs + crosscheck-siwc.mjs + nprofile-crosslang.mjs + fuzz-resolve.mjs 1500 + one straddle test per gate (v20-v27). Real-chain co-sign conformance lives downstream in the cairnx service repo.
- Money-safety conformance (REPORT-ONLY, deliberately not a CI gate; standing directive is to run and GROW them): audit:invariants (read the COVERAGE line, not just violations; widen fuel before trusting a clean run), audit:money-safety (a burn = rejected resolve().events entry whose paidTo pays the treasury), audit:race (P1 treasury-burn / P2 displacement-burn / P3 payment-without-delivery / P4 byte-identity; run only on a SETTLED tree, mid-rebuild dist reads as fake divergence).
- CI: install --frozen-lockfile, build, check-lockstep, per-package tests, e2e (node-dependent parts skip); conformance job = Python 3.12 + test:crosslang as its own independently enforced job.

## Release and publish

Consensus-touching checklist (CONSENSUS_CHANGES.md): (1) land with golden vectors, (2) bump only changed packages, (3) add a CONSENSUS_CHANGES entry describing exactly what bytes/math changed, (4) full suite against a live node, then `pnpm publish` per package (one-time maintainer token). For a new gate/fee tier follow the V28+ rollout checklist. Vendored consumers (cairn website bundle, wallet SPV bundle) carry PROVENANCE.json regenerated by their own check-vendor-fresh.mjs --write; their CI is red between a core merge here and their re-vendor commit, so land re-vendors promptly.

## Consumer footprint (who pins what, verified 2026-07-21 in the sibling checkouts)

npm-pinning consumers: cairn-cli 0.3.22 pins cairnx-core 0.1.38, csd-codec/csd-crypto 0.1.15, csd-registry 0.1.16. cairn-sdk 0.3.2 (branch rebind/b4b, 0.4.0-to-be) pins cairnx-core 0.1.38 + csd-tx 0.1.17 + csd-light 0.1.18 + csd-client/codec/crypto 0.1.15 + csd-registry 0.1.16. csd-indexer 0.2.9 pins csd-codec/csd-crypto 0.1.15, csd-light 0.1.17, csd-registry 0.1.16. cairnx 0.4.20 (0.4.21-to-be) pins cairnx-core 0.1.38 + csd-tx 0.1.16. The bridge relayer also pins exact versions (testnet-only). ALL cairnx-core consumers re-pin to 0.1.40 at its publish (runbook step; never pin an unpublished version); scripts/check-consumer-pins.mjs asserts pin coherence across whatever sibling checkouts it finds.

Vendored consumers: the cairn website serves the packages server-side and ships PROVENANCE-pinned browser vendor bundles; cairn-wallet ships its own vendored SPV bundle whose PROVENANCE pins an exact csd-sdk version + commit, kept honest by each repo's check-vendor-fresh gate and the shared golden vectors. clarvis (the second-source resolver) runs cairnx-core and must ride every gate bump.

## Gotchas and incident history

- C1, the PROVEN consensus-fork class (2026-06-20): Python re.match(...$) accepts a trailing newline where JS $ rejects; one mined record {"name":"alice\n"} would fork the two resolvers. Fixed with re.fullmatch across 8 validators; the raw regex differential now guards the class. THE motivating incident for the conformance directory.
- 0.1.22 npm-publish incident: raw npm shipped unresolved workspace:*; publish-guard now blocks non-pnpm publishes.
- Dead-green rot: a consumer repo's fail-close test asserted a frozen flag after the lane had already shipped true AND always skipped (optional dep missing), reading green for weeks; the same class was later re-found in another consumer's stats tests. Lesson: mutation-test the guards; a test that cannot fail is worse than no test.
- Race-harness P4 transient divergence: running audits mid-rebuild produced 302 fake divergences once. Settled tree only; heavy audit/mutation runs belong in a disposable git worktree.
- Coverage-gap lesson (5c0bb71): an invariant run under-exercised what it claimed. Read the coverage line; extend fuel first.
- Stale golden vector masked a missing POW-limit gate once (GOLDEN_POW). Vectors must track live params.
- CI pnpm/action-setup reads the version from packageManager; do NOT also pass version:.
- Activation-height re-pins are legal but coordinated-only (the 2026-07-03 V24-V27 pull-in required same-day re-pin of every verifier).

## State snapshot (2026-07-21, REBIND S-06; ephemeral facts live HERE; verify with git/npm before trusting)

Branch rebind/b6 (the REBIND B6 + B9 stack; the 0.1.40 bump commit, --ff-only merge to master, tag `cairnx-core-0.1.40` and publish are close-out/runbook steps). Root csd-sdk 0.1.10 (private, never published). Published npm state:

| Package | npm version |
|---|---|
| cairnx-core | 0.1.38 |
| csd-tx | 0.1.17 |
| csd-light | 0.1.18 |
| csd-registry | 0.1.16 |
| csd-client, csd-codec, csd-crypto, csd-siwc, csd-vectors | 0.1.15 |
| csd-indexwire | 0.1.0 |

In-tree package.json numbers still read the published versions, but the TREE IS AHEAD of npm on this branch (version bumps are deliberately deferred to close-out, per the R3 rule: bump BEFORE the downstream re-vendors regenerate PROVENANCE so csdSdkVersion pins the real number):

- cairnx-core 0.1.40-to-be = the B6 CLIENT-additive surface (opt-in bindOfferTerms give/want-type legs + the MintedProvenOfferTerms brand, fillEndorsement/fillOutputPlan, fclaim-aware claimWindowOf, the M13 publish-guard test gate; SEAL-proven canonical-state byte-identical to 0.1.38 with every opt-in off; tag point for 0.1.39) + the B9 V29 consensus gate @ 88,000 (M4 event de-dup + M5 concurrent-hold status filter; see CONSENSUS_CHANGES.md).
- codec/tx/registry carry the B8-sdklow leaf hardening (verifyMerkleProof boolean-not-throw, node byte caps in builders via MAX_DOMAIN_BYTES/MAX_URI_BYTES, registry URL-encode) riding the same release train.

Gate state: V28 = 60,000 is CROSSING ~2026-07-22/23 (every primary replayer on the v2.8 core). V29 = 88,000 is GATED-pending; the replay-hash V28 baseline re-pin (B8-hash) and the V29 re-pin are post-crossing runbook steps (see the 0.1.40 CONSENSUS_CHANGES entry).

## Cross-repo map

Upstream oracle: the official Rust node (`compute-substrate`). In-repo second implementation: conformance/cairnx_ref.py. Downstream npm consumers: the cairnx trading service, cairn-cli, cairn-sdk, csd-indexer, the bridge relayer; after a consensus bump, re-pin them promptly and never let a live replayer cross a gate height on stale code. Downstream vendored consumers: the cairn website and cairn-wallet, each with its own vendor-build script + PROVENANCE freshness check. Real-chain conformance (live co-sign and vendor-parity tests) lives downstream in those repos. Deeper audit history and rollout runbooks are maintained privately by the maintainers.
