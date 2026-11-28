# @inversealtruism/csd-anchors

The block-hash anchors of the CSD chain as data: one table of block hashes on a 4,096-block grid, the floor every header
walk starts from, and the block at the CairnX activation root (height 29,859). The package has no runtime dependency and
no dependent inside this repository, so a refresh is one publish of this package alone and each consumer takes it in
its own release.

```bash
npm install @inversealtruism/csd-anchors
```

```ts
import { ANCHORS } from "@inversealtruism/csd-anchors";
ANCHORS.floor;            // { height: 29960, hash: "0x..." }
ANCHORS.activationRoot;   // { height: 29859, hash: "0x..." }
ANCHORS.anchors.at(-1);   // the newest entry: { height, hash }
```

`ANCHORS` is `anchors.json` (also exported as `./anchors.json`) as a deep-frozen object, with types. The hashes are
`0x` and 64 lowercase hex digits in the node's display order.

## The data

`anchors.json` is `{ format: 1, chunk: 4096, floor, activationRoot, anchors }`. `floor` is the checkpoint a header walk
is seeded at; `anchors` holds one `{ height, hash }` per grid top, at heights `4096k + 4095` ascending by 4,096 from the
first chunk top at or above the floor, each with its explicit height so a reader does not recompute the grid.
`scripts/table.mjs` holds the rules once (the grid, the shape, the canonical text, "extends the previous table"), and the
build, the generator, the renderer and the tests read them there.

A consumer that pins an entry trusts this release for the hash at that height. `@inversealtruism/csd-light` verifies
the headers above a checkpoint it is given, so a table entry is the checkpoint, not a header proof.

## How the table is made and checked

`scripts/generate-anchors.mjs` makes the next table, by hand, on a host with a node of its own:

```bash
node packages/anchors/scripts/generate-anchors.mjs <anchor.json> --headers <base> [--write]
```

The input is one JSON line from the releaser's corroboration of the target height: the height, its hash and the
answers of three sources (node, miner, third), checked rule for rule: every source answers yes, the third is routed to
its primary, the margin is at least 1,000, the height is at least 1,000 below the tip, the hash is lowercase, the height
is a chunk top at or above the first one. The generator walks the headers `<base>` serves from the committed floor
through csd-light (hash, prev link, time rules, LWMA bits, proof of work), so every entry is the hash the walk reaches
at its height, not a served one. It refuses a walk that does not reach the corroborated hash and a new table that does
not extend the committed one entry for entry, and it carries the floor from the committed table. Without `--write` it
prints what it would write. There is no default host: `<base>` comes from `--headers` or `ANCHORS_HEADERS_BASE`.

```bash
node packages/anchors/scripts/generate-anchors.mjs --check --headers <base> --rpc <base>
```

`--check` re-walks the committed table from `<base>` and requires the floor, the activation root and every entry to be
canonical at a second RPC, and the newest entry to be at least 1,000 below that RPC's tip. Both bases are named by
arguments. The age of the newest entry is not checked: how old a table may be is each consumer's rule and the release
rule below.

The package test (`pnpm test`) runs offline. It holds the shape rules, a copy of cairn-wallet's two generated files as
they shipped (`test/fixtures/`, with their sha256 and the wallet commit they were read at) and proves that the wallet's
table is a prefix of `anchors.json` (same floor and chunk, each wallet entry equal at its index), that
`scripts/render-wallet.mjs` renders those two files byte for byte from that prefix, and that rendering the whole table
changes them only by the added entries' lines and the newest height. It re-derives the floor and the activation root
from recorded headers, runs the build's refusals, and runs every refusal of the generator and of `--check` against stub
sources. That the entries are on the chain is not something the offline test can say. Only `--check` against a headers
source and a second RPC says it, so `.github/workflows/anchors-check.yml` runs it by hand (`workflow_dispatch` only)
with both bases as inputs.

The wallet's generated files come from the package with `node scripts/render-wallet.mjs anchors` and `newest`, which
print `spvanchors.ts` and `spvnewest.ts` to stdout.

## Cutting the next table

1. A new table is due when the newest entry is 14 days old, or when a release of a consumer needs one. A consumer's own
   age bound (the wallet's release check, the site's watchdog) stays that consumer's.
2. Copy the published `anchors.json` to `test/previous-published.json`. From the second version on the package test
   requires that file and holds the new table to extend it entry for entry.
3. On a host with a node of its own, make the input for the target height, run the generator without and then with
   `--write`, then `pnpm build` and `pnpm test` in this package.
4. Bump the version and add the CHANGELOG entry naming the newest entry and where the input came from.
5. Run the `anchors-check` workflow with a headers source and a second RPC that the host which made the input does not
   control. It must be
   green on the commit to be published, before the npm window.
6. A consumer switches in its own release: the wallet renders its two files with `render-wallet.mjs` and the diff is the
   added entries.
