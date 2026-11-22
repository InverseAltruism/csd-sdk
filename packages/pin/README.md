# @inversealtruism/cairnx-pin

A CairnX pin: the log of the chain's `cairnx:v1` records at or below an epoch boundary, with the block hash, events
hash and state hash there, for `pinned()` of `@inversealtruism/cairnx-replica`. A replica opened over it reads only the
blocks above the pin. Below the pin the trust is this release.

```bash
npm install @inversealtruism/cairnx-pin @inversealtruism/cairnx-replica@<version> @inversealtruism/cairnx-core@<version>
```

`@inversealtruism/cairnx-replica` is an optional peer with a range (`^` the replica version this release was built
with): the package uses it for the `Pin` type alone. Install a replica inside that range and the cairnx-core that
replica names.

```ts
import { PIN } from "@inversealtruism/cairnx-pin";
import { local, open } from "@inversealtruism/cairnx-replica/server";
const replica = await open(local({ node: "http://127.0.0.1:8789", pin: PIN }));
```

`PIN` is `pin.json` (also exported as `./pin.json`) with `log()`, which gives the log's bytes: the UTF-8 canonical
JSON of the event list in the order of CONVENTION section 33.3. `pinned()` checks the log against the pin's
`logSha256`, `eventsHash` and `stateHash` and the pin's `blockHash` against the headers it reads above the pin, and
refuses a mismatch (the replica's README, "Pins"). The package has no runtime dependency; its types name the
replica's `Pin`.

## How a pin is made and checked

The repo holds the data, not the log: cairnx-core's recorded block fixture (29,860 to 117,000), and here
`fixtures/delta-<from>-<to>.json`, one per pin, each holding the blocks of its range that hold a record, with every
transaction carrying an app payload in each such block and its author bound to the coin it spent. `pnpm build`
derives the log from those through the replica's `derivePin` and refuses unless it gives `pin.json` in every field
but `core` (information only), so every build regenerates the shipped log byte for byte. The package test does the
same and checks that the deltas hold exactly the blocks above 117,000 that hold a record.

`scripts/generate-pin.mjs` makes a pin on a host with a node of its own, by hand and never in CI:

```bash
node packages/pin/scripts/generate-pin.mjs --rpc http://127.0.0.1:8789 --anchor <height>:<hash> [--check]
```

The anchor is the newest entry of a released header anchor table; the pin is the highest epoch boundary at or below
it. The generator reads the range above the last pin as complete blocks with verified headers
(`conformance/chain-read.mjs`), walks the headers on to the anchor, derives the log twice (from the recorded blocks
through `derivePin`, and with the replica's `nodeBlocks` loop from the activation height) and writes the delta and
`pin.json` only when both agree. It refuses an anchor less than 12 blocks below the node's tip, an anchor the node's
chain does not hold, a previous pin that is not the node's block below the new range, headers that do not reach the
anchor, two derivations that differ, a log that does not extend the committed pin's, and a gate table that differs
from the replica's built one at or below the pin or from the committed pin's at or below its height. `--check`
regenerates the newest delta and pin and compares them with the committed files, writing nothing.

The recorder's output is a function of the chain alone and the log is canonical JSON, so a second host with its own
node reaches the same bytes with `--check`. Until such a host checks a pin, its one derivation host is ours. To check
the shipped pin against your own node, pass the anchor its CHANGELOG entry names:

```bash
node packages/pin/scripts/generate-pin.mjs --rpc http://127.0.0.1:8789 --anchor 143359:0x0000000000003e6d8aa16bdc20ab58023bd58c92185bca427783f33985bf6007 --check
```

The build and the package test prove that the repo's data gives `pin.json`, not that the data is the chain's: a
delta changed together with a `pin.json` rewritten to match passes the build and CI, which reads no node. Only
`--check` against a node catches it, so a pin release is checked against a node by the releaser, and can be by
anyone.

## Cutting the next pin

1. Run the generator with the newest anchor of the next released anchor table; it writes the new delta and
   `pin.json`. Run it again with `--check`, and from a second host when one is available.
2. Capture the honest-path fixture for the new pin with `packages/replica/scripts/capture-node-blocks.mjs`: the 45
   blocks ending at the pin with their bodies emptied, and the blocks above it up to a tip at least 12 above the pin
   with no payload transaction, as `test/fixtures/node-blocks-143296-143356.json` is for 143,340; replace that file.
3. Point `test/pin.test.ts` at the new capture (the line that reads `node-blocks-143296-143356.json`).
4. Add the CHANGELOG entry with the full anchor, then `pnpm build` and `pnpm test` in this package.

## Notes

- Follow-up, not built: CI's fork gate could run cairnx-core's fixture and the deltas through the Python reference
  (`conformance/cairnx_ref.py`) against `pin.json`, a derivation that shares no code with the generator.
