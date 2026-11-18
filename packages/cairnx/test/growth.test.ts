// The growth streams of conformance/growth-streams.mjs at 500 and 1,000: each stream's expectations (a refusal and an
// admission of every cap, the V21 flip, the bulk-cancel filters, the edges) and its state at the tip. A pin is the
// first 16 hex digits of stateHash and of sha256 over the whole result with each log entry's note left out (codes,
// recaptures and fclaims stay in), as the tree computed them before the replay indexes (fc6e081); canonicalState
// there equals cairnx-core 0.2.4's on every stream. A sanctioned rule change that moves a stream re-pins it in the
// same commit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { growthStreams, resolverAt } from "../../../conformance/growth-streams.mjs";
import * as R from "../src/index.js";
import type { CairnXState } from "../src/index.js";

const PINS: Record<string, [string, string]> = {
  "500 registrations": ["6321fc7c6419f169", "4f80cb47966cc9c7"],
  "500 open bids": ["dacd2393a715e10c", "040d5307ebacb68a"],
  "500 open offers with holds": ["029ed4f0ca90c3c4", "b50c1f4dda14b1a2"],
  "500 reservations alive at once": ["46d848d2dafb6b9b", "4cfa10550ef1a80b"],
  "500 recaptures alive at once": ["764a548a71623987", "c059f86ffa9149a0"],
  "50 bulk cancels over 500 offers": ["ae9b3759d1ee99bd", "5c3145a336e46302"],
  "50 displacements over 500 offers": ["f7c7ec581a6935cc", "f49ccf2128a12736"],
  "the V21 crossing": ["a11ef6b4e789fe30", "36b611e72c2cdc78"],
  "a duplicated offer id around a same-block ocancel": ["c1f6a3e075836d6a", "0ca14695545c8d94"],
  "NaN heights among offers, holds and reservations": ["3beeec5a59d36c28", "c02ac6b7580c5d6f"],
  "a NaN-height fclaim at input position 0": ["039bd7140420e94b", "17de148080f5d16f"],
  "a NaN-height fclaim at input position 1": ["039bd7140420e94b", "17de148080f5d16f"],
  "a NaN-height fclaim at input position 2": ["039bd7140420e94b", "17de148080f5d16f"],
  "a NaN-height fclaim at input position 3": ["039bd7140420e94b", "17de148080f5d16f"],
  "a NaN-height fclaim at input position 4": ["039bd7140420e94b", "17de148080f5d16f"],
  "a NaN-height fclaim at input position 5": ["039bd7140420e94b", "17de148080f5d16f"],
  "a NaN-height fclaim at input position 6": ["cc3aa9e2b2678edd", "88e26e0cdffb68b1"],
  "a NaN-height fclaim at input position 7": ["039bd7140420e94b", "17de148080f5d16f"],
  "a NaN-height fclaim at input position 8": ["039bd7140420e94b", "e64a44fd1d10e124"],
  "a NaN-height fclaim at input position 9": ["039bd7140420e94b", "e64a44fd1d10e124"],
  "a NaN-height fclaim at input position 10": ["039bd7140420e94b", "e64a44fd1d10e124"],
  "a NaN-height fclaim at input position 11": ["039bd7140420e94b", "e64a44fd1d10e124"],
  "1000 registrations": ["aa5a59f1554179ba", "5fc2f5eb4ac0c7f2"],
  "1000 open bids": ["546a23a5f7773a13", "fd12af5ebb86b700"],
  "1000 open offers with holds": ["ec444f5db08e2830", "d9645fe72bf0f161"],
  "1000 reservations alive at once": ["46d848d2dafb6b9b", "d7e9796ada5f55ad"],
  "1000 recaptures alive at once": ["846c2f06783a7bd2", "a02471ce0517c348"],
  "100 bulk cancels over 1000 offers": ["68b54687d9af9251", "fa4fc19db38a8adb"],
  "100 displacements over 1000 offers": ["5170a015b54205f4", "b6475f59b1e33a09"],
};

const sha16 = (x: string): string => createHash("sha256").update(x).digest("hex").slice(0, 16);
const withoutNotes = (s: CairnXState) => ({ ...s, events: s.events.map(({ note: _note, ...e }) => e) });

let streams = 0;
const seen = new Set<string>();
for (const n of [500, 1_000]) {
  for (const s of growthStreams(R, n)) {
    if (seen.has(s.label)) continue;
    seen.add(s.label);
    const missed = s.expect(resolverAt(R.resolve, s));
    assert.deepEqual(missed, [], `${s.label}: expected ${missed.join("; ")}`);
    const st = R.resolve(s.events, s.tipHeight);
    const pin = PINS[s.label];
    assert.ok(pin, `a pin for ${s.label}`);
    assert.equal(R.stateHash(st).slice(2, 18), pin[0], `${s.label}: canonical state moved`);
    assert.equal(sha16(JSON.stringify(withoutNotes(st))), pin[1], `${s.label}: the result moved (codes, recaptures or fclaims)`);
    streams++;
  }
}
assert.equal(streams, Object.keys(PINS).length, "every pin is used");
console.log(`growth streams: ${streams} streams, each stream's expectations met and its state equal to its pin`);
