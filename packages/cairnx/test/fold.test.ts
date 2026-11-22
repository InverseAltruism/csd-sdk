// resolve() on an input outside its contract (CONVENTION section 5): an events array with an undefined entry after an
// event whose handler throws (a null proposer). JSON cannot carry it; the fold reads each event when it applies it, so
// the handler's TypeError is what comes out.
import assert from "node:assert/strict";
import { resolve, type ChainEvent } from "../src/index.js";

let pass = 0;
{
  const events = [{
    kind: "propose", id: "0xf100000000000000000000000000000000000000000000000000000000000000", proposer: null,
    uri: "{\"decimals\":0,\"mint\":\"issuer\",\"supply\":\"10\",\"t\":\"deploy\",\"ticker\":\"ZZZ\",\"v\":1}",
    payloadHash: "0xd7e26894645a7c8689a7d0c90d05ca5673c36a3c5470b5285a66f0b801e0f90a", expiresEpoch: 9_000_000_000, height: 90_000, pos: 0, paidTo: {},
  }, undefined] as unknown as ChainEvent[];
  // 0.2.8 threw a TypeError here too, with another text: it read every event's height before the first handler ran
  assert.throws(() => resolve(events, 90_000), TypeError);
  pass++;
}
console.log(`fold inputs: ${pass} passed`);
