# Testing and CI

The test layers, the report-only audit tooling and what CI runs. The rules are in `AGENTS.md`; the cross-language
differential is described in `conformance/README.md` and the audit method in `conformance/AUDIT.md`.

## Test layers

- Unit: `pnpm -r test`. Build first (`pnpm -r build`): the tsx tests import the sibling packages' dists. cairnx-core's
  glob runner `packages/cairnx/test/run.mjs` runs every `test/*.test.ts` and refuses to report green below its
  discovery floor.
- Golden vectors: csd-vectors pins the node's golden_vectors.rs + real on-chain data; cairnx pins cases.json +
  replay-hashes.json (canonical-state sha256 at every activation height).
- Root e2e (independent oracles, never self-grading), `pnpm test:e2e`: `test/live-opt-in.test.ts`,
  `test/edge.test.ts`, `test/security.test.ts` (hostile RPC/counterparty). Their live parts run only with `CSD_RPC`
  set.
- Live (`pnpm test:live`, needs `CSD_RPC`, not in CI; `test/ci-workflow.test.ts` pins that): `test/oracle.test.ts`
  (real on-chain signatures vs SDK-computed sighash, node /tx/template match, chainwork-from-genesis match, real-tx
  round trip), `packages/client/test/client.test.ts`, `packages/light/test/light.test.ts`.
- Cross-language differential (`pnpm test:crosslang`, the CI fork gate, needs python3): crosscheck.mjs,
  crosscheck-regex.mjs (raw regex differential, the C1 class), crosscheck-resolve.mjs, replay-corpus-crosslang.mjs
  (the committed on-chain corpus at every pinned height), crosscheck-siwc.mjs, nprofile-crosslang.mjs,
  fuzz-resolve.mjs 1500, one straddle test per gate (v20-v29), v20-incident-69csd.mjs,
  proven-terms-classification.mjs and unreachability-premises.mjs. The `test:crosslang` script in the root
  `package.json` is the list. Real-chain co-sign conformance (live co-sign and vendor-parity tests) lives downstream
  in the consumer repos.
- A test that cannot fail is worse than none: mutation-test every guard (see the dead-green entry in
  `docs/incidents/README.md`).

## Audit tooling (report-only)

Money-safety conformance is report-only: CI runs it through `audit:all`, but a finding never fails the build. Run it
and grow it. `pnpm run audit:all` runs the consensus citation check (hard), the audit self-tests, the invariants, the
money-safety corpus and the race harness.

- audit:invariants: read the `coverage reached:` line, not only the violations; widen fuel before trusting a clean
  run.
- audit:money-safety: a burn is a rejected resolve().events entry whose paidTo pays the treasury.
- audit:race: P1 treasury-burn, P2 displacement-burn, P3 payment-without-delivery, P4 byte-identity. Run it only on a
  settled tree (a mid-rebuild dist reads as fake divergence); heavy audit and mutation runs belong in a disposable
  git worktree.

## CI (`.github/workflows/ci.yml`)

- The `test` job: `pnpm install --frozen-lockfile`, the consensus citation check, build, typecheck, lint (blocking;
  `test/lint-config.test.ts` pins that biome.json enables exactly the four rules), `check:dashes-paths`,
  check-lockstep, the per-package tests, edge and security (their node-dependent parts skip), the live opt-in guard
  (`test/live-opt-in.test.ts`: an opted-in live suite fails when its node does not answer) and the root tests of the
  release scripts, the workflow, the lint config and the dependency pins (`test/*.test.ts`).
- The `conformance` job runs Python 3.12 + test:crosslang + `audit:all` as its own independently enforced job (audit
  findings stay report-only; a failed self-test, stale citation or JS/Python divergence fails it).
- The `secrets` job runs gitleaks over the full history (release binary, sha256 checked).
- Every `uses:` is pinned to a full commit SHA with its tag in a trailing comment; the workflow token is read-only and
  no checkout keeps credentials (`test/ci-workflow.test.ts` pins this shape).
- Every job runs on `ubuntu-24.04`, not a moving `-latest` image, as in the other Cairn repos: GitHub moved
  `ubuntu-latest` to 26.04, where playwright-core 1.60.0 cannot install its Chromium, and a moving image changes the
  toolchain under a job without a commit (`test/ci-runner-image.test.ts` refuses a `-latest` runner).
- pnpm/action-setup reads the pnpm version from `packageManager`; do not also pass `version:`.

## Local setup

- pnpm blocks the esbuild postinstall unless it is in `onlyBuiltDependencies` (already set; `pnpm rebuild esbuild` if
  dist is missing).
- The pre-commit gitleaks hook is installed with `bash .githooks/install.sh` (`.githooks/README.md`). Node 22.
