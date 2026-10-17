// Input canon of the codec: hostile or malformed input is refused, and every honest input encodes to the
// same bytes as before (the golden vectors in codec.test.ts and csd-vectors pin those bytes).
import assert from "node:assert/strict";
import { serialize, txid, sighash, isWellFormedUtf16, merkleRoot, merkleBranch, verifyMerkleProof, type Tx } from "../src/index.js";
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

console.log("verifyMerkleProof: every node is exactly 32 bytes");
{
  const leaves = [1, 2, 3, 4, 5].map((n) => "0x" + n.toString(16).padStart(64, "0"));
  const root = merkleRoot(leaves);
  check("an empty txid, branch and root no longer verify", () => {
    assert.equal(verifyMerkleProof("", 0, [], "0x"), false);
    assert.equal(verifyMerkleProof("0x", 0, [], ""), false);
  });
  check("a short txid equal to a short root no longer verifies", () => {
    assert.equal(verifyMerkleProof("0xabcd", 0, [], "0xabcd"), false);
  });
  check("a sibling one byte short is refused (the 64-byte buffer used to zero-pad it)", () => {
    const L = ["0x" + "01".repeat(32), "0x" + "ab".repeat(31) + "00", "0x" + "03".repeat(32)];
    const R = merkleRoot(L), br = merkleBranch(L, 0);
    assert.equal(br[0], L[1]);
    assert.equal(verifyMerkleProof(L[0]!, 0, br, R), true);
    assert.equal(verifyMerkleProof(L[0]!, 0, [br[0]!.slice(0, -2), ...br.slice(1)], R), false);
  });
  check("a 33-byte root is refused", () => {
    assert.equal(verifyMerkleProof(leaves[0]!, 0, merkleBranch(leaves, 0), root + "00"), false);
  });
  check("honest proofs verify at every position, with or without 0x and in upper case", () => {
    leaves.forEach((leaf, i) => {
      const br = merkleBranch(leaves, i);
      assert.equal(verifyMerkleProof(leaf, i, br, root), true);
      assert.equal(verifyMerkleProof(leaf.slice(2).toUpperCase(), i, br.map((b) => b.slice(2)), root.slice(2).toUpperCase()), true);
    });
  });
  check("a single-tx block (empty branch, root == txid) still verifies", () => {
    assert.equal(verifyMerkleProof(leaves[0]!, 0, [], merkleRoot([leaves[0]!])), true);
  });
}

console.log(`csd-codec input canon: ${pass} passed`);
