# Changelog

## 0.1.0 (unreleased)

- `PIN` at 143,340 (block `0x...763c42`), generated from a node against the anchor
  `143359:0x0000000000003e6d8aa16bdc20ab58023bd58c92185bca427783f33985bf6007`, the newest entry of the anchor table
  cairn-wallet 0.3.4 ships: 1,486 events, a log of 711,379 bytes. `pin.json`, the delta 117,001 to 143,340, the
  build that derives the log from cairnx-core's fixture and the deltas and refuses unless it gives `pin.json`, and
  `scripts/generate-pin.mjs` with `--check`.
- Not done, on purpose: the generator's two writes (the delta, then pin.json) are not atomic, since a stop between them
  fails closed at the build; `gatesOf` stays exported from the replica's `./server` beside the two the generator uses.
