# csd-sdk

> Onboarding briefing for coding agents and contributors. `AGENTS.md` is the canonical briefing; `CLAUDE.md` is a symlink to it. Production and operations specifics (hosts, services, deploy cadence) are intentionally out of scope here and maintained privately.

The L0 SDK monorepo for the CSD (Compute Substrate) chain: a pnpm + tsup TypeScript workspace publishing 9 npm packages under `@inversealtruism/*` (public repo InverseAltruism/csd-sdk). It is the single canonical TypeScript implementation of the chain's byte-level consensus surface (serialization, txid, sighash, header/PoW/LWMA math, merkle) and of the CairnX application convention (tokens, .csd names / CNS, DvP trades) via `cairnx-core`. Everything it produces must be byte-for-byte identical to the official Rust node (`compute-substrate`), checked against the node's golden vectors and real mainnet data.

There are two implementations of the consensus surface: this shipped TypeScript core, imported or deterministically vendored by every consumer (wallet, website UI and server, cairnx service, indexer, cairn-sdk, second-source resolvers), and one independent Python oracle (`conformance/cairnx_ref.py`) used only for cross-language differential testing. Runtime deps are only @noble/curves + @noble/hashes; zero Buffer (MV3/browser-safe).

## Cross-repo standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The rules that matter for a contributor here:

- One home per concept: a rule, constant, type or encoder lives in one place and is imported everywhere else. Consensus code lives only in this repo; byte-exact golden vectors and the Python oracle cover every encoder and resolver rule; height-gated changes are recorded in `CONSENSUS_CHANGES.md`.
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary. Money is integer base units (`bigint`), never floats. No empty `catch {}`; on money paths no catch-and-continue that hides a failure.
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the honest path still passes with the call shape production sends. A skipped test names its reason and when it un-skips. No test reads another repo's working tree.
- Comments state constraints and non-obvious invariants, not history or audit IDs. Removing code needs the same evidence as adding it.
- Docs: this file holds what stays true (no version tables, no status snapshots; versions live in `package.json` and tags, live state comes from a live query). History goes to `docs/incidents/` or a package CHANGELOG. Dates are absolute, no em dashes.

Known deviations (checked 2026-10-22, not exhaustive): `scripts/check-consumer-pins.mjs` reads sibling consumer checkouts when present (skips absent ones); `packages/cairnx/test/primary.test.ts:63` reads the sibling cairnx fixture when present; comment essays and audit-ID markers in `packages/cairnx/src` are trimmed per module, not as drive-by edits.

## The stack around it

The chain is the only source of truth; every layer above is a deterministic replay. This repo is the consensus mirror the whole app layer runs on: the cairn web front end (https://cairn-substrate.com) pins packages for its server and vendors its browser bundles, the cairnx trading service pins cairnx-core, the wallet vendors an SPV bundle, cairn-sdk and csd-indexer pin packages, and clarvis runs a second-source resolver on the same core. The Rust node is the upstream oracle; the node never depends on the SDK.

## Architecture (packages)

Workspace: `pnpm-workspace.yaml` = packages/*. Root package.json is private; `packageManager: pnpm@10.32.1`. All packages build with tsup (esm+cjs+dts). Versions are not listed in this file: read `packages/*/package.json` (workspace) or `npm view @inversealtruism/<pkg> version` (published).

| Package | Purpose |
|---|---|
| csd-codec | Consensus codec: bincode fixint-LE, txid, sighash CSD_SIG_V1 (sha256d over taggedHash + CHAIN_ID_HASH), 84-byte header, bits<->target, merkle root/branch/proof, canonicalJson/payloadHash. Only dep: @noble/hashes. |
| csd-crypto | secp256k1 keygen/signDigest (low-S, RFC-6979)/verifyDigest (fail-closed), hash160 addresses, addrFromScriptPubkey (the node's address parser), buildScriptSig, authorOf (a tx's author: the owner of the coin input 0 spends, when the scriptSig is that owner's signature). Thin noble wrappers, no hand-rolled crypto. |
| csd-tx | Tx builder: selectInputs (dedupe, unconfirmed-drop, 512 cap), buildSendVerified (takes a verifier such as csd-client verifyInputValues and computes change from the verified input total), buildProposeVerified/buildAttestVerified (DvP value outputs), the deprecated buildSend and unverified buildPropose/buildAttest, signTx, txToNodeJson, feeCap helpers. |
| csd-client | Typed HTTP RPC client; 4xx doesn't spend retry budget; hostile-boundary tested. Transport, plus verifyInputValues (recomputes each input's source txid). Bodies parse with parseJsonExact by default (an integer above 2^53 stays an exact bigint). |
| csd-light | Light client: headers-first sync, client-side PoW + LWMA-45 bits re-derivation + chainwork + MTP/timestamp rules, verifyTxInclusion, bindBlockBody (the one block bind: exact parse, repeated-txid refusal, merkle compare to a verified header), syncFromCheckpoint, honest trustLevel on every read (balance is rpc-trusted); tipHeaderPowOk and contenderPlausible, the checks before a non-primary RPC backend may win routing. |
| csd-vectors | Golden conformance vectors from the node's frozen golden_vectors.rs + real on-chain data. Zero deps. |
| cairnx-core (packages/cairnx) | `resolve(events, tipHeight) -> canonical state`, pure deterministic replay (tokens, names+lease+commit-reveal, offers, bids, fills, fees). Ships the normative CONVENTION.md (section 32 is the v2.9 M4/M5 write-up) + portable vectors + replay-hashes. Modules below. |
| cairnx-core/mm (packages/cairnx/src/mm, export `./mm`) | The market maker's sizing and Sunrise pricing math, shared by the maker service and the site. Not consensus: resolve() reads none of it and the root export does not include it. |
| csd-siwc | Sign in with CSD: audience-bound, replay-resistant wallet auth; own Python ref (siwc_ref.py). |
| csd-indexwire | csd-indexer REST wire contract as types + runtime guards. |

cairnx-core modules (`packages/cairnx/src/`):

- `resolve.ts`: the replay loop; its per-record handlers and shared state context live in `resolve/`.
- `types.ts`: all gate heights, fee constants, regexes, RESERVED_NAMES, and the pure client selectors including claimWindowOf.
- `records.ts`: parseRecord/onlyKeys.
- `preflight.ts`: previewFill, requiredFillOutputs, buildFeeHeight, fillIsSafe, finalizeWinnerCheck, fillEndorsement, fillOutputPlan.
- `verifyfill.ts`: verifyFillSpv + bindOfferTerms, the shared fail-closed fill fund boundary.
- `primary.ts`: pickPrimaryName.
- `client.ts`: claim-burial depth helpers.
- `paidto.ts`: outputs to paidTo aggregation for ChainEvent builders.
- `fillclosed.ts`: whether a buyer's proven fill closed the offer behind its fclaim hold.

`conformance/`: cairnx_ref.py + siwc_ref.py (independent Python oracles, written from spec, kept independent), crosscheck*.mjs, fuzz-resolve.mjs, per-gate v2x-*-crosslang.mjs, and the report-only audit tooling: invariants.mjs (7 ledger-soundness invariants), money-safety.mjs (anchored-then-rejected burn detector), race-harness.mjs (adversarial multi-actor races; P4 JS==Python byte-identity alone exits 1), AUDIT.md (method doc).

## Consensus gates

All gate heights live in `packages/cairnx/src/types.ts`; gates are height-pure and non-retroactive.

- V16 = 33,600: fee 1% -> 1.5% + maker rebate.
- V17 = 34,000: claim-to-fill.
- V19 = 36,700: nprofile.
- V20 = 38,400: late-fill fund-loss fix, claim window 15 -> 40 + 5 grace.
- V18 = 40,000: 2-tier name fee.
- V21 = 40,100: offer duration cap 168 epochs.
- V22 = 41,300: cap removed for offers >= V22.
- V24 = 46,400: 4-tier name fee 15/10/5/3 CSD.
- V25 = 46,440: sealed reservation (payment-free reveal, winner-only nfinalize).
- V26 = 46,480: sealed recapture.
- V27 = 46,520: young-name sale embargo 240 -> 8 blocks.
- V23 = 52,000: nset-clear to zero addr.
- V28 = 60,000: fclaim open-lane settlement atomicity (CONVENTION section 31).
- V29 = 88,000: M4 event de-dup + M5 concurrent-hold status filter (v2.9).

Whether a gate is crossed is a live fact: compare its height with the tip from https://cairn-substrate.com/api/rpc/tip (the `gates` field of /trade/api/cairnx/health lists V24 to V29). History and rollout notes: CONSENSUS_CHANGES.md.

RESERVED_NAMES (csd, treasury, admin, official, root, www, support) is consensus and lives here: defined in packages/cairnx/src/types.ts, enforced by records.ts isName, mirrored in conformance/cairnx_ref.py. It is the chain's only name blocklist (no profanity filter exists anywhere); changing it is a fork, same rules as a gate.

Adoption-gate discipline:

- Fee increases hurt stale verifiers (an attacker pays the old fee, a stale wallet accepts); relaxations hurt stale replayers (they reject what the chain accepts). Both mean every replayer is upgraded before the height, never "publish and hope".
- The V28+ rollout checklist at the bottom of CONSENSUS_CHANGES.md is the normative procedure: core change -> vectors -> bump/publish -> re-pin npm consumers -> re-vendor bundled consumers -> grep raw height literals -> CDN cache purge.
- Moving an activation height is legal but only as a coordinated change with a same-day re-pin of every verifier.

## Invariants and red lines

Consensus:

- Byte-identity with the Rust node is the prime invariant. Any change to tx/sighash/header bytes, LWMA/chainwork math, merkle acceptance, or the CairnX replay must be recorded in CONSENSUS_CHANGES.md, pinned by a golden vector before landing, and gated on an activation height. Reject-more hardening is allowed; accept-different never silently.
- Every pre-existing canonical-state replay hash stays byte-identical across any refactor (proved by `packages/cairnx/test/vectors/replay-hashes.json`). If a hash moves, something forked.
- The Python oracle is independent by design, written from the spec, never transliterated from the JS (the C1 regex class in `docs/incidents/README.md` is why).
- Numeric-key trap (CONVENTION 5.1 A2): canonicalJson sorts keys pure code-unit ("10" before "2") but canonicalState inherits JSON.stringify enumeration (integer keys ascending-numeric first). Both must be reproduced; pinned by vector.
- Golden vectors track live parameters; a stale vector once masked a missing proof-of-work-limit gate.

claimWindowOf is a depth hint, never a sole fund gate (it is published npm surface):

- For an fclaim hold (claimTxid passed) it returns FCLAIM_WINDOW_MIN = 46, the minimum span an fclaimEpochFor-requested hold can carry, so the derived grant is normally no earlier than the true grant and depth is under-stated (fail-safe).
- An expiry-capped hold (E clamped to the offer's expiry) can carry a true span < 46. There the derived grant is earlier than the true grant and claimWindowOf-derived depth over-states burial by (46 - true span) blocks, early in the hold. Against the older 40-block inverse this adds at most 6 blocks of over-statement; spans < 40 were over-stated under that constant too.
- Consumers gate funds on verifyFillSpv's independently computed merkle burial (verifyfill.ts derives depth from the proven events and never imports claimWindowOf), as the site swapguard and wallet do.

Packaging (enforced by `scripts/check-lockstep.mjs`):

- Intra-workspace deps are `workspace:*`; pnpm rewrites them to exact versions at pack time. No caret ever ships.
- Published pins: every package version already on npm pins the current workspace versions of its deps.
- Published dist: for a version already on npm, the registry tarball (sha512-verified) holds byte-identical `dist/` files to this tree's build, so a source change needs a version bump. It detects that accident (one version, two code states), not a hostile tarball crafted to extract differently under npm and not a newly published version. The reader in `scripts/published-dist.mjs` refuses every archive shape `pnpm pack` does not emit. It compares files, not a whole-tarball hash, because pnpm orders the packed package.json dependencies nondeterministically (see `docs/incidents/README.md`).
- Dist freshness: `dist/` is not older than `src/`, for versions not yet on npm.
- A package with a CHANGELOG.md lists it in `files`, since pnpm pack does not add it.

Publishing:

- pnpm publish, never npm publish. Every package's prepublishOnly runs `scripts/publish-guard.mjs`, which refuses a non-pnpm client (raw npm once shipped unresolved `workspace:*`).
- Every package's prepack runs its build, so a packed tarball carries a dist built from the tree. pnpm runs prepublishOnly before prepack, so the guard's tests see the dist that existed; the dist-freshness leg covers that gap.
- Independent versioning (strict lockstep deliberately abandoned; do not re-litigate): bump the packages you changed and every workspace package that depends on them, because a published version keeps the exact pins it shipped with. Numbers need not match.
- Consumers pin exact versions; a lockfile never resolves two different csd-codec copies (sign with one encoding, verify with another).
- npm tokens are not stored: a maintainer supplies a one-time token per publish (temp gitignored .npmrc, deleted and revoked immediately; redact npm_* in any output).
- Do not republish for docs alone; docs changes ride the next real release.

## How we work (contributor ground rules)

1. Consumers of this repo run live services, so consensus changes are the most dangerous edits in the whole ecosystem: write up the design and get maintainer sign-off first.
2. Security fixes must not regress UX (no hot-path latency or declines; warn over hard-block).
3. No em dashes in any doc; `grep -cP '\x{2014}' <file>` must print 0 before committing (`pnpm check:dashes-paths` checks every tracked doc in CI).
4. Run `pnpm run audit:all` before merging any change to packages/cairnx/src/* or a new gate. test:crosslang only proves the two implementations agree; they can agree and both be unsound.
5. Releases are maintainer-only: tags and `pnpm publish` happen on maintainer say-so, never speculatively.

## Dev workflow

```bash
pnpm install                     # pnpm@10.32.1 pinned
pnpm -r build                    # build before testing: tsx tests import sibling dists
pnpm typecheck                   # tsc over packages/*/src, packages/*/test and test/ (strict, noUncheckedIndexedAccess)
pnpm lint                        # Biome, four rules: unused imports, empty blocks, focused tests, @ts-ignore
pnpm check:dashes-paths          # em dashes in tracked docs, sibling-checkout paths in code (exceptions in scripts/dashes-exceptions.json)
pnpm -r test                     # per-package suites
pnpm test:e2e                    # live opt-in guard + edge/security (their live parts run only with CSD_RPC set)
pnpm test:live                   # needs CSD_RPC: the oracle and the client and light live suites; never in CI
pnpm test:crosslang              # full JS<->Python differential: the fork gate
pnpm run audit:all               # check-consensus-citations (hard) + invariants + money-safety + race harness
node scripts/check-lockstep.mjs
node scripts/check-consumer-pins.mjs   # cross-repo pin coherence; expects sibling consumer
                                       # checkouts under the same parent dir, skips absent ones
```

Gotchas:

- pnpm blocks the esbuild postinstall unless it is in onlyBuiltDependencies (already set; `pnpm rebuild esbuild` if dist is missing).
- Pre-commit gitleaks hook via `.githooks/install.sh`. Node 22.
- CI's pnpm/action-setup reads the version from packageManager; do not also pass `version:`.

## Testing

- Unit: `pnpm -r test`. cairnx-core's glob runner `packages/cairnx/test/run.mjs` runs every `test/*.test.ts` and refuses to report green below its discovery floor.
- Golden vectors: csd-vectors pins the node's golden_vectors.rs + real on-chain data; cairnx pins cases.json + replay-hashes.json (canonical-state sha256 at every activation height).
- Root e2e (independent oracles, never self-grading): edge.test.ts, security.test.ts (hostile RPC/counterparty).
- Live (`pnpm test:live`, needs CSD_RPC, not in CI; `test/ci-workflow.test.ts` pins that): test/oracle.test.ts (real on-chain signatures vs SDK-computed sighash, node /tx/template match, chainwork-from-genesis match, real-tx round trip), packages/client/test/client.test.ts, packages/light/test/light.test.ts.
- Cross-language differential (CI fork gate): crosscheck.mjs, crosscheck-regex.mjs (raw regex differential, the C1 class), crosscheck-resolve.mjs, replay-corpus-crosslang.mjs (the committed on-chain corpus at every pinned height), crosscheck-siwc.mjs, nprofile-crosslang.mjs, fuzz-resolve.mjs 1500, and one straddle test per gate (v20-v29). Real-chain co-sign conformance (live co-sign and vendor-parity tests) lives downstream in the consumer repos.
- A test that cannot fail is worse than none: mutation-test every guard (see the dead-green entry in `docs/incidents/README.md`).

Money-safety conformance is report-only: CI runs it through `audit:all`, but a finding never fails the build. Run it and grow it.

- audit:invariants: read the `coverage reached:` line, not only the violations; widen fuel before trusting a clean run.
- audit:money-safety: a burn is a rejected resolve().events entry whose paidTo pays the treasury.
- audit:race: P1 treasury-burn, P2 displacement-burn, P3 payment-without-delivery, P4 byte-identity. Run it only on a settled tree (a mid-rebuild dist reads as fake divergence); heavy audit and mutation runs belong in a disposable git worktree.

CI:

- install --frozen-lockfile, typecheck, lint (blocking; `test/lint-config.test.ts` pins that biome.json enables exactly the four rules), the consensus citation check, build, check-lockstep, per-package tests, edge and security (their node-dependent parts skip), and the live opt-in guard (`test/live-opt-in.test.ts`: an opted-in live suite fails when its node does not answer).
- The conformance job runs Python 3.12 + test:crosslang + `audit:all` as its own independently enforced job (audit findings stay report-only; a failed self-test, stale citation or JS/Python divergence fails it).
- A `secrets` job runs gitleaks over the full history (release binary, sha256 checked).
- Every `uses:` is pinned to a full commit SHA with its tag in a trailing comment; the workflow token is read-only and no checkout keeps credentials (`test/ci-workflow.test.ts` pins this shape).

## Release and publish

Consensus-touching checklist (CONSENSUS_CHANGES.md):

1. Land with golden vectors.
2. Bump changed packages and their workspace dependents.
3. Add a CONSENSUS_CHANGES entry describing exactly what bytes or math changed.
4. Run the full suite against a live node, then `pnpm publish` per package, dependencies before dependents (one-time maintainer token).

For a new gate or fee tier follow the V28+ rollout checklist. Vendored consumers (cairn website bundle, wallet SPV bundle) carry PROVENANCE.json regenerated by their own check-vendor-fresh.mjs --write; their CI is red between a core merge here and their re-vendor commit, so land re-vendors promptly.

## Consumer footprint

npm-pinning consumers: cairnx (trading service), the cairn web server, cairn-sdk, csd-indexer and clarvis pin exact versions; `node scripts/check-consumer-pins.mjs` reports the cairnx-core pins of cairnx, cairn-sdk and clarvis. A re-pinned package.json is inert until that service restarts, so a coherent pin table is not the same as a coherent fleet: confirm each replayer by live query before a gate height, never by reading a manifest.

Vendored consumers: the cairn website serves the packages server-side and ships PROVENANCE-pinned browser vendor bundles; cairn-wallet ships its own vendored SPV bundle whose PROVENANCE pins an exact csd-sdk version + commit, kept honest by each repo's check-vendor-fresh gate and the shared golden vectors. Each freshness gate compares bytes, so a docs-only commit past that pin is a warning, not a failure, and the pin is refreshed by that repo's own `check-vendor-fresh.mjs --write` on its next vehicle. clarvis (the second-source resolver) runs cairnx-core and must ride every gate bump.

## Cross-repo map

Upstream oracle: the official Rust node (`compute-substrate`). In-repo second implementation: conformance/cairnx_ref.py. Downstream npm and vendored consumers are listed under "The stack around it" and "Consumer footprint"; after a consensus bump re-pin or re-vendor them promptly and never let a live replayer cross a gate height on stale code. Deeper audit history and rollout runbooks are maintained privately by the maintainers.

## Docs

| Doc | Holds |
|---|---|
| `README.md` | what the packages are, install, quick start |
| `CONSENSUS_CHANGES.md` | every height-gated change, with the V28+ rollout checklist at the bottom; cited by `scripts/check-consensus-citations.mjs` |
| `docs/incidents/README.md` | the incidents and lessons behind the rules in this file |
| `packages/cairnx/CONVENTION.md` | the normative CairnX convention (ships in the npm package) |
| `packages/cairnx/CHANGELOG.md` | cairnx-core release notes |
| `packages/cairnx/MAKERS.md` | protocol-level market maker guide (ships in the npm package) |
| `packages/cairnx/test/vectors/VECTORS.md` | the portable conformance artifacts |
| `packages/*/README.md` | one readme per published package |
| `conformance/README.md`, `conformance/AUDIT.md` | the cross-language differential and the report-only audit method |
| `.githooks/README.md` | the secret-scan pre-commit hook |

The cross-repo standard is a private document; the summary above is the part that binds a contributor here.
