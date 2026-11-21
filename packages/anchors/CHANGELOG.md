# Changelog

## 0.1.0 (unreleased)

- `ANCHORS` (`anchors.json`): the first table is the table cairn-wallet ships, read at its commit
  `39882ed95a8064e9b2d148192967d7f12fc2b361` (the merge of its 0.3.4 release pull request, `src/core/spvanchors.ts` and
  `src/core/spvnewest.ts`): floor 29,960, the 4,096 grid, 28 entries from 32,767 to 143,359, plus the activation root at
  29,859 (the block hash the replica's recorded blocks hold). The package test holds the wallet's two files as fixtures
  and proves every value equal.
- `scripts/render-wallet.mjs` renders the wallet's two generated files from the table byte for byte.
- `scripts/generate-anchors.mjs`, the wallet's `update-spv-anchors.mjs` on the workspace's csd-light, with `--check`.
  Changes from the wallet's: the headers base is an argument or `ANCHORS_HEADERS_BASE` with no default host; `--check`
  also requires the floor and the activation root canonical at the second RPC and drops the 6,000-block bound on the
  newest entry's age (the wallet's release check keeps it); the table is `anchors.json` with explicit heights and the
  generator writes that file alone; an unknown option is refused before any read.
- The build refuses a table that fails the shape rules or is not its own canonical text.
- Not done, on purpose: no consumer switches in this release; the first publish waits for a green `anchors-check` run.
