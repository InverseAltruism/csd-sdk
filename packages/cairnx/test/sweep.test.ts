// The streams of conformance/sweep-streams.mjs: expiries at heights that hold no event or at one height together, each
// read by a later event. Per stream: its expectations (codes of the applied log); its state at the tip equal to its pin
// (the first 16 hex digits of stateHash and of sha256 over the whole result, computed by cairnx-core 0.2.8's source
// before the sweep applied each expiry at its own height, or by the published 0.2.8 for the streams added later); check
// mode at every tip of a dense walk, which asserts that each expiry lands at the first height it is due while sweeps
// split; and, for the streams whose heights a chain can produce, the result unchanged by an event that writes nothing
// at each of those heights (CONVENTION section 5). A sanctioned rule change that moves a stream re-pins it in the same commit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolverAt } from "../../../conformance/growth-streams.mjs";
import { denseTips, inertEvents, sweepStreams, upTo } from "../../../conformance/sweep-streams.mjs";
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
  V: ["8b7798080aca3570", "1272c94642a09231"],
  X: ["b12648cf6033d939", "b81478b691447776"],
  X2: ["fa19b8d403075e99", "8f7fcfcb39227b29"],
  Y: ["39077cf82797df0b", "4578b4bbe6c3e704"],
  Y2: ["c39b888a3a4cf914", "07dcaad0b2760c53"],
};
// X and X2 also at V21 - 1 and V21 (events not above the tip): the counterexample's offer and transfer around V21
const TIP_PINS: Record<string, [string, string]> = {
  [`X@${R.V21_HEIGHT - 1}`]: ["6baff7b0544d9a3d", "773e19f306c59c21"],
  [`X@${R.V21_HEIGHT}`]: ["e0c13af9237c231a", "ee76f69b54b3e578"],
  [`X2@${R.V21_HEIGHT - 1}`]: ["4e04686cfe0982d2", "a7755c05e3bff829"],
  [`X2@${R.V21_HEIGHT}`]: ["a58fa7fdbffc41cb", "19aa71006a353e2b"],
};
const sha16 = (x: string): string => createHash("sha256").update(x).digest("hex").slice(0, 16);

let streams = 0, tips = 0, inert = 0, tipPins = 0;
for (const s of sweepStreams(R)) {
  assert.deepEqual(s.expect(resolverAt(R.resolve, s)), [], `${s.key}: expectations`);
  const whole = R.resolve(s.events, s.tipHeight);
  const pin = PINS[s.key];
  assert.ok(pin, `a pin for ${s.key}`);
  assert.equal(R.stateHash(whole).slice(2, 18), pin[0], `${s.key}: canonical state moved`);
  assert.equal(sha16(JSON.stringify(whole)), pin[1], `${s.key}: the whole result moved`);
  for (const [k, p] of Object.entries(TIP_PINS).filter(([k]) => k.startsWith(`${s.key}@`))) {
    const t = Number(k.slice(s.key.length + 1)), st = R.resolve(upTo(s.events, t), t);
    assert.equal(R.stateHash(st).slice(2, 18), p[0], `${k}: canonical state moved`);
    assert.equal(sha16(JSON.stringify(st)), p[1], `${k}: the whole result moved`);
    tipPins++;
  }
  const walk = denseTips(s.events, s.tipHeight, R.EPOCH_LEN);
  for (const t of walk) {
    const upto = upTo(s.events, t);
    assert.equal(JSON.stringify(replay(upto, t, { check: true })), JSON.stringify(R.resolve(upto, t)), `${s.key}@${t}: check mode's result`);
    tips++;
  }
  // the property holds for heights a chain can produce; X, X2, Y and Y2 hold others (CONVENTION section 5)
  if (s.events.every((e) => Number.isSafeInteger(e.height))) {
    const added = inertEvents(walk);
    assert.equal(JSON.stringify(R.resolve([...added, ...s.events], s.tipHeight)), JSON.stringify(whole), `${s.key}: events that write nothing changed the result`);
    inert += added.length;
  }
  streams++;
}
assert.equal(streams, Object.keys(PINS).length, "every pin is used");
assert.equal(tipPins, Object.keys(TIP_PINS).length, "every tip pin is used");
console.log(`sweep streams: ${streams} streams, expectations met, each equal to its pin (and ${tipPins} at further tips); check mode clean at ${tips} tips; ${inert} events that write nothing changed nothing`);
