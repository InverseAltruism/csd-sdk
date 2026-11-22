# CairnX Convention v1

**Status:** v2.9 (normative; v2.9 activated at `V29_HEIGHT` = 88 000, crossed 2026-08-31, see §32; v2.8 activated at 60 000, crossed 2026-07-23; supersedes the 2026-06-10 v1.0 draft; §33 to §41 carry no gate and move no state) · **Domain:** `cairnx:v1` · **Base activation:** 29 860

**Version ladder** (each gate non-retroactive: below it, behavior + canonical hashes are byte-identical to history):
v1.1 @ 29 960 · v1.2 @ 30 300 · v1.3 @ 31 100 · v1.4 @ 31 400 · v1.5 @ 32 000 · v1.6 @ 33 600 (§19) ·
v1.7 @ 34 000 (§20) · v1.9 @ 36 700 (§22) · v2.0 @ 38 400 (§23) · v1.8 @ 40 000 (§21) · v2.1 @ 40 100 (§24) ·
v2.2 @ 41 300 (§25) · v2.4 @ 46 400 (§27) · v2.5 @ 46 440 (§28) · v2.6 @ 46 480 (§29) · v2.7 @ 46 520 (§30) ·
v2.3 @ 52 000 (§26) · v2.8 @ 60 000 (§31) · v2.9 @ 88 000 (§32; its replay hash is pinned in `test/vectors/replay-hashes.json`).
Sections §19–§32 are the normative semantics for v1.6–v2.9; §5.1 is the byte-level canonical-JSON contract that binds all of them.
§33 is the rule that turns the chain's blocks into the events every version replays; §34 defines the two hashes
replicas compare. §35 and §36 are for other applications (their domains, the profile-key registry), §37 states what
a result proves, §38 how a replica conforms, §39 how the rules change, §40 the reason codes of the applied log
and of record validation and §41 the token moves of the applied log; none of §33 to §41 has a gate.
Activation order is by HEIGHT, not by version number (v1.8 activated after v2.0; v2.3 activates after v2.4–v2.7): a
replayer gates each rule on its own height constant, never on "version X implies version Y is active".

> **Height re-pin history (2026-07-03).** v2.4–v2.7 originally published as 49 200 / 51 000 / 51 200 / 52 500
> and were RE-PINNED to 46 400 / 46 440 / 46 480 / 46 520 (`CONSENSUS_CHANGES.md` 0.1.33): an operator-approved,
> coordinated same-day re-pin of every verifier while the tip (~46 071) was still below every new height, so all
> recorded history replays byte-identically. Replayers built from this spec MUST use the re-pinned heights above.

> **Canonical copy.** This spec ships in the published `@inversealtruism/cairnx-core` package; the source of
> truth is `csd-sdk/packages/cairnx/CONVENTION.md`. The `cairnx` app repo keeps no copy: its `CONVENTION.md`
> is a pointer to this file and to the copy in the installed package. A third-party implementer fetches the
> *published* copy, so it is the one that must never lag the code.

CairnX is a meta-asset and exchange convention on Compute Substrate (CSD). It defines fungible
tokens and trades, one transaction paying and recording each fill, using **only** the chain's existing `Propose`
and `Attest` transactions: no fork, no new transaction types, no custodian. Token semantics are
enforced by a **pure, deterministic resolver** that any party can run; independent resolvers
replaying the same chain converge on identical state.

This document is normative. The reference resolver (`src/resolve.ts`), the reference rule of §33
(`src/events.ts`), the hashes of §34 (`src/hashes.ts`), the reason codes of §40 (`src/codes.ts`) and their conformance
suites implement exactly what is written here.

---

## 1. Consensus facts relied upon

Verified against the node source (`compute-substrate` @ v1.x, 2026-06-10):

- **C1.** Every input of a tx signs the same global sighash; tx validity requires all signatures.
- **C2.** A `Propose`/`Attest` tx's value outputs are unrestricted (only fee floors apply:
  ≥ 0.25 CSD propose, ≥ 0.05 CSD attest). One tx can pay arbitrary addresses *and* carry an app payload.
- **C3.** `proposer` / `attester` = `hash160(input[0].pubkey)`, stored by consensus. The node accepts input 0
  only when that hash equals the `script_pubkey` of the coin it spends, so for a mined tx it is that coin's
  owner. The txid does not commit the signature script; a reader takes the author from the spent coin (§33.5).
- **C4.** `Propose.uri` is a consensus-stored string ≤ **512 bytes** (non-empty); `payload_hash`
  is a consensus-stored 32-byte value (non-zero).
- **C5.** An `Attest` referencing proposal `P` is **consensus-rejected** once
  `epoch > P.expires_epoch` (epoch = ⌊height/30⌋). Same-block attest-after-propose is valid
  (block apply phases: proposals, then attestations).
- **C6.** Duplicate `payload_hash` anchors are allowed; proposals are keyed by txid.
- **C7.** Mempool is first-seen; conflicting spends rejected; no RBF.

## 2. Encoding: records live on-chain in `uri`

Every CairnX record is a **canonical JSON** object (UTF-8, recursively sorted keys, compact:
exactly `canonicalJson` from `@inversealtruism/csd-codec`) whose serialized form MUST be
≤ 512 bytes. It is anchored by a `Propose` to domain **`cairnx:v1`** with:

- `uri` = the canonical JSON string itself (the record is **fully on-chain**, replicated by
  every node, forever: there is no off-chain content-availability problem);
- `payload_hash` = `sha256(uri bytes)` (`payloadHash` of the record). Resolvers MUST verify
  `sha256(uri) == payload_hash` and treat mismatching anchors as no-ops;
- `expires_epoch`: see per-record semantics (for offers it is the consensus-enforced fill window).

A record's **actor** is the anchoring tx's consensus `proposer` (C3). There are no off-chain
signatures in v1: anchoring *from your key* is the authorization.

## 3. Common rules

- **Amounts** are strings of decimal integers in base units, `"1"` ≤ x < `2^96`, except an offer's price: its
  `want.value` (§4.4) and its `want.amount` (§11) may be `"0"`. Resolvers use arbitrary-precision integers.
  `decimals` (0–8) is display-only.
- **Tickers** match `^[A-Z][A-Z0-9]{2,11}$`.
- **Addresses** are `0x` + 40 lowercase hex.
- **Hashes and ids in records** (`ncommit`'s `commit`, `tmeta`'s `hash`, an offer's `bid`, an `fclaim`'s `offer`) are
  `0x` + 64 lowercase hex (`HASH_RE`); any other form makes the record an invalid no-op (`RECORD_BAD_HASH`).
- **Apply order:** events are replayed in consensus order: by block height; within a block,
  all `cairnx:v1` proposals in tx order (`pos`), then all attestations on CairnX proposals in tx
  order (the events of §33). (Mirrors the node’s propose/attest phases, C5.) Remaining ties (same height, phase, pos:
  possible only across indexer quirks, never on a real chain) break by **ordinal (code-unit)
  comparison of the lowercase `0x`-hex txid**. Ordinal comparison is the ONLY string ordering
  used anywhere in resolution and serialization: locale-aware collation (e.g. JavaScript's
  `localeCompare`) is forbidden, since it is ICU-dependent and non-reproducible across runtimes.
- **Invalid = no-op.** A record that fails any check (schema, balance, state) has **no effect**.
  Unknown `t` values and `v ≠ 1` are no-ops (forward compatibility). Invalidity never poisons
  later records.
- **Activation:** anchors below height **29 860** are ignored, and are not events (§33); neither is an
  Attest on such an anchor. (Set just before the first protocol traffic: the domain had no prior use; the
  live X2 e2e records ARE the genesis.)
- **Finality:** state derived from blocks < 6 confirmations is provisional (display threshold
  3, final 6, matching Cairn's site conventions).

## 4. Records

### 4.1 `deploy`: create a token

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
| `mintLimit` | required iff `mint:"open"`: max amount credited per mint record |

The deploy's `expires_epoch` SHOULD be far future (e.g. tip-epoch + 100 000); expiry has no
CairnX meaning for deploys. The **deployer** is the anchoring proposer.

### 4.2 `mint`: issue supply

```json
{"v":1,"t":"mint","ticker":"DUST","amount":"100000"}
```

- Token must exist (deploy anchored strictly earlier in apply order; same-block-earlier-pos counts).
- `mint:"open"`: any proposer; credited `min(amount, mintLimit, remaining supply)`; if remaining
  supply is 0 the mint is a no-op. `amount` defaults to `mintLimit` if omitted.
- `mint:"issuer"`: proposer MUST equal the deployer; credited `min(amount, remaining)`; `amount` required.
- Credited to the **proposer**.

### 4.3 `transfer`: move tokens

```json
{"v":1,"t":"transfer","ticker":"DUST","to":"0x…40","amount":"2500","memo":"…","ts":1781387000}
```

- Sender = **proposer**. Valid iff sender's *unlocked* balance ≥ `amount` at apply time.
- `to` may be any address (including sender). `memo` ≤ 64 chars and `ts` are optional
  free fields (also serve to differentiate otherwise-identical records; note two anchors of
  byte-identical transfer content by the same sender are **two transfers**: each anchor is an
  independent authorization by C3).

### 4.4 `offer`: on-chain sell order (locks tokens)

```json
{"v":1,"t":"offer","give":{"ticker":"DUST","amount":"1000"},
 "want":{"value":"50000000","payto":"0x…40"},"taker":"0x…40","memo":"…"}
```

- Seller = **proposer**. Valid iff seller's unlocked balance ≥ `give.amount`; on apply, that
  amount is **locked** (cannot be transferred or re-offered).
- `want.value`: CSD price in base units (string; `"0"` allowed = giveaway). `want.payto`
  defaults to the seller.
- `taker` (optional): if present, only this address can fill. **Taker-bound offers are the
  protected path** (see §6).
- The anchoring proposal's **`expires_epoch` is the offer's validity window**: after it, the
  chain itself rejects fill attempts (C5), and the resolver releases the lock (the expiry sweep of §5). Offers SHOULD
  use short windows (e.g. tip-epoch + 24 ≈ 1 day).
- An offer is identified by its **proposal id (txid)**.
- `memo` (64 UTF-16 units max) and `ts` are optional free fields with the same rules as
  `transfer` (4.3); `ts` MUST be a JS-safe integer (A8).

### 4.5 `fill`: payment and record in one transaction (an Attest, not a Propose)

A fill is an **`Attest` transaction** referencing the offer's proposal id with **`score = 100`**,
whose **own outputs** pay the seller:

- valid iff the offer is open (not filled, not cancelled, not expired) at apply time;
- if `taker` is set, `attester == taker`;
- `Σ(outputs of the attesting tx paying want.payto) ≥ want.value`;
- on apply: the locked `give.amount` moves to the **attester**, the offer closes.

Because payment outputs and the attestation are one transaction (C2), **one transaction pays and
records the fill**, and the replay then decides delivery by the rules above. A CSD-paid fill the replay
refuses keeps the payment: CairnX rejecting the fill does not undo or refund the transaction's CSD outputs,
which stand as the chain keeps them (subject to reorganization). A token-for-token fill
(§11) is atomic: the replay moves both sides or neither. The seller's tokens were already
convention-locked. The fill costs only the attest fee floor (0.05 CSD) plus the payment.

The **first valid fill in apply order wins**. For a **CSD-priced** fill `confidence` is ignored
(set 100); a **token-priced** fill (§11) additionally requires the `confidence = 1 000 000` opt-in
marker or it is a no-op.

### 4.6 `cancel`: close an offer (an Attest)

`Attest` on the offer with **`score = 0`**, valid only when `attester == seller`. Releases the
lock, closes the offer. (Cancel and fill race in apply order like everything else.)

Other `score` values on CairnX offers are reserved (no-ops). The **claim-to-fill** exclusivity
extension shipped at v1.7 (height 34 000) and uses **`score = 50`** (`SCORE_CLAIM`), *not* `score = 1`
(an earlier draft placeholder that was never implemented). See §20.

## 5. Resolver state (normative output)

```
tokens:   ticker → { ticker, deployId, deployer, name?, decimals, supply, minted, mint, mintLimit?, height, tmeta? }
balances: ticker → address → { available, locked }
names:    name → { name, owner, claimId, height, effectiveHeight, locked, addr?, viaFill?, profile?,
                   paidThroughEpoch?, expired? }
          or, for a pending reservation (§28):
          name → { name, owner, claimId, height, effectiveHeight, locked, pending, finalizeBy }
offers:   offerId → { id, seller, give, want: { value, payto } | { ticker, amount, payto }, taker?,
                      status: open|filled|cancelled|expired, expiresEpoch, height, feeBps,
                      min?, paid?, delivered?, fills?, bid?, claimedBy?, claimUntilHeight?, claimTxid?,
                      fill?: { buyer, txid, height, paid, fee, got? } }
bids:     bidId → { id, bidder, want, give: { value }, status: open|cancelled|expired|done,
                    expiresEpoch, height, offers }
feesPaid: the protocol fees owed by applied records (§10), a decimal string
events:   ordered log of applied/no-op decisions { height, pos, id, kind, ok, code, note?, moves? } (for explorers &
          audit; INFORMATIONAL, excluded from the canonical surface; each entry's `code` is stable (§40), its `note`
          text a diagnostic, and an applied record that moved tokens carries its `moves` (§41))
```

An address whose `available` and `locked` are both 0 is left out of `balances`, and so is a ticker with no address
remaining. `want.payto` is always present: the record's `payto`, or the seller when the record has none.

**Fill records.** A whole fill sets `fill` once. Its `paid` is what the fill's transaction pays to `want.payto` (the
`paidTo` sum of §33.4), overpayment included, and so the maker rebate as well when `payto` is the seller (§19); for a
token-priced fill it is `want.amount`. Its `fee` is the fee the fill owed (§10, §14, §19). A partial fill (§12) appends
`{buyer, txid, height, paid, fee, got}` to `fills`, with `paid` its effective payment `x` and `got` the give units it
delivered; the partial fill that completes the offer also sets `fill` to that same entry, `got` included.

**Expiry in the state.** Before each event at height h the resolver expires every open offer and bid whose effective
expiry epoch (§24, §25) is below `epochOf(h)`, releasing an offer's give, and deletes every reservation (§28) and
recapture reservation (§29) whose `finalizeBy` is below h. After the last event, and after the deferred cancels of its
block (§16), it runs the same sweep once more at `tipHeight + 1`. So the state at a tip shows an offer or bid whose
effective expiry epoch, as the sweep at `tipHeight + 1` computes it, is `epochOf(tipHeight)` as `expired` when
`tipHeight` is the last height of that epoch (`tipHeight mod 30 = 29`), and as `open` at every earlier tip of the
epoch. For an offer or bid anchored below V22 that sweep applies the §24 cap once `tipHeight + 1` reaches V21
(40 100), that is from tip 40 099 on. A name's `expired` (§17) is read at the tip's own epoch: it is present when
`epochOf(tipHeight) > paidThroughEpoch + NAME_GRACE_EPOCHS`.

For the heights a chain produces (block heights, non-negative integers below 2^53) the state at a tip does not depend
on the heights at which sweeps ran between events: an item only becomes due as the height grows, whether it is due
reads that item alone, and an expiry writes the item's status and what it releases (an addition to one seller's
balance, or the unlock of one name) or deletes one reservation. A resolver may apply each expiry at the first height
it is due, or every due expiry before each event, as cairnx-core 0.2.8 and the Python reference do. So an event that
writes nothing (§40.1) changes no state: at most it adds a sweep at its height and runs the flush of the previous
block's deferred cancels (§16) that the next event at a new height would run before its own sweep; below activation,
or repeated at V29 or above, it adds neither.

`resolve()` takes heights and tips of any value, and outside that domain the heights at which sweeps run can matter:
an offer whose event height is NaN has a NaN cap (§24) from V21 on, so it is due below V21 and at no height from V21
on, and a commit at the string height "90000" gives a reservation the deadline "90000820", which a sweep compares as
text at a string height and as a number at a number one. cairnx-core from 0.2.9 applies each expiry at the first
height it is due only while every event height and the tip it has read is a safe integer (`Number.isSafeInteger`).
Inside that domain being due only grows with height, so batches at the due heights give the state of one batch per
sweep; the first height or tip outside it ends the batches before any sweep reads it; from then on every sweep is the
one before each event and at `tipHeight + 1`, as in 0.2.8. That gives the state 0.2.8 gives for inputs made of plain
values (what JSON carries); a getter or a conversion with side effects, which the fold reads a different number of
times, is outside that statement. Outside the domain the result is not consensus: released cores have answered
differently (0.2.4 and 0.2.7 on a string height), so a caller checks that event heights and the tip are safe integers
before the call.

**Canonical state (format 2, normative):** the canonical surface is
`{tipHeight, tokens, balances, names, offers, bids, feesPaid}`: the event log is excluded.
Serialization is **canonical JSON** in the state form of §5.1: object keys sorted in ordinal (code-unit) order at every
depth, except that keys which are array indices (the canonical decimal of an integer in [0, 2^32 − 2]: an all-digit
name, an all-digit profile key) come first in ascending numeric order (§5.1 A2); arrays keep their order (`fills` and a
bid's `offers` in apply order); no insignificant whitespace, UTF-8, all amounts as decimal strings (no floats anywhere),
booleans/numbers in their shortest JS form. Two resolvers fed the events of §33 for the same chain prefix MUST produce
byte-identical canonical state; `sha256(canonicalState)` at the activation heights is pinned in
`test/vectors/replay-hashes.json`, and `test/vectors/cases.json` carries language-neutral replay
vectors a third-party implementation must reproduce. (Format 1, pre-2026-06-12, included the
event log and used locale collation; it is retired.)

Determinism requirement: the conformance suite enforces byte-identity, including
shuffle-invariance of inputs that consensus ordering re-sorts.

### 5.1 The byte-level canonical-JSON contract (normative: pin before a 2nd implementation exists)

"Canonical JSON" above is only as portable as these rules. They document exactly what the reference
canonicalizer (`@inversealtruism/csd-codec` `canonicalJson`, which bottoms out in ECMA-262
`JSON.stringify`) produces. An independent resolver that diverges on any of them will fork the
record-acceptance gate and/or the canonical-state hash on valid mainnet data. These are unmigratable
once a replay hash is pinned over data that exercises them, so they are stated here verbatim.

- **A1: String escaping.** Escape **only** `"` → `\"`, `\` → `\\`, and the C0 controls U+0000–U+001F
  (using the short escapes `\b \f \n \r \t`, otherwise lowercase `\u00XX`). Emit **every other**
  codepoint as **raw UTF-8**: in particular do **NOT** escape `/` (solidus) and do **NOT** `\u`-escape
  any non-ASCII codepoint (U+0080 and above). A token `name` of `"Café"` serializes the `é` as the raw
  2-byte UTF-8 `0xC3 0xA9`, never `é`; an emoji serializes as its raw 4-byte UTF-8, never an
  escaped surrogate pair. (Note: `memo` fields on transfer/offer/bid carry the same free-Unicode
  surface inside the record `uri`, so they obey A1 too even though they are not in canonical state.)
  **A1 is unsatisfiable for a lone/unpaired UTF-16 surrogate** (it has no valid UTF-8 form): V8 escapes
  it to ASCII `\uXXXX` while a raw-UTF-8 resolver rejects/mangles it, so such a string is rejected
  outright by **A7** before it can reach A1; see A7.
- **A2: Key ordering is UTF-16 code-unit order, NOT Unicode codepoint / UTF-8 byte order.** Sort object
  keys by comparing their UTF-16 code units. These two orders are identical for all-BMP strings but
  **diverge for non-BMP characters (U+10000+)**: a leading surrogate `0xD800–0xDBFF` sorts *below* BMP
  chars `0xE000–0xFFFF` under UTF-16, but *above* all BMP chars under codepoint order. **Rust
  `str::cmp` / Go `<` on `string` compare by UTF-8 bytes = codepoint order and are therefore WRONG** for
  a non-BMP key: implementers MUST compare UTF-16 code units (JS `localeCompare` is also wrong; use the
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
- **A3: Field types (bare number/boolean vs decimal string vs identity string).** Canonical state mixes
  raw JSON integers and booleans with decimal-string amounts and raw identity strings. Emit as **bare
  integers**: `decimals, height, effectiveHeight, expiresEpoch, feeBps, tipHeight, paidThroughEpoch, finalizeBy`,
  and (v1.7) `claimUntilHeight` (all JS-safe, < 2^53). Emit as **bare booleans**: `locked, viaFill, expired,
  pending`. Emit as **decimal strings**: `supply, minted, mintLimit, feesPaid`, every
  `balances.*.available`/`.locked`, an offer's `give.amount`, `want.value`, `want.amount`, `min`, `paid` and
  `delivered`, a bid's `want.amount` and `give.value`, and each fill entry's `paid`, `fee` and `got` (see the fill
  shapes below). Emit as **raw 0x-hex identity strings**: the 32-byte ids, that is the offer and bid `id`, the token
  `deployId`, the name `claimId` (the anchor txid, present on **every** name), a fill's `txid`, the offer `bid` and
  (v2.8) `claimTxid`, and the token `tmeta` (a content hash); and the 20-byte addresses `deployer`, `owner`, `addr`,
  `seller`, `taker`, `want.payto`, `bidder`, `buyer` and (v1.7) `claimedBy`. Emit as plain strings: `ticker`, the
  token `name`, `mint`, a name's `name` (also `give.name` and a bid's `want.name`) and `status`. Emit as **arrays**:
  an offer's `fills` and a bid's `offers` (offer ids), in apply order. Emit as a nested **object**: the name `profile`
  (v1.9 nprofile: a flat string→string map). **Two fill shapes (the `got`-presence rule):** a whole fill (of an offer
  without `min`) is the singular object `fill` = `{buyer, txid, height, paid, fee}` with **no** `got`; a
  partial-fillable (`min`) offer carries an **array** `fills`, each entry `{buyer, txid, height, paid, fee, got}`
  **with** `got` (`got` = the give-asset units delivered by that partial), and the partial fill that completes it also
  sets the singular `fill` to that same entry, `got` included (§5). An implementer who adds `got` to a whole fill, or
  drops it from a `fills[]` entry or from a completed partial offer's `fill`, forks `sha256(canonicalState)`. Never
  serialize an amount as a number or an `f64`; never stringify an integer field.
  > **⚠ v1.7/v1.9 are part of this byte contract on every live tip past their gate** (`V17_HEIGHT=34000`
  > claims, `V19_HEIGHT=36700` profiles). A second-language resolver built to an earlier copy of this list
  > (omitting `claimedBy`/`claimUntilHeight`/`claimId`/`profile`/`fills`) **forks `sha256(canonicalState)`
  > the moment any offer is claimed or any name carries a profile.** (Pinned on live data by
  > `replay-hashes.json` at **every activation height through V20**: incl. 34 000 claims, 36 700 profiles,
  > 38 400 grace; V18/V21 auto-pin once the chain tip crosses them. The static `cases.json` bar additionally
  > pins the V20/V21/nprofile/name-op/lapse byte-contract with no live node required.)
- **A4: Optional fields are OMITTED, never `null`.** A key whose value is absent is dropped entirely: the token
  `name`, `mintLimit` and `tmeta`; the name `addr`, `viaFill`, `profile` (only when an nprofile is set, at v1.9+
  tips), `paidThroughEpoch` (on every name at v1.5+ tips except a pending reservation), `expired`, and `pending` and
  `finalizeBy` (only on a pending reservation, §28); the offer `taker`, `min`, `paid`, `delivered` and `fills` (only on
  a `min` offer, from its creation), `bid`, `claimedBy` and `claimUntilHeight` (from the offer's first claim grant on,
  and kept after the hold ends and after the offer closes, §20), `claimTxid` (from its first fclaim grant on, §31) and
  `fill` (until a whole fill, or the partial fill that completes the offer); and a whole fill's `got`. A zero balance
  is left out as §5 says. Never emit `"addr":null`.
- **A5: The acceptance gate is a byte-exact round-trip (stronger than the hash check).** A record anchor
  is accepted iff **both** `canonicalJson(JSON.parse(uri)) === uri` (byte-for-byte) **and**
  `sha256(uri) === payload_hash`. The round-trip is what rejects duplicate keys, leading-zero amounts,
  `+` signs, and insignificant whitespace; a record failing either check is a no-op and never enters
  replay. The round-trip does **not** catch a lone surrogate (it survives `JSON.parse`→`canonicalJson`
  identically as ASCII `\uXXXX`); that class is rejected by **A7**, which every resolver MUST apply.
- **A6: Integer grammar + the exact expressions.** Amounts match `^(0|[1-9][0-9]*)$` with
  `MAX_AMOUNT = 2^96 − 1`. The taker fee is `tradeFee(want) = (want·FEE_BPS + 9999) / 10000` (integer
  division = ceil of 1%). `epochOf(height) = floor(height / 30)`. Constants: `COMMIT_MAX_BLOCKS = 240`,
  `NAME_TERM_EPOCHS = 8760`, `NAME_GRACE_EPOCHS = 720`. Tickers match `^[A-Z][A-Z0-9]{2,11}$`
  (effective length **3–12**). **String length limits count UTF-16 CODE UNITS (JS `.length`)**, NOT
  codepoints or UTF-8 bytes: the free-text token `name` ≤ **32** units and `memo` ≤ **64** units. An
  astral codepoint (U+10000+) is **2** units, so a 16-emoji name is exactly 32 units (accepted) and a
  17-emoji name is 34 (a no-op). A resolver counting `chars`/codepoints (Rust `str::chars().count()`)
  or bytes would FORK at this boundary: implementers MUST count UTF-16 units (Rust
  `s.encode_utf16().count()`). Pinned by the `determinism-name-length-utf16-boundary` vector.
- **A7: String well-formedness (UTF-16).** A record whose decoded JSON contains **any non-well-formed
  UTF-16 string**, a lone/unpaired surrogate (`0xD800–0xDBFF` not followed by `0xDC00–0xDFFF`, or a
  bare `0xDC00–0xDFFF`) in **any** key or value at any depth, is an **INVALID no-op for every
  conformant resolver**, rejected before schema validation. Rationale: such a string has no defined
  raw-UTF-8 canonical form (A1), so accepting it would credit on a V8 resolver and reject on a
  raw-UTF-8 one: a cross-language fork on identical chain bytes. Reference: `parseRecord`'s
  `isWellFormedDeep` gate (records.ts), which runs immediately after the A5 round-trip. Implementers
  MUST reproduce it (e.g. JS `String.prototype.isWellFormed`, Rust `str` is already well-formed so a
  `serde_json` parse that surfaces the escape and re-encodes will reject; assert it explicitly).
- **A8. The closed record schema and the `ts` bound.** Every record type's key set is CLOSED
  (records.ts `onlyKeys` exact-key allowlists, mirrored by `_only_keys` in the Python reference):
  an unknown key anywhere in a record makes it an invalid no-op, never a tolerated extra. The
  optional free field `ts` (on `transfer`, `offer` and `bid`) MUST be a JSON integer number with
  absolute value at most 2^53 - 1 (a JS-safe integer; a boolean is NOT an integer). A `ts` of 2^53
  or above round-trips byte-identically through a bignum/decimal parser but exceeds the IEEE-754
  exact range, so a JS resolver and a bignum porter would disagree on ONE mined transfer and fork
  sha256(canonicalState). Out-of-range, fractional, boolean or non-number `ts` is an invalid no-op.
  Reference: the three `Number.isSafeInteger(r.ts)` gates in records.ts and `is_safe_int` in
  cairnx_ref.py. Pinned by the `ts` rows of the parse-gate differential (conformance/crosscheck.mjs).

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
cap: ecosystem doc 16 §4; these are NOT in canonical state today.)*

## 6. Honest limits & safety

- **Convention-enforced, not consensus-enforced.** The chain knows nothing about tokens; it
  enforces (a) record immutability/ordering, (b) payment+attest atomicity in one tx, (c) the
  offer fill window (C5). Everything else is this convention, enforced identically by every
  honest resolver: the trust class of BRC-20/Runes, stated plainly.
- **Open-offer fill races:** if two buyers fill the same untaken offer, the first in apply
  order wins; the loser's payment still reached the seller. Buyer software MUST default to
  taker-bound (RFQ) flows or warn loudly on open-offer fills. Note the miner orders same-block
  txs **by feerate DESC, then txid ASC** (verified in chain/mine.rs): a same-block race is
  therefore a fee auction, not arrival order; takers can bid up their fill's fee to win
  deterministically. **v1.3 closes this structurally:** from height 31 100, CSD-priced offers
  must be taker-bound (§15): a warning cannot hold users back from a full-payment loss, and a
  no-escrow chain has nothing to refund from, so the unsafe shape is removed rather than warned
  about. (A claim window was first dismissed here as impossible because a *payment-bearing*
  reservation has nothing to refund, but v1.7's claim is **payment-free** (an `Attest`, not a
  payment), so a losing claimer forfeits only the 0.05 CSD attest fee. On that basis v1.7 safely
  **re-opens** untaken CSD offers via claim-to-fill (§20), and v2.0/§23 bounds its late-fill edge.)
- **No unconfirmed chaining (no CPFP).** The mempool only accepts txs whose inputs exist in the
  confirmed UTXO set: you cannot spend change that hasn't been mined. A key's next action needs a
  confirmed coin: with one coin, one confirmation between actions; a key holding several confirmed
  coins can anchor several records in one block (§16). Client software that spends one coin must
  serialize its actions and surface this ("next action available after 1 conf").
- **No native-CSD pools.** CSD itself cannot be locked by convention (real UTXOs obey only
  keys). CairnX trades CSD↔token atomically per-trade; it does not and cannot pool CSD.
- **Reorgs:** state is a pure function of the chain; resolvers recompute (or roll back) on
  reorg. Treat sub-final fills accordingly.
- **Spam/squatting:** every record costs ≥ 0.25 CSD (anchor fee floor): sybil-priced, like
  everything on this chain. Ticker squatting is priced, not prevented; names are
  first-anchored-wins (§9).

## 7. Wire-level summary for implementers

| action | tx type | domain/ref | app fields | outputs |
|---|---|---|---|---|
| deploy/mint/transfer/offer/bid/name-ops | Propose | `cairnx:v1` | `uri` = record JSON, `payload_hash` = sha256(uri), `expires_epoch` per §4 | fee/payment outputs per §10/§19 + change |
| fill (CSD-priced) | Attest | offer proposal id | `score=100` (confidence ignored) | payment to `want.payto` + treasury fee + maker rebate (§19) + change |
| fill (token-priced) | Attest | offer proposal id | `score=100, confidence=1 000 000` | change only (debit + in-kind fee are convention-side, §11) |
| claim (v1.7, untaken CSD offer) | Attest | offer proposal id | `score=50` | change only: payment-free reservation (§20) |
| cancel | Attest | offer proposal id | `score=0` | change only |
| ocancel | Propose | `cairnx:v1` | `uri` = `{t:"ocancel",…}` | change only |

Fee floors: Propose ≥ 25 000 000, Attest ≥ 5 000 000 base units. 1 CSD = 100 000 000 base units.

---

# CairnX Convention v1.1 (names + protocol fees)

**Activation height: 29 960** (non-retroactive: pre-29 960 token offers/deploys remain fee-free).

## 9. Names: an on-chain-native namespace (ENS/BNS class)

CairnX names are a **tradeable, on-chain-native namespace**, distinct from `csd:identity` (which
binds a handle to a real-world identity via external proof and is NOT for sale). A name here is
owned purely on-chain: register, hold, point it at an address, transfer, or sell it.

- **Charset:** lowercase ASCII only: `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`, **1–32 chars**,
  no leading/trailing hyphen (single- and double-character premium names are valid and priced at
  the top of the fee curve). ASCII-only removes the mixed-script homograph class (no Unicode, so
  no Cyrillic U+0430 in place of a Latin `a`) and is trivially deterministic for every indexer. It
  does not remove look-alikes within ASCII: `paypa1` and `paypal` are distinct, valid names.
  Reserved: `csd treasury admin official root www support` (`cairn`/`cairnx` are deliberately
  NOT reserved: the operator registered them as ordinary, tradeable names).
- **`name` (claim):** `{v:1,t:"name",name,salt?}`. Owner = anchoring proposer. **Lowest
  effective anchor (effHeight, pos, id) wins**, numeric on `effHeight` and `pos`, ordinal (code-unit) on `id`:
  `effHeight` is the claim's own height, or a reveal's commit height (below); `pos` and `id` are always the claim or
  reveal record's own position and transaction id, never the commit's. Requires the registration fee (§ below).
  - **Direct claim** (no `salt`): effective height = claim height. Simple, instant; front-runnable.
  - **Commit-reveal** (`salt` present): `salt` is 16 to 128 hex digits in either case (`SALT_RE`,
    `^[0-9a-fA-F]{16,128}$`); any other `salt` makes the record an invalid no-op (`RECORD_BAD_SALT`). A prior
    `ncommit` of `sha256({t:"cairnx:name:commit:v1", name,salt,owner})` must exist at a strictly lower height within
    `COMMIT_MAX_BLOCKS` (8 epochs): with the commit height the LOWEST height at which that commit hash was anchored,
    the reveal is valid only when `0 < revealHeight − commitHeight ≤ COMMIT_MAX_BLOCKS` (`REG_COMMIT_MAX_BLOCKS = 8`
    blocks from v2.5, §28). A later anchoring of the same commit hash leaves that height as it is, so it does not
    reopen a window that has passed; a retry after the window needs a fresh salt.
    The reveal **back-dates** its effective height to the commit height, so a committer beats any
    direct-claim squatter who acts in between (the reveal **displaces** them). This is the
    front-run defense (ENS/Namecoin/Runes pattern adapted to a fee-ordered chain).
- **`ncommit`:** `{v:1,t:"ncommit",commit}`: the commit hash (binds name+salt+owner, so it can't
  be reused by another address). Cheap; the reg fee is paid at reveal.
- **`nxfer`:** `{v:1,t:"nxfer",name,to}`: owner gifts the name. Clears the resolver record. Fails
  while the name is locked by an open offer, and on a pending reservation (§28).
- **`nset`:** `{v:1,t:"nset",name,addr}`: owner points the name at an address (the resolver
  record). Fails on a pending reservation (§28). Reverse resolution (address → names owned) is computed by the resolver.
- **Selling a name:** an `offer` with `give:{name}` (instead of `{ticker,amount}`), not on a pending reservation (§28). Anchoring it
  **locks** the name (can't transfer/re-offer); a `fill` transfers ownership to the buyer and pays
  the seller (+ protocol fee), atomically, in one tx; cancel/expiry release the lock.
- **Honest limits (v1.1, superseded):** names were **perpetual** through v1.4 (the registration fee
  was the only anti-squat measure). **Since v1.5 @ height 32 000 every name is a lease**: renewal,
  grace period, and decaying-premium recapture are normative in **§17**. Displacement can unwind a transfer made by a wrongful holder within the commit window
  (rare; deterministic).

## 10. Protocol fees → the CairnX treasury

The chain can't enforce a fee in consensus, so, like everything here, fees are **convention-
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
payment and fee output buckets distinct); since `payto` defaults to the seller, an offer the treasury anchors names
another `payto`. The resolver tracks `feesPaid`, recomputable by anyone like all CairnX state: the sum of the fees
that applied fee-bearing records owed, not of what was paid to the treasury. Each applied deploy (from 29 960),
registration or finalize, renewal and recapture adds its fee or premium, and each applied CSD-priced fill, whole or
partial, adds its trade fee (§19); an overpayment, a treasury output on a record that owes no fee and the outputs of a
refused record add nothing, and the in-kind fee of a token-priced fill is not counted (§14).

---

# CairnX Convention v1.2 (token⇄token swaps + partial fills + bids)

**Activation height: 30 300** (non-retroactive: records using v1.2 shapes anchored below it are
no-ops; all v1/v1.1 records behave exactly as before at every height).

## 11. Token-priced offers: token⇄token swaps

An offer's `want` may now be a **token amount** instead of a CSD value:

```json
{"v":1,"t":"offer","give":{"ticker":"DUST","amount":"1000"},
 "want":{"ticker":"CAIRN","amount":"50000000","payto":"0x…40"},"taker":"0x…40"}
```

- `want.ticker` must exist at fill time (checked at apply, like every balance rule); a
  token-priced offer over an unknown ticker simply can never fill until that ticker exists.
  `give.ticker ≠ want.ticker`. `give` may also be a **name** (sell a name for tokens).
- `want.amount` may be `"0"` (§3), as `want.value` may (§4.4). Such an offer is filled for nothing: the fill debits
  `0 + ceil(0)` = 0, so an attester holding none of `want.ticker` fills it (with the marker below, and as its taker
  when it is taker-bound).
- Anchoring locks `give` exactly as in v1 (§4.4). `want.payto` (default seller) receives the
  want-tokens; it may not be the treasury.
- **Fill** = an `Attest` with `score = 100` **and `confidence = 1 000 000`** whose attester's
  *unlocked* `want.ticker` balance at apply time is ≥ `want.amount + fee`, where
  `fee = ceil(1% × want.amount)` **in kind**. On apply, atomically: debit the attester
  `amount + fee`; credit `payto` `amount`; credit the treasury `fee`; deliver `give` to the
  attester; close the offer.
- **Why the `confidence = 1 000 000` marker:** attestation is this chain's native signaling
  mechanism: people attest proposals to score them. A plain `score=100` attest on a
  token-priced offer must NOT silently spend the attester's tokens. The magic confidence value
  (impossible in normal signaling, which uses 0–100) makes a token-debiting fill an explicit,
  signed opt-in. CSD-priced fills don't need it: their payment outputs already prove intent.
- Insufficient balance / missing marker / taker mismatch → **no-op, offer stays open**.
- Token-priced offers are **whole-fill only** in v1.2 (an Attest carries no amount channel;
  partial fills below use the CSD payment itself as the amount signal).
- The buyer's tokens are **not pre-locked**: only the maker locks inventory. A fill that races
  the buyer's own same-block transfer resolves deterministically by apply order (proposals
  before attests, §3).

## 12. Partial fills (CSD-priced token offers)

A CSD-priced **token** offer may opt into partial fills with `min`:

```json
{"v":1,"t":"offer","give":{"ticker":"DUST","amount":"1000"},
 "want":{"value":"50000000"},"min":"5000000"}
```

- `min` (amount-string, `1 ≤ min ≤ want.value`) = the smallest payment a fill may make:
  the maker's anti-dust/anti-grief floor. Presence of `min` ⇒ the offer is partially fillable.
  `min` is invalid on name offers and on token-priced offers.
- A partial fill is a normal fill (Attest `score=100` + same-tx payment of `X` to `payto` +
  fee) where `min ≤ X`. Let `x = min(X, wantRemaining)` (overpayment is capped: it buys no
  more than what remains). Exception: when `wantRemaining < min`, `X ≥ wantRemaining` is
  allowed (the tail is always buyable).
- **Delivery (cumulative pro-rata, no rounding loss):**
  `deliveredCum' = floor(give.amount × paidCum' / want.value)`: each fill delivers
  `deliveredCum' − deliveredCum`. The final fill (`paidCum' = want.value`) therefore delivers
  exactly the undelivered remainder; rounding dust never strands in the lock.
- A partial fill that would deliver nothing (`deliveredCum' = deliveredCum`) is a no-op (`FILL_ZERO_DELIVERY`): it is
  not appended, `paid`, `delivered` and `feesPaid` do not move, and its payment stays with `payto` (§4.5).
- `fee = ceil(1% × x)` to the treasury in the same tx, per fill.
- The offer stays `open` until `paidCum = want.value` → `filled`. Cancel/expiry release the
  undelivered remainder to the seller; completed partial fills stand.
- Each applied partial fill is appended to the offer's `fills[]` (buyer, txid, height, paid = `x`, got, fee); the one
  that completes the offer is also its `fill` (§5).
- Open partially-fillable offers race like v1 open offers (fee auction, §6), but losing a
  race now only costs the loser the *overlap*: their payment still buys whatever remained.
  Wallets must still warn on open-offer fills.

## 12b. `ocancel`: mass-cancel (maker's kill switch)

```json
{"v":1,"t":"ocancel","ticker":"DUST"}
```

Cancels **all of the proposer's open offers anchored strictly earlier in apply order**, releasing
their locks, optionally filtered to one `give` asset (`ticker` or `name`, at most one), except what §31 exempts: a
taker-bound offer anchored at V28 or above is not a target (Lane B), and from V28 the block-boundary flush skips a
target under a live fclaim hold (Correction 2). Without
cheap mass-cancel a market maker cannot keep a ladder of quotes honest (per-offer cancel = one tx
each: the 0x `minValidSalt` lesson). Anchor an `ocancel`, then re-post the fresh ladder in a later block. From v1.4
(height 31 400, §16) an `ocancel`'s effect waits for the end of its block, so the give it releases stays locked for the
rest of that block: an offer of that give later in the same block is refused (`TOKEN_BALANCE_LOW` for tokens,
`NAME_LOCKED` for a name) and its anchor fee is spent for nothing. A same-block offer at a later position is not a
target of the `ocancel` (its targets are fixed when it applies), so it stands when the proposer's available balance
covers it without the released amount.

**Self-fills** (attester == seller) are **valid** and pay the protocol fee like any fill: wash
trading is self-punishing, and a no-op rule would just complicate determinism. **Fill races on
open offers** (§6) keep their v1 semantics; note that partial fills soften the loss: a racing
fill is clamped to whatever remainder exists, so its payment is only fully wasted when the
remainder is zero. Takers who need atomic certainty use whole-fill offers and taker-binding.

## 13. Bids: non-binding buy-side intents

CSD cannot be locked by convention (§6), so a *binding* buy order is impossible: the buy side
of the book is instead built from **bids**, on-chain discovery records:

```json
{"v":1,"t":"bid","want":{"ticker":"DUST","amount":"1000"},"give":{"value":"40000000"},"memo":"…"}
```

- "I will pay `give.value` CSD (>0) for `want`": `want` is a token amount or `{name}`.
  The **bidder** = proposer. `expires_epoch` = the bid's validity window. Cancel = Attest
  `score=0` by the bidder. **Non-binding**: nothing is locked; honoring it is reputational.
- `memo` (64 UTF-16 units max) and `ts` are optional free fields, same rules as 4.3; `ts` MUST
  be a JS-safe integer (A8).
- **Fulfillment** is the two-step RFQ: the asset owner anchors a **taker-bound offer**
  (`taker = bidder`, price ≤ bid) optionally tagged `"bid":"<bidId>"` (the bid's id, §3); the bidder's client
  detects the responding offer and fills it atomically. Two anchors + one fill: the
  scriptless ceiling for buy-side flow.
- The resolver tracks `bids` (open/cancelled/expired/done). An applied offer whose `bid` names a bid in `bids` is
  appended to that bid's `offers` (in apply order) whatever its taker, its price and the bid's status: taker = bidder
  and price ≤ bid describe an honest answer, not a condition of the link. An offer whose `bid` names no bid when it
  applies is created with its `bid` and is never added to a bid's `offers`, then or later. A fill that closes an offer
  carrying `bid` (a whole fill, or the partial fill that completes it) looks that id up in `bids` at the fill, not
  through `offers`, and marks the bid `done` when it exists, the buyer is its bidder and it is still `open`; a bid
  already cancelled or expired keeps its status, and a bid anchored after the offer naming it can be `done` with empty
  `offers` (purely informational).
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

**Activation height: 31 100** (non-retroactive: all records and fills below it behave exactly
as before at every height).

## 15. CSD-priced offers must be taker-bound

The open (non-taker-bound) CSD-quoted fill was the **one structurally unsafe shape** in the
convention: a fill pays `want.value` as a real, irreversible CSD output to the seller in the
same tx that attests. If two buyers fill the same offer in one block, the apply-order winner
gets the asset and the **loser's full payment is already confirmed to the seller**: the seller
is paid twice and delivers once. The substrate has no escrow (§6), so no claim window, partial
fill, or warning can refund the loser. The only safe shapes are the two that already exist:
**taker-bound (RFQ) fills** (the resolver rejects non-takers, so a wallet never builds the
losing payment) and **token⇄token fills**, where both legs are convention-ledger debits and a
lost race is a guaranteed no-op.

From height **31 100**:

- **`offer` anchor rule:** a CSD-priced offer (`want.value`, token *or* name give) without a
  `taker` field is a **no-op** (`v1.3: CSD-priced offers must be taker-bound`). Token-priced
  (token⇄token) offers are unaffected and remain open to any filler.
- **`fill` rule:** a `SCORE_FILL` attest on **any** CSD-priced offer with no `taker`, including
  offers anchored before activation, is a no-op. Pre-v1.3 open CSD offers therefore become
  unfillable at activation (sellers cancel/`ocancel` or let them expire; locked give releases as
  usual). This is deliberately strict: the loser-pays race is only dead if no open CSD fill can
  ever succeed.
- **Buy-side flow for CSD pricing** is the v1.2 RFQ loop (§13): bid → seller answers with a
  taker-bound offer (partial-fillable allowed; `min` works as in §12) → bidder fills race-free.
  One extra anchor versus v1, in exchange for "a buyer can never lose more than the anchor fee."
- **Name sales are displacement-proof, two rules acting together:**
  1. **Age gate (offer anchor):** a name `offer` (CSD- *or* token-priced) is a no-op unless the
     name's basis is a fill (`viaFill`, below) or its effective claim is **strictly older than
     `COMMIT_MAX_BLOCKS`**. Every dangerous commit (one back-dating below the current claim) has
     a reveal deadline of `commitHeight + COMMIT_MAX_BLOCKS < claimEffHeight + COMMIT_MAX_BLOCKS`,
     so by the earliest legal offer, and therefore any fill, every lurking back-dated reveal
     has either fired (displacing the *claimant*, which IS the §9 front-run defense, loss
     bounded to the registration fee) or expired.
  2. **Fill immunity:** a name `fill` (CSD- or token-priced) marks the record **`viaFill`** and
     re-stamps `claimId/height/effectiveHeight/pos` to the fill itself. Displacement arbitrates
     **claim-vs-claim only**: a `viaFill` record can never be displaced by any reveal. (Without
     the age gate, immunity alone would let a front-run squatter launder a name through a quick
     flip; the gate makes that impossible, so the two rules are sound only together.)

  Net effect: an innocent buyer of a completed sale can never lose the name to a back-dated
  commit-reveal, and the §9 claim-time front-run defense is fully preserved. Residuals
  (documented): a **claim-based** record younger than the commit window is still displaceable;
  that is the defense working as designed; `nxfer` (a gift, no payment) does **not** re-stamp or
  immunize: the recipient inherits the giver's basis; and `viaFill` records re-sell with no
  aging delay (their basis cannot be back-dated under). Offers anchored *before* v1.3 that fill
  after it are not age-gated (one-time activation edge; all current open offers are
  operator-controlled).

## 16. Fill-before-cancel: cancels defer to the block boundary

§15 killed the buyer-vs-buyer race, but the same apply-order semantics left one **malicious-
seller** variant: the **cancel snipe**. Within a block the resolver applies **all proposals
(pos asc), then all attests (pos asc)** (§1). A fill is an attest; an `ocancel` is a proposal
(always applies first); a plain `cancel` is an attest whose pos the seller can lower by paying
a higher fee (miners order feerate-DESC). So a seller who sees a buyer's fill in the mempool
could broadcast a cheap `ocancel` (or a higher-fee `cancel`) in the same block: the cancel
applied first, the offer was no longer `open`, the fill no-op'd, **but the fill tx's payment
is a real confirmed output to the seller.** Seller paid, delivers nothing, cost ≈ one anchor
fee. That breaks §15's guarantee ("a buyer can never lose more than the anchor fee") the moment
a non-operator seller answers an RFQ.

From height **31 400**:

- **Rule:** a `cancel` or `ocancel`'s **effect** (releasing the give, flipping the offer to
  `cancelled`) is **deferred to the end of its block**: it applies only to offers still `open`
  after every same-block fill has settled. A same-block fill therefore **always wins**: a fill
  that lands means the seller got paid in that very tx, so it is a completed, fair sale; the
  late cancel then no-ops on the now-filled offer (noted
  `superseded by same-block fill (v1.4)`). An honest cancel (no competing same-block fill)
  lands exactly as before, one block-boundary later in effect but in the same block.
- **Guards still fire at apply time:** only-the-seller and offer-must-be-open are checked when
  the cancel is applied in order (a cancel on an already-filled/cancelled offer fails
  immediately, as pre-v1.4). Only the *effect* of a passing cancel is deferred.
- **`ocancel` snapshot:** the target set (the proposer's open offers matching the filter) is
  computed at apply time (correctly capturing only strictly-earlier offers, since higher-pos
  same-block offers are not yet applied) and at the flush only the targets **still open** are
  cancelled (partial fills in between deliver first; the flush releases the remainder).
- **Partial fills:** a same-block partial fill on a being-cancelled offer delivers its pro-rata
  amount; the deferred cancel then releases only the unsold remainder. The buyer keeps what
  they paid for; the seller keeps the rest.
- **Scope:** deferral is **intra-block only.** A fill in any later block than the cancel loses
  normally (the cancel flushed at the block boundary). Expiry sweeps are unchanged and run
  after the flush.
- **Why deferral, not reordering:** moving cancels after fills in the sort would break the
  global ordered loop and the "offers settle before fills" invariant for every other record
  type. Deferring only the effect keeps apply order intact. A relist by the same key later in
  the cancel's block sees the lock state before the flush, so a relist that needs the give the
  cancel releases is refused (§12b). One key can anchor several records in one block, each spending
  its own confirmed coin.
- **Determinism:** the deferred-cancel list is built and flushed in apply order, so the state
  (and the event log) remains a pure function of the chain prefix. Non-retroactive: pre-v1.4
  blocks never defer, so all historical replay is byte-identical.

With §15 + §16 together the invariant holds against **both** failure modes: a buyer can never
lose more than the anchor fee: not to another buyer (race), and not to the seller (snipe).

## 17. Name leasing: names are paid-through, renewable, recapturable (v1.5)

§9's perpetual names were the registry's known economic gap: a 10+-char name costs 0.1 CSD
**once, forever**: squatting is free to carry, and lapsed projects strand names permanently.
From height **32 000** every name is a **lease**:

- **Term:** a claim (or premium re-claim) is paid through `claimEpoch + 8 760` epochs (≈ 1 year), with `claimEpoch`
  the epoch of the claim or reveal record's own height, not of its back-dated effective height (from v2.5 the lease
  starts at the finalize instead, §28, §29).
  Names claimed before v1.5 are **grandfathered** one full term from activation
  (`epochOf(32 000) + 8 760`), computed lazily, no state rewrite at the boundary.
- **`nrenew` `{v:1,t:"nrenew",name}`:** extends the lease one term from its CURRENT end. Valid
  from **anyone** while the lease is live (third-party gifting, ENS-style) iff the same tx pays
  `nameRegFee(name)` to the treasury. A renewal never changes ownership. A pending reservation (§28) holds no lease and
  is not renewed, by anyone.
- **Grace (720 epochs ≈ 30 days):** past `paidThroughEpoch`, only the **owner** may renew;
  otherwise a squatter could extend a lapsing name they intend to take.
- **Lapse → decaying-premium recapture:** past grace the name is unowned again. Anyone may claim
  it by paying `expiredClaimFee(name, e) = nameRegFee(name) × m(e)`, priced at height `h` (the finalize from v2.6,
  §29), where `e = epochOf(h) − (paidThroughEpoch + 720)` counts the epochs past the grace end (at least 1, since the
  name has lapsed) and, in integer division, `m(e) = 1 + floor(19 × (720 − e) / 720)` for `e < 720` and `m(e) = 1`
  from `e = 720` on. `m` is a staircase that steps down from 19 at `e = 1` to 1 from `e = 683` on.
  The 20 of `NAME_PREMIUM_START` would apply only at `e = 0`, where the name has not lapsed. The re-claim is a
  **fresh basis**: prior `viaFill` immunity is void (immunity protects a *paid* basis; an unpaid
  lease is an abandoned one), and any still-open offer on the name is voided with its lock freed.
- **Guards:** `nxfer`/`nset` on a lapsed lease are no-ops. A name **offer** is a no-op unless the
  lease covers the offer's ENTIRE fill window (`paidThroughEpoch ≥ expiresEpoch`), so a fill can
  never hit a mid-window lapse; the alternative (a no-op'd CSD fill whose payment already
  confirmed to the seller) would be a fund-loss shape, so it is made unrepresentable. Offers
  anchored before v1.5 are exempt (their windows all end long before any grandfathered lease).
- **State:** at v1.5+ tips every name except a pending reservation (§28) carries `paidThroughEpoch` (and
  `expired: true` once lapsed at the tip's epoch, §5; the record is kept for history until re-claimed). Pre-v1.5 canonical hashes are
  unchanged: the fields exist only at v1.5+ tips.

## 18. `tmeta`: issuer token metadata via the content layer (v1.5)

`{v:1,t:"tmeta",ticker,hash}`: **issuer-only**, last write wins, no fee beyond the anchor.
`hash` is a CSD Content Convention v1 hash (0x + 64 lowercase hex, §3; `payloadHash` in csd-codec) pointing at
the token's `{logo, description, links}` document: self-certifying content, so the record stays tiny
(the 512-byte `uri` cap is untouched) and any copy of the document can be checked against the hash
on read (`verifyContentBytes` in csd-codec). The csd-swarm content service this section was written
for is retired; the convention names no host for the document. State: `tokens[t].tmeta`. Records
before v1.5 are no-ops.

---

# CairnX Convention v1.6 (fee update + maker rebate)

**Activation height: 33 600** (`V16_HEIGHT`; non-retroactive: pre-v1.6 offers keep the 1% fee and earn no rebate).

## 19. Taker fee 1% → 1.5%, and a maker rebate on resting liquidity

- **Fee bump.** The taker fee becomes `FEE_BPS_V16 = 150` (1.5%, `ceil`) instead of `FEE_BPS = 100` (1%).
  The rate is **captured per-offer at creation height** into `offers[id].feeBps` (a bare-int canonical field,
  §5.1-A3): an offer anchored ≥ 33 600 carries `feeBps = 150`, one anchored in [29 960, 33 600) carries `100`, and one
  anchored below 29 960 (v1.1) carries `0` and owes no trade fee (§10). Every fill of that
  offer (whole, partial, token-priced) uses the offer's own `feeBps`, so pre-v1.6 offers are byte-identical
  forever. A third-party resolver MUST select the fee by **offer-creation height**, not by fill height.
- **Maker rebate (whole CSD-priced fills only).** On a whole fill of a **resting-liquidity** CSD-priced offer,
  the taker additionally pays the **maker** (`offers[id].seller`) a rebate, as an extra output **in the same
  fill tx**, reimbursing the maker's posting (Propose) cost:
  `makerRebate(want) = REBATE_FLAT + ceil(REBATE_BPS × want / 10000)` with `REBATE_FLAT = 25 000 000`
  (0.25 CSD) and `REBATE_BPS = 50` (0.5%).
- **`restingLiquidity` predicate (normative):** an offer qualifies iff
  `(offer.taker !== undefined && offer.bid !== undefined)`, a taker-bound answer to a bid (the RFQ/MM lane),
  **OR** `(offer.height ≥ V17_HEIGHT && offer.taker === undefined)`, a v1.7 open ask (claim-to-fill).
  Partial fills and token⇄token fills earn **no** rebate. (Keying on `bid` alone was a closed self-mint hole:
  a maker could self-attach an unanchored bid to an open offer; the open-ask lane now earns it via `taker
  === undefined && height ≥ V17` regardless of `bid`, and a bid-answer rebate requires a real consenting taker.)
- **Same-tx output gate (the SUM rule).** The fill's required outputs are accumulated **per recipient**:
  `want.payto += want.value`, `TREASURY += tradeFee(want, feeBps)`, and (if rebate applies) `seller += rebate`.
  When `want.payto == seller` (the common default) the two amounts **SUM**: a resolver MUST check each
  recipient against the summed requirement, never satisfy by `max()`. (`payto` can never be the treasury, so
  those buckets never collide.) For a pre-v1.6 offer the rebate is 0 and this reduces to the two original checks.

---

# CairnX Convention v1.7 (claim-to-fill: race-safe open CSD offers)

**Activation height: 34 000** (`V17_HEIGHT`; non-retroactive: in `[V13, V17)` open CSD fills stay banned, §15).

## 20. Claim-to-fill: an untaken CSD offer is reserved before it is paid

v1.3 (§15) removed open CSD offers because the loser of a payment-bearing fill race loses a real payment.
v1.7 re-opens them safely by moving the race to a **payment-free reservation**: a losing claimer forfeits only
the 0.05 CSD attest fee, never a payment.

- **Claim** = an `Attest` on the offer with **`score = SCORE_CLAIM = 50`** (∉ {fill 100, cancel 0}, so it is an
  inert no-op below V17, non-retroactive). It grants the attester an **exclusive hold** of the offer for
  `CLAIM_WINDOW_BLOCKS = 15` blocks: on grant the resolver records `offers[id].claimedBy = attester` and
  `offers[id].claimUntilHeight = grantHeight + 15` (both canonical fields, §5.1-A3, written at each grant and kept
  after the hold ends and after the offer closes: a hold's end is read from `claimUntilHeight`, not from the fields'
  absence).
- **Fill gate.** A `SCORE_FILL` fill on an **untaken** (`taker === undefined`) CSD-priced offer at height ≥ V17
  is valid **only if** the offer is currently held **and the filler is the holder**: `claimHeld(o, h) &&
  attester === o.claimedBy`, where `claimHeld(o, h) = (o.claimedBy !== undefined) && (h < o.claimUntilHeight)`
  (v2.0 widens this: §23). A fill by anyone else, or with no live claim, is a no-op (offer stays open).
- **No new claim while held.** A `claim` on an offer that is already held (`claimHeld`) is a no-op.
- **`MAX_ACTIVE_CLAIMS = 3` per address.** A claim is rejected if the attester already holds 3 offers
  (`liveN = count of offers x where x.claimedBy === attester && claimHeld(x, h)`). Anti-squat.
- **`CLAIM_COOLDOWN_BLOCKS = 15`.** The address whose hold just lapsed (`o.claimedBy === attester`) may not
  immediately re-grab the **same** offer until `h ≥ o.claimUntilHeight + CLAIM_COOLDOWN_BLOCKS` (in v2.0, the
  cooldown runs from the end of the hold = window + grace). Known bound (identical in the Python reference, so
  not a fork): the cooldown keys on the last claimer, so a colluding A→B→A pair can recycle one offer: a
  payment-free liveness nuisance on a single offer, never value loss.
- **Reorg note (client, not consensus):** claim→fill is two txs, so the payment has a reorg exposure a single-tx
  fill lacks. Buyer software MUST wait a value-scaled confirmation depth (gambler's-ruin sized) on the claim
  before broadcasting the fill; this is a client policy, not a resolver rule, and does not affect canonical state.
- Taker-bound offers need no claim (they were never in the race). Token⇄token offers are no-op-safe and ignore claims.

---

# CairnX Convention v1.8 (two-tier name registration fee)

**Activation height: 40 000** (`V18_HEIGHT`; non-retroactive: below it the §10 ENS curve applies unchanged).

## 21. Flat two-tier name fee

At/above V18, `nameRegFee(name, height)` (the fee for `name` claim/reveal, `nrenew`, and the base of the §17
lapsed-premium) becomes a flat **two-tier** schedule, replacing the §10 length curve:

- name length **≤ 4** chars → `NAME_FEE_SHORT_V18 = 670 000 000` (6.7 CSD);
- name length **≥ 5** chars → `NAME_FEE_V18 = 300 000 000` (3 CSD).

Below 40 000 the original 5-tier curve (§10: ≤3→5, 4→2, 5→1, 6–9→0.5, 10+→0.1 CSD) still applies: the fee is
selected by **anchor height**, so all historical replay is byte-identical. (Client builders should price a fee
output built within a few blocks *below* V18 at the V18 rate, since overpay is always accepted but underpay is a
no-op that forfeits the treasury output.)

---

# CairnX Convention v1.9 (nprofile: ENS-class identity)

**Activation height: 36 700** (`V19_HEIGHT`; non-retroactive: `nprofile` below it is a forward-compat no-op).

## 22. `nprofile`: owner-set identity metadata on a name

```json
{"v":1,"t":"nprofile","name":"alice","p":{"url":"https://alice.example","eth.address":"0x…"}}
```

- **Inert metadata.** `p` is a flat string→string map. It carries **no fee, no value, and is never a send
  target**: the address a name resolves to for payment stays in `nset` (`names[x].addr`). A resolver keeps
  no reserved keys; the app layer keeps send targets out of `p`.
- **Owner-gated, last-write-wins.** Valid iff the proposer is the current name owner, the lease is not
  lapsed (§17) and the name is not a pending reservation (§28). The new `p` **replaces** the prior profile; an **empty `p` (`{}`) clears it**.
- **Cleared on every ownership change**: `nxfer`, a name `fill`, and a lapsed-premium re-claim all clear
  `profile` exactly as they clear `addr`.
- **Shape limits (deterministic):** keys match `PKEY = ^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$` (ASCII only,
  so the canonical key sort is invariant across UTF-16/codepoint/byte impls, future-proof vs a third-language
  resolver); at most `PROFILE_MAX_KEYS = 16` keys; each value is a string of ≤ `PROFILE_MAX_VALUE_BYTES = 256`
  **UTF-8 bytes**. Any violation → the record is a no-op.
- **State:** `names[x].profile` is a nested object, materialized **only at v1.9+ tips** and **only when set**,
  so every pre-v1.9 canonical hash is byte-unchanged, and a name with no profile omits the key (§5.1-A4).

---

# CairnX Convention v2.0 (claim grace: the bounded late-fill fix)

**Activation height: 38 400** (`V20_HEIGHT`; non-retroactive: below it the strict 15-block window of §20 stands).

## 23. Bounded claim grace: a slightly-late in-window fill still delivers

v1.7's claim-to-fill had a fund-loss edge: a fill submitted inside the window but **mining at the window
boundary** (`height == claimUntilHeight`) was rejected by the resolver while its CSD payment was already
UTXO-final → the buyer paid and received nothing (the live `69.csd` incident). v2.0 fixes it without a race:

- At/above V20 the claim window widens to `CLAIM_WINDOW_BLOCKS_V20 = 40`, and a **bounded fill grace** of
  `CLAIM_FILL_GRACE_BLOCKS = 5` is added. The **hold = window + grace = 45 blocks** is exclusive on **both**
  sides: within it the claimer's fill is honored **AND** no other address may claim. So a slightly-late
  in-window fill still delivers, and there is **no displacement race** (the holder is exclusive for the whole
  hold; below the grace a new claim is rejected). Past the hold the offer **reopens**: the hold is **bounded,
  not "until displaced."** `claimHeld(o, h)` becomes `h < o.claimUntilHeight + grace(o)`.
- **Era inference (no new stored field).** The grace is derived from the claim's era so its inverse is
  unambiguous: a claim granted at ≥ V20 has `claimUntilHeight = grantHeight + 40 ≥ V20 + 40`; a pre-V20 claim
  has `claimUntilHeight ≤ V20 + 14`; the range `[V20+15, V20+40)` is **unreachable**. Therefore
  `grace(o) = (o.claimUntilHeight − 40 ≥ V20_HEIGHT) ? 5 : 0`. Below V20 the window is 15 and the grace is 0:
  byte-identical history.
- The `MAX_ACTIVE_CLAIMS` count and the `CLAIM_COOLDOWN_BLOCKS` both use the **hold** (window + grace), so the
  grace can neither expand an address's concurrent reach past the cap nor be used to dodge the cooldown.
- **Offer-expiry interaction (client guard, not consensus).** `sweepExpired` runs before the fill, so a fill
  mining between the offer's expiry and the hold-end would still burn the payment. Client software MUST refuse
  to claim/fill unless the offer's lease/expiry outlives the **hold-end** (`claimUntilHeight + grace`), not
  merely the tip. This is a client policy bounding what to sign; the resolver state is unchanged by it.

---

# CairnX Convention v2.1 (offer/bid duration cap)

**Activation height: 40 100** (`V21_HEIGHT`; non-retroactive: below it the effective expiry is the raw `expires_epoch`).

## 24. Maximum offer/bid lifetime: `MAX_OFFER_EPOCHS = 168` (≈ 7 days)

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
  everyone. Below V21, `effExpiry = expires_epoch`: byte-identical history.
- **Client expiry-height closed form** (mirrors the resolver's height-gated sweep, for buy-safety guards):
  `offerExpiryHeight = min( (expires_epoch+1)·30 , max( V21_HEIGHT , (epochOf(anchor)+168+1)·30 ) )`.

---

# CairnX Convention v2.2 (offer/bid duration cap removed, anchor-keyed)

**Activation height: 41 300** (`V22_HEIGHT`; non-retroactive; keyed on the offer/bid ANCHOR height, not the sweep height).

## 25. The §24 cap applies only to the [V21, V22) anchor era

The §24 lifetime cap proved to be an infrastructure symptom, not a market need, and was lifted:

- **Anchor ≥ 41 300:** the raw `expires_epoch` binds. No creation gate, no capped `effExpiry`. The 1-week
  suggestion survives only as CLIENT policy (the reference UI defaults to it); it is not consensus.
- **Anchor in [40 100, 41 300):** the §24 rules apply to that offer/bid FOREVER (creation gate at its
  anchor, capped `effExpiry` in every later sweep). Era membership is fixed by the anchor, so every
  replayer ages the same record identically regardless of when it replays.
- **Anchor < 40 100:** no creation gate (the record predates it), but every sweep at a height ≥ V21 reads it with the
  capped `effExpiry` of §24, so over-cap inventory from before V21 expires at the first such sweep past its cap; a
  sweep below V21 reads the raw `expires_epoch`, so every pre-V21 state is unchanged.
- **Client closed form:** for anchor ≥ V22, `offerExpiryHeight = (expires_epoch+1)·30`; for every anchor below V22,
  `min((expires_epoch+1)·30, max(40 100, (epochOf(anchor)+MAX_OFFER_EPOCHS+1)·30))` (`offerExpiryHeightOf`).
- **Adoption note:** a relaxation. A v2.1-only replayer rejects (no-ops) a long-dated offer the chain
  accepts, so its book diverges from the canonical one from the first over-cap anchor onward. Every
  replayer must run the v2.2 core before the tip crosses 41 300 (already long past; stated for the record).

---

# CairnX Convention v2.3 (`nset` to the zero address clears the record)

**Activation height: 52 000** (`V23_HEIGHT`; non-retroactive; keyed on the `nset` event height).

## 26. Clearing a name's payment target

`ZERO_ADDR = 0x` + 40 hex zeros.

- **Event height ≥ 52 000:** an owner `nset` whose `addr` equals `ZERO_ADDR` CLEARS the record: the
  canonical state materializes the name with NO `addr` key (absent, not `null`). A cleared name resolves
  to its OWNER address (the §9 fallback) and drops out of the reverse-resolution / primary-name candidate
  set. This is the supported way to switch which of several names is an address's primary.
- **Event height < 52 000:** the identical record literally sets `addr` to the zero address (historical
  behavior, byte-identical replay). The zero address has always been a VALID `addr`, so there is no
  parser change in either direction.
- **Guards unchanged:** `nset` on a lapsed lease stays a no-op (§17); owner-only as before.
- **Adoption note (fund safety, the harder direction):** a stale (pre-v2.3) replayer shows a cleared name
  still pointing at `0x000...0`. A payer trusting that stale view burns funds to the zero address. Wallets
  MUST refuse to pay `0x000...0` regardless (the reference wallet hard-blocks it), and every replayer must
  run the v2.3 core before the tip crosses 52 000.

---

# CairnX Convention v2.4 (length-graded registration fee increase)

**Activation height: 46 400** (`V24_HEIGHT`; non-retroactive; keyed on the FEE-BEARING event's height;
re-pinned 2026-07-03 from the originally published 49 200; see the height re-pin history note at the top).

## 27. The fee curve

`nameRegFee(name, height)` selects the regime by the height of the event that carries the fee: the `name`
reveal below v2.5, the winner's `nfinalize` at/after v2.5 (§28), and every renewal at its own event height.

| name length | < 40 000 | ≥ 40 000 (v1.8) | ≥ 46 400 (v2.4) |
|---|---|---|---|
| ≤ 3 chars | 5 CSD | 6.7 CSD | 15 CSD |
| 4 chars | 2 CSD | 6.7 CSD | 10 CSD |
| 5 chars | 1 CSD | 3 CSD | 5 CSD |
| 6 - 9 chars | 0.5 CSD | 3 CSD | 5 CSD |
| ≥ 10 chars | 0.1 CSD | 3 CSD | 3 CSD |

- Underpayment is a **no-op** (`name registration fee unpaid`), and the §10 warning applies with force:
  the attached payment outputs still settle on-chain. An underpaid registration or renewal is a burn.
- **Adoption note (BOTH directions are hard):** a stale replayer ACCEPTS an underpaid post-46 400
  registration the chain rejects (it shows a phantom owner), and a stale wallet ATTACHES the old fee and
  burns it. Every replayer and every fee-quoting client must run the v2.4 core before the tip crosses
  46 400.

---

# CairnX Convention v2.5 (sealed-reservation registration)

**Activation height: 46 440** (`V25_HEIGHT`; non-retroactive; keyed on the reveal event height;
re-pinned 2026-07-03 from the originally published 51 000; see the height re-pin history note at the top).

Root fix for the reveal fee-burn: pre-v2.5, every losing racer in a §9 commit-reveal race paid the FULL
registration fee for nothing (payment-without-delivery). At/after v2.5 the reveal is payment-free; only
the settled winner ever pays.

## 28. Commit, payment-free reveal, freeze, winner-only finalize

- **Commit (unchanged):** a prior `ncommit` per §9. Back-dating is unchanged: the reveal's effective
  anchor `effHeight` is its commit's height.
- **Reveal window shrinks:** at/after v2.5 a reveal must land within `REG_COMMIT_MAX_BLOCKS = 8` blocks
  of its commit (below v2.5: 240). One constant serves as BOTH the reveal window and the displacement
  freeze, so no back-dated challenger can appear after the freeze has passed. Direct no-salt registration
  is rejected at/after v2.5 (`v2.5: registration requires a commit-reveal (salt)`): an unsealed
  registration could not be finalized.
- **Reveal (`name` record, height ≥ 46 440):** carries NO registration fee. Creates a PENDING reservation,
  materialized in canonical state (at v2.5+ tips) as exactly `{name, owner, claimId, height, effectiveHeight, locked,
  pending: true, finalizeBy}`, with `finalizeBy = effHeight + 8 + 20` (`REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS`).
  It holds no lease, so it carries no `paidThroughEpoch` and no `expired`, and it carries no `addr`, `viaFill` or
  `profile`.
- **While pending** the reservation gives its owner only the right to finalize it: `nxfer`, `nset`, `nprofile` and a
  name `offer` by the owner, and `nrenew` by anyone, are no-ops on it (`NAME_PENDING`). Only `nfinalize`, a displacing
  reveal (below) and the expiry sweep act on a reservation.
- **Contest while pending:** a rival reveal with a strictly earlier `(effHeight, pos, id)` (numeric on
  `effHeight` and `pos`, ordinal code-unit on `id`; `pos` and `id` the reveal's own, §9; earliest wins) DISPLACES the reservation; the displaced party has lost only its
  ~0.25 CSD anchor. A FINALIZED name can never be displaced: any window-valid challenger has an
  `effHeight` within 8 blocks of the current height, which is strictly later than a finalized name's
  (its freeze has passed). Names owned `viaFill` are likewise never displaced.
- **Per-address cap:** at most `MAX_PENDING_REG = 3` concurrent un-finalized reservations per owner
  (expired ones and a re-reveal of the same name do not count); excess reveals are no-ops.
- **Finalize (`nfinalize` record):** `{v:1, t:"nfinalize", name, salt}`, `salt` in the form of §9. Valid iff ALL of: the name is
  pending and owned by the sender; `salt` re-derives the SAME commit that anchored the reservation
  (`sha256` per §9, binding name + salt + owner, and the commit's height must equal the reservation's
  `effHeight`); the freeze has passed (`ev.height > effHeight + 8`); the reservation has not expired
  (`ev.height ≤ finalizeBy`); and the payment to the treasury covers `nameRegFee(name, ev.height)`
  (§27, priced at the FINALIZE height). On success the `pending`/`finalizeBy` keys become ABSENT, the
  lease starts (`paidThroughEpoch = epochOf(ev.height) + NAME_TERM_EPOCHS`), and the name is NOT
  `viaFill`.
- **Reservation expiry (lazy):** past `finalizeBy` an un-finalized reservation is deleted by the expiry sweep of §5
  (before each event above `finalizeBy`, and at the closing sweep at `tipHeight + 1`, so it is gone from the state at
  a tip equal to `finalizeBy`, although an `nfinalize` mined at that height still applies), and the name reopens. The
  would-be winner has lost only anchors, never the registration fee.
- **Client timing rule** (`FINALIZE_TIP_MARGIN = 2`, client-side only): sign the finalize at
  `effHeight + 8 + 2` or later so one reorg cannot un-freeze the contest under a fee-bearing tx. The
  20-block grace exists so a slow inclusion still lands before `finalizeBy`.
- **Adoption note (hard gate):** a stale (pre-v2.5) wallet crossing 46 440 attaches the registration fee
  to what is now a payment-free reveal; the resolver ignores the fee and the payment burns. Every
  replayer AND every fee-attaching client must run the v2.5 core before the tip crosses 46 440.

---

# CairnX Convention v2.6 (sealed-reservation recapture)

**Activation height: 46 480** (`V26_HEIGHT`; non-retroactive; keyed on the reveal event height;
re-pinned 2026-07-03 from the originally published 51 200; see the height re-pin history note at the top).

The §28 cure applied to LAPSED-name recapture (§17), whose losing racer previously forfeited the full
decaying premium (up to hundreds of CSD).

## 29. Recapture through the same sealed machinery

- **Reveal on a lapsed name (height ≥ 46 480):** payment-free. Creates a recapture reservation in an
  INTERNAL `recaptures` map. The reservation is NOT materialized in canonical state, and the lapsed
  record in `names` is left untouched (it is the premium basis; an abandoned reservation can never
  bypass the premium). Below v2.6, recapture stays pay-now at reveal (§17, byte-identical).
- **Same windows and contest:** reveal window and freeze are `REG_COMMIT_MAX_BLOCKS = 8`;
  `finalizeBy = effHeight + 8 + 20`; lowest `(effHeight, pos, id)` (the reveal's own `pos` and `id`) displaces among reservations; its own
  `MAX_PENDING_REG = 3` per-address cap; overdue reservations are lazily swept.
- **Finalize:** the same `nfinalize` record, salt-bound to the recapture commit. The winner pays the §17
  decaying premium priced at the FINALIZE height (slightly more decayed than at reveal: rounding favors
  the payer). On success the name becomes a normal fresh lease under the new owner, NOT `viaFill`
  (displacement-immune by the same freeze arithmetic as §28). The new record keeps the reveal's anchor: `claimId` is
  the reveal's transaction id, `height` the reveal's height and `effectiveHeight` its commit's height (the finalize's
  own id and height are not recorded), and `paidThroughEpoch = epochOf(finalize height) + NAME_TERM_EPOCHS`; it
  carries no `addr` or `profile`, and `locked` is false.
- **Replayer note:** because the reservation map is internal, pre-v2.6 canonical hashes are untouched,
  but a third-party resolver MUST still replicate the map (reveal, displacement, expiry) to agree on
  which later `nfinalize` succeeds. The map is defined by this section plus the reference resolver and
  its Python mirror; the v2.6 conformance vectors pin it.
- **Adoption note (hard gate):** same shape as §28. A stale wallet attaches the premium to a
  payment-free recapture reveal and burns it. All replayers and clients on the v2.6 core before 46 480.

---

# CairnX Convention v2.7 (young-name sale embargo shrinks)

**Activation height: 46 520** (`V27_HEIGHT`; non-retroactive; keyed on the OFFER event height;
re-pinned 2026-07-03 from the originally published 52 500; see the height re-pin history note at the top).

## 30. Sale embargo: 240 blocks becomes 8

A name `offer` (§17 sale path) whose event height `H` satisfies `H − effHeight ≤ embargo` is a no-op
(`name too young to sell (must out-age the reveal window)`), where `effHeight` is the name's effective
anchor. `viaFill` names were never embargoed.

- **`H` < 46 520:** `embargo = COMMIT_MAX_BLOCKS` (240 blocks, ≈ 8 h). The pre-sealed rule: a fresh name
  had to out-age every lurking back-dated reveal before it could be sold.
- **`H` ≥ 46 520:** `embargo = REG_COMMIT_MAX_BLOCKS` (8 blocks, ≈ 16 min). Under §28/§29 a finalized
  name is displacement-immune the moment its freeze passes, so out-aging the old 240-block window is
  redundant; 8 matches the freeze itself.
- The gate keys on the OFFER's height, so the same young name can be unsellable at 46 519 and sellable
  at 46 521. Deterministic for every replayer; no name-age era bookkeeping is needed.
- **Adoption note:** a relaxation (fresh cores accept a sale a stale core no-ops), so every replayer must
  run the v2.7 core before the tip crosses 46 520.

---

# CairnX Convention v2.8 (fclaim: atomic open-lane settlement)

**Activation height: `V28_HEIGHT`** (baked at rollout; non-retroactive; each rule keys on its OWN governed
event's height, and Lane B additionally on the offer's anchor era).
Below it an `fclaim` record parses to a forward-compatible no-op (like `nprofile` below V19, §22), `SCORE_CLAIM`
claims work exactly as §20/§23, and every replay hash is byte-identical.

## 31. `fclaim`: the open-lane claim becomes a short-expiry proposal, the fill attests it

v1.7 (§20) moved the open-CSD race to a payment-free claim (`Attest score = 50`), but the resulting hold is an
overlay-only deadline invisible to L0: a fill delayed past the hold, or a cancel reordered against the fill, can
still burn a paid buyer (the cross-block delivery-versus-payment flaw). v2.8 closes it by making the claim a
**short-expiry `Propose`** and the fill an **`Attest` on that proposal**, so L0's own rules (an Attest to an
unknown proposal is block-invalid, and an Attest mined in an epoch past the proposal's `expires_epoch` is
block-invalid) enforce the SAME hold deadline the overlay uses. Delivery and payment become one
consensus-observable quantity.

**Record.** `fclaim = {v, t:"fclaim", offer}`, where `offer` is the 0x-hex id (`isHash`) of an open,
CSD-priced, untaken offer. `FCLAIM_KEYS = {"v","t","offer"}` (exact-key set, §5.1). The expiry rides the
carrying `Propose.expires_epoch`; there is no `expiresEpoch` in the record body (matching the `offer` /
`OfferRecord` precedent). Parsing is height-agnostic; the resolve handler is `V28_HEIGHT`-gated, so below the
gate a parsed fclaim is inert (nfinalize precedent, §28).

**The two transactions.**
- **Claim** = `Propose(uri = the fclaim record, expires_epoch = E)`, with `E` the desired hold-end epoch. The
  network fee is the propose floor 0.25 CSD (up from the 0.05 attest floor). A client picks
  `E = min(epochOf(tip + 45), offer.expiresEpoch)` to approximate the legacy 45-block hold while never
  requesting an `E` the grant would deny.
- **Fill** = `Attest(score = SCORE_FILL = 100)` on the **fclaim txid** (not the offer id), paying the SAME
  §4 / §19 delivery outputs (the CSD `want.value` sum plus the §19 fee and maker rebate). The fill itself
  stays at the 0.05 attest floor; only the claim rises to the 0.25 propose floor.

**Grant (the propose handler, at height `h >= V28_HEIGHT`).** A well-formed fclaim grants a hold iff, in order:
`E` is at most 2^53 − 1 (§33.4); the referenced offer exists AND is `open` AND untaken (`!taker`) AND CSD-priced; `E <= effExpiry(offer, h)`
(§24 / §25, so the hold never outlives the offer); `E <= epochOf(h) + FCLAIM_MAX_EPOCH_AHEAD` (`= 2`, anti-squat,
bounding a hold to `EPOCH_LEN*(2 + 1) - 1 = 89` blocks); `epochOf(h) <= E` (lower bound); the offer has no live
hold (`!claimHeld`, unifying legacy and fclaim holds so one offer is never double-held); the same-offer cooldown
has elapsed (`h >= o.claimUntilHeight + grace + CLAIM_COOLDOWN_BLOCKS` for the last holder, where `grace` is the
prior hold's era grace per §20 / §23, i.e. 0 for a prior fclaim hold and `CLAIM_FILL_GRACE_BLOCKS` for a prior
legacy hold; the cooldown runs from the END of the prior hold, so a straddling legacy hold and a fresh fclaim
never disagree); and the proposer holds fewer than `MAX_ACTIVE_CLAIMS` (`= 3`) live holds. The grant is the
conjunction of these clauses, so their order decides only the reason code of a denial: the code of the first clause
broken (§40.1). The Python reference checks them in this order and writes no codes. On grant the resolver records `claimedBy = proposer`, `claimUntilHeight = (E + 1)*EPOCH_LEN`, and
`claimTxid = fclaimTxid`.

**Last-write-wins (fund-safety).** All three fields are last-write-wins: a later grant on the same offer (after
a prior hold has lapsed) RE-ASSIGNS all three unconditionally. `claimTxid` is never left stale behind an
`if (claimTxid === undefined)` guard and is never cleared. (If a later holder's `claimTxid` were left stale,
fill-routing (`claimTxid === proposalId`) would fail for that holder while their payment mined on the new
fclaim, a burn.) A denied fclaim records `{granted:false}` in the internal `fclaims` map (for the money-safety
audit) and grants no hold.

**Canonical surface (§5.1).** `claimTxid` is a canonical offer field (§5.1-A3, present only once granted at
V28+, following the §20 `claimedBy` / `claimUntilHeight` precedent). The `fclaims` map is INTERNAL and is NOT
materialized in canonical state (the §29 `recaptures` precedent). So every pre-V28 replay hash is unchanged,
and post-V28 canonical hashes cover `claimTxid` only.

**Hold and grace.** `claimHeld(o, h)` keeps its form, but grace is fclaim-aware: an fclaim hold (`claimTxid`
set) has grace 0, so the hold is exactly `[grantHeight, holdEnd]` with `holdEnd = (E + 1)*EPOCH_LEN - 1`, the
last L0-minable height for the fill (an attest at `h > holdEnd` is in an epoch `> E` and L0-invalid). The
resolver-local grace and the shared `claimGraceOf` selector are made `claimTxid`-aware TOGETHER so the resolver
and every client bundle stay in lockstep.

**Fill routing.** A `SCORE_FILL` attest on an fclaim txid looks up the linked offer and delivers iff: the
fclaim was `granted`; the offer is `open`; `claimTxid === fclaimTxid && claimHeld(o, h)`; and
`attester === claimedBy`. It then runs the EXISTING §4 / §19 (whole) and §12 (partial) value-and-delivery
machinery unchanged (same required outputs, keyed on the offer). Partial fills ride the fclaim lane and the
hold PERSISTS across them until `holdEnd` or a whole fill. A granted fclaim's own `paidTo` is
allowed-and-ignored (the §28 payment-free-reveal precedent). Any non-`SCORE_FILL` score on an fclaim txid is a
no-op (no buyer early-release).

**Correction 1 (offer-txid fill blocked during a hold).** At `h >= V28`, an open **offer-txid** fill on an
offer with `claimTxid !== undefined` is rejected. Without it, an updated buyer (or a stale bundle) could route
the payment through the offer id, whose L0 deadline is the offer's far-off expiry, silently reopening the
delayed-fill burn. One guard covers both the whole and partial offer-txid fill paths; token-priced fills never
carry a `claimTxid`.

**Correction 2 (cancel-freeze at apply-time, on the cancel's own block).** §16 defers a cancel's effect to the
block boundary. At `h >= V28`, both deferred closures (the `ocancel` Propose and the score-0 cancel Attest)
SKIP any target with a live fclaim hold: evaluate `claimTxid !== undefined && claimHeld(o, ev.height)` LIVE on
the offer object INSIDE the closure, keyed on the cancel's OWN block height. (A same-block higher-pos grant
mutates that offer object, so an inside-closure read sees the hold; a value snapshotted at the `ocancel`
apply-time target scan would not.) The freeze is scoped to `claimTxid !== undefined`, so pre-V28 legacy holds
keep §16 behavior byte-for-byte.

*Griefing note (Correction 2).* The freeze lets a buyer who holds a claim block the seller's cancel, and
nothing in this version bounds how many holds follow one another. The claim cooldown binds only the address
that held last (`claimedBy` is last-write-wins), so two addresses can alternate: each grant buys a hold of 61 to
90 blocks for one Propose fee (0.25 CSD), and a grant that lands in the block where the previous hold lapses
also freezes a cancel in that block. Sustained, that costs about 2 to 3 CSD a day at the 120-second block
target. While the chain of holds lasts the seller cannot withdraw the offer, and the holder can fill it at its
posted terms whenever they become favourable: a free option on a stale price, not a loss of funds already
paid. The exposure ends at the offer's expiry, because a hold can never outlive it. A seller who may need to
pull an offer should keep its expiry short or quote taker-bound (Lane B, below), which cannot be claimed.
`packages/cairnx/test/fclaim-v28.test.ts` case 12 pins both halves (two holders freeze the cancel; one cannot).

**Lane B (taker-bound offers become uncancellable at V28).** A taker-bound (RFQ) answer is a firm quote: at
`h >= V28`, both cancel paths reject a cancel when `o.taker !== undefined` and the offer was anchored at V28+.
The maker exits by letting the answer expire (one epoch, about an hour). This eliminates the cancel-reorder half
for the RFQ lane entirely.

**Name-offer freeze (lease-lapse safety).** A held offer that sells a **name** is also protected from
`voidOpenNameOffers`: at `h >= V28`, a recapture or displacement does not void an offer carrying a live
`claimTxid` hold (the same predicate as Correction 2). Without this, a name whose lease lapses mid-hold could be
recaptured and its offer voided, stranding the buyer's L0-minable fill.

**`SCORE_CLAIM` sunset.** At `h >= V28` a `SCORE_CLAIM` attest is explicitly rejected (`claims are fclaim
proposals now`) so a stale wallet's claim is diagnosable rather than silently inert. Pre-V28 live holds continue
to honor legacy `SCORE_FILL` fills until they lapse (all within 45 blocks of the gate); the legacy lane
self-sunsets with no height literal in the predicate.

**Denied-fclaim is an L0-valid fill target (the sharp edge).** L0 stores every mined Propose, and an Attest's
existence check only reads storage, so a fill on a resolver-DENIED fclaim (for example on a taken or expired
offer) still MINES and, because the resolver denied the hold, BURNS. A client therefore MUST re-derive the
entire grant itself over PoW-buried offer + fclaim events before signing a fill, and MUST NOT trust fclaim
inclusion or any resolver `granted` assertion. The `fclaims` map records the denied grant so the money-safety
audit flags such a burn.

**Client policy (not consensus, does not affect canonical state).** A filler waits a value-scaled
`requiredClaimDepth` (§20 reorg note) on BOTH the offer and the fclaim (and, for a partial tail-fill, on the
offer's earlier fill-basis events) before signing, and refuses to broadcast a fill within `FILL_TIP_MARGIN`
(`= 4`) blocks of `holdEnd` (a stranded no-op, never a fund risk), computed from the fclaim's actual confirmed
height and `expires_epoch`. Whether an fclaim was granted depends on the holds granted in the
`GAP_NEEDED = EPOCH_LEN*(FCLAIM_MAX_EPOCH_AHEAD + 1) - 1 + CLAIM_COOLDOWN_BLOCKS` (`= 104`) blocks before it and on
its proposer's live holds on other offers. A client replaying a window of blocks it read completely therefore
decides an fclaim only when the window reaches `GAP_NEEDED` below it and the fclaims in that span are decided as
well; an fclaim in the window's lowest `GAP_NEEDED` blocks, and a fill older than the window, are not decided by
it. cairnx-core's `verifyFillSpv` replays such a window and names these as known limits.

- **Adoption note:** at/above V28 the fill's referenced proposal changes (offer id becomes fclaim txid) and
  `SCORE_CLAIM` is rejected, so v2.8 is BOTH a relaxation (an fclaim fill a fresh core accepts, a stale core
  no-ops) AND a tightening (a stale core still grants legacy claims a fresh core rejects). Every replayer,
  resolver, and client bundle MUST run the v2.8 core before the tip crosses `V28_HEIGHT`. Below the gate every
  rule above is inert and all replay is byte-identical.

## 32. v2.9: replay-feed de-duplication and the open-holds concurrent-claim count

Two `resolve()`-side corrections that both move canonical state, so both ride ONE height gate,
`V29_HEIGHT` = 88 000 (set 2026-07-20 by operator decision; the REBIND audit's M4 + M5). Each rule keys on
the triggering EVENT's OWN height (`>= V29_HEIGHT`), never on the tip: non-retroactive, so every pre-V29
event replays byte-identically forever and a mixed-version fleet cannot fork below the gate.

**M4: duplicate-event drop (reject-more).** The §3 consensus ordering sorts events but never de-duplicates,
so a double-fed transaction (an overlapping scanner page delivered verbatim) applies twice; on the §12
partial-fill path that double-credits `paid` / `delivered`. A transaction has ONE identity: a `Propose`'s
`id`, an `Attest`'s `txid`. At an event height `>= V29_HEIGHT` the FIRST occurrence in consensus order
(§3: height, propose-before-attest, pos, ordinal id/txid) is kept and every later occurrence of the same
identity is dropped BEFORE apply. Below the gate nothing is dropped. Two copies of one event that a feed
delivers twice share one txid, height and position, so they land on the same side of the gate. A
transaction can also be mined again: coinbase txids are not unique on this chain, so a spent coin can be
created again and the same spending transaction mined in a later block. Those copies sit in two blocks,
possibly on both sides of the gate, and `resolve()` fed both drops the later copy only when both are at or
above the gate. §33 keeps the first occurrence, so a feed built by its rule holds neither kind of duplicate;
the drop above stays the rule for a feed that is not built by it. A list holding one transaction id at two places (a
later height, or another position in the same block) with the first copy below the gate is not a list §33 produces
(§33.2), and no level of §38 covers `resolve()` over it; there the two reference implementations differ: from V14, an
offer among its seller's `ocancel` targets, fed again after that `ocancel` in its block, stays open past its expiry in
cairnx-core and expires in the Python reference. Two copies at one height and position below the gate both apply in
both, as `cases-v29.json` pins.

**M5: the concurrent-hold cap counts only OPEN holds (relaxation).** §20/§31 cap an address at
`MAX_ACTIVE_CLAIMS` (= 3) live holds, counted as `claimedBy === who && claimHeld(o, h)`. A FILLED offer
keeps its last-write-wins `claimedBy` / `claimUntilHeight` / `claimTxid` (§31 fund-safety: never cleared),
so a completed buy kept consuming a cap slot until its hold window lapsed: three completed fclaim buys
wrongly denied a fourth honest claim. At a counting event's height `>= V29_HEIGHT` the count admits only
holds whose offer is still `open`: `claimedBy === who && claimHeld(o, h) && (h < V29_HEIGHT ||
o.status === "open")`. A filled offer has SETTLED; its residual claim fields are a record, not a live
reservation. The post-V29 count is a strict SUBSET of the pre-V29 count, so the rule can only GRANT a
claim, never newly deny one. Normatively the same clause applies to BOTH counting sites (the §31 fclaim
grant ladder and the §20 legacy `SCORE_CLAIM` handler); in the legacy handler it is provably unreachable
(`SCORE_CLAIM` at height `>= V28_HEIGHT` is rejected by §31, and `V29 > V28`), and is kept for symmetry.

**Canonical surface.** No new fields. Both rules change only WHICH events apply, so pre-V29 canonical
hashes (every pinned vector and the whole live-chain replay below 88 000) are byte-identical; the v2.9
divergence height is pinned by the fork-lens vector set (`cases-v29.json`).

- **Adoption note (HARD adoption gate, sharper than §31):** M5 GRANTS holds a stale replayer still
  DENIES, so a stale replayer forks the moment the chain crosses `V29_HEIGHT` with a post-gate grant in
  flight: it rejects claims (and the fills routed through them) that the canonical chain accepts. Every
  replayer, resolver, and client bundle (cairnx service, clarvis, the vendored site and wallet bundles,
  cairn-sdk, cairn-cli, csd-indexer, the Python oracle) MUST run the v2.9 core and be CONFIRMED live
  before the tip crosses 88 000, never "publish and hope". The `replay-hashes.json` V29 entry is pinned
  only POST-crossing from the live chain (see CONSENSUS_CHANGES.md); a pre-crossing V29 hash would be an
  invented pin and is forbidden.

---

# CairnX chain input (no gate)

## 33. From a block to events

`resolve()` (§3, §5) replays a list of events. This section is the rule that makes that list from the chain's
blocks; two readers that apply it to the same blocks feed `resolve()` the same events. It has no activation gate:
it is the input form the reference service has always replayed (§33.2), and where other readers used other forms
(an expiry above 2^53 - 1, a `uri` holding U+0000), `resolve()` derives the same state from both forms (§33.4).

The rule has two parameters: a domain D and an activation height A. CairnX uses D = `cairnx:v1` and A = 29 860
(`DOMAIN` and `ACTIVATION_HEIGHT`, together `CAIRNX_EVENT_RULE`). D is a non-empty, well-formed string holding
neither U+0000 nor U+0001; A is an integer >= 0. Another application may apply the rule with its own D and A.

### 33.1 Membership

A transaction at height h and position p (its index in the block; the coinbase is at 0) is an event when h >= A and

- it is a `Propose` whose domain equals D, code unit for code unit, or
- it is an `Attest` whose proposal id is the id of a `Propose` event of this rule at a height <= h. A `Propose`
  event in the same block counts at any position, before or after the `Attest`: the node applies a block's
  proposals before its attestations (C5).

Nothing below A is an event, and nothing below A is read: an `Attest` at or above A on a `Propose` mined below A is
not an event. A transaction without an app payload is not an event. The coinbase is never an event: consensus
refuses a block whose first transaction is not the coinbase or whose coinbase carries an app payload, so a list
with an app payload at position 0 is not a block of the chain, and a reader refuses it.

A reader may apply the rule to a sparse block: a list in strictly increasing position order, each transaction at
its true position, that holds every transaction of the block that carries an app payload. A complete block is one
such list. The rule cannot see whether a list is complete; establishing that is the reader's. A complete block
whose transactions hash to the merkle root of a header the reader verified establishes it; a feed (a node's events
route, a recorded fixture) establishes it only on the feed's word.

### 33.2 First occurrence

A transaction id is one event, at the lowest height at or above A at which the chain holds it. A block holds a
transaction id at most once (consensus refuses a block that repeats one), so a reader refuses a list that repeats
one. A transaction id can still sit in two blocks: coinbase transaction ids are not unique on this chain, so a
spent coin can be created again and the same spending transaction mined in a later block. Its later copies are not
events. Occurrences below A are never read, so a transaction mined below A and again at or above A is an event at
its first height at or above A, when it is a member there. This fixes the input form the reference service has
always replayed (csd-indexer keeps the first occurrence of a transaction id at every height, and the service reads
that feed), so a reader that feeds `resolve()` every copy of a re-mined transaction can differ from the reference
when a copy lies below V29, where §32's M4 drop does not apply.

A reader that applies the rule a block at a time keeps two sets, derived from the events it holds and rolled back
with them on a reorganisation: the ids of all its events (a `Propose`'s id, an `Attest`'s transaction id) and the
ids of the `Propose` events among them.

### 33.3 Order

A block's events are listed in apply order: its `Propose` events by position, then its `Attest` events by
position; blocks follow by height. This is the order of §3.
The reference comparator is `applyOrder` (with `eventId`, the id it compares last), the function `resolve()` sorts with.

### 33.4 Field forms

Each event is a `ProposeEvent` or an `AttestEvent` (`src/types.ts`). Transaction ids, hashes and addresses are
written `0x` and lowercase hex: 64 digits for 32 bytes, 40 for 20 bytes. An output's address is its 20-byte
`script_pubkey`. The fields are taken from the transaction as decoded from its consensus bytes or its node JSON,
with u64 values exact. In JavaScript a u64 input (an expiry, an output value) is a bigint in [0, 2^64), or a number
that is an integer in [0, 2^53]: 2^53 is accepted as a number because it is the rule's own form of a clamped expiry,
and a number above 2^53 is refused, because such a double no longer identifies one u64. The rule does not check
again what the node checked (fee floors, `uri` length, expiry at creation).

| Field | Value |
|---|---|
| `kind` | `"propose"` or `"attest"` |
| `id` (Propose), `txid` (Attest) | the transaction id |
| `proposer`, `attester` | the author (§33.5) |
| `uri` | the consensus text with each U+0000 written as U+0001, the form csd-indexer keeps from 0.3.8 on. JSON admits neither character unescaped, so a `uri` holding either is no record in both forms |
| `payloadHash`, `proposalId` | the consensus 32 bytes |
| `expiresEpoch` | the consensus u64 when it is at most 2^53 - 1, otherwise 2^53 (9007199254740992). `resolve()` reads it only for offers, bids and fclaims, and refuses each of those above 2^53 - 1 |
| `score`, `confidence` | the consensus u32 values |
| `height`, `pos` | the block height; the position in the block |
| `paidTo` | for each address paid by an output whose value is at most 2^53 - 1, the sum of those outputs' values as a decimal string (an output of value 0 lists its address with `"0"`); an output above 2^53 - 1 is left out, since the total supply can exceed 2^53 - 1 |

### 33.5 The author

The author of an event (`proposer`, `attester`) is the owner of the output that the transaction's first input
spends: that output's `script_pubkey`. The node accepts the first input only when hash160 of the public key in its
signature script equals that `script_pubkey` (C3), so for a mined transaction the two are one address. The
transaction id does not commit the signature script, so a copy of a mined transaction can carry another key's
valid signature and still match its merkle root. The rule therefore takes the author as an input the reader binds:
the spent output is read from its source transaction after that transaction's id is recomputed, and csd-crypto
`authorOf(tx, scriptPubkey)` returns the owner only when the first input's signature is the owner's. A copy for
which it returns null is a damaged copy, to be read again from another source, never an event of another author. A
reader that cannot bind the author of a member has no events for that block; it never leaves the event out.

### 33.6 The byte form of an event list

The bytes of an event list are csd-codec `canonicalJson` of the array of events in the order of §33.3 (keys in
code-unit order at every depth, §5.1). No event key and no `paidTo` key is an array index, so §5.1 A2 does not
arise.

### 33.7 Reference functions and vectors

cairnx-core exports the rule as `eventOfTx`, `blockMembers`, `blockEvents` and `CAIRNX_EVENT_RULE`;
`conformance/cairnx_ref.py` implements the same three functions independently.

- `eventOfTx(t, height, author, rule?)` maps one transaction (`{pos, txid, tx: {app, outputs}}`) to its event, or to
  null when it carries no app payload, lies below A, or is a `Propose` in another domain. It does not decide `Attest`
  membership, which needs the block: a caller that reads single transactions (a wallet proving one fill, a scanner
  reading a feed that joins attestations to their proposals) decides it itself. An `Attest` on a proposal that is
  not an event changes no state: `resolve()` ignores it.
- `blockMembers(height, txs, sofar, rule?)` returns the members of one block (§33.1, §33.2) in position order, so a
  reader binds authors for those alone; `sofar` holds the two sets of §33.2. `txs` is a list as §33.1 describes.
- `blockEvents(height, txs, sofar, authors, rule?)` returns the block's events in the order of §33.3, with
  `authors[i]` the author of the i-th member. It selects the members again, so a list of authors one short is
  refused.

Each refuses (throws; `ValueError` in Python) input that is not a block of the chain or not in the forms of
§33.4: positions that are not integers >= 0 in strictly increasing order, a transaction id repeated in a block, an
app payload at position 0, a field outside its consensus type (hex of the wrong length, an integer out of range,
text that is not well-formed), a member without an author, and a rule whose domain or activation height is not
in the form above. Hex input may carry a `0x` prefix or none, with its digits in either case. An integer field (a
height, the activation height, a position, a score, a confidence) may come in any JSON spelling of its value (`1`,
`1.0`, `1e0`); a boolean is not an integer.
`eventOfTx` checks the height, position, transaction id and app type of any transaction; of one below A it reads
nothing more, and it checks the remaining fields and the author only of an event. `blockMembers` checks the
position, transaction id and app type of every listed transaction, the domain of every `Propose` and the proposal
id of every `Attest`; `blockEvents` checks in addition what `eventOfTx` checks of each member. Neither reads
anything of a block below A.

`test/vectors/events.json` holds the language-neutral vectors, `{format: 1, rule, tx, blocks}`, one case per line.
A `tx` case gives `input` (`txid`, `height`, `pos`, `app`, `outputs`, field names as in csd-codec's `Tx`, u64 values
as decimal strings), `author`, and `expect`: the event, null, or `"error"`. A `blocks` case gives a sequence of
blocks (`{height, txs}`), the authors by transaction id, and `expect`: the members' positions per block and the
events of the whole sequence, or `{"error": i}` with i the first block refused. The two sets carry across a case's
blocks, and a member whose author is not listed is given null. A conformant reader reproduces every case, each
event list as the bytes of §33.6.

Feeds are not this rule's output. csd-indexer's chain-order feed of a domain's attestations includes attestations
on proposals below A, which `resolve()` ignores; a node's events route can list every copy of a re-mined
transaction, and §32's M4 drop removes only the copies at heights at or above V29.

---

# Comparing replicas (no gate)

## 34. State hash and events hash

Two replicas that replay the same chain compare two hashes at one block: the events hash commits what they read, the
state hash what they derived. Neither enters a record or the canonical state, so defining them moves no state; both
are fixed byte for byte here so that every replica computes them alike.

### 34.1 The state hash

The state hash of a resolver state is sha256 of the UTF-8 bytes of its canonical state (§5, §5.1, with the
integer-key order of A2), written `0x` and 64 lowercase hex digits. Besides the seven keys of §5's surface, a
`resolve()` result carries three diagnostic fields that the canonical state leaves out: `events` (the applied log),
`recaptures` (§29) and `fclaims` (§31); the state hash of a complete result is the hash of its surface alone. At
height h it is the state hash of `resolve()` over the events at heights <= h with tip h;
`test/vectors/replay-hashes.json` pins that digest, without the `0x`.

### 34.2 The events hash

The events hash runs over the events of §33 block by block. For a block at height h that holds at least one event:

```
b     = sha256( h as 8 bytes big endian || row_1 || ... || row_n )
row_i = position as 4 bytes big endian || transaction id (32 bytes) || author (20 bytes)
```

with one row per event of the block, in ascending position. The transaction id is a `Propose`'s `id` or an
`Attest`'s `txid`, the author its `proposer` or `attester`. The order is position order, not the apply order of
§33.3, which lists `Propose` events first; positions within a block are distinct. The running value e is 32 zero
bytes before the first block at or above A, and each block that holds an event, in ascending height, replaces it:

```
e = sha256( e_prev || b )
```

A block without events leaves e as it is. The events hash at height h is e after the last block at or below h that
holds an event, written `0x` and 64 lowercase hex digits.

Height and position are in the hash because the resolver compares positions of records in different blocks (the
name contests of §9 and §28). The transaction id commits every other field of the transaction, and the author, which
it does not commit (§33.5), is in the row, so no JSON form, number form or text storage enters the hash.

### 34.3 Comparing two replicas

Two replicas compare (height, block hash, events hash, state hash) at one height. The comparison means something only
at a height both treat as final (§38 names the depth): near the tip two honest replicas can hold different blocks
for a while.

- Another block hash at the height: the replicas follow different branches. Wait and compare again; this is a
  branch difference, never a divergence.
- The same block hash, another events hash: the replicas read different events from the same blocks, so their record
  sources differ (a source left out or added a transaction, or recorded another author, height or position).
- The same events hash, another state hash: the replicas read the same transactions at the same places with the same
  authors and apply different rules to them: the resolver (§3 to §32), or the field forms of §33.4, which the events
  hash does not see.

The running value carries every earlier block, so the first block whose events differ lies after the last height at
which the events hashes agree.

### 34.4 Reference functions and vectors

cairnx-core exports `stateHash`, `eventsHashStep`, `eventsHash` and `EVENTS_HASH_START` (the 32 zero bytes);
`conformance/cairnx_ref.py` implements them independently.

- `stateHash(state)` is the state hash of a `resolve()` result.
- `eventsHashStep(prev, height, events)` is e after one block from the value `prev`, with `events` the block's
  events in any order; for no events it is `prev`.
- `eventsHash(events)` is e over a list from the start value. The list is in the order of §33.3 or in an order that
  differs from it only within a block, so each height forms one run. Unlike `resolve()`, it does not sort across
  heights: a list in another order is sorted by height first.

Values, transaction ids and authors are `0x` and lowercase hex, the forms of §33.4; a height is an integer in
[0, 2^53 - 1], a position an integer in [0, 2^32 - 1], either in any JSON spelling of its value (`100000.0` and `1e5`
are 100000); a boolean is not an integer. Each function refuses (throws; `ValueError` in Python) a
previous value, transaction id or author in another form (upper case or without `0x` included), a height or position
out of its range, an event whose kind is neither `propose` nor `attest`, an event whose height is not the step's, and
a position repeated in a block; `eventsHash` refuses a height below the one before it. `eventsHashStep` sees no
earlier height, so a caller that steps block by block keeps the blocks in order. Neither reads any other field.

`test/vectors/hashes.json` (`conformance/gen-hashes-vectors.mjs`) holds the vectors, `{format: 1, start, cases,
corpus}`, one case per line. A case gives `blocks` (`{height, events}`, each event with the five fields above), may
give `prev`, and gives `expect`: `steps`, `eventsHashStep` applied to the blocks in turn from `prev` or the start
value, as the value or `{"error": i}` with i the first block refused; and, without `prev`, `list`, `eventsHash` over
the blocks' events in turn, as the value or `"error"`. `corpus` gives both hashes over
`test/vectors/replay-corpus.json` at each height of `replay-hashes.json`, the events at heights <= h in a stable sort
by height.

---

# CairnX for other applications (no gate)

## 35. Other applications

This section and §36 bind an application that is not CairnX and reads or writes on the same chain. Neither has an
activation gate: they state what the reference already does and reserve names for later, so they move no state.

### 35.1 Record types under `cairnx:v1` are reserved

Every record type under `cairnx:v1` belongs to this convention. A record whose `t` this version does not define is a
no-op today (§3), and a later gate may give that type a meaning; from the gate's height on, a record of that type is
read by the new rule, whoever anchored it and for whatever purpose. A record of a defined type with a key its schema
does not list is a no-op too (§5.1 A8). An application therefore must not anchor its own records under `cairnx:v1`,
neither as a new type nor as extra keys on a defined one.

### 35.2 An application's own domain

An application's own records go in its own domain, named `<app>:<major>`: `<app>` names the application and `<major>`
is the major version of its record format. A domain is a string of the form §33 requires of D. Domains whose text
begins with `cairnx`, `csd` or `cairn` are reserved to this convention and its maintainers; an application uses none
of them.

A domain is a label and not an authority. Anyone can anchor a `Propose` under any domain, a reserved one included,
and reserving a prefix gives no one control of it. An application decides which authors it accepts under its domain,
with the author of §33.5.

The rule of §33 takes the domain and the activation height as parameters (`EventRule`; `CAIRNX_EVENT_RULE` is
CairnX's), so an application reads its own domain with the same functions (`eventOfTx`, `blockMembers`,
`blockEvents`) and its own D and A. `resolve()` reads only CairnX records; the meaning of an application's records is
the application's to define.

### 35.3 Data for readers of a name: the profile

Data an application publishes for the readers of a name (a site, a node address, a pointer to its own data) goes in
the name's profile, the `nprofile` record of §22, under the keys of §36.

- A write replaces the whole map: the resolver stores the record's `p` as the profile, and `{}` clears it (§22). A
  writer therefore reads the current profile first and writes the merged map, with every key it did not set kept at
  its current value.
- A reader ignores the profile of a name that is expired or pending. In the state of §5 these are a name with
  `expired: true` (its lease and grace have lapsed, §17) and a name with `pending: true` (a reservation of §28 not yet
  finalized; `resolve()` materializes it without a profile). An expired name keeps its last profile in state until the name is claimed again; that profile is
  history, not the word of a current owner.

Known limit: only the owner writes a profile (§22), and two writers for one owner (two applications, or two devices)
that read the same profile and both write within one block interval lose one write: the later in apply order (§3)
replaces the map, and the keys only the earlier write carried are gone. The convention has no per-key write; a writer
that needs its write kept reads the profile again once its record is mined.

### 35.4 Forward resolution: the address a name receives at

A payment to a name goes to its `addr` (set by `nset`, §9, §26), else to its owner, so a name receives before its owner
sets an address. Read from `names` in the state of §5 at a tip:

| The name in `names` | Resolves to |
|---|---|
| held, with `addr` | `addr` (`via: "nset"`) |
| held, without `addr` (not set, or cleared by an `nset` to the zero address from V23) | the owner (`via: "owner"`) |
| held, with the zero address as `addr` (an `nset` to it below V23 stored it, §26) | the zero address (`via: "nset"`); a wallet refuses to pay it (§26) |
| in grace (§17: past `paidThroughEpoch`, without `expired`) | as held |
| with `expired: true` (§17) | the record's address, flagged `lapsed: true`; a sender refuses it |
| with `pending: true` (§28) | nothing: a reservation confers no address |
| absent | nothing |

A name an open offer locks (§9) resolves as held. A sale and an `nxfer` clear `addr`, so the new owner receives until
it sets one. The profile is not read (§36.3). A reserved name (`RESERVED_NAMES`) is absent from `names`, since a record
that claims it does not parse (§9), so it resolves to nothing. The name is looked up as `names` writes it: a reader
lowercases its input, drops a `.csd` suffix and refuses a string that does not match `NAME_RE` before it asks. In
JavaScript `names` is a plain object and `constructor` matches `NAME_RE`, so a reader tests for an own key: a bare index
on an unregistered `constructor` reads `Object.prototype.constructor`.

cairnx-core exports the rule as `resolveNameIn(names, name)`, which answers `{name, addr, via, lapsed, owner}` or null,
and `nameView(names, name)` for a reader that shows a name: its class (`held`, `pending`, `lapsed`, `free` when absent,
`reserved`), its owner (the reserver of a pending name, the last owner of a lapsed one), its address and its profile (a
held name's only, §35.3) and its `paidThroughEpoch`; null for a string that does not match `NAME_RE`.
`test/vectors/forward.json` (`conformance/gen-forward-vectors.mjs`) holds the cases, one per line: the events, the tip,
and for each name asked the answers of both functions over `resolve(events, tip).names`, written by hand. Neither
function writes state, so this section has no gate.

## 36. The profile-key registry

This is the registry of profile keys, the first version. The resolver validates keys by their form alone and keeps no
list of them (§22), so the registry binds writers and readers, not replay.

### 36.1 The caps

From `src/types.ts`; a record that breaks one is a no-op (§22).

| Cap | Constant | Value |
|---|---|---|
| keys in one profile | `PROFILE_MAX_KEYS` | 16 |
| UTF-8 bytes of one value | `PROFILE_MAX_VALUE_BYTES` | 256 |
| UTF-8 bytes of the whole record, its `uri` | `MAX_RECORD_BYTES` (the node's `uri` cap, C4) | 512 |
| the form of a key | `PKEY` | `^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$`: 1 to 32 characters, lowercase letters and digits, with dots and hyphens inside |

Each value is a string. The resolver accepts any well-formed string within the byte cap (§5.1 A7), the empty string
included; the forms below are what a reader accepts as the value of a registered key.

### 36.2 The keys

| Key | Value |
|---|---|
| `display`, `description`, `avatar`, `header`, `url`, `email`, `location`, `com.twitter`, `com.github`, `com.discord`, `org.telegram`, `com.linkedin`, `com.reddit` | the 13 keys the reference site's profile editor writes, registered as they are: a display name, a short text, an image URL (`avatar`, `header`, `https://` only), a link (`url`, below), an email address, a place, and six handles on the named services |
| `url` | an `https://` link |
| `contenthash` | a URI: `ipfs://<CIDv1>`, with nothing after the CID. Not ENS's binary encoding. A later revision of this registry may add `ipns://`; it is not valid now |
| `csd.*` | reserved to this convention for keys about the chain itself; only the keys below are defined |
| `csd.p2p` | a peer of the chain's own network: a libp2p multiaddr that ends with its peer id (`/p2p/<peer id>`) |
| `csd.rpc` | an address through which a page reaches a node's API: an `https://` base URL without credentials, query or fragment, or the multiaddr of a gateway that carries that API, ending with the gateway's peer id |
| an application's keys | under a reverse-DNS prefix of a domain the application controls, for example `org.example.app` for the application at `app.example.org`; the whole key matches `PKEY` |

The six service keys of the editor (`com.twitter` to `com.reddit`) are reverse-DNS names of domains this convention
does not control. They are registered as the editor writes them and are the only such keys.

### 36.3 Reader rules

- Accept only the schemes and forms stated in §36.2, and treat any other value of a registered key as absent.
- `csd.p2p` and `csd.rpc`: never use an address that is loopback, link-local or private, whether it is written as an
  address or reached through a name that resolves to one. A multiaddr ends with a peer id, and a reader dials that
  peer only with its peer id checked.
- An address that a name's profile publishes is that name owner's node. What is read through it is at most single
  records, each proven for inclusion with its author bound to the coin it spent (§33.5; the record proof of §37),
  never a complete history, and never what marks any name, that one or another, as verified.
- A profile is never a send target (§22): the address a name pays to is `addr`, set by `nset`, else the owner (§35.4).
- The profile of an expired or pending name is ignored (§35.3).

### 36.4 The byte budget

For a 32-character name, each row is the record `nameProfile` builds, measured with `canonicalJson`, in UTF-8 bytes
against `MAX_RECORD_BYTES`. `node scripts/profile-budget.mjs` in the csd-sdk repository prints every figure, and its
test keeps this table equal to that output. The example values are of a realistic length: `contenthash` a CIDv1 in
base32, 66 bytes; `csd.p2p` a DNS multiaddr with an Ed25519 peer id, 89 bytes; `csd.rpc` an https base URL, 24
bytes, or a WebRTC gateway multiaddr with a certificate hash and a peer id, 158 bytes; each editor key 12 bytes.

| Profile | Keys | Record bytes | Left of 512 |
|---|---|---|---|
| empty | 0 | 71 | 441 |
| `contenthash` | 1 | 153 | 359 |
| `contenthash`, `csd.p2p` | 2 | 255 | 257 |
| `contenthash`, `csd.p2p`, `csd.rpc` (https URL) | 3 | 292 | 220 |
| `contenthash`, `csd.p2p`, `csd.rpc` (gateway multiaddr) | 3 | 426 | 86 |
| 13 editor keys, `contenthash`, `csd.p2p` | 15 | 601 | 89 over: `nameProfile` refuses it |

The 13 editor keys and the three registered keys `contenthash`, `csd.p2p` and `csd.rpc` are 16 keys, the key cap
exactly, yet the last row, with 15 of them and 12-byte values, is already over the byte cap. The byte cap binds
before the key cap, so an application uses one key that points at its own data rather than one key per field.

### 36.5 Adding a key

A key is added to the registry by a change to this file: a row in §36.2 with its value form, and its reader rules in
§36.3 when it needs any. It needs no gate, since the resolver keeps no list of keys. A key under an application's own
reverse-DNS prefix needs no registration.

---

# What a result proves (no gate)

## 37. The three levels

A result says which of three levels it is.

1. Display. An answer read from someone's API. It is worth the trust placed in that API.
2. Record proof. One record was mined in a block under valid proof of work, and its author is the owner of the coin
   its first input spends (§33.5). It does not prove that the record is the latest for its name or token, and it
   decides nothing about a name whose state depends on records outside the name's own history (a fill that depends
   on the buyer's other claims or balance, a registration that depends on the registrant's other reservations).
3. Replica. `resolve()` over every event of §33. It is exact for names and tokens when its event list is complete;
   §33.1 states what establishes that. What it proves depends on its source:
   - blocks from one's own node: the trust is one's own node;
   - complete blocks checked against headers: a block cannot be thinned, because its transactions must hash to the
     merkle root of the header and each author is bound to the coin it spent; what remains to trust is that the
     header source serves the chain with the most work;
   - a record log fixed in a release, plus complete blocks above the height it ends at: below that height the trust
     is the release;
   - a feed: a node's events route, csd-indexer's feeds, or any other list of records. A feed is complete only on its
     word, so a replay fed from one gives display, or a record proof for each record it proves, and says so. From
     one's own node the events route is the node software's word, which a replica makes equal to the first source by
     a recount from blocks at the boundaries of §38.

---

# Conformance and rule changes (no gate)

## 38. Conformance

A replica conforms at three levels.

1. The vectors: `test/vectors/cases.json`, `cases-v29.json`, `cases-rules.json` and `cases-convention.json` (replay, §5), `events.json`
   (§33.7) and `hashes.json` (§34.4). A conformant implementation reproduces every case byte for byte.
2. The pinned replay hashes: `test/vectors/replay-hashes.json`, the state hash (§34.1) of the live chain at each
   pinned height.
3. A running comparison: two replicas compare the tuple (height, block hash, events hash, state hash) of §34.3 at
   finalized epoch boundaries. An epoch is `EPOCH_LEN` = 30 blocks (csd-codec, re-exported by cairnx-core); a
   boundary is a height that is a multiple of `EPOCH_LEN`, and a finalized boundary is one that both replicas hold at
   least `FINAL_DEPTH` = 12 blocks below their tips (cairnx-core `FINAL_DEPTH`). The thresholds of §3 (3 and 6) are
   display conventions and are not this depth; neither is a bound on how deep a reorganisation can reach.

What a difference means is in §34.3. The operating rule: a difference is reported, never acted on automatically. A
replica that credits value stops crediting only when a difference at one block hash persists over three consecutive
boundaries and its own recount from complete blocks (§37) gives the same difference.

A form of the tuple recorded on chain is reserved under the reserved prefixes of §35.2 and is not defined by this
version.

`test/vectors/codes.json` (§40.7) is not a level: the reason codes move no state. A replica that publishes codes
reproduces it. `test/vectors/moves.json` (§41) is not a level: the token moves move no state. A replica that publishes
moves reproduces it.

## 39. Rule changes

- This specification is normative for the future. Pinned history stands: every height below a gate replays as it
  did, and the pinned replay hashes do not move. Behaviour changes only at a gate, an activation height in
  `src/types.ts`; a section without a gate, such as §33 to §41, moves no state.
- `CONSENSUS_CHANGES.md` in the csd-sdk repository is the ledger of every change. Each gate after v2.9 also has its
  own file, `docs/gates/<gate>.md`, written from `docs/gates/TEMPLATE.md` and linked from its ledger entry. It
  states the motivation, the rule text, the class of the change (reject-more: an input the earlier rule applied
  becomes a no-op; accept-different: an input is applied where it was not, or applied otherwise), the height, the
  vectors that pin it, and a rollout table of every consumer with how its adoption is observed.
  `scripts/check-consensus-citations.mjs` checks the citations of the ledger and of every gate file, and that each
  gate file is linked from the ledger.
- A published height never moves earlier. (The v2.4 to v2.7 heights were moved earlier once, on 2026-07-03, before
  this rule; see the note at the top of this file.)
- Rule changes ride gates within `cairnx:v1`. A second domain is only for a deliberate restart of state: its records
  are not events of `cairnx:v1` (§33.1), so it starts from no tokens, no balances and no names.

---

# Reason codes (no gate)

## 40. Reason codes

Every entry of the applied log (§5) carries `code`, the rule that decided the record, beside its `note`. A record that
does not parse is refused with a record code, which `explainRecord(uri, payloadHash)` returns and a record builder's
`RecordError` carries. The log stays outside canonical state, so codes move no state, and a replica that writes no
codes conforms at every level of §38.

### 40.1 What a code is

- A code names one rule. A rule that several record kinds or gate eras share has one code; the entry's `kind` names
  the record (`invalid` for one that does not parse).
- Each code has one outcome, applied or refused, and an entry's `ok` is true exactly when its code is applied.
- A code is upper snake case of at most 40 characters with a family prefix: RECORD, GATE, TOKEN, NAME, OFFER, BID,
  FILL, CLAIM, EXPIRY, TREASURY, CAP or INVARIANT.
- Where a record breaks more than one rule, its code is that of the first rule in the reference implementation's order
  (`src/resolve/`, `src/records.ts`); `test/vectors/codes.json` pins the order where two rules meet.
- An event that writes no entry has no code: an event below activation (§3); a repeated event at V29 or above (§32);
  an Attest on a proposal that is not an offer, except a cancel of a bid and a fill of a known fclaim; an Attest on an
  offer with a reserved score (any but 0, 50 and 100, and 50 below V17); and every expiry the sweep applies.

### 40.2 Stability

A code in a release keeps its meaning: it is never renamed, never reused for another meaning and never removed; a code
that is no longer written is marked retired and stays reserved. Codes may be added in any release, and a reason may be
split into a new code only with a line in the changelog. The note text is a diagnostic and may change in any release.
A consumer must treat an unknown code by its outcome (`ok`), since codes are added in any release.

### 40.3 Caps

The caps are the per-address rules that count the proposer's other names or offers: CAP_PENDING_RESERVATIONS and
CAP_PENDING_RECAPTURES (`MAX_PENDING_REG`), and CAP_LIVE_HOLDS (`MAX_ACTIVE_CLAIMS`, for fclaims and legacy claims).
`CAP_CODES` lists them, for an alarm on any cap refusal. A bound on one record or one token is not a cap:
TOKEN_SUPPLY_EXHAUSTED, EXPIRY_TOO_LONG, CLAIM_TOO_FAR_AHEAD, RECORD_TOO_LARGE and the profile limits.

### 40.4 The table

Four codes guard a state no event reaches, so no vector holds them: NAME_RECLAIMED, NAME_RESERVATION_EXPIRED,
NAME_NOT_LAPSED and INVARIANT_BROKEN (their rows say why).

| Code | Outcome | Cap | Meaning |
|---|---|---|---|
| TOKEN_DEPLOYED | applied | | a ticker is created |
| TOKEN_MINTED | applied | | supply is credited to the minter (note: the amount) |
| TOKEN_TRANSFERRED | applied | | tokens move |
| TOKEN_META_SET | applied | | the issuer sets the metadata hash |
| NAME_COMMITTED | applied | | a commit is recorded (its earliest height is kept) |
| NAME_REGISTERED | applied | | a pay-now registration below V25, the name free |
| NAME_REGISTERED_DISPLACED | applied | | a pay-now registration that displaces a holder with a later anchor |
| NAME_RESERVED | applied | | a reservation (V25 and above) of a free name |
| NAME_RESERVED_DISPLACED | applied | | a reservation that displaces a reservation with a later anchor |
| NAME_RECAPTURE_RESERVED | applied | | a recapture reservation (V26 and above) of a lapsed name |
| NAME_RECAPTURE_RESERVED_DISPLACED | applied | | a recapture reservation that displaces a later one |
| NAME_RECLAIMED | applied | | a pay-now reclaim of a lapsed name below V26; no event reaches it, since the earliest lapse falls far above V26 |
| NAME_FINALIZED | applied | | a registration is finalized and its fee paid |
| NAME_RECAPTURE_FINALIZED | applied | | a recapture is finalized and its premium paid |
| NAME_TRANSFERRED | applied | | the name has a new owner |
| NAME_ADDR_SET | applied | | the address is set, or cleared by the zero address at V23 and above |
| NAME_PROFILE_SET | applied | | the profile is set, or cleared by an empty `p` |
| NAME_RENEWED | applied | | one term is added (note: the new paid-through epoch) |
| OFFER_CREATED | applied | | an offer opens and its give is locked |
| OFFER_BULK_CANCELLED | applied | | an ocancel applies (note: the count, which may be 0) |
| OFFER_CANCELLED | applied | | a seller's cancel applies |
| BID_CREATED | applied | | a bid opens |
| BID_CANCELLED | applied | | a bidder's cancel applies |
| FILL_APPLIED | applied | | a whole fill delivers (token-priced or CSD-priced) |
| FILL_PARTIAL | applied | | a partial fill delivers, the one that completes the offer included (note: paid/want) |
| CLAIM_GRANTED | applied | | an fclaim (kind fclaim) or a legacy claim (kind claim) holds the offer |
| GATE_NOT_ACTIVE | refused | | the record type or shape is not active at this height |
| CLAIM_LEGACY_SUNSET | refused | | a legacy claim attest at V28 or above |
| TOKEN_TICKER_TAKEN | refused | | an earlier deploy holds the ticker |
| TOKEN_UNKNOWN | refused | | the ticker, or an offer's want ticker, was never deployed |
| TOKEN_NOT_ISSUER | refused | | an issuer-only mint or metadata record from another address |
| TOKEN_SUPPLY_EXHAUSTED | refused | | nothing is left to mint |
| TOKEN_MINT_AMOUNT_REQUIRED | refused | | an issuer mint without `amount` |
| TOKEN_BALANCE_LOW | refused | | the available balance is short (a transfer, an offer's give, a token fill's price and fee) |
| TREASURY_FEE_UNPAID | refused | | the output to the treasury is below the fee or premium (where the treasury is the seller on a rebate lane, below the fee plus the maker rebate, which sum on its output) |
| NAME_NO_COMMIT | refused | | no commit for this reveal below its height and inside the window |
| NAME_SALT_REQUIRED | refused | | a `name` without salt at V25 and above (registration) or V26 and above (recapture) |
| NAME_TAKEN_EARLIER | refused | | an earlier (effective height, position, id) holds the name or its reservation |
| NAME_TAKEN_PURCHASED | refused | | the holder bought the name in a fill and cannot be displaced |
| NAME_SALT_MISMATCH | refused | | the finalize's salt does not re-derive the reservation's commit |
| NAME_FINALIZE_TOO_EARLY | refused | | a finalize before the displacement freeze ends |
| NAME_RESERVATION_EXPIRED | refused | | a finalize after finalizeBy; no event reaches it, since the sweep before each event drops the reservation and the late finalize gets NAME_NO_RESERVATION |
| NAME_NOT_LAPSED | refused | | a recapture finalize of a name no longer lapsed; no event reaches it, since nothing makes a lapsed record live again before that finalize |
| NAME_NO_RESERVATION | refused | | no reservation or recapture of this name owned by the proposer |
| NAME_NOT_OWNER | refused | | the proposer does not own the name |
| NAME_PENDING | refused | | the name is a reservation not yet finalized |
| NAME_LAPSED | refused | | the lease and its grace are over |
| NAME_NO_LIVE_LEASE | refused | | a renewal of an unknown or lapsed name |
| NAME_GRACE_OWNER_ONLY | refused | | a renewal in grace by another address |
| NAME_LOCKED | refused | | an open offer holds the name |
| NAME_TOO_YOUNG | refused | | the sale embargo is not over |
| OFFER_LEASE_TOO_SHORT | refused | | the lease ends before the offer expires |
| OFFER_TAKER_REQUIRED | refused | | an open CSD-priced offer in [V13, V17) |
| OFFER_PAYTO_TREASURY | refused | | the payto is the treasury |
| OFFER_UNKNOWN | refused | | the fclaim names no known offer |
| OFFER_NOT_OPEN | refused | | the offer is filled, cancelled or expired (note: the status) |
| OFFER_NOT_SELLER | refused | | a cancel by another address |
| OFFER_FIRM_QUOTE | refused | | a cancel of a taker-bound offer created at V28 or above |
| OFFER_CANCEL_HOLD_LIVE | refused | | at the block boundary a deferred cancel meets a live fclaim hold |
| OFFER_CLOSED_BEFORE_CANCEL | refused | | at the block boundary the offer is already closed (by a fill, or by an earlier cancel) |
| BID_NOT_BIDDER | refused | | a bid cancel by another address |
| BID_NOT_OPEN | refused | | the bid is cancelled, expired or done |
| EXPIRY_UNSAFE | refused | | the expires_epoch is at or above 2^53 |
| EXPIRY_PAST | refused | | the expiry epoch is before the inclusion epoch |
| EXPIRY_TOO_LONG | refused | | the v2.1 duration cap (anchors in [V21, V22)) |
| FILL_FCLAIM_NOT_CURRENT | refused | | a fill attests a denied or superseded fclaim: the payment moves, nothing is delivered |
| FILL_NOT_TAKER | refused | | the filler is not the bound taker |
| FILL_NO_TOKEN_MARKER | refused | | a token-priced fill without confidence `CONF_TOKEN_FILL` |
| FILL_OPEN_LANE_CLOSED | refused | | an open CSD fill in [V13, V17) |
| FILL_WRONG_TARGET | refused | | an offer-id fill during an fclaim hold |
| FILL_NO_LIVE_CLAIM | refused | | an open CSD fill without the filler's live hold |
| FILL_BELOW_MIN | refused | | a partial payment below the effective minimum |
| FILL_ZERO_DELIVERY | refused | | the payment delivers no unit |
| FILL_UNDERPAID | refused | | the payment to payto is below want.value (where payto is the seller and a maker rebate applies, a shortfall there is FILL_REBATE_UNPAID) |
| FILL_REBATE_UNPAID | refused | | the payment to the seller is below the maker rebate, or, where payto is the seller, below want.value plus the rebate |
| CLAIM_TAKER_BOUND | refused | | a taker-bound offer takes no claim |
| CLAIM_TOKEN_PRICED | refused | | claims are for CSD-priced offers |
| CLAIM_HOLD_LIVE | refused | | a hold (window and grace) is live, whoever holds it |
| CLAIM_COOLDOWN | refused | | the last holder within `CLAIM_COOLDOWN_BLOCKS` of its hold's end |
| CLAIM_OUTLIVES_OFFER | refused | | the hold's expiry is after the offer's |
| CLAIM_TOO_FAR_AHEAD | refused | | the hold's expiry is more than `FCLAIM_MAX_EPOCH_AHEAD` epochs ahead |
| CAP_PENDING_RESERVATIONS | refused | yes | the proposer holds `MAX_PENDING_REG` other live reservations |
| CAP_PENDING_RECAPTURES | refused | yes | the proposer holds `MAX_PENDING_REG` other live recapture reservations |
| CAP_LIVE_HOLDS | refused | yes | the proposer holds `MAX_ACTIVE_CLAIMS` live holds |
| INVARIANT_BROKEN | refused | | an open offer's name or give lock is missing; no event reaches it |
| RECORD_TOO_LARGE | refused | | the uri is over `MAX_RECORD_BYTES` UTF-8 bytes |
| RECORD_NOT_OBJECT | refused | | the uri is not JSON, or not a JSON object |
| RECORD_NOT_CANONICAL | refused | | the uri is not the canonical JSON of its object |
| RECORD_HASH_MISMATCH | refused | | the payload hash does not commit to the uri |
| RECORD_LONE_SURROGATE | refused | | a string holds a lone surrogate |
| RECORD_NOT_V1 | refused | | `v` is not 1, or `t` is not a string |
| RECORD_UNKNOWN_TYPE | refused | | an unknown `t` |
| RECORD_EXTRA_KEY | refused | | a key outside the record's set |
| RECORD_BAD_SHAPE | refused | | the fields form none of the record's allowed shapes |
| RECORD_SAME_TOKEN | refused | | the give and the want are one ticker |
| RECORD_BAD_TICKER | refused | | a ticker is missing or does not match `TICKER_RE` |
| RECORD_BAD_NAME | refused | | a name is missing or does not match `NAME_RE` |
| RECORD_NAME_RESERVED | refused | | a name in `RESERVED_NAMES` |
| RECORD_BAD_ADDRESS | refused | | an address is missing or does not match `ADDR_RE` |
| RECORD_BAD_AMOUNT | refused | | an amount is missing or not a canonical decimal string |
| RECORD_AMOUNT_TOO_LARGE | refused | | an amount at or above 2^96 |
| RECORD_AMOUNT_ZERO | refused | | an amount of 0 where zero is refused |
| RECORD_MIN_ABOVE_WANT | refused | | the offer's `min` is above want.value |
| RECORD_BAD_HASH | refused | | a hash is missing or does not match `HASH_RE` |
| RECORD_BAD_SALT | refused | | a salt does not match `SALT_RE` |
| RECORD_BAD_DECIMALS | refused | | the decimals are not an integer from 0 to `MAX_TOKEN_DECIMALS` |
| RECORD_BAD_MINT_MODE | refused | | the mint is neither open nor issuer |
| RECORD_BAD_TEXT | refused | | a memo or token name is not a string or is too long (in UTF-16 units) |
| RECORD_BAD_TS | refused | | the ts is not a safe integer |
| RECORD_PROFILE_TOO_MANY_KEYS | refused | | a profile over `PROFILE_MAX_KEYS` keys |
| RECORD_PROFILE_BAD_KEY | refused | | a profile key that does not match `PKEY` |
| RECORD_PROFILE_BAD_VALUE | refused | | a profile value that is not a string |
| RECORD_PROFILE_VALUE_TOO_LONG | refused | | a profile value over `PROFILE_MAX_VALUE_BYTES` UTF-8 bytes |

### 40.5 Records and builders

`explainRecord(uri, payloadHash)` answers `{ ok: true, record }` or `{ ok: false, code }`, and `parseRecord` answers
null exactly when it answers a code. A record builder that refuses throws `RecordError`, an `Error` whose `code` is the
record code and whose message is `record does not validate against CONVENTION.md (<code>)`. A builder input that is not
JSON data throws the codec's own error before any rule is checked.

### 40.6 The client helpers' reasons

`previewFill` and `fillOutputPlan` keep their own reasons: `not-open` is OFFER_NOT_OPEN, `zero-delivery` is
FILL_ZERO_DELIVERY, and `below-min` is FILL_BELOW_MIN on a partial fill and FILL_UNDERPAID on a whole one.

### 40.7 Reference and vectors

`src/codes.ts` holds the table: `REASON_CODES`, `REASON_CODE_OUTCOME`, `CAP_CODES` and the types `ReasonCode`,
`AppliedCode`, `RefusalCode` and `RecordCode`; a test requires it equal to §40.4. `test/vectors/codes.json` holds 145
resolve cases (the events, the tip and the expected entries as `[id, kind, ok, code]`, compared as a set) and 50 record
cases (the uri, the payload hash and the expected code, or null for a record that parses), with every expectation
written by hand in `conformance/gen-codes-vectors.mjs`. A replica that publishes codes reproduces it. The Python
reference of `conformance/` writes no codes.

---

# Token moves (no gate)

## 41. Token moves

An applied entry of the log (§5) whose record moved tokens carries `moves`: the movements in the order the record
applied them, each `{ leg, ticker, from, to, amount }`, that is `amount` base units of `ticker` from the address `from`
to the address `to`. `amount` is a positive decimal string in the form of the state's balances (§5). The resolver
writes each move where it applies the balance change, so a reader takes who received what from the log and does not
restate the rules that decide the amounts (the mint caps, a whole fill's delivery, the partial fill's floor, the fee).

| leg | written by | from | to | amount |
|---|---|---|---|---|
| `mint` | an applied mint (§4.2) | null | the proposer | the credit: `min(amount, mintLimit, remaining)` for an open mint, `amount` defaulting to `mintLimit`; `min(amount, remaining)` for an issuer mint |
| `xfer` | an applied transfer (§4.3) | the proposer | `to` | `amount` |
| `sale` | an applied fill of a token-priced offer (§11) | the buyer | `want.payto` | `want.amount`, the fill's `paid` (§5) |
| `fee` | the same fill | the buyer | the treasury (§10) | the fill's `fee` |
| `fill` | an applied fill of an offer whose give is a token (§4.5, §11, §12) | the seller | the buyer | `give.amount` on a whole fill, the `got` of its `fills` entry on a partial one (§12) |

- A token-priced fill writes its sale, then its fee, then its give. A zero amount writes no move: the sale of a token
  priced at `"0"` (§11) and its fee of 0.
- An offer, a cancel, an `ocancel` and an expiry move tokens between one address's `available` and `locked` and write
  no move; nor does a fill that moves no token (a name sold for CSD), nor any other record. A refused entry carries no
  moves. An entry with no move has no `moves` key, and `moves` is its last key.
- In one result a ticker names one token: the first anchored deploy of a ticker wins and a later one is refused (§4.1),
  and no record removes a token. A replay of another chain, after a reorganisation below the deploy, can bind the
  ticker to another deploy. So a move carries no deploy id; `tokens[ticker].deployId` of the same result gives it.
- The identity the moves meet: for every ticker and address, the amounts the address received less the amounts it
  sent, over every move of the log, equal its `available` plus `locked` in `balances`, an address left out of
  `balances` holding 0; and the mint moves of a ticker sum to its `minted`.
- The log is outside canonical state (§5), so moves change no state hash, and a replica that writes no moves conforms
  at every level of §38. A replica that publishes moves reproduces `test/vectors/moves.json`.

`TokenMove` (`src/types.ts`) is the type; `src/resolve/tokens.ts` and `src/resolve/attest.ts` write the moves.
`test/vectors/moves.json` holds 13 cases (the events, the tip, and the entries that carry moves with their moves, in
log order), every expectation written by hand in `conformance/gen-moves-vectors.mjs`. `conformance/moves-check.mjs`
checks a result's moves against its input events and its state by the rules above, each transfer's and mint's move
against its own record; the cairnx-core tests run it over the replay corpus at
every pinned height and over every case file, and the seal over every input of its differential. The Python reference
of `conformance/` writes no moves.
