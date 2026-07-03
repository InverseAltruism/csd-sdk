# CairnX Convention v1

**Status:** v2.1 (normative; supersedes the 2026-06-10 v1.0 draft) · **Domain:** `cairnx:v1` · **Base activation:** 29 860

**Version ladder** (each gate non-retroactive — below it, behavior + canonical hashes are byte-identical to history):
v1.1 @ 29 960 · v1.2 @ 30 300 · v1.3 @ 31 100 · v1.4 @ 31 400 · v1.5 @ 32 000 · v1.6 @ 33 600 (§19) ·
v1.7 @ 34 000 (§20) · v1.9 @ 36 700 (§22) · v2.0 @ 38 400 (§23) · v1.8 @ 40 000 (§21) · v2.1 @ 40 100 (§24).
Sections §19–§24 are the normative semantics for v1.6–v2.1; §5.1 is the byte-level canonical-JSON contract that binds all of them.

> **Canonical copy.** This spec ships in the published `@inversealtruism/cairnx-core` package; the source of
> truth is `csd-sdk/packages/cairnx/CONVENTION.md`. Any in-repo mirror (e.g. the `cairnx` app repo) MUST be
> kept **byte-identical** to it on every change — a third-party implementer fetches the *published* copy, so
> it is the one that must never lag the code. Keep the two in lockstep when editing.

CairnX is a meta-asset and exchange convention on Compute Substrate (CSD). It defines fungible
tokens and atomic delivery-versus-payment trades using **only** the chain's existing `Propose`
and `Attest` transactions — no fork, no new transaction types, no custodian. Token semantics are
enforced by a **pure, deterministic resolver** that any party can run; independent resolvers
replaying the same chain converge on identical state.

This document is normative. The reference resolver (`src/resolve.ts`) and its conformance suite
implement exactly what is written here.

---

## 1. Consensus facts relied upon

Verified against the node source (`compute-substrate` @ v1.x, 2026-06-10):

- **C1.** Every input of a tx signs the same global sighash; tx validity requires all signatures.
- **C2.** A `Propose`/`Attest` tx's value outputs are unrestricted (only fee floors apply:
  ≥ 0.25 CSD propose, ≥ 0.05 CSD attest). One tx can pay arbitrary addresses *and* carry an app payload.
- **C3.** `proposer` / `attester` = `hash160(input[0].pubkey)`, stored by consensus.
- **C4.** `Propose.uri` is a consensus-stored string ≤ **512 bytes** (non-empty); `payload_hash`
  is a consensus-stored 32-byte value (non-zero).
- **C5.** An `Attest` referencing proposal `P` is **consensus-rejected** once
  `epoch > P.expires_epoch` (epoch = ⌊height/30⌋). Same-block attest-after-propose is valid
  (block apply phases: proposals, then attestations).
- **C6.** Duplicate `payload_hash` anchors are allowed; proposals are keyed by txid.
- **C7.** Mempool is first-seen; conflicting spends rejected; no RBF.

## 2. Encoding: records live on-chain in `uri`

Every CairnX record is a **canonical JSON** object (UTF-8, recursively sorted keys, compact —
exactly `canonicalJson` from `@inversealtruism/csd-codec`) whose serialized form MUST be
≤ 512 bytes. It is anchored by a `Propose` to domain **`cairnx:v1`** with:

- `uri` = the canonical JSON string itself (the record is **fully on-chain**, replicated by
  every node, forever — there is no off-chain content-availability problem);
- `payload_hash` = `sha256(uri bytes)` (`payloadHash` of the record). Resolvers MUST verify
  `sha256(uri) == payload_hash` and treat mismatching anchors as no-ops;
- `expires_epoch` — see per-record semantics (for offers it is the consensus-enforced fill window).

A record's **actor** is the anchoring tx's consensus `proposer` (C3). There are no off-chain
signatures in v1: anchoring *from your key* is the authorization.

## 3. Common rules

- **Amounts** are strings of decimal integers in base units, `"1"` ≤ x < `2^96`. Resolvers use
  arbitrary-precision integers. `decimals` (0–8) is display-only.
- **Tickers** match `^[A-Z][A-Z0-9]{2,11}$`.
- **Addresses** are `0x` + 40 lowercase hex.
- **Apply order:** events are replayed in consensus order — by block height; within a block,
  all `cairnx:v1` proposals in tx order (`pos`), then all attestations on CairnX offers in tx
  order. (Mirrors the node’s propose/attest phases, C5.) Remaining ties (same height, phase, pos —
  possible only across indexer quirks, never on a real chain) break by **ordinal (code-unit)
  comparison of the lowercase `0x`-hex txid**. Ordinal comparison is the ONLY string ordering
  used anywhere in resolution and serialization — locale-aware collation (e.g. JavaScript's
  `localeCompare`) is forbidden, since it is ICU-dependent and non-reproducible across runtimes.
- **Invalid = no-op.** A record that fails any check (schema, balance, state) has **no effect**.
  Unknown `t` values and `v ≠ 1` are no-ops (forward compatibility). Invalidity never poisons
  later records.
- **Activation:** anchors below height **29 860** are ignored. (Set just before the first
  protocol traffic — the domain had no prior use; the live X2 e2e records ARE the genesis.)
- **Finality:** state derived from blocks < 6 confirmations is provisional (display threshold
  3, final 6 — matching Cairn's site conventions).

## 4. Records

### 4.1 `deploy` — create a token

```json
{"v":1,"t":"deploy","ticker":"DUST","name":"Dust","decimals":2,
 "supply":"100000000","mint":"open","mintLimit":"100000"}
```

| field | rule |
|---|---|
| `ticker` | required; **first-anchored deploy of a ticker wins** (C6 + this convention); later deploys of the same ticker are no-ops |
| `name` | optional, ≤ 32 chars |
| `decimals` | integer 0–8 |
| `supply` | max total supply, amount-string |
| `mint` | `"open"` (anyone) or `"issuer"` (only the deployer) |
| `mintLimit` | required iff `mint:"open"` — max amount credited per mint record |

The deploy's `expires_epoch` SHOULD be far future (e.g. tip-epoch + 100 000); expiry has no
CairnX meaning for deploys. The **deployer** is the anchoring proposer.

### 4.2 `mint` — issue supply

```json
{"v":1,"t":"mint","ticker":"DUST","amount":"100000"}
```

- Token must exist (deploy anchored strictly earlier in apply order; same-block-earlier-pos counts).
- `mint:"open"`: any proposer; credited `min(amount, mintLimit, remaining supply)`; if remaining
  supply is 0 the mint is a no-op. `amount` defaults to `mintLimit` if omitted.
- `mint:"issuer"`: proposer MUST equal the deployer; credited `min(amount, remaining)`; `amount` required.
- Credited to the **proposer**.

### 4.3 `transfer` — move tokens

```json
{"v":1,"t":"transfer","ticker":"DUST","to":"0x…40","amount":"2500","memo":"…","ts":1781387000}
```

- Sender = **proposer**. Valid iff sender's *unlocked* balance ≥ `amount` at apply time.
- `to` may be any address (including sender). `memo` ≤ 64 chars and `ts` are optional
  free fields (also serve to differentiate otherwise-identical records; note two anchors of
  byte-identical transfer content by the same sender are **two transfers** — each anchor is an
  independent authorization by C3).

### 4.4 `offer` — on-chain sell order (locks tokens)

```json
{"v":1,"t":"offer","give":{"ticker":"DUST","amount":"1000"},
 "want":{"value":"50000000","payto":"0x…40"},"taker":"0x…40","memo":"…"}
```

- Seller = **proposer**. Valid iff seller's unlocked balance ≥ `give.amount`; on apply, that
  amount is **locked** (cannot be transferred or re-offered).
- `want.value` — CSD price in base units (string; `"0"` allowed = giveaway). `want.payto`
  defaults to the seller.
- `taker` (optional) — if present, only this address can fill. **Taker-bound offers are the
  protected path** (see §6).
- The anchoring proposal's **`expires_epoch` is the offer's validity window** — after it, the
  chain itself rejects fill attempts (C5), and the resolver releases the lock. Offers SHOULD
  use short windows (e.g. tip-epoch + 24 ≈ 1 day).
- An offer is identified by its **proposal id (txid)**.

### 4.5 `fill` — atomic delivery-versus-payment (an Attest, not a Propose)

A fill is an **`Attest` transaction** referencing the offer's proposal id with **`score = 100`**,
whose **own outputs** pay the seller:

- valid iff the offer is open (not filled, not cancelled, not expired) at apply time;
- if `taker` is set, `attester == taker`;
- `Σ(outputs of the attesting tx paying want.payto) ≥ want.value`;
- on apply: the locked `give.amount` moves to the **attester**, the offer closes.

Because payment outputs and the attestation are one transaction (C2), **delivery-versus-payment
is atomic at consensus level**: the buyer cannot pay without (the chain recording the basis for)
receiving, and the seller's tokens were already convention-locked. The fill costs only the
attest fee floor (0.05 CSD) plus the payment.

The **first valid fill in apply order wins**. For a **CSD-priced** fill `confidence` is ignored
(set 100); a **token-priced** fill (§11) additionally requires the `confidence = 1 000 000` opt-in
marker or it is a no-op.

### 4.6 `cancel` — close an offer (an Attest)

`Attest` on the offer with **`score = 0`**, valid only when `attester == seller`. Releases the
lock, closes the offer. (Cancel and fill race in apply order like everything else.)

Other `score` values on CairnX offers are reserved (no-ops). The **claim-to-fill** exclusivity
extension shipped at v1.7 (height 34 000) and uses **`score = 50`** (`SCORE_CLAIM`) — *not* `score = 1`
(an earlier draft placeholder that was never implemented). See §20.

## 5. Resolver state (normative output)

```
tokens:   ticker → { deployId, deployer, name, decimals, supply, minted, mint, mintLimit, height }
balances: ticker → address → { available, locked }
offers:   offerId → { seller, give, want, taker?, status: open|filled|cancelled|expired,
                      expiresEpoch, height, fill?: { buyer, txid, height, paid } }
events:   ordered log of applied/no-op decisions (for explorers & audit — INFORMATIONAL,
          excluded from the canonical surface; its reason strings are diagnostics, not protocol)
```

**Canonical state (format 2, normative):** the canonical surface is
`{tipHeight, tokens, balances, names, offers, bids, feesPaid}` — the event log is excluded.
Serialization is **canonical JSON**: object keys sorted in ordinal (code-unit) order at every
depth, no insignificant whitespace, UTF-8, all amounts as decimal strings (no floats anywhere),
booleans/numbers in their shortest JS form. Two resolvers fed the same chain prefix MUST produce
byte-identical canonical state; `sha256(canonicalState)` at the activation heights is pinned in
`test/vectors/replay-hashes.json`, and `test/vectors/cases.json` carries language-neutral replay
vectors a third-party implementation must reproduce. (Format 1 — pre-2026-06-12 — included the
event log and used locale collation; it is retired.)

Determinism requirement: the conformance suite enforces byte-identity, including
shuffle-invariance of inputs that consensus ordering re-sorts.

### 5.1 The byte-level canonical-JSON contract (normative — pin before a 2nd implementation exists)

"Canonical JSON" above is only as portable as these rules. They document exactly what the reference
canonicalizer (`@inversealtruism/csd-codec` `canonicalJson`, which bottoms out in ECMA-262
`JSON.stringify`) produces. An independent resolver that diverges on any of them will fork the
record-acceptance gate and/or the canonical-state hash on valid mainnet data. These are unmigratable
once a replay hash is pinned over data that exercises them, so they are stated here verbatim.

- **A1 — String escaping.** Escape **only** `"` → `\"`, `\` → `\\`, and the C0 controls U+0000–U+001F
  (using the short escapes `\b \f \n \r \t`, otherwise lowercase `\u00XX`). Emit **every other**
  codepoint as **raw UTF-8** — in particular do **NOT** escape `/` (solidus) and do **NOT** `\u`-escape
  any non-ASCII codepoint (U+0080 and above). A token `name` of `"Café"` serializes the `é` as the raw
  2-byte UTF-8 `0xC3 0xA9`, never `é`; an emoji serializes as its raw 4-byte UTF-8, never an
  escaped surrogate pair. (Note: `memo` fields on transfer/offer/bid carry the same free-Unicode
  surface inside the record `uri`, so they obey A1 too even though they are not in canonical state.)
  **A1 is unsatisfiable for a lone/unpaired UTF-16 surrogate** (it has no valid UTF-8 form): V8 escapes
  it to ASCII `\uXXXX` while a raw-UTF-8 resolver rejects/mangles it, so such a string is rejected
  outright by **A7** before it can reach A1 — see A7.
- **A2 — Key ordering is UTF-16 code-unit order, NOT Unicode codepoint / UTF-8 byte order.** Sort object
  keys by comparing their UTF-16 code units. These two orders are identical for all-BMP strings but
  **diverge for non-BMP characters (U+10000+)**: a leading surrogate `0xD800–0xDBFF` sorts *below* BMP
  chars `0xE000–0xFFFF` under UTF-16, but *above* all BMP chars under codepoint order. **Rust
  `str::cmp` / Go `<` on `string` compare by UTF-8 bytes = codepoint order and are therefore WRONG** for
  a non-BMP key — implementers MUST compare UTF-16 code units (JS `localeCompare` is also wrong; use the
  default `<`/`>` on the JS string, i.e. code-unit order, which is what the resolver's `ord()` does).
  **The numeric-key trap, and it points in OPPOSITE directions for the two hashes we compute, so read
  carefully.** Nprofile maps (and all-digit names) can carry numeric-looking keys like `"2"`/`"10"`:
  - **payloadHash / the record `uri` (`canonicalJson`)** sorts keys by pure code unit: `canonicalJson` is
    `Object.keys(o).sort()`, and although JS's native `Object.keys` enumerates integer-index keys ascending-
    NUMERIC (`"1","2","10"`), the trailing `.sort()` overrides that to code-unit order (`"1","10","2"`). So
    for the record hash, `"10"` sorts BEFORE `"2"`. Do NOT special-case numeric keys here.
  - **`sha256(canonicalState)` (the STATE hash)** is a DIFFERENT serializer (`sortKeys` + `JSON.stringify`,
    not `canonicalJson`), and it INHERITS `JSON.stringify`'s native enumeration: ECMAScript array-index keys
    (the canonical decimal of an integer in `[0, 2^32-2]`) are emitted FIRST in ascending-NUMERIC order,
    THEN the remaining keys in code-unit order, regardless of the intermediate `.sort()`. So for the state
    hash, `"2"` sorts BEFORE `"10"`. An implementer who applies the record-hash's pure-code-unit rule here
    (or who ignores the integer-first enumeration) forks `sha256(canonicalState)` the first time a profile
    carries two numeric keys. The reference Python mirror encodes exactly this split (`canonicalJson` vs
    `_js_obj_key_order`/`_js_stringify` in `conformance/cairnx_ref.py`); a third impl MUST reproduce both.
- **A3 — Field types (bare number/boolean vs decimal string vs identity string).** Canonical state mixes
  raw JSON integers and booleans with decimal-string amounts and raw identity strings. Emit as **bare
  integers**: `decimals, height, effectiveHeight, expiresEpoch, feeBps, tipHeight, paidThroughEpoch`, and
  (v1.7) `claimUntilHeight` (all JS-safe, < 2^53). Emit as **bare booleans**: `locked, viaFill, expired`.
  Emit as **decimal strings**: `supply, minted, mintLimit, feesPaid`, every `balances.*.available`/`.locked`,
  `want.value`, `want.amount`, `min`, `paid`, `delivered`, and each fill's `paid`/`.fee` (plus `.got` ONLY on
  a partial `fills[]` entry — see the fill shapes below). Emit as **raw 0x-hex identity strings**: the offer
  `id` (32-byte txid), the name `claimId` (32-byte anchor txid, present on **every** name), and (v1.7) the
  offer `claimedBy` (20-byte addr). Emit as a nested **object**: the name `profile` (v1.9 nprofile — a flat
  string→string map). **Two distinct fill shapes (the `got`-presence rule):** a whole-offer fill is the
  singular object `fill` = `{buyer, txid, height, paid, fee}` and **OMITS `got`**; a partial-fillable (`min`)
  offer instead carries an **array** `fills`, each entry `{buyer, txid, height, paid, fee, got}` **WITH
  `got`** (`got` = the give-asset units delivered by that partial). An implementer who adds `got` to the
  singular `fill` (or drops it from a `fills[]` entry) forks `sha256(canonicalState)`. Never serialize an
  amount as a number or an `f64`; never stringify an integer field.
  > **⚠ v1.7/v1.9 are part of this byte contract on every live tip past their gate** (`V17_HEIGHT=34000`
  > claims, `V19_HEIGHT=36700` profiles). A second-language resolver built to an earlier copy of this list
  > — omitting `claimedBy`/`claimUntilHeight`/`claimId`/`profile`/`fills` — **forks `sha256(canonicalState)`
  > the moment any offer is claimed or any name carries a profile.** (Pinned on live data by
  > `replay-hashes.json` at **every activation height through V20** — incl. 34 000 claims, 36 700 profiles,
  > 38 400 grace; V18/V21 auto-pin once the chain tip crosses them. The static `cases.json` bar additionally
  > pins the V20/V21/nprofile/name-op/lapse byte-contract with no live node required.)
- **A4 — Optional fields are OMITTED, never `null`.** A key whose value is absent is dropped entirely
  (`addr, viaFill, min, bid, taker, paidThroughEpoch, expired`, token `name`/`mintLimit`/`tmeta`, and the
  v1.7/v1.9 optionals `claimedBy`/`claimUntilHeight` (omitted unless the offer is claimed), `fill`
  (omitted until first filled), `fills` (only on a `min` offer), `profile` (only when an nprofile is set)).
  Never emit `"addr":null`.
- **A5 — The acceptance gate is a byte-exact round-trip (stronger than the hash check).** A record anchor
  is accepted iff **both** `canonicalJson(JSON.parse(uri)) === uri` (byte-for-byte) **and**
  `sha256(uri) === payload_hash`. The round-trip is what rejects duplicate keys, leading-zero amounts,
  `+` signs, and insignificant whitespace; a record failing either check is a no-op and never enters
  replay. The round-trip does **not** catch a lone surrogate (it survives `JSON.parse`→`canonicalJson`
  identically as ASCII `\uXXXX`) — that class is rejected by **A7**, which every resolver MUST apply.
- **A6 — Integer grammar + the exact expressions.** Amounts match `^(0|[1-9][0-9]*)$` with
  `MAX_AMOUNT = 2^96 − 1`. The taker fee is `tradeFee(want) = (want·FEE_BPS + 9999) / 10000` (integer
  division = ceil of 1%). `epochOf(height) = floor(height / 30)`. Constants: `COMMIT_MAX_BLOCKS = 240`,
  `NAME_TERM_EPOCHS = 8760`, `NAME_GRACE_EPOCHS = 720`. Tickers match `^[A-Z][A-Z0-9]{2,11}$`
  (effective length **3–12**). **String length limits count UTF-16 CODE UNITS (JS `.length`)**, NOT
  codepoints or UTF-8 bytes: the free-text token `name` ≤ **32** units and `memo` ≤ **64** units. An
  astral codepoint (U+10000+) is **2** units, so a 16-emoji name is exactly 32 units (accepted) and a
  17-emoji name is 34 (a no-op). A resolver counting `chars`/codepoints (Rust `str::chars().count()`)
  or bytes would FORK at this boundary — implementers MUST count UTF-16 units (Rust
  `s.encode_utf16().count()`). Pinned by the `determinism-name-length-utf16-boundary` vector.
- **A7 — String well-formedness (UTF-16).** A record whose decoded JSON contains **any non-well-formed
  UTF-16 string** — a lone/unpaired surrogate (`0xD800–0xDBFF` not followed by `0xDC00–0xDFFF`, or a
  bare `0xDC00–0xDFFF`) in **any** key or value at any depth — is an **INVALID no-op for every
  conformant resolver**, rejected before schema validation. Rationale: such a string has no defined
  raw-UTF-8 canonical form (A1), so accepting it would credit on a V8 resolver and reject on a
  raw-UTF-8 one — a cross-language fork on identical chain bytes. Reference: `parseRecord`'s
  `isWellFormedDeep` gate (records.ts), which runs immediately after the A5 round-trip. Implementers
  MUST reproduce it (e.g. JS `String.prototype.isWellFormed`, Rust `str` is already well-formed so a
  `serde_json` parse that surfaces the escape and re-encodes will reject — assert it explicitly).

The conformance suite **now includes** the A1–A4/A7 vectors (`determinism-nonascii-name-value-pinned`
covers a non-ASCII token name, an emoji/non-BMP name, and CJK; `determinism-lone-surrogate-rejected`
covers the A7 no-op; control-character and present-vs-absent optionals are exercised by
`determinism-a.test.ts`). A second-language resolver is conformant only if it reproduces every vector's
canonical state **and** the pinned `replay-hashes.json` on live data byte-for-byte.

**Activated since this section was first written (all gated, all in the byte contract above):** v1.6
(`V16_HEIGHT=33600`) raised the taker fee to `FEE_BPS_V16=150` and added the flat+`REBATE_BPS` maker
rebate on resting liquidity; v1.7 (`V17_HEIGHT=34000`) added claim-to-fill (`SCORE_CLAIM`, the offer
`claimedBy`/`claimUntilHeight` fields, `MAX_ACTIVE_CLAIMS`/`CLAIM_WINDOW_BLOCKS`/`CLAIM_COOLDOWN_BLOCKS`);
v1.8 (`V18_HEIGHT=40000`, dormant) retiers the name registration fee; v1.9 (`V19_HEIGHT=36700`) added the
`nprofile` record + the name `profile` map (`PROFILE_MAX_KEYS`/`PROFILE_MAX_VALUE_BYTES`, the `PKEY`
charset). *(Still genuinely future / not implemented: pooled `pools`/`shares` value and a `MAX_RESERVE`
cap — ecosystem doc 16 §4; these are NOT in canonical state today.)*

## 6. Honest limits & safety

- **Convention-enforced, not consensus-enforced.** The chain knows nothing about tokens; it
  enforces (a) record immutability/ordering, (b) payment+attest atomicity in one tx, (c) the
  offer fill window (C5). Everything else is this convention, enforced identically by every
  honest resolver — the trust class of BRC-20/Runes, stated plainly.
- **Open-offer fill races:** if two buyers fill the same untaken offer, the first in apply
  order wins; the loser's payment still reached the seller. Buyer software MUST default to
  taker-bound (RFQ) flows or warn loudly on open-offer fills. Note the miner orders same-block
  txs **by feerate DESC, then txid ASC** (verified in chain/mine.rs) — a same-block race is
  therefore a fee auction, not arrival order; takers can bid up their fill's fee to win
  deterministically. **v1.3 closes this structurally:** from height 31 100, CSD-priced offers
  must be taker-bound (§15) — a warning cannot hold users back from a full-payment loss, and a
  no-escrow chain has nothing to refund from, so the unsafe shape is removed rather than warned
  about. (A claim window was first dismissed here as impossible because a *payment-bearing*
  reservation has nothing to refund — but v1.7's claim is **payment-free** (an `Attest`, not a
  payment), so a losing claimer forfeits only the 0.05 CSD attest fee. On that basis v1.7 safely
  **re-opens** untaken CSD offers via claim-to-fill — §20 — and v2.0/§23 bounds its late-fill edge.)
- **No unconfirmed chaining (no CPFP).** The mempool only accepts txs whose inputs exist in the
  confirmed UTXO set — you cannot spend change that hasn't been mined. Sequential CairnX actions
  from one key require one confirmation between them; client software must serialize and surface
  this ("next action available after 1 conf").
- **No native-CSD pools.** CSD itself cannot be locked by convention (real UTXOs obey only
  keys). CairnX trades CSD↔token atomically per-trade; it does not and cannot pool CSD.
- **Reorgs:** state is a pure function of the chain; resolvers recompute (or roll back) on
  reorg. Treat sub-final fills accordingly.
- **Spam/squatting:** every record costs ≥ 0.25 CSD (anchor fee floor) — sybil-priced, like
  everything on this chain. Ticker squatting is priced, not prevented; names are
  first-anchored-wins, same as 04-registry's golden rule.

## 7. Wire-level summary for implementers

| action | tx type | domain/ref | app fields | outputs |
|---|---|---|---|---|
| deploy/mint/transfer/offer/bid/name-ops | Propose | `cairnx:v1` | `uri` = record JSON, `payload_hash` = sha256(uri), `expires_epoch` per §4 | fee/payment outputs per §10/§19 + change |
| fill (CSD-priced) | Attest | offer proposal id | `score=100` (confidence ignored) | payment to `want.payto` + treasury fee + maker rebate (§19) + change |
| fill (token-priced) | Attest | offer proposal id | `score=100, confidence=1 000 000` | change only (debit + in-kind fee are convention-side, §11) |
| claim (v1.7, untaken CSD offer) | Attest | offer proposal id | `score=50` | change only — payment-free reservation (§20) |
| cancel | Attest | offer proposal id | `score=0` | change only |
| ocancel | Propose | `cairnx:v1` | `uri` = `{t:"ocancel",…}` | change only |

Fee floors: Propose ≥ 25 000 000, Attest ≥ 5 000 000 base units. 1 CSD = 100 000 000 base units.

---

# CairnX Convention v1.1 (names + protocol fees)

**Activation height: 29 960** (non-retroactive — pre-29 960 token offers/deploys remain fee-free).

## 9. Names — an on-chain-native namespace (ENS/BNS class)

CairnX names are a **tradeable, on-chain-native namespace**, distinct from `csd:identity` (which
binds a handle to a real-world identity via external proof and is NOT for sale). A name here is
owned purely on-chain — register, hold, point it at an address, transfer, or sell it.

- **Charset:** lowercase ASCII only — `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`, **1–32 chars**,
  no leading/trailing hyphen (single- and double-character premium names are valid and priced at
  the top of the fee curve). ASCII-only **eliminates the entire homograph/confusable attack
  class** (no Unicode → no look-alikes) and is trivially deterministic for every indexer.
  Reserved: `csd treasury admin official root www support` (`cairn`/`cairnx` are deliberately
  NOT reserved — the operator registered them as ordinary, tradeable names).
- **`name` (claim):** `{v:1,t:"name",name,salt?}`. Owner = anchoring proposer. **Lowest
  effective-anchor (height, pos, id) wins.** Requires the registration fee (§ below).
  - **Direct claim** (no `salt`): effective height = claim height. Simple, instant; front-runnable.
  - **Commit-reveal** (`salt` present): a prior `ncommit` of `sha256({t:"cairnx:name:commit:v1",
    name,salt,owner})` must exist at a strictly lower height within `COMMIT_MAX_BLOCKS` (8 epochs).
    The reveal **back-dates** its effective height to the commit height — so a committer beats any
    direct-claim squatter who acts in between (the reveal **displaces** them). This is the
    front-run defense (ENS/Namecoin/Runes pattern adapted to a fee-ordered chain).
- **`ncommit`:** `{v:1,t:"ncommit",commit}` — the commit hash (binds name+salt+owner, so it can't
  be reused by another address). Cheap; the reg fee is paid at reveal.
- **`nxfer`:** `{v:1,t:"nxfer",name,to}` — owner gifts the name. Clears the resolver record. Fails
  while the name is locked by an open offer.
- **`nset`:** `{v:1,t:"nset",name,addr}` — owner points the name at an address (the resolver
  record). Reverse resolution (address → names owned) is computed by the resolver.
- **Selling a name:** an `offer` with `give:{name}` (instead of `{ticker,amount}`). Anchoring it
  **locks** the name (can't transfer/re-offer); a `fill` transfers ownership to the buyer and pays
  the seller (+ protocol fee), atomically, in one tx; cancel/expiry release the lock.
- **Honest limits (v1.1, superseded):** names were **perpetual** through v1.4 (the registration fee
  was the only anti-squat measure). **Since v1.5 @ height 32 000 every name is a lease** — renewal,
  grace period, and decaying-premium recapture are normative in **§17**. Displacement can unwind a transfer made by a wrongful holder within the commit window
  (rare; deterministic).

## 10. Protocol fees → the CairnX treasury

The chain can't enforce a fee in consensus, so — like everything here — fees are **convention-
enforced via same-tx outputs** (consensus F4: Propose/Attest outputs are unrestricted). A fee-
bearing action is a **no-op unless its own transaction pays the fee to the treasury address**
`0x6b09ce74e6070ebc982ab0fb793a211c4d24f016`. Fees accrue as ordinary UTXOs the operator controls.

| Action (height ≥ 29 960) | Fee to treasury | Carried by |
|---|---|---|
| **trade fill** (token or name) | **1%** of `want.value`, `ceil` | the fill's Attest tx, alongside the seller payment |
| **token deploy** | **1 CSD** | the deploy's Propose tx |
| **name registration** (claim/reveal) | **length curve**: ≤3→5, 4→2, 5→1, 6–9→0.5, 10+→0.1 CSD | the claim's Propose tx |

Mint, transfer, name-xfer, name-set, offer, commit and cancel pay only the chain's own anchor fee
(to miners), not a protocol fee. An offer's `want.payto` may not be the treasury (keeps the
payment and fee output buckets distinct). The resolver tracks `feesPaid` (total observed to the
treasury) — recomputable by anyone, like all CairnX state.

---

# CairnX Convention v1.2 (token⇄token swaps + partial fills + bids)

**Activation height: 30 300** (non-retroactive — records using v1.2 shapes anchored below it are
no-ops; all v1/v1.1 records behave exactly as before at every height).

## 11. Token-priced offers — token⇄token swaps

An offer's `want` may now be a **token amount** instead of a CSD value:

```json
{"v":1,"t":"offer","give":{"ticker":"DUST","amount":"1000"},
 "want":{"ticker":"CAIRN","amount":"50000000","payto":"0x…40"},"taker":"0x…40"}
```

- `want.ticker` must exist at fill time (checked at apply, like every balance rule); a
  token-priced offer over an unknown ticker simply can never fill until that ticker exists.
  `give.ticker ≠ want.ticker`. `give` may also be a **name** (sell a name for tokens).
- Anchoring locks `give` exactly as in v1 (§4.4). `want.payto` (default seller) receives the
  want-tokens; it may not be the treasury.
- **Fill** = an `Attest` with `score = 100` **and `confidence = 1 000 000`** whose attester's
  *unlocked* `want.ticker` balance at apply time is ≥ `want.amount + fee`, where
  `fee = ceil(1% × want.amount)` **in kind**. On apply, atomically: debit the attester
  `amount + fee`; credit `payto` `amount`; credit the treasury `fee`; deliver `give` to the
  attester; close the offer.
- **Why the `confidence = 1 000 000` marker:** attestation is this chain's native signaling
  mechanism — people attest proposals to score them. A plain `score=100` attest on a
  token-priced offer must NOT silently spend the attester's tokens. The magic confidence value
  (impossible in normal signaling, which uses 0–100) makes a token-debiting fill an explicit,
  signed opt-in. CSD-priced fills don't need it: their payment outputs already prove intent.
- Insufficient balance / missing marker / taker mismatch → **no-op, offer stays open**.
- Token-priced offers are **whole-fill only** in v1.2 (an Attest carries no amount channel;
  partial fills below use the CSD payment itself as the amount signal).
- The buyer's tokens are **not pre-locked** — only the maker locks inventory. A fill that races
  the buyer's own same-block transfer resolves deterministically by apply order (proposals
  before attests, §3).

## 12. Partial fills (CSD-priced token offers)

A CSD-priced **token** offer may opt into partial fills with `min`:

```json
{"v":1,"t":"offer","give":{"ticker":"DUST","amount":"1000"},
 "want":{"value":"50000000"},"min":"5000000"}
```

- `min` (amount-string, `1 ≤ min ≤ want.value`) = the smallest payment a fill may make —
  the maker's anti-dust/anti-grief floor. Presence of `min` ⇒ the offer is partially fillable.
  `min` is invalid on name offers and on token-priced offers.
- A partial fill is a normal fill (Attest `score=100` + same-tx payment of `X` to `payto` +
  fee) where `min ≤ X`. Let `x = min(X, wantRemaining)` (overpayment is capped — it buys no
  more than what remains). Exception: when `wantRemaining < min`, `X ≥ wantRemaining` is
  allowed (the tail is always buyable).
- **Delivery (cumulative pro-rata, no rounding loss):**
  `deliveredCum' = floor(give.amount × paidCum' / want.value)` — each fill delivers
  `deliveredCum' − deliveredCum`. The final fill (`paidCum' = want.value`) therefore delivers
  exactly the undelivered remainder; rounding dust never strands in the lock.
- `fee = ceil(1% × x)` to the treasury in the same tx, per fill.
- The offer stays `open` until `paidCum = want.value` → `filled`. Cancel/expiry release the
  undelivered remainder to the seller; completed partial fills stand.
- Each fill is appended to the offer's `fills[]` (buyer, txid, height, paid, got, fee).
- Open partially-fillable offers race like v1 open offers (fee auction, §6) — but losing a
  race now only costs the loser the *overlap*: their payment still buys whatever remained.
  Wallets must still warn on open-offer fills.

## 12b. `ocancel` — mass-cancel (maker's kill switch)

```json
{"v":1,"t":"ocancel","ticker":"DUST"}
```

Cancels **all of the proposer's open offers anchored strictly earlier in apply order**, releasing
their locks — optionally filtered to one `give` asset (`ticker` or `name`, at most one). Without
cheap mass-cancel a market maker cannot keep a ladder of quotes honest (per-offer cancel = one tx
each — the 0x `minValidSalt` lesson). Anchor an `ocancel`, then re-post the fresh ladder — even in
the same block (proposals apply in tx order, so a later-pos ladder survives an earlier-pos cancel).

**Self-fills** (attester == seller) are **valid** and pay the protocol fee like any fill — wash
trading is self-punishing, and a no-op rule would just complicate determinism. **Fill races on
open offers** (§6) keep their v1 semantics; note that partial fills soften the loss — a racing
fill is clamped to whatever remainder exists, so its payment is only fully wasted when the
remainder is zero. Takers who need atomic certainty use whole-fill offers and taker-binding.

## 13. Bids — non-binding buy-side intents

CSD cannot be locked by convention (§6), so a *binding* buy order is impossible — the buy side
of the book is instead built from **bids**, on-chain discovery records:

```json
{"v":1,"t":"bid","want":{"ticker":"DUST","amount":"1000"},"give":{"value":"40000000"},"memo":"…"}
```

- "I will pay `give.value` CSD (>0) for `want`" — `want` is a token amount or `{name}`.
  The **bidder** = proposer. `expires_epoch` = the bid's validity window. Cancel = Attest
  `score=0` by the bidder. **Non-binding**: nothing is locked; honoring it is reputational.
- **Fulfillment** is the two-step RFQ: the asset owner anchors a **taker-bound offer**
  (`taker = bidder`, price ≤ bid) optionally tagged `"bid":"<bidId>"`; the bidder's client
  detects the responding offer and fills it atomically. Two anchors + one fill — the
  scriptless ceiling for buy-side flow.
- The resolver tracks `bids` (open/cancelled/expired) and links responding offers
  (`offer.bid` → `bid.offers[]`). A bid whose linked offer is **filled by the bidder** is
  marked `done` (purely informational).
- No protocol fee on bids (the anchor fee to miners is the spam price; the trade fee is paid
  when the responding offer fills).

## 14. v1.2 fee table (additions)

| Action (height ≥ 30 300) | Fee to treasury |
|---|---|
| token-priced fill | **1% in kind** (`ceil`, of `want.amount`, debited convention-side from the buyer) |
| partial fill | **1%** of each fill's effective payment `x`, `ceil`, same-tx CSD output |
| bid / bid-cancel | none (anchor fee only) |

In-kind fees accrue to the treasury **as token balances** (visible in `balances`); `feesPaid`
continues to count only CSD fees. The treasury spends its token balances like any holder
(transfer/offer records signed by the treasury key).

---

# CairnX Convention v1.3 (mandatory taker-binding for CSD-priced offers)

**Activation height: 31 100** (non-retroactive — all records and fills below it behave exactly
as before at every height).

## 15. CSD-priced offers must be taker-bound

The open (non-taker-bound) CSD-quoted fill was the **one structurally unsafe shape** in the
convention: a fill pays `want.value` as a real, irreversible CSD output to the seller in the
same tx that attests. If two buyers fill the same offer in one block, the apply-order winner
gets the asset and the **loser's full payment is already confirmed to the seller** — the seller
is paid twice and delivers once. The substrate has no escrow (§6), so no claim window, partial
fill, or warning can refund the loser. The only safe shapes are the two that already exist:
**taker-bound (RFQ) fills** — the resolver rejects non-takers, so a wallet never builds the
losing payment — and **token⇄token fills**, where both legs are convention-ledger debits and a
lost race is a guaranteed no-op.

From height **31 100**:

- **`offer` anchor rule:** a CSD-priced offer (`want.value`, token *or* name give) without a
  `taker` field is a **no-op** (`v1.3: CSD-priced offers must be taker-bound`). Token-priced
  (token⇄token) offers are unaffected and remain open to any filler.
- **`fill` rule:** a `SCORE_FILL` attest on **any** CSD-priced offer with no `taker` — including
  offers anchored before activation — is a no-op. Pre-v1.3 open CSD offers therefore become
  unfillable at activation (sellers cancel/`ocancel` or let them expire; locked give releases as
  usual). This is deliberately strict: the loser-pays race is only dead if no open CSD fill can
  ever succeed.
- **Buy-side flow for CSD pricing** is the v1.2 RFQ loop (§13): bid → seller answers with a
  taker-bound offer (partial-fillable allowed; `min` works as in §12) → bidder fills race-free.
  One extra anchor versus v1, in exchange for "a buyer can never lose more than the anchor fee."
- **Name sales are displacement-proof — two rules acting together:**
  1. **Age gate (offer anchor):** a name `offer` (CSD- *or* token-priced) is a no-op unless the
     name's basis is a fill (`viaFill`, below) or its effective claim is **strictly older than
     `COMMIT_MAX_BLOCKS`**. Every dangerous commit (one back-dating below the current claim) has
     a reveal deadline of `commitHeight + COMMIT_MAX_BLOCKS < claimEffHeight + COMMIT_MAX_BLOCKS`,
     so by the earliest legal offer — and therefore any fill — every lurking back-dated reveal
     has either fired (displacing the *claimant*, which IS the §9 front-run defense, loss
     bounded to the registration fee) or expired.
  2. **Fill immunity:** a name `fill` (CSD- or token-priced) marks the record **`viaFill`** and
     re-stamps `claimId/height/effectiveHeight/pos` to the fill itself. Displacement arbitrates
     **claim-vs-claim only** — a `viaFill` record can never be displaced by any reveal. (Without
     the age gate, immunity alone would let a front-run squatter launder a name through a quick
     flip; the gate makes that impossible, so the two rules are sound only together.)

  Net effect: an innocent buyer of a completed sale can never lose the name to a back-dated
  commit-reveal, and the §9 claim-time front-run defense is fully preserved. Residuals
  (documented): a **claim-based** record younger than the commit window is still displaceable —
  that is the defense working as designed; `nxfer` (a gift, no payment) does **not** re-stamp or
  immunize — the recipient inherits the giver's basis; and `viaFill` records re-sell with no
  aging delay (their basis cannot be back-dated under). Offers anchored *before* v1.3 that fill
  after it are not age-gated (one-time activation edge; all current open offers are
  operator-controlled).

## 16. Fill-before-cancel — cancels defer to the block boundary

§15 killed the buyer-vs-buyer race, but the same apply-order semantics left one **malicious-
seller** variant: the **cancel snipe**. Within a block the resolver applies **all proposals
(pos asc), then all attests (pos asc)** (§1). A fill is an attest; an `ocancel` is a proposal
(always applies first); a plain `cancel` is an attest whose pos the seller can lower by paying
a higher fee (miners order feerate-DESC). So a seller who sees a buyer's fill in the mempool
could broadcast a cheap `ocancel` (or a higher-fee `cancel`) in the same block: the cancel
applied first, the offer was no longer `open`, the fill no-op'd — **but the fill tx's payment
is a real confirmed output to the seller.** Seller paid, delivers nothing, cost ≈ one anchor
fee. That breaks §15's guarantee ("a buyer can never lose more than the anchor fee") the moment
a non-operator seller answers an RFQ.

From height **31 400**:

- **Rule:** a `cancel` or `ocancel`'s **effect** (releasing the give, flipping the offer to
  `cancelled`) is **deferred to the end of its block** — it applies only to offers still `open`
  after every same-block fill has settled. A same-block fill therefore **always wins**: a fill
  that lands means the seller got paid in that very tx, so it is a completed, fair sale; the
  late cancel then no-ops on the now-filled offer (noted
  `superseded by same-block fill (v1.4)`). An honest cancel — no competing same-block fill —
  lands exactly as before, one block-boundary later in effect but in the same block.
- **Guards still fire at apply time:** only-the-seller and offer-must-be-open are checked when
  the cancel is applied in order (a cancel on an already-filled/cancelled offer fails
  immediately, as pre-v1.4). Only the *effect* of a passing cancel is deferred.
- **`ocancel` snapshot:** the target set (the proposer's open offers matching the filter) is
  computed at apply time — correctly capturing only strictly-earlier offers, since higher-pos
  same-block offers are not yet applied — and at the flush only the targets **still open** are
  cancelled (partial fills in between deliver first; the flush releases the remainder).
- **Partial fills:** a same-block partial fill on a being-cancelled offer delivers its pro-rata
  amount; the deferred cancel then releases only the unsold remainder. The buyer keeps what
  they paid for; the seller keeps the rest.
- **Scope:** deferral is **intra-block only.** A fill in any later block than the cancel loses
  normally (the cancel flushed at the block boundary). Expiry sweeps are unchanged and run
  after the flush.
- **Why deferral, not reordering:** moving cancels after fills in the sort would break the
  global ordered loop and the "offers settle before fills" invariant for every other record
  type. Deferring only the effect keeps apply order intact. The one non-physical edge — a
  same-key `ocancel`-then-relist in one block observing pre-flush lock state — **cannot occur
  on-chain**: anchor inputs must be confirmed (no CPFP), so one key cannot chain two anchors
  into a single block.
- **Determinism:** the deferred-cancel list is built and flushed in apply order, so the state
  (and the event log) remains a pure function of the chain prefix. Non-retroactive: pre-v1.4
  blocks never defer, so all historical replay is byte-identical.

With §15 + §16 together the invariant holds against **both** failure modes: a buyer can never
lose more than the anchor fee — not to another buyer (race), and not to the seller (snipe).

## 17. Name leasing — names are paid-through, renewable, recapturable (v1.5)

§9's perpetual names were the registry's known economic gap: a 10+-char name costs 0.1 CSD
**once, forever** — squatting is free to carry, and lapsed projects strand names permanently.
From height **32 000** every name is a **lease**:

- **Term:** a claim (or premium re-claim) is paid through `claimEpoch + 8 760` epochs (≈ 1 year).
  Names claimed before v1.5 are **grandfathered** one full term from activation
  (`epochOf(32 000) + 8 760`) — computed lazily, no state rewrite at the boundary.
- **`nrenew` `{v:1,t:"nrenew",name}`:** extends the lease one term from its CURRENT end. Valid
  from **anyone** while the lease is live (third-party gifting, ENS-style) iff the same tx pays
  `nameRegFee(name)` to the treasury. A renewal never changes ownership.
- **Grace (720 epochs ≈ 30 days):** past `paidThroughEpoch`, only the **owner** may renew —
  otherwise a squatter could extend a lapsing name they intend to take.
- **Lapse → decaying-premium recapture:** past grace the name is unowned again. Anyone may claim
  it by paying `expiredClaimFee(name, epochsPastGraceEnd)`: `nameRegFee × 20` linearly decaying
  to `× 1` over 720 epochs (pure integer function — deterministic everywhere). The re-claim is a
  **fresh basis**: prior `viaFill` immunity is void (immunity protects a *paid* basis; an unpaid
  lease is an abandoned one), and any still-open offer on the name is voided with its lock freed.
- **Guards:** `nxfer`/`nset` on a lapsed lease are no-ops. A name **offer** is a no-op unless the
  lease covers the offer's ENTIRE fill window (`paidThroughEpoch ≥ expiresEpoch`) — so a fill can
  never hit a mid-window lapse; the alternative (a no-op'd CSD fill whose payment already
  confirmed to the seller) would be a fund-loss shape, so it is made unrepresentable. Offers
  anchored before v1.5 are exempt (their windows all end long before any grandfathered lease).
- **State:** at v1.5+ tips `names[x]` carries `paidThroughEpoch` (and `expired: true` once
  lapsed; the record is kept for history until re-claimed). Pre-v1.5 canonical hashes are
  unchanged — the fields exist only at v1.5+ tips.

## 18. `tmeta` — issuer token metadata via the content layer (v1.5)

`{v:1,t:"tmeta",ticker,hash}` — **issuer-only**, last write wins, no fee beyond the anchor.
`hash` is a csd-swarm Content Convention v1 hash (0x + 64 hex) pointing at the token's
`{logo, description, links}` document — self-certifying content, so the record stays tiny
(the 512-byte `uri` cap is untouched) and the metadata inherits the swarm's verify-on-read
property. State: `tokens[t].tmeta`. Records before v1.5 are no-ops.

---

# CairnX Convention v1.6 (fee update + maker rebate)

**Activation height: 33 600** (`V16_HEIGHT`; non-retroactive — pre-v1.6 offers keep the 1% fee and earn no rebate).

## 19. Taker fee 1% → 1.5%, and a maker rebate on resting liquidity

- **Fee bump.** The taker fee becomes `FEE_BPS_V16 = 150` (1.5%, `ceil`) instead of `FEE_BPS = 100` (1%).
  The rate is **captured per-offer at creation height** into `offers[id].feeBps` (a bare-int canonical field,
  §5.1-A3): an offer anchored ≥ 33 600 carries `feeBps = 150`, an earlier one keeps `100`. Every fill of that
  offer (whole, partial, token-priced) uses the offer's own `feeBps` — so pre-v1.6 offers are byte-identical
  forever. A third-party resolver MUST select the fee by **offer-creation height**, not by fill height.
- **Maker rebate (whole CSD-priced fills only).** On a whole fill of a **resting-liquidity** CSD-priced offer,
  the taker additionally pays the **maker** (`offers[id].seller`) a rebate, as an extra output **in the same
  fill tx**, reimbursing the maker's posting (Propose) cost:
  `makerRebate(want) = REBATE_FLAT + ceil(REBATE_BPS × want / 10000)` with `REBATE_FLAT = 25 000 000`
  (0.25 CSD) and `REBATE_BPS = 50` (0.5%).
- **`restingLiquidity` predicate (normative):** an offer qualifies iff
  `(offer.taker !== undefined && offer.bid !== undefined)` — a taker-bound answer to a bid (the RFQ/MM lane) —
  **OR** `(offer.height ≥ V17_HEIGHT && offer.taker === undefined)` — a v1.7 open ask (claim-to-fill).
  Partial fills and token⇄token fills earn **no** rebate. (Keying on `bid` alone was a closed self-mint hole:
  a maker could self-attach an unanchored bid to an open offer; the open-ask lane now earns it via `taker
  === undefined && height ≥ V17` regardless of `bid`, and a bid-answer rebate requires a real consenting taker.)
- **Same-tx output gate (the SUM rule).** The fill's required outputs are accumulated **per recipient**:
  `want.payto += want.value`, `TREASURY += tradeFee(want, feeBps)`, and (if rebate applies) `seller += rebate`.
  When `want.payto == seller` (the common default) the two amounts **SUM** — a resolver MUST check each
  recipient against the summed requirement, never satisfy by `max()`. (`payto` can never be the treasury, so
  those buckets never collide.) For a pre-v1.6 offer the rebate is 0 and this reduces to the two original checks.

---

# CairnX Convention v1.7 (claim-to-fill — race-safe open CSD offers)

**Activation height: 34 000** (`V17_HEIGHT`; non-retroactive — in `[V13, V17)` open CSD fills stay banned, §15).

## 20. Claim-to-fill — an untaken CSD offer is reserved before it is paid

v1.3 (§15) removed open CSD offers because the loser of a payment-bearing fill race loses a real payment.
v1.7 re-opens them safely by moving the race to a **payment-free reservation**: a losing claimer forfeits only
the 0.05 CSD attest fee, never a payment.

- **Claim** = an `Attest` on the offer with **`score = SCORE_CLAIM = 50`** (∉ {fill 100, cancel 0}, so it is an
  inert no-op below V17 — non-retroactive). It grants the attester an **exclusive hold** of the offer for
  `CLAIM_WINDOW_BLOCKS = 15` blocks: on grant the resolver records `offers[id].claimedBy = attester` and
  `offers[id].claimUntilHeight = grantHeight + 15` (both canonical fields, §5.1-A3, present only while claimed).
- **Fill gate.** A `SCORE_FILL` fill on an **untaken** (`taker === undefined`) CSD-priced offer at height ≥ V17
  is valid **only if** the offer is currently held **and the filler is the holder**: `claimHeld(o, h) &&
  attester === o.claimedBy`, where `claimHeld(o, h) = (o.claimedBy !== undefined) && (h < o.claimUntilHeight)`
  (v2.0 widens this — §23). A fill by anyone else, or with no live claim, is a no-op (offer stays open).
- **No new claim while held.** A `claim` on an offer that is already held (`claimHeld`) is a no-op.
- **`MAX_ACTIVE_CLAIMS = 3` per address.** A claim is rejected if the attester already holds 3 offers
  (`liveN = count of offers x where x.claimedBy === attester && claimHeld(x, h)`). Anti-squat.
- **`CLAIM_COOLDOWN_BLOCKS = 15`.** The address whose hold just lapsed (`o.claimedBy === attester`) may not
  immediately re-grab the **same** offer until `h ≥ o.claimUntilHeight + CLAIM_COOLDOWN_BLOCKS` (in v2.0, the
  cooldown runs from the end of the hold = window + grace). Known bound (identical in the Python reference, so
  not a fork): the cooldown keys on the last claimer, so a colluding A→B→A pair can recycle one offer — a
  payment-free liveness nuisance on a single offer, never value loss.
- **Reorg note (client, not consensus):** claim→fill is two txs, so the payment has a reorg exposure a single-tx
  fill lacks. Buyer software MUST wait a value-scaled confirmation depth (gambler's-ruin sized) on the claim
  before broadcasting the fill — this is a client policy, not a resolver rule, and does not affect canonical state.
- Taker-bound offers need no claim (they were never in the race). Token⇄token offers are no-op-safe and ignore claims.

---

# CairnX Convention v1.8 (two-tier name registration fee)

**Activation height: 40 000** (`V18_HEIGHT`; non-retroactive — below it the §10 ENS curve applies unchanged).

## 21. Flat two-tier name fee

At/above V18, `nameRegFee(name, height)` (the fee for `name` claim/reveal, `nrenew`, and the base of the §17
lapsed-premium) becomes a flat **two-tier** schedule, replacing the §10 length curve:

- name length **≤ 4** chars → `NAME_FEE_SHORT_V18 = 670 000 000` (6.7 CSD);
- name length **≥ 5** chars → `NAME_FEE_V18 = 300 000 000` (3 CSD).

Below 40 000 the original 5-tier curve (§10: ≤3→5, 4→2, 5→1, 6–9→0.5, 10+→0.1 CSD) still applies — the fee is
selected by **anchor height**, so all historical replay is byte-identical. (Client builders should price a fee
output built within a few blocks *below* V18 at the V18 rate, since overpay is always accepted but underpay is a
no-op that forfeits the treasury output.)

---

# CairnX Convention v1.9 (nprofile — ENS-class identity)

**Activation height: 36 700** (`V19_HEIGHT`; non-retroactive — `nprofile` below it is a forward-compat no-op).

## 22. `nprofile` — owner-set identity metadata on a name

```json
{"v":1,"t":"nprofile","name":"alice","p":{"url":"https://alice.example","eth.address":"0x…"}}
```

- **Inert metadata.** `p` is a flat string→string map. It carries **no fee, no value, and is never a send
  target** — the address a name resolves to for payment stays in `nset` (`names[x].addr`). A resolver keeps
  no reserved keys; the app layer keeps send targets out of `p`.
- **Owner-gated, last-write-wins.** Valid iff the proposer is the current name owner and the lease is not
  lapsed (§17). The new `p` **replaces** the prior profile; an **empty `p` (`{}`) clears it**.
- **Cleared on every ownership change** — `nxfer`, a name `fill`, and a lapsed-premium re-claim all clear
  `profile` exactly as they clear `addr`.
- **Shape limits (deterministic):** keys match `PKEY = ^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$` (ASCII only,
  so the canonical key sort is invariant across UTF-16/codepoint/byte impls — future-proof vs a third-language
  resolver); at most `PROFILE_MAX_KEYS = 16` keys; each value is a string of ≤ `PROFILE_MAX_VALUE_BYTES = 256`
  **UTF-8 bytes**. Any violation → the record is a no-op.
- **State:** `names[x].profile` is a nested object, materialized **only at v1.9+ tips** and **only when set** —
  so every pre-v1.9 canonical hash is byte-unchanged, and a name with no profile omits the key (§5.1-A4).

---

# CairnX Convention v2.0 (claim grace — the bounded late-fill fix)

**Activation height: 38 400** (`V20_HEIGHT`; non-retroactive — below it the strict 15-block window of §20 stands).

## 23. Bounded claim grace — a slightly-late in-window fill still delivers

v1.7's claim-to-fill had a fund-loss edge: a fill submitted inside the window but **mining at the window
boundary** (`height == claimUntilHeight`) was rejected by the resolver while its CSD payment was already
UTXO-final → the buyer paid and received nothing (the live `69.csd` incident). v2.0 fixes it without a race:

- At/above V20 the claim window widens to `CLAIM_WINDOW_BLOCKS_V20 = 40`, and a **bounded fill grace** of
  `CLAIM_FILL_GRACE_BLOCKS = 5` is added. The **hold = window + grace = 45 blocks** is exclusive on **both**
  sides — within it the claimer's fill is honored **AND** no other address may claim. So a slightly-late
  in-window fill still delivers, and there is **no displacement race** (the holder is exclusive for the whole
  hold; below the grace a new claim is rejected). Past the hold the offer **reopens** — the hold is **bounded,
  not "until displaced."** `claimHeld(o, h)` becomes `h < o.claimUntilHeight + grace(o)`.
- **Era inference (no new stored field).** The grace is derived from the claim's era so its inverse is
  unambiguous: a claim granted at ≥ V20 has `claimUntilHeight = grantHeight + 40 ≥ V20 + 40`; a pre-V20 claim
  has `claimUntilHeight ≤ V20 + 14`; the range `[V20+15, V20+40)` is **unreachable**. Therefore
  `grace(o) = (o.claimUntilHeight − 40 ≥ V20_HEIGHT) ? 5 : 0`. Below V20 the window is 15 and the grace is 0 —
  byte-identical history.
- The `MAX_ACTIVE_CLAIMS` count and the `CLAIM_COOLDOWN_BLOCKS` both use the **hold** (window + grace), so the
  grace can neither expand an address's concurrent reach past the cap nor be used to dodge the cooldown.
- **Offer-expiry interaction (client guard, not consensus).** `sweepExpired` runs before the fill, so a fill
  mining between the offer's expiry and the hold-end would still burn the payment. Client software MUST refuse
  to claim/fill unless the offer's lease/expiry outlives the **hold-end** (`claimUntilHeight + grace`), not
  merely the tip. This is a client policy bounding what to sign; the resolver state is unchanged by it.

---

# CairnX Convention v2.1 (offer/bid duration cap)

**Activation height: 40 100** (`V21_HEIGHT`; non-retroactive — below it the effective expiry is the raw `expires_epoch`).

## 24. Maximum offer/bid lifetime — `MAX_OFFER_EPOCHS = 168` (≈ 7 days)

To keep resting inventory shallow (so an in-browser SPV light client's checkpoint stays near the tip rather
than being dragged back to the oldest open offer), an offer or bid may rest at most `MAX_OFFER_EPOCHS = 168`
epochs from its anchor:

- **Creation gate (≥ V21):** an `offer` or `bid` whose `expires_epoch − epochOf(anchorHeight) > 168` is a
  **no-op at creation** (`v2.1: offer/bid duration exceeds the max`).
- **Lazy sweep cap (≥ V21):** the **effective** expiry used by `sweepExpired` is
  `effExpiry = min(expires_epoch, epochOf(anchorHeight) + 168)` whenever the **sweep height** is ≥ V21. So an
  over-cap offer/bid created **before** V21 (which was validly accepted at creation) auto-expires the moment a
  sweep first runs at a height ≥ V21 past its capped expiry. The cap is gated by the **current sweep height**
  (deterministic across replayers), so existing over-cap inventory expires at exactly the same height for
  everyone. Below V21, `effExpiry = expires_epoch` — byte-identical history.
- **Client expiry-height closed form** (mirrors the resolver's height-gated sweep, for buy-safety guards):
  `offerExpiryHeight = min( (expires_epoch+1)·30 , max( V21_HEIGHT , (epochOf(anchor)+168+1)·30 ) )`.
