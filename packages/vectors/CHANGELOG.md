# Changelog

## 0.1.17

- New `SIG_VECTORS` (`SIG_COMPACT_DER_SHAPED_A1`, `SIG_COMPACT_DER_SHAPED_A2`, `SIG_DER64_B`, type `SigVector`): the
  signature encodings the node's `verify_sig` accepts. Each is a cairnx:v1 Propose whose input 0 is signed by
  `sig64` and `pub33`, with its `expectedSighash`, the spent coin's `owner` (hash160 of `pub33`) and `nodeAccepts`,
  the verdict of the node's crate (secp256k1 0.29.1) on it. A1 and A2 are compact low-S signatures whose bytes are
  also DER-shaped (accepted); B is a valid 64-byte DER signature (refused). csd-crypto's test checks `verifyDigest`,
  `recoverSigner` and `authorOf` against them.
- The package description names the signature vectors as a third source and no longer carries an em dash.
