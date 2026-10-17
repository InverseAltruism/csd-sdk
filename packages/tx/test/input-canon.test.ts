// Input canon of the tx builder: hostile or malformed input is refused with a result, and the honest
// call shapes still build the same transaction.
import assert from "node:assert/strict";
import { buildPropose, buildProposeVerified } from "../src/index.js";
import { MIN_FEE_PROPOSE } from "@inversealtruism/csd-codec";

let pass = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); pass++; console.log(`  ok ${name}`); };

const PRIV = "0x" + "11".repeat(32);
const utxo = (value: number, i = 0, txid = "0x" + (i + 1).toString(16).padStart(64, "0")) => ({ txid, vout: 0, value, confirmations: 6, coinbase: false });
const proposeArgs = (domain: string, uri: string) =>
  ({ domain, payloadHash: "0x" + "ab".repeat(32), uri, expiresEpoch: 9999, fee: MIN_FEE_PROPOSE, utxos: [utxo(MIN_FEE_PROPOSE * 2)], priv: PRIV });

console.log("buildPropose: unpaired surrogates refused as a result, not a throw");
await check("a lone surrogate in the uri returns ok:false with the reason", () => {
  const r = buildPropose(proposeArgs("csd:test", "cairn:v1:\uD800"));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /uri contains an unpaired surrogate/);
});
await check("a lone surrogate in the domain returns ok:false with the reason", () => {
  const r = buildPropose(proposeArgs("csd:\uDC00", "u"));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /domain contains an unpaired surrogate/);
});
await check("the verified lane refuses the same way", async () => {
  const r = await buildProposeVerified({ ...proposeArgs("csd:test", "\uD83D"), verify: async () => ({ ok: true, total: MIN_FEE_PROPOSE * 2 }) });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unpaired surrogate/);
});
await check("honest text with an emoji (a surrogate pair) still builds", () => {
  const r = buildPropose(proposeArgs("csd:test", "cairn:v1:\u{1F600}"));
  assert.equal(r.ok, true);
  assert.equal(r.tx?.app.type, "Propose");
});

console.log(`csd-tx input canon: ${pass} passed`);
