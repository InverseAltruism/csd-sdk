# Changelog

## 0.1.22

- Pins `@inversealtruism/csd-crypto` 0.1.21, whose `verifyDigest` reads a signature as compact r || s only, the node's
  rule. `verifySiwc` therefore accepts a valid compact signature whose bytes are also DER-shaped (it answered
  `bad-signature` before) and refuses a 64-byte DER signature (it accepted one before). No csd-siwc source change.
