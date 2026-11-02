# Changelog

## 0.1.24

- Pins `@inversealtruism/csd-crypto` 0.1.21 (`verifyDigest` reads a signature as compact r || s only, the node's
  rule), so an install does not nest the older csd-crypto beside the current one. No csd-tx source change; signing
  and the built bytes are unchanged.
