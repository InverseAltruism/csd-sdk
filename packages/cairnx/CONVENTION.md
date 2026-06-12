# CairnX Convention v1

**Status:** DRAFT v1.0 (2026-06-10) · **Domain:** `cairnx:v1` · **Activation height:** 29 860

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

The **first valid fill in apply order wins**. `confidence` is ignored (set 100).

### 4.6 `cancel` — close an offer (an Attest)

`Attest` on the offer with **`score = 0`**, valid only when `attester == seller`. Releases the
lock, closes the offer. (Cancel and fill race in apply order like everything else.)

Other `score` values on CairnX offers are reserved (no-ops); `score = 1` is reserved for a
future claim/exclusivity extension (v1.1).

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
  about. (Claim windows, floated for v1.1, are impossible for the same reason.)
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
| deploy/mint/transfer/offer | Propose | `cairnx:v1` | `uri` = record JSON, `payload_hash` = sha256(uri), `expires_epoch` per §4 | change only |
| fill | Attest | offer proposal id | `score=100, confidence=100` | payment to `want.payto` + change |
| cancel | Attest | offer proposal id | `score=0, confidence=100` | change only |

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
