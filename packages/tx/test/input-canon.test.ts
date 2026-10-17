// Input canon of the tx builder: hostile or malformed input is refused with a result, and the honest
// call shapes still build the same transaction.
import assert from "node:assert/strict";
import { buildPropose, buildProposeVerified, buildSendVerified, selectInputs } from "../src/index.js";
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

console.log("selectInputs: one outpoint in two spellings is taken once");
{
  const T = "ab".repeat(32);
  const coin = (txid: string, value = 100) => ({ txid, vout: 0, value, confirmations: 6 });
  await check("0x and bare spellings of one coin dedupe (the second copy is dropped)", () => {
    assert.equal(selectInputs([coin("0x" + T), coin(T)], 150), null);
    assert.equal(selectInputs([coin("0x" + T), coin(T.toUpperCase())], 150), null);
    assert.equal(selectInputs([coin("0X" + T.toUpperCase()), coin(T)], 150), null);
  });
  await check("the first spelling is the one selected, unchanged", () => {
    const sel = selectInputs([coin(T), coin("0x" + T)], 100);
    assert.deepEqual(sel, { inputs: [{ txid: T, vout: 0, value: 100 }], total: 100 });
  });
  await check("an exclude key in either spelling skips both spellings", () => {
    for (const key of [`0x${T}:0`, `${T}:0`]) {
      assert.equal(selectInputs([coin("0x" + T)], 100, new Set([key])), null, key);
      assert.equal(selectInputs([coin(T)], 100, new Set([key])), null, key);
    }
  });
  await check("distinct outpoints still sum (different vout, different txid)", () => {
    const other = "cd".repeat(32);
    assert.equal(selectInputs([coin("0x" + T), { ...coin("0x" + T), vout: 1 }], 200)?.total, 200);
    assert.equal(selectInputs([coin("0x" + T), coin(other)], 200)?.total, 200);
  });
  await check("buildSendVerified: a coin the verifier rejects is excluded in its other spelling too", async () => {
    const good = "0x" + "cd".repeat(32);
    const utxos = [coin("0x" + T, 300_000_000), coin(T, 300_000_000), coin(good, 200_000_000)];
    const seen: string[][] = [];
    const r = await buildSendVerified({
      outputs: [{ to: "0x" + "cc".repeat(20), value: 100_000_000 }], fee: 1_000_000, utxos, priv: PRIV,
      verify: async (ins) => {
        seen.push(ins.map((i) => i.txid));
        const bad = ins.find((i) => i.txid.toLowerCase().endsWith(T));
        return bad ? { ok: false, total: 0, badInput: bad } : { ok: true, total: ins.reduce((a, i) => a + i.value, 0) };
      },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, [["0x" + T], [good]]);
  });
}

console.log(`csd-tx input canon: ${pass} passed`);
