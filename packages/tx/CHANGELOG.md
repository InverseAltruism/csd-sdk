# Changelog

## Unreleased

- `txToNodeJson` decodes its hex fields with csd-codec's `hb`, the decode `serialize`, `txid` and `sighash` use. Its
  own decoder read a pair that is not hex as a zero byte and dropped an odd last digit, so a direct call with such a
  field returned node JSON carrying bytes the field does not name; it now throws, as the signing path does. Every
  builder signs before it calls `txToNodeJson`, and signing already threw on such a field, so no built transaction
  changes: over 20,000 seeded serializable transactions (upper- and lower-case hex, empty and long scriptSigs, the
  three app types) the node JSON is byte-equal to 0.1.24's, and a send, a propose and an attest built with one key
  give equal signed bytes, txids and sighashes.

## 0.1.24

- Pins `@inversealtruism/csd-crypto` 0.1.21 (`verifyDigest` reads a signature as compact r || s only, the node's
  rule), so an install does not nest the older csd-crypto beside the current one. No csd-tx source change; signing
  and the built bytes are unchanged.
