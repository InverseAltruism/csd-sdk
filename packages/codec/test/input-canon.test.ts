// Input canon of the codec: hostile or malformed input is refused, and every honest input encodes to the
// same bytes as before (the golden vectors in codec.test.ts and csd-vectors pin those bytes).
import assert from "node:assert/strict";
import { serialize, txid, sighash, isWellFormedUtf16, type Tx } from "../src/index.js";
import { GOLDEN_PROPOSE_TX } from "@inversealtruism/csd-vectors";

let pass = 0;
const check = (name: string, fn: () => void) => { fn(); pass++; console.log(`  ok ${name}`); };

console.log("serializeApp: unpaired surrogates refused");
{
  const propose = (domain: string, uri: string): Tx => ({
    ...GOLDEN_PROPOSE_TX.tx,
    app: { type: "Propose", domain, payloadHash: "0x" + "11".repeat(32), uri, expiresEpoch: 0 },
  });
  check("a lone high surrogate in the uri throws in serialize, txid and sighash", () => {
    const tx = propose("d", "a\uD800b");
    assert.throws(() => serialize(tx), /Propose uri must not contain an unpaired surrogate/);
    assert.throws(() => txid(tx), /unpaired surrogate/);
    assert.throws(() => sighash(tx), /unpaired surrogate/);
  });
  check("a lone low surrogate in the domain throws", () => {
    assert.throws(() => serialize(propose("d\uDC00", "u")), /Propose domain must not contain an unpaired surrogate/);
  });
  check("a reversed pair (low then high) throws", () => {
    assert.throws(() => serialize(propose("d", "\uDC00\uD800")), /unpaired surrogate/);
  });
  check("the two strings utf8ToBytes would merge into U+FFFD no longer share one txid", () => {
    assert.throws(() => txid(propose("d", "\uD800")));
    assert.equal(typeof txid(propose("d", "\uFFFD")), "string");
  });
  check("honest astral text (a surrogate pair) and U+FFFD itself still encode", () => {
    const emoji = serialize(propose("d", "x\u{1F600}y"));
    const utf8 = new TextEncoder().encode("x\u{1F600}y");
    assert.deepEqual(Array.from(emoji.slice(emoji.length - 8 - utf8.length, emoji.length - 8)), Array.from(utf8));
    assert.doesNotThrow(() => serialize(propose("d", "\uFFFD")));
  });
  check("the golden Propose vector is byte-identical", () => {
    assert.equal(txid(GOLDEN_PROPOSE_TX.tx), GOLDEN_PROPOSE_TX.expectedTxid);
    assert.equal(sighash(GOLDEN_PROPOSE_TX.tx), GOLDEN_PROPOSE_TX.expectedSighash);
  });
  check("isWellFormedUtf16 matches String.prototype.isWellFormed on a grid", () => {
    const grid = ["", "a", "\uD800", "\uDC00", "\uD800\uDC00", "\uDC00\uD800", "a\uD83D", "\uD83D\uDE00\uD83D", "\u{10FFFF}", "\uFFFD"];
    for (const s of grid) assert.equal(isWellFormedUtf16(s), s.isWellFormed(), JSON.stringify(s));
  });
}

console.log(`csd-codec input canon: ${pass} passed`);
