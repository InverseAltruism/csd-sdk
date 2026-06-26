# @inversealtruism/csd-siwc

**Sign in with CSD:** an EIP-4361 / CAIP-122 analogue for the Compute Substrate. A relying party (RP)
asks a wallet to sign a canonical, human-readable message bound to the RP's `domain`, a single-use
`nonce`, and the chain id; the RP then verifies the signature server-side and derives the account
**only from the recovered key** (never from a client-supplied address field).

```ts
import { buildSiwcMessage, signSiwc, verifySiwc, generateNonce, rfc3339, CSD_CHAIN_MAINNET } from "@inversealtruism/csd-siwc";

// RP issues a nonce, wallet builds + signs:
const fields = { domain: "app.example", account, uri: "https://app.example/login", version: "1",
  chainId: CSD_CHAIN_MAINNET, nonce, issuedAt: rfc3339(Date.now()), expirationTime: rfc3339(Date.now() + 600_000) };
const { message, sig64, pub33 } = signSiwc(fields, priv);

// RP verifies (fail-closed). `account` is the PROVEN signer.
const r = verifySiwc({ message, sig64, pub33 }, { domain: "app.example", nonce, chainId: CSD_CHAIN_MAINNET });
if (r.ok) grantSession(r.account);
```

## Security model

- **Domain-separated digest:** `sha256d(tagged_hash("CSD-SIWC-v1", utf8(message)))` is disjoint from the
  tx sighash (`CSD_SIG_V1`) and the legacy login digest, so a sign-in signature can never be replayed as a
  transaction or a legacy login.
- **Canonical round-trip gate:** `verifySiwc` re-builds the parsed fields and rejects unless the bytes match,
  closing line-injection / field-smuggling. Field values reject **all** line terminators (incl. U+2028/2029/0085).
- **Time bounds:** timestamps MUST carry an explicit timezone (RFC3339 `Z`/offset; a zoneless time is rejected
  to avoid per-server-TZ divergence). `issuedAt` must be ≤ `now + futureSkew` (default 120s, tolerating normal
  NTP drift; set `futureSkewMs` to tighten/loosen) and not older than ~1h; `expirationTime` is required.
- **Nonce + audience:** single-use nonce and per-RP `domain` binding are the RP's responsibility (the library
  is stateless and binds audience via the message bytes).

Cross-language parity (digest + canonical message) is pinned by `conformance/siwc_ref.py` (a Python reference)
and `conformance/crosscheck-siwc.mjs`. License: MIT.
