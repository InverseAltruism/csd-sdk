# Changelog

## 0.1.21

- `verifyDigest` reads the 64 signature bytes as compact r || s only, the node's rule (`verify_sig` in the node's
  `src/crypto/mod.rs`, `Signature::from_compact`). It called noble's `verify` without a format, which tries DER first.
  So a node-valid compact low-S signature whose bytes are also DER-shaped was refused, and `recoverSigner` and
  `authorOf` returned null for a mined tx; and a 64-byte valid DER signature, which the node refuses, was accepted.
  Signatures from `signDigest` (RFC 6979, low S) verify as before. The test vectors are csd-vectors 0.1.17's
  `SIG_VECTORS`.
- The package description no longer carries an em dash.
