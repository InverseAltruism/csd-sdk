// The streams of conformance/sweep-streams.mjs: expiries at heights that hold no event or at one height together, each
// read by a later event. Per stream: its expectations (codes of the applied log); its state at the tip equal to its pin
// (the first 16 hex digits of stateHash and of sha256 over the whole result, computed by cairnx-core 0.2.8's source
// before the sweep applied each expiry at its own height); check mode at every tip of a dense walk, which asserts that
// each expiry lands at the first height it is due; and the result unchanged by an event that writes nothing at each of
// those heights (CONVENTION section 5). A sanctioned rule change that moves a stream re-pins it in the same commit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolverAt } from "../../../conformance/growth-streams.mjs";
import { denseTips, inertEvents, sweepStreams } from "../../../conformance/sweep-streams.mjs";
import * as R from "../src/index.js";
import { replay } from "../src/resolve.js";

const PINS: Record<string, [string, string]> = {
  A: ["f24416e9b7412226", "376b3d89ee7ee716"],
  A2: ["3f0c02500646fa71", "55515a39b879fe6f"],
  B1: ["0c920bf6098bbce2", "e58b96bd25280398"],
  B2: ["dcffdb6208f275d7", "823c348979691339"],
  N: ["8f5fc51f6ba2f1a9", "f54e9bbd1acac3a7"],
  D: ["b8819bfaa4315aa9", "e205e10a9765308a"],
  G: ["ebbf8f859c522cd2", "149c249eb6ba22cb"],
};
const sha16 = (x: string): string => createHash("sha256").update(x).digest("hex").slice(0, 16);

let streams = 0, tips = 0, inert = 0;
for (const s of sweepStreams(R)) {
  assert.deepEqual(s.expect(resolverAt(R.resolve, s)), [], `${s.key}: expectations`);
  const whole = R.resolve(s.events, s.tipHeight);
  const pin = PINS[s.key];
  assert.ok(pin, `a pin for ${s.key}`);
  assert.equal(R.stateHash(whole).slice(2, 18), pin[0], `${s.key}: canonical state moved`);
  assert.equal(sha16(JSON.stringify(whole)), pin[1], `${s.key}: the whole result moved`);
  const walk = denseTips(s.events, s.tipHeight, R.EPOCH_LEN);
  for (const t of walk) {
    const upto = s.events.filter((e) => e.height <= t);
    assert.equal(JSON.stringify(replay(upto, t, { check: true })), JSON.stringify(R.resolve(upto, t)), `${s.key}@${t}: check mode's result`);
    tips++;
  }
  const added = inertEvents(walk);
  assert.equal(JSON.stringify(R.resolve([...added, ...s.events], s.tipHeight)), JSON.stringify(whole), `${s.key}: events that write nothing changed the result`);
  inert += added.length;
  streams++;
}
assert.equal(streams, Object.keys(PINS).length, "every pin is used");
console.log(`sweep streams: ${streams} streams, expectations met, each equal to its pin; check mode clean at ${tips} tips; ${inert} events that write nothing changed nothing`);
