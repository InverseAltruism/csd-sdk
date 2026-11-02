# @inversealtruism/cairnx-core

**CairnX** is the application layer of [Compute Substrate](https://cairn-substrate.com/docs) (CSD): an
on-chain **name service (CNS / `.csd`)**, **tokens**, and **trades** (one transaction pays and records a fill; the replay decides delivery), implemented as a **pure deterministic convention** over the chain's native `Propose`/`Attest`
transactions. No fork, no smart contracts, no custodian. The same trust class as Bitcoin
Ordinals/Runes/BRC-20, stated plainly, and engineered to be byte-for-byte reproducible.

> **First product shipping: CNS, the Cairn Name Service.** `alice.csd` is an on-chain-native, leased,
> tradeable identity. This README leads with how CNS works, then covers tokens and trades.

Live: market **[/trade](https://cairn-substrate.com/trade)** · names **[/names](https://cairn-substrate.com/names)** · explorer **[/explorer](https://cairn-substrate.com/explorer)**
Normative spec: **[`CONVENTION.md`](./CONVENTION.md)** (shipped in this package) · Conformance bar: **[`test/vectors/`](./test/vectors)**

> Diagrams below render on GitHub (Mermaid). The ASCII architecture map renders everywhere.

---

## 1 · The one idea: a pure deterministic overlay

Compute Substrate is a proof-of-work chain that does one thing: it **records** signed `Propose` /
`Attest` transactions and orders them. It does **not** know what a "token" or a "name" is. CairnX gives
those records *meaning* by replaying them through a single pure function:

```
resolve(events, tipHeight)  →  canonical state   (tokens · names · offers · bids · balances)
```

**Determinism is the trust model.** Every honest party that replays the same chain prefix MUST produce
**byte-identical** canonical state. There is no privileged server, your wallet computes the same answer
the operator's resolver does, and disagreement is detectable.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  APP SURFACES        CNS UI (/names)   ·   Market (/trade)   ·   Cairn Wallet  │
│                      Explorer          ·   3rd-party dApps                     │
└───────────────▲───────────────────────────────────────────────▲──────────────┘
                │ read derived state                              │ build + sign records
┌───────────────┴───────────────────────────────────────────────┴──────────────┐
│  cairnX OVERLAY  =  resolve(events, tip) → state   (THIS PACKAGE)               │
│  every replayer runs the SAME pure function and gets the SAME bytes:            │
│     wallet (SPV, in-browser)  ·  reference resolver  ·  clarvis                 │
└───────────────▲────────────────────────────────────────────────────────────────┘
                │ events (Propose/Attest) + block headers
┌───────────────┴────────────────────────────────────────────────────────────────┐
│  COMPUTE SUBSTRATE (base chain)   PoW · records & orders txs · pays every output │
│                                   it mines, enforces expiry - decides NOTHING    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**The safety consequence of "overlay":** CairnX names and tokens have **no native-CSD backing**. A bug,
an over-mint, or even a fully-lying indexer can only fork the *overlay view* of whoever trusts it, it
**cannot move CSD**. CSD moves *only* via real payment outputs in the fill's own transaction. The chain pays them
whenever it mines the transaction; CairnX then decides delivery by replay, and a CSD-paid fill it refuses (an expired
offer, a wrong target, an underpaid leg, a denied reservation) keeps the payment. So a buyer's wallet and the site
check the fill against the offer's merkle-proven terms and the reservation before signing. An overlay bug can
therefore not create or move CSD on its own; it can make a fill a buyer signs deliver nothing, which those checks
exist to refuse.

```mermaid
flowchart TD
  subgraph BASE["Compute Substrate · PoW base chain"]
    TX["Propose / Attest txs<br/>(records live in the uri)"]
  end
  CORE["cairnx-core<br/><b>resolve(events, tip) → state</b><br/>pure · deterministic · this package"]
  W["Cairn Wallet<br/>in-browser SPV replayer"]
  G["reference resolver svc :8794"]
  CL["clarvis · 2nd source"]
  UIN["CNS UI /names"]
  UIT["Market /trade"]
  TX --> CORE
  CORE --> W & G & CL
  G --> UIN & UIT
  W -. "self-verifies, never trusts a server" .-> UIN
```

---

## 2 · CNS, the Cairn Name Service (`.csd`)

CNS is an **ENS-class** namespace native to Compute Substrate. A name like `alice.csd` is owned by an
address, **leased** (not sold forever), points to an address, and carries an optional profile, all as
plain on-chain records, all resolvable by replay.

- **Names are lowercase-ASCII only** (`^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`, 1–32 chars). This kills
  the homograph/confusable phishing class outright, there is no unicode look-alike attack surface.
- **The `.csd` suffix is presentation, not consensus.** The on-chain record stores the *bare* name
  (`alice`); the UI renders `alice.csd`. The CNS rebrand and any display-suffix change are **UI-only**,   they do not touch the resolver or chain history.
- **Reserved names** (`csd`, `treasury`, `admin`, `official`, `root`, `www`, `support`) can never be
  registered, anti-impersonation. The convention's parse rule refuses them (`isName`, `src/records.ts`), so every
  replayer agrees; the chain itself does not read names.

### 2.1 · Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Committed: ncommit · hash(name+salt+owner)
  Committed --> Reserved: name (reveal within 8 blocks, ~16 min) · payment-free reservation
  Reserved --> Active: nfinalize (once the contest froze) · pays the fee, starts a 1-year lease
  Active --> Active: nrenew · nset (point to addr) · nprofile (identity) · nxfer (transfer) · sell (offer/fill)
  Active --> Grace: lease term ends (~1 year)
  Grace --> Active: nrenew · OWNER ONLY, ~30-day window
  Grace --> Lapsed: grace ends un-renewed
  Lapsed --> Active: recapture · anyone re-claims at a DECAYING premium (20x to 1x over ~30 days), fresh lease
  Active --> [*]
```

1. **Commit → Reveal → Finalize (registration, v2.5 sealed reservation, `CONVENTION.md` section 28).** You
   first publish `ncommit`, a hash of `{name, salt, owner}`. Within 8 blocks (~16 min) you publish the `name`
   record revealing the name; the reveal pays nothing and makes a reservation. The resolver **back-dates** it to
   the commit height, so a front-runner who copies your reveal loses the race. Once the displacement contest has
   frozen, the winner publishes `nfinalize`, which pays the fee and starts the lease; a reservation not finalized
   in time lapses. Recapture of a lapsed name runs through the same machinery (v2.6, section 29).
2. **Active lease (~1 year).** You own the name: point it at an address (`nset`), set an identity profile
   (`nprofile`), transfer it (`nxfer`), renew it (`nrenew`), or list it for sale.
3. **Grace (~30 days).** When the term ends, **only the current owner** may renew during a grace window,    your name is never sniped out from under you while you still hold it.
4. **Lapsed → decaying-premium recapture.** If grace passes un-renewed, anyone may re-claim, but at a
   **premium that decays 20× → 1×** over ~30 days (a Dutch auction back to the floor price). This prices
   in genuine demand without a permanent squatting tax, and a recaptured name gets a fresh ownership basis
   so a stale pre-lapse commit can't steal it.

### 2.2 · The records

| Record | What it does |
|---|---|
| `ncommit` | Commit to a name (hash of name+salt+owner), opens the front-run-safe reveal window |
| `name` | Reveal (registration): a payment-free reservation, back-dated to the commit |
| `nfinalize` | Finalize the reservation: pays the registration fee, starts the lease |
| `nrenew` | Extend the lease (owner-only in grace) |
| `nxfer` | Transfer ownership to another address |
| `nset` | Set the forward address record (`alice.csd → 0x…`) |
| `nprofile` | Owner-set identity metadata (ENSIP-5-style keys: avatar, url, com.twitter, …) |

### 2.3 · Parameters

| Parameter | Value | Notes |
|---|---|---|
| Lease term | ~1 year (`NAME_TERM_EPOCHS = 8760`) | 1 epoch ≈ 1 h (30 blocks) |
| Grace window | ~30 days (`NAME_GRACE_EPOCHS = 720`) | owner-only renewal |
| Recapture premium | **20× → 1×** over ~30 days | decaying Dutch auction on lapsed names |
| Reveal window | ~16 min (`REG_COMMIT_MAX_BLOCKS = 8`, v2.5+; was 240 blocks below v2.5) | commit-reveal deadline; doubles as the displacement freeze |
| Registration fee | **15 / 10 / 5 / 3 CSD** by length (≤3 / 4 / 5-9 / ≥10 chars, v2.4) | length-graded (was flat 6.7 / 3 CSD under v1.8); paid to the treasury at finalize (v2.5+) |

### 2.4 · How a name resolves, and what's actually *verified*

This is what makes CNS trust-minimized rather than "ask a server." When the wallet resolves `alice.csd`
to choose a send recipient, it does **not** take the resolver's answer as the address: it SPV-verifies every
relevant record into the proof-of-work chain it built itself, replays them, and sends to the recomputed winner
when the replay proves one. When it cannot prove one, it says so and leaves the decision to the user.

```mermaid
sequenceDiagram
  participant U as User / dApp
  participant Wallet
  participant Sources as Name sources (resolver + 2nd source)
  participant SPV as In-browser SPV (own PoW headers)
  U->>Wallet: send to alice.csd
  Wallet->>Sources: fetch alice's name-history (records + inclusion proofs)
  Sources-->>Wallet: candidate records (UNTRUSTED)
  Wallet->>SPV: merkle-verify each record into the PoW-verified headers
  Note over Wallet,SPV: union of sources: a source can only ADD real,<br/>signer-authenticated, prevout-bound events (never fabricate)
  Wallet->>Wallet: resolve() the verified events to a deterministic owner + addr
  alt the replay proves an address
    Wallet-->>U: verified: send to the proven address (warn if a source stated another)
  else nothing provable, or the sources prove different addresses
    Wallet-->>U: not chain-verified: show the served address with a caution, the user decides
  end
```

- **Forward resolution (`name → address`, the funds path) is SPV-verified, and a disagreement is a warning.**
  The wallet treats the resolver as untrusted, merkle-binds each record to a PoW header and replays. When a
  source states another address than the replay proves, the send goes to the proven address with a "sources
  disagree" warning; when nothing can be proven, the name is shown as not chain-verified, with the served
  address and a caution, and the user decides. Every `.csd` send carries the name-service caution. It refuses
  a name that does not resolve or whose lease lapsed, and at signing it re-checks and refuses an address change
  or a drop from verified to not verified. The wallet's `SECURITY.md` ("What happens when the sources
  disagree") is the full list.
- **Reverse resolution (`address → primary name`, a display label) is server-trusted.** It is never a send
  target, an identity badge only, so it is cheaper and clearly bounded as "unverified label."
- **Ownership has an unambiguous total order:** lowest `(effectiveHeight, position, ordinal-id)` wins, with
  a paid market-fill (`viaFill`) immune to displacement. Exactly one owner per name at every height.

> **Note on bought names:** a name you *register* is fully SPV-verifiable today. A name acquired via a
> *market fill* is displacement-immune and correctly resolved, but its forward resolution currently shows
> a caution rather than a green check (the wallet never shows it as verified) pending a resolver change
> that makes name-fills name-local. Registration, the alpha's primary flow, is unaffected.

---

## 3 · Tokens

Fungible tokens, same overlay model. A `deploy` declares a ticker; `mint` issues supply (capped by the
declared supply and, for open mints, a per-tx limit); `transfer` moves balances; `tmeta` attaches issuer
metadata. Because tokens are an overlay, an over-mint can only inflate *that token's* overlay view, it
can never touch CSD.

| Record | What it does |
|---|---|
| `deploy` | Create a token: `ticker`, `decimals` (0–8), `supply`, `mint: "open" \| "issuer"`, optional `mintLimit` |
| `mint` | Issue supply (≤ declared supply; open mints bounded per-tx by `mintLimit`) |
| `transfer` | Move a balance to another address (optional memo) |
| `tmeta` | Issuer-set token metadata (via the content layer) |

---

## 4 · Trades: one transaction pays and records the fill

Sell a token **or a name** for CSD or another token. The offer locks the give-side in the resolver; the fill is an
`Attest` whose **same transaction carries the payment outputs**, so the chain records the payment and the fill
together, and CairnX decides delivery by replay. A token-for-token fill is atomic: the replay moves both sides or
neither. A CSD-paid fill the replay refuses keeps the payment (a CSD output is final when its transaction mines),
so the buyer's client checks the offer's proven terms, the reservation and the amount before signing
(`verifyFillSpv`, `fillEndorsement`). No escrow, no custodian.

```mermaid
sequenceDiagram
  participant Maker
  participant Chain as Compute Substrate
  participant Taker
  Maker->>Chain: offer { give: alice.csd or token, want: 100 CSD, payto }  (locks the give)
  Note over Chain: an open CSD offer is reserved first (fclaim, v2.8):<br/>only the holder's fill delivers, no race
  Taker->>Chain: fill (Attest) + SAME-TX outputs · 100 CSD to payto, fee to treasury, rebate to maker
  Chain-->>Chain: resolve(): payment satisfies want? deliver give to taker, else no delivery
  Note over Maker,Taker: a refused CSD-paid fill keeps the payment · check before signing
```

Highlights: partial fills (pro-rata, maker-favoring), bids (RFQ buy-side intents), `ocancel` (maker's mass
kill-switch), a 1.5% taker fee + maker rebate on resting liquidity (v1.6), and the reservation lane for open CSD
offers: a short-expiry `fclaim` proposal reserves an untaken offer and the fill attests it (v2.8, `CONVENTION.md`
section 31, which replaced v1.7's claim attest), so two buyers can't race into a refused payment. Listing duration is a **UI policy** (consensus places no cap as of v2.2), long-rester inventory
is bounded in the light client, not the chain.

---

## 5 · How it's built (and why you can trust the replay)

- **One pure fold.** `resolve()` rebuilds *all* state from the event log every call, reorg-safe by
  construction. Integer-only math (BigInt, ceil-rounded fees), one ordinal string comparator, sorted
  iteration at every materialization, **no `Date`/`Math.random`/float in any value path**.
- **A fail-closed parse gate.** `parseRecord` validates every record type with `onlyKeys` allow-lists, a
  recursive well-formed-UTF-16 check, and `Number.isSafeInteger` guards, closing real cross-language
  canonicalization fork classes (astral-decoy keys, lone surrogates, the 2⁵³/`1e21` JSON trap). Invalid
  input is always a no-op, never a throw that poisons replay.
- **Non-retroactive height-gated eras.** Every change activates at a `V*_HEIGHT` and is **byte-identical
  below that gate:** history is never reinterpreted. Relaxations key on the offer's *anchor* height so a
  mixed-version fleet can't fork during a rollout.
- **The determinism contract is *enforced*, not asserted.** An independent Python reference
  (`conformance/cairnx_ref.py`) runs the same corpus and a 1500-iteration JS↔Python differential fuzzer on
  every CI run, plus the language-neutral vectors in `test/vectors/` and pinned live-chain replay hashes.

### Version history (activation heights are consensus-grade, never reinterpret history)

Each row's normative statement is its section of `CONVENTION.md` (v2.5 to v2.9 are sections 28 to 32); the heights
live in `src/types.ts`.

| Version | Height | What |
|---|---|---|
| v1.0 / 1.1 | 29 860 / 29 960 | tokens · **names (CNS)** + protocol fees |
| v1.2 | 30 300 | token⇄token swaps · partial fills · bids (RFQ) · `ocancel` |
| v1.3 / 1.4 | 31 100 / 31 400 | CSD-priced offers taker-bound · fill-before-cancel (a same-block fill beats a cancel) |
| v1.5 | 32 000 | **name leasing** (renew / grace / decaying-premium recapture) · `tmeta` |
| v1.6 | 33 600 | taker fee 1% → 1.5% + maker rebate on resting liquidity |
| v1.7 | 34 000 | claim-to-fill, race-safe open CSD offers (claim attests rejected from v2.8) |
| v1.9 | 36 700 | `nprofile`, ENS-class identity on a name |
| v2.0 | 38 400 | bounded claim grace (the late-fill fix) |
| v1.8 | 40 000 | flat two-tier name fee (6.7 / 3 CSD) |
| v2.1 | 40 100 | offer/bid duration cap (`MAX_OFFER_EPOCHS = 168`), *superseded by v2.2* |
| v2.2 | 41 300 | duration cap **removed from consensus** → UI policy; bound moves to the light client |
| v2.4 | 46 400 | length-graded registration fee (15 / 10 / 5 / 3 CSD by name length) |
| v2.5 | 46 440 | sealed-reservation registration: payment-free reveal, winner-only fee at `nfinalize` |
| v2.6 | 46 480 | sealed-reservation recapture (lapsed-name premium paid by the settled winner only) |
| v2.7 | 46 520 | young-name sale embargo shrinks 240 → 8 blocks |
| v2.3 | 52 000 | `nset` to the zero address CLEARS the pointer |
| v2.8 | 60 000 | `fclaim`: the open-lane reservation becomes a short-expiry proposal the fill attests |
| v2.9 | 88 000 | replay-feed de-duplication; the concurrent-claim cap counts open holds only |

v2.4–v2.7 were re-pinned 2026-07-03 from their originally published heights (49 200 / 51 000 / 51 200 /
52 500); see the re-pin history note in `CONVENTION.md` and `CONSENSUS_CHANGES.md` 0.1.33.

### Package layout

`src/resolve.ts` + `src/resolve/` (the ledger: the replay loop and its per-record handlers) · `src/records.ts` (the parse/validate gate) · `src/types.ts` (constants +
height-gated client selectors) · `src/client.ts` (the claim-burial depth a payer waits for, sized against a minority miner) · `src/preflight.ts`
(build-side helpers every host must compute identically: `requiredFillOutputs`, `previewFill`/`fillIsSafe`,
`buildFeeHeight` + `NAME_FEE_GATES`, `finalizeWinnerCheck`) · `src/primary.ts` (`pickPrimaryName` /
`primaryRankBefore`, the one primary-name selection every host must agree on) · `src/mm/` (the
`@inversealtruism/cairnx-core/mm` subpath: the market maker's bid sizer, fill notional, Sunrise spot curve and
order pricing, and the RFQ all-in sum; not consensus and not part of the root export) · `CONVENTION.md`
(normative spec, §1–§32) · `test/vectors/` (portable conformance corpus).

### Use it

```ts
import { resolve, canonicalState, offer, nameCommit, DOMAIN } from "@inversealtruism/cairnx-core";
import { buildPropose } from "@inversealtruism/csd-tx";

// BUILD a record (e.g. a partially-fillable sell offer, reserved for one buyer, v1.3 RFQ)
const built = offer({ give: { ticker: "CAIRN", amount: "5000000000" },
                      want: { value: "100000000" }, min: "10000000", taker: buyerAddr });

// ANCHOR it (the record IS the uri; outputs in the same tx pay fees and sellers)
const tx = buildPropose({ domain: DOMAIN, uri: built.uri, payloadHash: built.payloadHash,
  expiresEpoch, fee: 25_000_000, utxos, priv });

// RESOLVE the chain (events come from any indexer; see the Scanner reference impl)
const state = resolve(events, tipHeight);
console.log(state.names, state.tokens.CAIRN, state.balances.CAIRN);
```

### Write a conformant resolver in another language

1. Implement `CONVENTION.md` §1–§32 (apply order, every record type, the `V*_HEIGHT` activations (using
   the re-pinned v2.4–v2.7 heights), the canonical-state format, ordinal key ordering, data surface only).
2. Replay `test/vectors/cases.json`, `cases-v29.json` and `cases-rules.json`: your canonical state must equal
   `expectedState` **byte-for-byte**.
3. Replay the live chain and compare `sha256(canonicalState)` against `test/vectors/replay-hashes.json`.

---

## 6 · ★ Single source of truth, change consensus without drift

**This package is the ONE canonical implementation of the CairnX convention.** Every consumer **imports**
its constants / regexes / fee+claim+expiry math / `canonicalJson` / `parseRecord` from here (via npm, or a
*deterministic vendored esbuild* of this exact dist where a browser/MV3 constraint forbids a runtime dep
tree). **Nothing re-declares a consensus value by hand:** a hand-mirror that drifts across a version bump
is a silent chain fork, the exact bug class the shared-core de-dup (`cairn/docs/Plans/46`) deleted.

| Consumer | How it gets consensus | Guard |
|---|---|---|
| **cairnx svc** (`cairnx/`, the live resolver `:8794`) | npm pin → re-export shim | svc replay-hash conformance |
| **cairn /trade + /names UI** (browser) | `public/vendor/cairnx-core.js` (esbuild of this dist) | `vendor-cairnx-parity.test.mjs` + `check-vendor-fresh.mjs` |
| **cairn-wallet** (MV3, fund custody) | `src/vendor/cairnx-spv.js` (esbuild, `export *`) | `test/cairnx.ts` + `check-vendor-fresh.mjs` + `PROVENANCE.json` |
| **the Python oracle** `conformance/cairnx_ref.py` | INDEPENDENT re-implementation (the differential, **KEEP**) | `test:crosslang` (JS⇄Python) |

**To make a consensus change:** edit `src/` here **and** `conformance/cairnx_ref.py`; add a height-gated
`V*_HEIGHT` (never reinterpret history) + a vector; `pnpm build && pnpm test && pnpm test:crosslang`
(all green); **bump the version** (`node scripts/check-lockstep.mjs` fails until you do: it compares the
published tarball of the current version with this build); the npm window (`node scripts/npm-window.mjs`); **rebuild + recommit
the two vendored bundles**; re-pin every consumer and deploy them **between** activation heights, not
across one (below the gate the output is byte-identical, so the rollout is fork-free).

**KEEP-list (verification, not duplication, never collapse):** the Python oracle, the wallet/swapguard SPV
light-client + `namespv.ts`, the wallet `core/csdtx.ts` tx-codec twin, the portable vectors.

---

### Honest limits (read these)

- **Trust-min is operator-shaped today.** Completeness/availability rests on a single indexer and a
  2-source name union whose two defaults share one apex, strong against *fabrication* (every event is
  SPV/signer/prevout-bound), weaker against *withholding* until a genuinely independent second source runs.
  The 2nd-indexer canonical-hash comparator is designed but parked until that exists.
- **`verifyInclusion` (merkle-binding the indexer's decoded outputs) is OFF by default** and is a hard
  prerequisite before any lane treats received CSD as spendable. The overlay model is what keeps the
  names/tokens alpha funds-safe regardless.

MIT · the same trust class as Ordinals/Runes, engineered for byte-for-byte reproducible replay.
