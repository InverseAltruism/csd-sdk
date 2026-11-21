// The derivation of a pin from a recorded block fixture (the format of cairnx-core's test/fixtures/events-blocks.json,
// one block per line of every transaction with an app payload and its bound author): the fixture driven through the
// loop by fixtureSource, the log the canonical JSON of the events held, and the pin's hashes computed from them. It
// reads nothing but its argument, so two hosts that hold the same fixture derive the same bytes; the pin package's
// build and its generator both call it.
import * as loaded from "@inversealtruism/cairnx-core";
import { CAIRNX_CORE_VERSION, CAIRNX_EVENT_RULE, EPOCH_LEN, canonicalJson, payloadHash, resolve, stateHash, type EventRule } from "@inversealtruism/cairnx-core";
import { gatesOf } from "./gates.js";
import { replicaLoop } from "./loop.js";
import { memoryStore } from "./memory-store.js";
import { fixtureSource, type BlockFixture } from "./testing.js";
import type { Pin } from "./types.js";

/** The pin at `fx.to`, an epoch boundary, and its log's bytes. Throws when the fixture does not start at or below the
 *  activation height or does not reach `fx.to` whole. */
export async function derivePin(fx: BlockFixture, rule: EventRule = CAIRNX_EVENT_RULE): Promise<{ pin: Omit<Pin, "log">; log: Uint8Array }> {
  if (!Number.isSafeInteger(fx.to) || fx.to % EPOCH_LEN !== 0) throw new Error(`derivePin: ${fx.to} is not an epoch boundary`);
  if (!(fx.from <= rule.activationHeight)) throw new Error(`derivePin: the fixture starts at ${fx.from}, above the activation height ${rule.activationHeight}`);
  const loop = replicaLoop({ source: fixtureSource(fx), store: memoryStore(), rule, maxBlocks: Number.MAX_SAFE_INTEGER });
  const s = await loop.advance();
  if (s.lastError !== null || s.cursor?.height !== fx.to) throw new Error(`derivePin: the fixture stops short of ${fx.to}: ${s.lastError?.reason ?? "no error"}`);
  const events = loop.rows(0).flatMap((r) => r.events), gates = Object.entries(gatesOf(loaded)).filter(([, h]) => h <= fx.to);
  await loop.close();
  return {
    pin: {
      format: 1, rule: { domain: rule.domain, activationHeight: rule.activationHeight }, height: fx.to, blockHash: fx.toHash,
      logSha256: payloadHash(events), eventsHash: s.eventsHash, stateHash: stateHash(resolve(events, fx.to)), gates: Object.fromEntries(gates), core: CAIRNX_CORE_VERSION,
    },
    log: new TextEncoder().encode(canonicalJson(events)),
  };
}
