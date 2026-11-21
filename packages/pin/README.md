# @inversealtruism/cairnx-pin

A CairnX pin: the log of the chain's `cairnx:v1` records at or below an epoch boundary, with the block hash, events
hash and state hash there, for `pinned()` of `@inversealtruism/cairnx-replica`. A replica opened over it reads only the
blocks above the pin. Below the pin the trust is this release. Not yet released.

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
node reaches the same bytes with `--check`. Until such a host checks a pin, its one derivation host is ours.
