# csd-sdk

The guide for maintainers and coding agents; `CLAUDE.md` is a symlink to this file and `README.md` is for users.
Production and operations specifics (hosts, services, deploy cadence) are out of scope here and maintained privately.

The L0 SDK monorepo of the CSD (Compute Substrate) chain: a pnpm and tsup TypeScript workspace that publishes the
`@inversealtruism/*` packages under `packages/` to npm (public repo InverseAltruism/csd-sdk). It is the one TypeScript
implementation of the chain's byte-level consensus surface (serialization, txid, sighash, header, PoW and LWMA math,
merkle) and, in `cairnx-core`, of the CairnX convention (tokens, .csd names, DvP trades). Every consumer imports it or
vendors a deterministic bundle of it. The one other implementation is the independent Python oracle in
`conformance/`, used only for differential testing. Runtime dependencies are @noble/curves and @noble/hashes only,
and no package uses `Buffer`, so the packages run in a browser and an MV3 extension.

## Check

```bash
pnpm install --frozen-lockfile   # the pnpm version is pinned in packageManager
pnpm -r build                    # first: the tests and the typecheck read the sibling packages' dist/
pnpm typecheck                   # tsc, strict and noUncheckedIndexedAccess, over src, the tests, the examples and the release scripts
pnpm lint                        # Biome, four rules: unused imports, empty blocks, focused tests, @ts-ignore
pnpm check:dashes-paths          # em dashes in tracked docs, sibling paths in code (scripts/dashes-exceptions.json)
pnpm -r test                     # per-package suites, offline
pnpm test:e2e                    # live opt-in guard + edge/security (their live parts run only with CSD_RPC set)
pnpm test:crosslang              # full JS<->Python differential: the fork gate (needs python3)
pnpm run audit:all               # citation check (hard), audit self-tests, invariants, money-safety, race harness
node scripts/check-lockstep.mjs  # workspace pins, published pins and dist, dist freshness (queries npm)
node scripts/npm-window.mjs      # the npm window in check mode: pack, guard, verify-tarball; publishes nothing
pnpm exec tsx packages/replica/scripts/exit-check.ts   # the replica, pin and anchors installed from packed tarballs, against recorded answers
pnpm test:live                   # needs CSD_RPC: the oracle and the client and light live suites; never in CI
node scripts/check-consumer-pins.mjs   # cross-repo pin coherence over sibling consumer checkouts; skips absent ones
```

CI runs Node 22. The pre-commit secret scan is installed with `bash .githooks/install.sh`. The test layers, the audit
tools, the CI jobs and local setup notes are in `docs/testing-and-ci.md`.

## Standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The part that binds a
contributor here:

- One home per concept: a rule, constant, type or encoder lives in one place and is imported everywhere else.
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary. Money is
  integer base units, never floats: `bigint` in cairnx-core; csd-tx and csd-client take and return CSD amounts (coin
  values, outputs, fees, totals) as `number`, each checked with `Number.isSafeInteger` and refused at 2^53 or above,
  and csd-codec's `u64` takes a `bigint` or refuses a `number` that is not a safe integer. No empty `catch {}`; on
  money paths no catch-and-continue that hides a failure.
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the
  honest path still passes with the call shape production sends. A skipped test names its reason and when it
  un-skips. No test reads another repo's working tree.
- Comments state constraints and non-obvious invariants, not history or audit IDs. Removing code needs the same
  evidence as adding it.
- Docs: this file holds what stays true (no version tables, no status snapshots; versions live in `package.json` and
  tags, live state comes from a live query). History goes to `docs/incidents/` or a package CHANGELOG. Dates are
  absolute, no em dashes.

Known deviations: `scripts/check-consumer-pins.mjs` reads sibling consumer checkouts when present (skips absent
ones); `packages/cairnx/test/primary.test.ts` reads the sibling cairnx fixture when present; comment essays and
audit-ID markers in `packages/cairnx/src` are trimmed per module, not as drive-by edits.

## Code map

Per-package and per-module detail, the gate list and the consumers are in `docs/architecture.md`.

- `packages/codec` (csd-codec): the consensus codec (bincode, txid, sighash, header, bits and target, merkle,
  canonicalJson and payloadHash).
- `packages/crypto` (csd-crypto): secp256k1 signing and the node's verify rule, addresses, script helpers. Thin noble
  wrappers, no hand-rolled crypto.
- `packages/tx` (csd-tx): the tx builders (the `*Verified` builders are the current ones), signing, fee caps.
- `packages/client` (csd-client): the typed RPC client and `verifyInputValues`.
- `packages/light` (csd-light): the light client (headers, PoW, LWMA, chainwork, inclusion proofs, the block bind);
  every read carries an honest `trustLevel`.
- `packages/vectors` (csd-vectors): the golden vectors from the node and from real chain data.
- `packages/cairnx` (cairnx-core): `resolve(events, tipHeight)`, the pure replay, with `CONVENTION.md`, the normative
  spec, and the portable vectors. `src/types.ts` holds every gate height, fee constant and regex; `src/verifyfill.ts`
  is the fail-closed fill fund boundary. The `./mm` export (`src/mm`) is the market maker's math and is not
  consensus: `resolve()` reads none of it and the root export does not include it.
- `packages/siwc` (csd-siwc): Sign in with CSD, with its own Python reference.
- `conformance/`: the Python oracles, the cross-language differential and the report-only audit tools.
- `scripts/`: the release and check scripts. `test/`: root tests of those scripts, of CI and the e2e suites.

## Invariants and red lines

Consensus:

- Byte-identity with the Rust node (`compute-substrate`) is the prime invariant. Any change to tx/sighash/header
  bytes, LWMA/chainwork math, merkle acceptance, or the CairnX replay must be recorded in `CONSENSUS_CHANGES.md`,
  pinned by a golden vector before landing, and gated on an activation height. Reject-more hardening is allowed;
  accept-different never silently.
- Consensus code lives only in this repo; byte-exact golden vectors and the Python oracle cover every encoder and
  resolver rule.
- Every pre-existing canonical-state replay hash stays byte-identical across any refactor (proved by
  `packages/cairnx/test/vectors/replay-hashes.json`). If a hash moves, something forked.
- The Python oracle is independent by design, written from the spec, never transliterated from the JS (the C1 regex
  class in `docs/incidents/README.md` is why).
- Numeric-key trap (CONVENTION 5.1 A2): canonicalJson sorts keys pure code-unit ("10" before "2") but canonicalState
  inherits JSON.stringify enumeration (integer keys ascending-numeric first). Both must be reproduced; pinned by
  vector.
- Golden vectors track live parameters; a stale vector once masked a missing proof-of-work-limit gate.
- All gate heights live in `packages/cairnx/src/types.ts`; gates are height-pure and non-retroactive. Whether a gate
  is crossed is a live fact: compare its height with the live tip (`docs/architecture.md` names the endpoints).
- RESERVED_NAMES is consensus and lives here (`types.ts`, enforced by `records.ts` `isName`, mirrored in
  `conformance/cairnx_ref.py`). It is the chain's only name blocklist (no profanity filter exists anywhere); changing
  it is a fork, same rules as a gate.
- claimWindowOf is a depth hint, never a sole fund gate (it is published npm surface): it can over-state burial on an
  expiry-capped hold. Consumers gate funds on verifyFillSpv's independently computed merkle burial; `verifyfill.ts`
  derives depth from the proven events and never imports claimWindowOf. The arithmetic is in `docs/architecture.md`.

Adoption-gate discipline:

- Fee increases hurt stale verifiers (an attacker pays the old fee, a stale wallet accepts); relaxations hurt stale
  replayers (they reject what the chain accepts). Both mean every replayer is upgraded before the height, never
  "publish and hope".
- The V28+ rollout checklist at the bottom of `CONSENSUS_CHANGES.md` is the normative procedure: core change ->
  vectors -> bump/publish -> re-pin npm consumers -> re-vendor bundled consumers -> grep raw height literals -> CDN
  cache purge.
- Moving an activation height is legal but only as a coordinated change with a same-day re-pin of every verifier.

Packaging and publishing (what each script checks, and why, is in `docs/release.md`):

- `scripts/check-lockstep.mjs` enforces: intra-workspace deps are `workspace:*` (pnpm rewrites them to exact versions
  at pack time; no caret ships, with one exception: cairnx-pin peers on cairnx-replica as `workspace:^`, packed as
  `^<version>`, because it uses the replica for a type alone, `RANGE_PEERS` in the script); every package version already on npm pins the current workspace versions of
  its deps; for a version already on npm the registry tarball's `dist/` is byte-identical to this tree's build, so a
  source change needs a version bump; `dist/` is not older than `src/` for versions not yet on npm; a package with a
  CHANGELOG.md lists it in `files`. `test/check-lockstep.test.ts` pins the `workspace:*` rule, the one range
  peer, the published peer pin, the published dist compare and its integrity check.
- A window publishes through `scripts/npm-window.mjs`, never by hand. The run needs a clean tree whose HEAD is on
  the first-parent line of `origin/master` (a merge or direct commit on master, not a commit inside a pull request
  merged with a merge commit; a rebased or fast-forwarded branch's commits are on the line and are admitted) and a
  typed `publish`. `test/npm-window.test.ts` pins that a local change, `CSD_PUBLISH_SKIP_TESTS`, a HEAD off that
  line, a failing publish guard or a failing verify-tarball each fail the window, and that a run with a failed check
  never reaches the publish step.
- The maintainer runs a window only from a fresh worktree created at the release commit
  (`git worktree add --detach <path> <commit>`, `git rev-parse HEAD` in it printing that commit, then
  `pnpm install --frozen-lockfile --offline` and `pnpm -r build`), never from a working checkout: the window binds
  the tarball to HEAD, not the build's inputs, and npm-window does not itself check that it runs from such a
  worktree.
- `scripts/publish-guard.mjs` (every package's `prepublishOnly`) refuses a non-pnpm client for a publish from a
  package directory (pinned in `test/check-lockstep.test.ts`); every package's `prepack` runs its build, so a packed
  tarball carries a dist built from the tree.
- Independent versioning (strict lockstep deliberately abandoned; do not re-litigate): bump the packages you changed
  and every workspace package that depends on them, because a published version keeps the exact pins it shipped
  with. Numbers need not match. A devDependency pin alone does not require a bump.
- Consumers pin exact versions; a lockfile never resolves two different csd-codec copies (sign with one encoding,
  verify with another).
- npm tokens are not stored: the maintainer supplies a one-time token per window in a mode-600 file outside the repo,
  then deletes the file and revokes the token after the window.
- Do not republish for docs alone; docs changes ride the next real release.

## How we work (contributor ground rules)

1. Consumers of this repo run live services, so consensus changes are the most dangerous edits in the whole
   ecosystem: write up the design and get maintainer sign-off first.
2. Security fixes must not regress UX (no hot-path latency or declines; warn over hard-block).
3. No em dashes in any doc; `grep -cP '\x{2014}' <file>` must print 0 before committing (`pnpm check:dashes-paths`
   checks every tracked doc in CI).
4. Run `pnpm run audit:all` before merging any change to packages/cairnx/src/* or a new gate. test:crosslang only
   proves the two implementations agree; they can agree and both be unsound.
5. Releases are maintainer-only: tags and npm windows happen on maintainer say-so, never speculatively.

## Testing rules

- A test that cannot fail is worse than none: mutation-test every guard.
- The live-node suites run only from `pnpm test:live`, never in CI (`test/ci-workflow.test.ts` pins that no CI step
  runs one; `test/live-opt-in.test.ts` pins that an opted-in suite fails when its node does not answer).
- `pnpm test:crosslang` is the fork gate and its own CI job, with `audit:all`. Audit findings are report-only: a
  finding never fails the build, but a failed self-test, a stale citation or a JS/Python divergence does. Run the
  audits and grow them.
- audit:invariants: read the `coverage reached:` line, not only the violations; widen fuel before trusting a clean
  run. audit:race: run it only on a settled tree (a mid-rebuild dist reads as fake divergence). Heavy audit and
  mutation runs belong in a disposable git worktree.
- cairnx-core's glob runner (`packages/cairnx/test/run.mjs`) runs every `test/*.test.ts` and refuses to report green
  below its discovery floor.
- Tests pin CI's shape: every `uses:` is pinned to a full commit SHA, the workflow token is read-only, no checkout
  keeps credentials and gitleaks scans the full history (`test/ci-workflow.test.ts`); every job runs on a fixed
  runner image, not `-latest` (`test/ci-runner-image.test.ts`); lint enables exactly the four rules
  (`test/lint-config.test.ts`). pnpm/action-setup reads the version from `packageManager`; do not also pass
  `version:`.

## Release and publish

Tags and npm windows are maintainer actions (rule 5). For a consensus-touching change (`CONSENSUS_CHANGES.md`):

1. Land with golden vectors.
2. Bump changed packages and their workspace dependents.
3. Add a `CONSENSUS_CHANGES.md` entry describing exactly what bytes or math changed.
4. Run the full suite against a live node, then the npm window (`node scripts/npm-window.mjs`, check mode first;
   one-time maintainer token).

For a new gate or fee tier follow the V28+ rollout checklist.

## Consumers and the cross-repo contract

- Upstream oracle: the official Rust node. The node never depends on the SDK.
- Downstream: cairnx (the trading service), the cairn web server, cairn-sdk, csd-indexer and clarvis (the
  second-source resolver) pin exact npm versions; the cairn website and cairn-wallet also ship vendored bundles with a
  `PROVENANCE.json`, regenerated by their own `check-vendor-fresh.mjs --write`. Detail: `docs/architecture.md`.
- After a consensus bump re-pin or re-vendor them promptly, and never let a live replayer cross a gate height on
  stale code. clarvis runs cairnx-core and must ride every gate bump.
- A re-pinned `package.json` is inert until that service restarts: confirm each replayer by live query before a gate
  height, never by reading a manifest.
- Deeper audit history and rollout runbooks are maintained privately by the maintainers.

## Docs

- `README.md`: what the packages are, install, quick start; `packages/*/README.md`: one per published package.
- `CONSENSUS_CHANGES.md`: every height-gated change and the two release checklists; `docs/gates/`: one file per gate
  after v2.9, from `docs/gates/TEMPLATE.md`, linked from its ledger entry. The citations of both are checked by
  `scripts/check-consensus-citations.mjs`.
- `docs/architecture.md`: packages, cairnx-core modules, the gate list, claimWindowOf, consumers.
- `docs/release.md`: check-lockstep, the npm window, the token, versioning.
- `docs/testing-and-ci.md`: test layers, audit tooling, CI jobs, local setup.
- `docs/incidents/README.md`: the incidents and lessons behind the rules in this file.
- `packages/cairnx/CONVENTION.md`: the normative CairnX convention; `packages/cairnx/MAKERS.md`: the protocol-level
  market maker guide (both ship in the npm package); `packages/cairnx/CHANGELOG.md`: cairnx-core release notes;
  `packages/cairnx/test/vectors/VECTORS.md`: the portable conformance artifacts.
- `conformance/README.md`, `conformance/AUDIT.md`: the cross-language differential and the report-only audit method.
- `.githooks/README.md`: the secret-scan pre-commit hook.
