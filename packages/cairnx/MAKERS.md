# Run a CairnX market maker

CairnX has no AMM and no escrow; native CSD cannot be pooled (CONVENTION section 6). Liquidity is whoever runs a
maker loop. This is the one maker guide for the project. Anyone may run a maker, against any token, with their own key.

What is public and what is not:

- Public: the packages [`@inversealtruism/cairnx-core`](https://www.npmjs.com/package/@inversealtruism/cairnx-core)
  (record builders such as `offer`, `bid`, `fclaim`; the resolver; `fillOutputPlan`, `makerRebate`,
  `fclaimEpochFor`; and the `/mm` subpath with the sizing and Sunrise pricing math), `@inversealtruism/csd-tx` and
  `@inversealtruism/csd-client`. A maker loop can be written against these alone.
- Not public: the reference bot (the `src/mm/` directory of the private `cairnx` service repo). This guide
  describes its behaviour and configuration because it is the normative statement of the safety rails, and so
  that another maker can compare or mirror them. Deployment details of the project's own maker are kept in that
  repo, not here.

## Required reading

Sections of [`CONVENTION.md`](https://github.com/InverseAltruism/csd-sdk/blob/master/packages/cairnx/CONVENTION.md):

1. Section 13: bids and the two-step RFQ fulfilment (what you are answering).
2. Section 15: why CSD-priced offers must be taker-bound (the buyer-pays-twice race this removes). Your answers are
   fillable only because they name the bidder as `taker`.
3. Section 16: fill-before-cancel. A same-block fill beats your cancel; you cannot claw back an answer a bidder is
   already filling.
4. Sections 12 and 12b: partial fills (`min`) and `ocancel`, the maker's mass-cancel.
5. Sections 6, 10, 14, 19: the honest limits and the fee tables. A maker pays anchor fees only (0.25 CSD per offer or
   `ocancel` anchor, 0.05 CSD per per-offer cancel). The 1.5% protocol fee (`FEE_BPS_V16 = 150`, section 19) and the
   maker rebate ride the fill transaction and are paid by the taker.
6. Sections 20 and 31: the open-ask claim lane (see "Open asks and the claim lane" below).

## How the market works

Since v1.3 (`V13_HEIGHT = 31,100`) the CSD-priced market is an RFQ loop:

1. A buyer anchors a bid: "I will pay N CSD for X". It is public and non-binding.
2. A maker answers with a taker-bound offer: `give` is X, `want` is N CSD, `taker` is the bidder, and the record
   carries `bid: <bidId>`. Only that bidder can fill it, so there is no same-block fill race and a losing buyer can
   never forfeit a payment.
3. The bidder fills it. One atomic transaction pays the maker and delivers X, or nothing happens.

Open (non-taker-bound) CSD offers are rejected by consensus in `[v1.3, v1.7)`, which is why making is RFQ. From v1.7
(`V17_HEIGHT = 34,000`) open CSD asks are allowed again and are made race-safe a second way; see "Open asks and the
claim lane".

## Maker economics

From v1.6 (`V16_HEIGHT = 33,600`) a whole fill of resting liquidity pays the maker a rebate, funded by the taker and
routed to `offer.seller`:

```
makerRebate(value) = 0.25 CSD + ceil(0.5% of value)       # REBATE_FLAT + REBATE_BPS, cairnx-core
```

Resting liquidity means a taker-bound answer to a bid, or an open ask anchored at or after v1.7. Partial fills and
token-priced fills earn no rebate. The taker also pays the 1.5% treasury fee, separately. On a 1 CSD fill the maker
receives the 1 CSD price plus 0.255 CSD of rebate. Net maker economics:

```
net = sum of rebates earned  -  sum of anchor (propose) fees spent
```

Each filled answer reimburses its own 0.25 CSD posting cost; the 0.5% covers answers that do not fill. The all-in a
buyer pays for a CSD value `n` is `rfqFillAllIn(n, feeBps)` (value, the treasury fee at the offer's `feeBps`, 1.5% when
omitted, rebate and the 0.05 CSD fill attest) and
`rfqBuyAllIn(n)` (that plus the 0.25 CSD propose that anchors the bid); both are exported from `cairnx-core/mm`.
A 2 CSD principal is 2.59 CSD all-in for the buyer.

## The maker loop

Each pass the reference bot does the following:

1. Reference price: compute a robust reference from trade history (see "Reference price hardening"). A suspicious
   reference is clamped into a safe range and alerted on; it never grief-halts the market.
2. Watch open bids: bids where `want.ticker` is your market and `status` is `open`, not yours, not already answered
   (`bid.offers` is empty and there is no in-flight answer of yours), with notional above your dust floor.
3. Answer: anchor a taker-bound offer with `give` equal to the bid's `want`, `want.value` at or under the bid's
   `give.value` (at the bid's price, or under it to outcompete other makers), `taker` the bidder, and `bid` the bid
   id so resolvers and UIs link them. Answer only bids whose unit price clears the reference plus your margin
   (`MM_BID_MARGIN_BPS`).
4. Short answer expiry: a few epochs (`MM_ANSWER_EXPIRY`, default 2; one epoch is 30 blocks, about an hour), capped by
   the bid's own expiry. The anchor locks your inventory, and a bidder who walks away must release it quickly.
   Expiry is consensus-enforced, so a dead maker degrades gracefully. Taker-bound answers cannot be cancelled once
   anchored (V28); expiry is the only exit.
5. Inventory lock accounting: every open answer locks its `give` until fill or expiry. Track outstanding answers (open
   on chain plus in flight, unconfirmed) and cap them (`MM_MAX_BID_ANSWERS`, `MM_LOCK_FRAC`), or one wave of bids locks
   the whole book.

A minimal answer, using only public packages:

```js
import { offer, epochOf } from "@inversealtruism/cairnx-core";
import { buildPropose } from "@inversealtruism/csd-tx";
import { MIN_FEE_PROPOSE } from "@inversealtruism/csd-codec";

// bid: one entry of GET /trade/api/cairnx/bids?status=open on the site, or /cairnx/bids on a resolver
const { record, uri, payloadHash } = offer({
  give: bid.want,                 // the token and amount the bidder wants
  want: { value: bid.give.value },  // the CSD they offered (or less, to compete)
  taker: bid.bidder,              // bind it to the bidder: race-free
  bid: bid.id,                    // link it; resolvers, UIs and the rebate use this
});
const tx = buildPropose({
  domain: "cairnx:v1", payloadHash, uri,
  expiresEpoch: Math.min(epochOf(tip) + 2, bid.expiresEpoch),
  fee: MIN_FEE_PROPOSE, utxos, priv,   // your maker key's confirmed UTXOs; submit with CsdClient
});
```

`offer()` returns the canonical bytes to anchor. `buildPropose` returns `{ ok: false, error }` when the balance cannot
cover the fee, so check `ok` before submitting.

### One anchor per confirmation

The chain has no child-pays-for-parent: do not chain a second anchor off an unconfirmed change output. The reference
bot posts at most one anchor per pass and persists it (`mm-state.json`: txid, kind, tip) so a restart or a lagging
indexer cannot double-post. It skips the pass when the indexer and the node are more than `MM_STALE_BLOCKS` apart in
either direction, or when the indexer's block hash at its tip differs from the node's hash at that height. Never act
on a stale view of the chain.

## Open asks and the claim lane

A maker may also keep open (non-taker) CSD asks on the book. Anyone can buy one, but a fill is gated on a prior claim
that reserves the offer for the first claimer, so two buyers never race a payment (CONVENTION sections 20 and 31).

- Before V28 (`V28_HEIGHT = 60,000`) a claim was a payment-free `Attest` with `score = SCORE_CLAIM (50)`. At or after
  V28 that form is rejected.
- From V28 a claim is an `fclaim` record carried by a short-expiry `Propose` (0.25 CSD), and the fill is an `Attest`
  (score 100) on the claim's txid, so L0's own expiry rules enforce the hold deadline. A client requests
  `E = fclaimEpochFor(tip, offer.expiresEpoch)`, which gives a hold of 46 to 75 blocks (about 1.5 to 2.5 hours at
  2 minute blocks). The consensus bound on a hold is 89 blocks.
- An address holds at most `MAX_ACTIVE_CLAIMS` (3) live claims and cannot re-grab a just-lapsed offer for
  `CLAIM_COOLDOWN_BLOCKS` (15).
- The maker rebate extends to open-ask fills, so an open ask filled in full pays the same `0.25 CSD + 0.5%`.

Buyer safety, which a maker should also understand: a fill on an open offer the buyer does not hold a live claim on is
rejected as a fill by consensus, but its payment outputs are still spent. Buyer software must claim, wait for the claim
to bury to a value-scaled depth (`requiredClaimDepth`), and only then fill. Size the fill outputs with
`fillOutputPlan(offer, pay)` and gate on `kind === "csd-outputs"` (`requiredFillOutputs` and `fillIsSafe` are
deprecated and behaviour-frozen). Taker-bound offers need no claim.

### Optional: a thin resting ask ladder (`MM_LADDER_LEVELS`, default off)

The RFQ loop answers demand: a buyer must post a bid and wait. For a "there is always a price" book, a maker can keep a
thin set of standing open asks using the claim lane. The reference bot posts them as whole-fill offers (no `min`) so
each earns the rebate that reimburses its 0.25 CSD anchor. Configure with `MM_LADDER_LEVELS='[[spreadBps,size],...]'`
(for example `[[200,10],[800,25],[2000,50]]`); empty means pure RFQ. The bot keeps both lanes: the RFQ answer is the
cheaper path for a taker, and the ladder keeps the book from being empty. Keep it to single-digit levels
(`MM_LADDER_MAX_OPEN`, default 4): standing offers are what the resolver has to track, and a thin ladder is enough.

Two rules the reference bot enforces, and any ladder implementation must follow:

1. Never cancel a claim-held rung. A cancel is beaten only by a same-block fill (section 16); a fill mining one block
   after your cancel is rejected after the buyer's payment has settled to you, which is a buyer burn you must never
   create. The bot refuses to cancel any rung a live hold covers (hold end plus grace plus a 2-block indexer-lag
   margin) and waits it out. Rungs are refreshed with per-offer cancels (a 0.05 CSD attest), never a blanket 0.25 CSD
   `ocancel`, which would also kill your live RFQ answers.
2. Price the free option. A claim gives the buyer a free option of at least about 90 minutes to fill at the rung price. On a
   volatile token a claimer can wait out the window and fill only if the market moves past your rung, which is
   stale-quote pickoff. Set spreads at least about twice the token's typical 90-minute move and keep the tight rung
   small. Treat repeated claim-then-lapse as a signal to widen. This is priced, not prevented.

A griefer can claim-lock a ladder cheaply (about 0.25 CSD per rung per hold, three claims per address, addresses are
free). The consequence is degraded discoverability only, with no fund loss, and taker-bound RFQ answers cannot be
claimed at all, so demand still clears.

## How multiple makers compete

Taker-bound answers are race-free by construction: the resolver rejects any fill by a non-taker, so two makers
answering the same bid cannot burn a buyer. The bidder fills the best answer, and the losers' anchors expire and
release their locks. Competition is on price (answer under the bid) and latency (answer first within a poll). The only
money a losing maker spends is its own anchor fee, the cost of quoting. Do not re-answer a bid already answered at or
below the price you would quote (check `bid.offers`): it is a wasted anchor.

## Reference price hardening

A "last trade print" reference is attacker-settable for one anchor fee: self-fill at an arbitrary unit price, then
harvest the mispriced quotes. The reference implementation (`robustRef` in `src/mm/lib.ts`) uses instead:

- A volume-weighted median over a trailing window (`MM_REF_WINDOW`, default 720 blocks, about a day). Weight is CSD
  paid, so many dust prints do not move it.
- Exclusions: self-fills (buyer equals seller), sub-notional trades (`MM_MIN_TRADE`), and your own buys. Your asks
  being lifted by others is genuine demand and counts.
- A per-buyer weight cap (`MM_MAX_BUYER_SHARE_BPS`, default 5000) so no single buyer's volume dominates.
- A buyer-diversity guard (`MM_MIN_REF_BUYERS`, default 3): the reference will not ratchet up unless at least this many
  distinct buyers traded in the window. Two addresses meet a value of 2, so keep it at 3 or more. This is not Sybil
  resistance: distinct addresses are not independent people.
- A move clamp (`MM_REF_CLAMP_BPS`, default 2000): one step when a new or changed qualifying print is admitted, at most
  once per `MM_REF_CLAMP_BLOCKS` (default 30). Prints that only leave the window do not move the reference, and
  repeating the same tape on a 30 second poll does not walk the price. A stored reference with no saved tape id adopts
  the current tape as its baseline and does not move on adoption.
- An absolute band (`MM_BAND_LO`, `MM_BAND_HI`), strongly recommended: it is the only hard cap on manipulation. Without
  it, a wash using at least `MM_MIN_REF_BUYERS` addresses can still move the quote by one clamp step each time the tape
  changes and the block window has elapsed. The bot warns at startup when no band is set.
- Clamp and alert, never grief-halt: a median at or below the floor, a band breach or low buyer diversity clamps the
  reference into a quotable range and logs an alert. Halting was itself griefable, since one at-floor wash could stop
  the market.

Paired rails: a per-UTC-day budget for fees that bought nothing back (`MM_FEE_BUDGET`; a quote or cancel storm runs
out of fuel), a minimum CSD float (`MM_MIN_FLOAT`, `MM_MIN_FLOAT_HARD`) so the maker surfaces "underfunded" instead of
failing submits silently, and a drift debounce (`MM_DRIFT_BPS` for `MM_DRIFT_PASSES` consecutive passes) before the
ladder refreshes.

## Key isolation

Run the maker on a dedicated key (`MM_KEY_FILE`), funded with the token inventory you are willing to sell plus CSD for
anchor fees. Never point it at an operator, treasury or personal key: the bot signs autonomously about every 30
seconds, so a bug, a poisoned reference or a compromised host is bounded to the maker key's balance. The state file is
written with mode 0600; the quotes and health files are public market data (0644) by design. The bot warns at startup
if `MM_KEY_FILE` is left at its default.

## Running the reference bot

The reference bot reads its configuration from `MM_*` environment variables, or from a JSON file named by `MM_CONFIG`
with the same keys. Precedence is environment, then file, then default. `MM_DRY=1` builds every transaction and
submits and writes nothing. The resolver runs in process: the bot scans the indexer feed and replays it canonically, so
it trusts a remote indexer's raw events but never its prices. Merkle inclusion verification of the feed is off by
default.

### Configuration reference

Amounts named "base" are base units (CSD has 8 decimals). Defaults are those of `loadConfig` in `src/mm/config.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `CSD_RPC` | `http://127.0.0.1:8789` | Node RPC for UTXOs, tip and submit. Run your own node; the public proxy rate-limits. |
| `CSD_INDEXER` | `http://127.0.0.1:8793` | Indexer event feed. The public read feed is `https://cairn-substrate.com/explorer/api`. |
| `CSD_RPC_SECONDARY` | unset (off) | Opt-in dual-submit to a co-located miner mempool, for faster inclusion. |
| `MM_CONFIG` | unset | Path of a JSON file with the same `MM_*` keys. |
| `MM_KEY_FILE` | `~/.config/cairn/key.json` | The maker key. Always set a dedicated one. |
| `MM_STATE`, `MM_QUOTES`, `MM_HEALTH` | `~/.config/cairn/mm-state.json`, `mm-quotes.json`, `mm-health.json` | Persistent state, indicative-quote export, health export. `~` is expanded. Set `MM_STATE` yourself when one machine runs two makers. |
| `MM_TICKER` | `CAIRN` | The market. |
| `MM_FLOOR` | `1000000` | Base CSD per display unit; never quote below. |
| `MM_LEVELS` | `[[0,50],[2500,100],[6000,200]]` | `[spreadBps, size]` RFQ indicative tiers. In Sunrise only the sizes are read. |
| `MM_LEVELS_FRAC` | `[[0,100],[2500,1000],[6000,2000]]` | Inventory-fraction ask tiers in bps of remaining inventory (1%, 10%, 20%), so a large seed is not a toy book. `[]` falls back to `MM_LEVELS`. |
| `MM_LADDER_LEVELS` | `[]` (off) | The resting ask ladder. |
| `MM_LADDER_EXPIRY`, `MM_LADDER_MAX_OPEN` | `8`, `4` | Rung expiry in epochs (must exceed the hold; a value below 4 is raised to 4) and cap on standing rungs. |
| `MM_MIN_FILL` | `5000000` | Partial-fill floor in base CSD (pre-v1.3 ladder offers). |
| `MM_EXPIRY`, `MM_ANSWER_EXPIRY` | `48`, `2` | Pre-v1.3 ladder and bid-answer expiry, in epochs. |
| `MM_POLL_MS` | `30000` | Pass interval; a bid should be answered in about 30 seconds. At least 1000. |
| `MM_REF_WINDOW`, `MM_MIN_TRADE` | `720`, `50000000` | Reference window in blocks and trade-notional floor in base CSD. |
| `MM_MIN_REF_BUYERS`, `MM_MAX_BUYER_SHARE_BPS` | `3`, `5000` | Distinct buyers required before an upward move; per-buyer weight cap. |
| `MM_REF_CLAMP_BPS`, `MM_REF_CLAMP_BLOCKS` | `2000`, `30` | One clamp step per admitted print, at most once per this many blocks. |
| `MM_BAND_LO`, `MM_BAND_HI` | unset | Absolute price band in base CSD per display unit. Set both. |
| `MM_DRIFT_BPS`, `MM_DRIFT_PASSES` | `1500`, `2` | Drift threshold and debounce. The ask ladder refreshes after the reference stays moved by more than `MM_DRIFT_BPS` for `MM_DRIFT_PASSES` consecutive passes; an own bid is cancelled after its price stays off target by more than `MM_DRIFT_BPS` for `MM_DRIFT_PASSES` blocks. |
| `MM_FEE_BUDGET` | `1000000000` | Base CSD per UTC day of fees that bought nothing back. Live and filled answers are not counted; answers that expired unfilled are. Past half of it, addresses with no prior fill on CairnX are answered only for bids of at least `MM_FRESH_MIN_CSD` (reason `budget-fresh-min`); past all of it the bot posts nothing of its own and answers returning buyers only (`budget-returning-only`). Answers to returning buyers are bounded by `MM_MAX_BID_ANSWERS` and `MM_MIN_FLOAT_HARD`, not by this budget. |
| `MM_FRESH_MIN_CSD`, `MM_FRESH_SLOTS` | `2000000000`, `16` | A bid below the minimum from an address with no prior fill is "fresh small" (in Sunrise the answer price is compared, not the bid). Such answers hold at most `MM_FRESH_SLOTS` of the `MM_MAX_BID_ANSWERS` slots (reason `fresh-slots`). |
| `MM_BID_MIN`, `MM_BID_MARGIN_BPS`, `MM_MAX_BID_ANSWERS` | `200000000`, `200`, `24` | Bid dust floor (2 CSD), accept margin over the reference, and outstanding-answer cap. |
| `MM_LOCK_FRAC` | `2500` | Token locked in open answers is at most this many bps of inventory. |
| `MM_DAY_SELL_CAIRN`, `MM_DAY_SELL_CSD` | `3000000000000`, `50000000000` | Daily sell caps in base units (30,000 CAIRN at 8 decimals, 500 CSD): today's fills plus live answers. In Sunrise an answer whose taker can no longer pay for it is not reserved against them; `MM_LOCK_FRAC`, inventory and `MM_SUNRISE_E` still count every live answer. |
| `MM_EXCLUDE_ADDRS` | the CairnX treasury address | Comma list; excluded from the reference, from answers and from fills. |
| `MM_BID_SPREAD_BPS`, `MM_BID_SIZE`, `MM_MAX_OPEN_BIDS` | `800`, `2000000000`, `2` | Thin bid side (Reservoir only). The bid reference is collared at the ask reference so the book cannot cross. `MM_MAX_OPEN_BIDS=0` stops new posts only, not fills of existing bids. |
| `MM_BID_LEVELS` | `[]` | `[[spreadBps, sizeCsd],...]`; empty means a single `MM_BID_SPREAD_BPS` bid. |
| `MM_FILL_BIDS` | `1` | `0` stops fills of answers to the maker's bids and new bid posts; cancels still run. The buy side runs only in the Reservoir: the Sunrise posts no bids. Must be 0 or 1. |
| `MM_DAY_BUY_CSD`, `MM_BID_EXPIRY` | `10000000000`, `24` | An absolute ceiling on the day's bid-side CSD (100 CSD); the buy-back guards below set the working limit. Bid life in epochs; bids are cancellable. |
| `MM_BUY_SALE_BPS` | `1000` | All-in buybacks over the trailing 7 days at most this share of the maker's 7-day sale proceeds. No recent sales, no buying. |
| `MM_BUY_LIFE_BPS` | `500` | Buybacks since the start tip at most this share of the sale proceeds since then. |
| `MM_BUY_SINCE_TIP` | `0` | Lifetime window start; a later Sunrise start recorded in state wins. Set it to the Sunrise start tip so a lost state file cannot widen the window. |
| `MM_BUY_SELLER_BPS` | `2000` | One seller at most this share of the trailing day's buy budget (the day's buybacks plus the room left, capped by `MM_DAY_BUY_CSD`). A bid only one seller can answer must fit it, so with `MM_DAY_BUY_CSD` 100 CSD a 20 CSD bid (20.70 CSD all-in) is never posted. |
| `MM_BUY_BID_CAP_BPS` | `8500` | A bid at most this share of the lower of the 7-day volume-weighted sale price and the graduated floor. |
| `MM_BUY_RESALE_BPS` | `11000` | The ask at least this share of the 7-day all-in average buy cost. Below 10000 is refused. |
| `MM_BUY_STOP_BPS` | `1000` | No buying past this share of the graduation inventory (the maker's available CAIRN at the graduation pass). |
| `MM_BUY_PAUSE_BPS` | `7000` | Pause line, as a share of the graduated floor (see below). |
| `MM_BUY_PAUSE_PARTIES`, `MM_BUY_PAUSE_MIN_CSD` | `3`, `2000000000` | The prints below the pause line must come from this many distinct addresses and sum to this much CSD. |
| `MM_VERIFY_INCLUSION` | `0` | 1 checks each indexer transaction against the maker's own node. Records younger than 12 blocks are deferred to a later pass, so the maker sees new records about 12 blocks late; `MM_INFLIGHT_TTL` grows by 12 blocks so a held-back post is not signed again, an answer holds its quota and capacity until its last epoch is final (one that expired unfilled frees it 12 blocks after expiry), and a buyer's bid is answered only once it is final with 2 epochs left; a record the node cannot prove fails the pass. It binds each record's outputs, position, height and own fields (proposer, uri, payload hash, expiry and domain; attester, score, confidence and target proposal) to the node's raw transaction, and an indexer row that disagrees fails the pass. The proposer or attester is the key whose signature in the first input verifies over the transaction's sighash, and a body without one fails the pass; this costs about 2.2 ms per record, cached until a reorg clears the cache (cold scan of 2,000 records on the test harness). The node supplies the headers, the tip and the bodies, and the maker checks no PoW and holds no UTXO set, so it cannot check that the signing key owns input 0's coin (a lying node could re-sign input 0 with its own key); the indexer can still withhold or delay records. A record with an expiry past 2^53 is parsed exactly and rejected per record, as with the flag off. Before turning it on in production, run one read-only flag-on scan against the live indexer and node and expect 0 field mismatches. |
| `MM_INV_LO` | `4000000000000` | Skip new sells when inventory is below this, in base units. Set it to 20% of `MM_SEED_INVENTORY` in base units (display units times 1e8 for an 8-decimal token): a 1M seed gives 200k, a 21M seed gives 4.2M. |
| `MM_STALE_BLOCKS`, `MM_INFLIGHT_TTL` | `2`, `24` | Indexer-lag skip threshold; blocks an unconfirmed post stays "covering". |
| `MM_SKEW_WINDOW`, `MM_SKEW_K_BPS`, `MM_SKEW_MAX_BPS`, `MM_SKEW_MAX_DN_BPS` | `720`, `200`, `10000`, `2000` | Flow skew of the ask: net tokens sold over the window (blocks) scaled by `k` against inventory, capped upward and, more tightly, downward so buying inventory back cannot sag the ask. |
| `MM_DRY` | off | `1` builds everything, submits nothing, writes nothing, logs what would post. |
| `MM_MODE` | `reservoir` | `reservoir` or `sunrise`. |
| `MM_SEED_INVENTORY`, `MM_SEED_CSD`, `MM_REFILL_BELOW_BPS` | `197000`, `13700000000`, `2500` | Reservoir well denominator (display units); informational CSD buffer (base); raise `refillDue` when remaining inventory is below this many bps of seed. Refill coin, never CSD. |
| `MM_MIN_FLOAT`, `MM_MIN_FLOAT_HARD` | `2500000000`, `500000000` | Below `MM_MIN_FLOAT` (25 CSD) bids pause and answers continue; below the hard value (5 CSD) the bot halts. Do not top up CSD: sells replenish it. |
| `MM_SUNRISE_P0`, `MM_SUNRISE_RATE_BPS`, `MM_SUNRISE_K_SCALED`, `MM_SUNRISE_CAP_MULT` | `500000`, `2`, `1098612`, `8` | Sunrise curve: start price in base CSD per display unit, per-epoch time growth in bps, the curve steepness scaled by 1e6 (default `ln 3`), and the price cap as a multiple of P0. |
| `MM_SUNRISE_E`, `MM_SUNRISE_DAY_QUOTA`, `MM_SUNRISE_MAX_EPOCHS` | `100000`, `5000`, `2160` | Scheduled emission (display units), per-UTC-day quota with no accrual, and the epoch cap after which the schedule graduates. |
| `MM_SUNRISE_MAX_ORDER` | `60000` | Largest single Sunrise answer in display units; the day quota caps it too. Published as `sunrise.maxOrder` in base units. |
| `MM_SUNRISE_BID_BUFFER_BPS` | `200` | Buffer a Swap UI adds to a Sunrise bid above the rung; the answer asks the maker's price, so this is the buyer's tolerance. At most 2000. |
| `MM_SUNRISE_TARGET_DEPTH_BPS` | `500` | Part of the float target behind `sunrise.skimmable`: this many bps of the remaining Sunrise value. |
| `MM_ISSUER_ADDR`, `MM_SKIM_LEDGER` | empty, `~/.config/cairn/mm-skim.jsonl` | Skim destination and ledger. The bot never sends CSD itself; see "Skimming CSD". |

`MM_SUNRISE_PRICE_LOCK_BLOCKS` and `MM_SUNRISE_PRICE_LOCK_LOOKBACK` are not read any more.

## Reservoir and Sunrise

The bot has two operating modes. Reservoir is the default: a fixed coin inventory plus a CSD float. The token page draws
a well (remaining over seed). When the well is thin, send the bot more coin, not CSD: sells already pay the ask plus the
maker rebate (buyer to seller, never protocol revenue). Bids pause first when the float is light so answering never
starves.

Sunrise is a published emission schedule for a fresh launch. The curve starts at `MM_SUNRISE_P0`, below the eventual
reservoir floor. None of it is chain consensus; it lives in local state and in the published quotes file.

The sale clock counts distinct chain epochs that contain a mined sale by this maker since `startTip`. The same sale list
gives the same count whether the maker watched each epoch or caught up later. Several fills in one epoch count once,
a sale in the launch epoch counts, quiet epochs and buybacks do not. `pricedEpochs` is a high-water of that count: a
reorg that drops a sale does not reduce a stored clock. `q`, the tokens sold, is high-water marked separately, and so is
the curve. The price the bot quotes and requires uses `q` plus the tokens in its live answers whose takers can still
pay, so answers to bids that race each other are priced one after another; the stored high-water is kept on the
sold-only price, so an answer that expires unfilled does not raise it. In Sunrise the quote reference is the curve; the
tape does not enter it. Empty windows hold the tape `lastRef` but not the executable ask, because Reservoir flow skew
expires on its own. A day quota does not accrue.

### Buy-back guards

The buy side runs only once the quote mode is `reservoir`. Amounts are base units; shares are bps. The keys are in
the configuration reference above (`MM_BUY_*`, `MM_VERIFY_INCLUSION`).

`MM_DAY_BUY_CSD` stays as an absolute ceiling, and every window uses `MM_REF_WINDOW` (720 blocks) as its day.

The pause: new maker bids stop while the filtered tape (the reference's `qualifyTrades` prints over one `MM_REF_WINDOW`,
per-buyer capped median) is below 70% of the floor, and for one tape window after it last was. One burst of low prints
stays in the window for a day and the pause runs a day past that, so up to about 2 days. It stops only new maker bids:
bids already posted stay fillable and the sell side is untouched. Its floor is not sybil resistance: three addresses
washing 20 CSD between themselves in two prints trigger it for about 1.4 CSD (two bids, two answers, two fill attests,
and the 1.5% fee on 20 CSD).

Each pass publishes these limits under `reservoir.buyBack` in the quotes file, including `boughtBack` with
`retired: false` (bought-back CAIRN is held for resale).

### Sunrise pricing

`sunrise.pricing` is `"integral-v1"`. An answer for `n` tokens asks `sunriseAnswerPrice` from
`@inversealtruism/cairnx-core/mm`: the integral of the curve from `q` to `q + n`, times `1 + MM_BID_MARGIN_BPS`, and
never less than that margin over the curve high-water (or `MM_SUNRISE_P0`) per token. The quotes file publishes the
inputs (`sunrise.qBase` in base units, `sunrise.pricedEpochs`, `sunrise.curveHighWater`), so anyone can recompute the
price. There are no size tiers: an order pays the curve's rise across its own size. `sunriseOrderCost`,
`sunriseCurve`, `sunriseTokensFor` and `expScaled` are exported from the same subpath.

The bid is a ceiling. The bot answers a bid when its CSD is at least the price, and the answer asks exactly the price
(`want.value`), so a bid that carries the Swap buffer pays less than it bid. A bid below the price is skipped as
`below-margin`. The solvency check (price plus the 1.5% fee, the maker fee and the fill attest) and the day-sell CSD
limits read the answer price. The fresh-address minimum (`MM_FRESH_MIN_CSD`) also reads the maker's price, not the bid;
otherwise a fresh address could declare 20 CSD, pay about 1 CSD and skip the fresh-slot limits. A signed answer not yet
on chain counts at the price it asks. One answer is at most `MM_SUNRISE_MAX_ORDER` tokens and at most the day quota; a
larger bid is `above-top-tier`. The cap bounds how far one answered but never filled bid lifts other buyers' prices while
it is live.

The tape reference does not enter the Sunrise price; it is published as `tapeRef` and still prices the Reservoir. A wider
`MM_BAND_LO`/`MM_BAND_HI` therefore cannot let wash prints lift the Sunrise ask. `levels` in the quotes file stays for
older clients: rung sizes come from `MM_LEVELS` cut at the order cap, `totalCsd` is the answer price of `size` tokens,
`pricePerUnit` is that per whole token rounded up, and `bps` is the rung's premium over `curvePrice`. The per-token price
rises with order size, so a bid sized on a rung with the Swap buffer clears the price of any smaller order. There is no
price lock; the bid buffer covers the sale clock moving between sizing and answer, and concurrent answers.

The Sunrise is sell-only. While `mode` in the quotes file is `sunrise` the bot posts no bids and fills no answers to its
own bids, whatever `MM_FILL_BIDS` says; existing own bids are still cancelled when they cross the ask or drift. The
quotes file then carries `bids: []`, `bidSpreadBps: null`, `bidReason: "sell-only"` and `availability.fillsEnabled:
false`. `feeRecovery.soldCairnLifetime` and `soldCsdLifetime` count every sale by this key since launch, not just the
Sunrise (`sunrise.emitted` is the Sunrise figure).

### Launch outcomes

Graduation uses one latch. When completed sales `q` reach `MM_SUNRISE_E`, or the chain epoch reaches `startEpoch +
MM_SUNRISE_MAX_EPOCHS`, the bot stores `graduatedFloor` as the curve at that moment and then quotes with
`max(graduatedFloor, MM_FLOOR)`. Flipping `MM_MODE` does not roll a latched `graduatedFloor` back; set `MM_FLOOR` to it
if that is the floor you want. Graduation is not a claim that the market is liquid. Three outcomes:

- Sold out: `q` has reached `E`. The curve at that quantity is the latched floor, and `MM_FLOOR` still applies when it is
  higher. `q` counts completed maker sales, while the daily quota counts commitments, and an unused quota unit does not
  carry into the next UTC day. The defaults (`E` 100,000, quota 5,000) need at least 20 days in which every quota unit is
  reserved and then sold. Treat `E` as a gross-sale budget for the launch, and as a lifetime issuance cap only if the
  launch note says so. Compare `E` with the seed inventory and the coin the desk will keep (`MM_INV_LO` defaults to 20% of
  the seed): a desk that holds exactly `E` and keeps that 20% can sell all of `E` only after more coin arrives. After
  graduation Reservoir sells what remains under Reservoir rules; write down whether later sales sit inside the original
  `E` or come from a later inventory decision.
- Timed out with sales: the epoch cap arrived, `q` is above zero and below `E`. The latched curve is the floor, raised to
  `MM_FLOOR` when the curve is lower. Say the schedule ended; the floor is the issuer's minimum ask after it.
- Timed out without sales: the epoch cap arrived and `q` is zero. The curve stays at `MM_SUNRISE_P0`. With the defaults
  that is 0.005 CSD per display unit while `MM_FLOOR` is 0.01, so the Reservoir floor steps from 0.005 to 0.01. That step
  is the current rule; keeping the floor at 0.005 after a quiet timeout would be a separate product decision with its own
  published migration. The bot does not clear `lastRef` or reinterpret a stored high-water.

### Skimming CSD

Excess CSD is moved out with an operator script (`scripts/mm-skim.mjs` in the reference repo). `--dry` is the default and
`--live` submits. It refuses amounts above the quotes file's `sunrise.skimmable`: the float above a target of `MM_SUNRISE_TARGET_DEPTH_BPS` of the remaining Sunrise value plus 30 days of `MM_FEE_BUDGET`, never less than twice `MM_MIN_FLOAT`, and only when the float exceeds 1.5 times that target. The
ledger is `MM_SKIM_LEDGER` (mode 600).

## Honest limits

- CSD has no liquid USD price; value math is in base units. CSD to token is RFQ (two signatures over a few blocks), never
  one click. That is the no-escrow tradeoff, not a bug.
- Competition is on price and latency: answer under the bid, answer first. The only money a losing maker spends is its own
  anchor fee.
- Self-dealing the rebate is net-negative: you still owe the treasury fee and the network fee.
- Distinct buyer addresses are not independent people; the buyer-diversity guard only blocks an upward seed or ratchet.

## Multi-maker quote discovery (design note, not implemented)

Today a resolver's `/cairnx/quotes` serves one maker's indicative file. With several makers, discovery would be: each
maker self-publishes, the chain advertises where, aggregators merge.

1. Each maker publishes a signed indicative-quote JSON at an HTTPS URL it controls (the bot's `MM_QUOTES` export plus an
   identity and a signature):

```json
{
  "v": 2, "ticker": "CAIRN", "maker": "0x<addr20>",
  "updatedAt": 1765500000000, "pollMs": 30000,
  "marginBps": 100, "minBidCsd": "50000000", "answerCap": 3,
  "ref": "1000000", "decimals": 2,
  "levels": [{ "bps": 0, "size": "50", "pricePerUnit": "1010000", "totalCsd": "50500000" }],
  "inventory": "350", "halted": null,
  "sig": "0x<65B recoverable secp256k1 over sha256(canonical JSON, keys sorted, sig omitted)>"
}
```

   `sig` recovers to `maker` (the same csd-crypto scheme as anchors), so quotes are self-certifying and the hosting URL is
   not trusted. Quotes are indicative only; the binding act is the on-chain taker-bound answer, so a lying quote file costs
   its maker reputation, never a counterparty's funds.
2. The URL is advertised on chain through a new cairnx record `{"v":1,"t":"maker","url":"https://..."}`, which would
   need a convention revision.
3. Aggregators fetch every advertised URL, verify `sig` against the advertised maker, drop stale quotes (older than about
   three poll intervals) and halted makers, keep the latest per maker, and merge the book by best `pricePerUnit` per size
   tier with attribution.

## Reference

- Protocol: [`CONVENTION.md`](https://github.com/InverseAltruism/csd-sdk/blob/master/packages/cairnx/CONVENTION.md);
  sections 13, 15, 16 (RFQ and taker binding), 19 (fee and rebate), 20 and 31 (claims), 6 (no escrow).
- Resolver and record builders: [`@inversealtruism/cairnx-core`](https://github.com/InverseAltruism/csd-sdk/tree/master/packages/cairnx):
  `offer`, `bid`, `fclaim`, `deploy`, `mint`, `parseRecord`, `resolve`, `canonicalState`, and `cairnx-core/mm`.
- Read endpoints on a resolver (on the site under `/trade/api/cairnx/`): `/cairnx/bids`, `/cairnx/offers`,
  `/cairnx/quotes` (the maker's indicative file), `/cairnx/mm-health` (live maker status) and `/cairnx/state`
  (byte-canonical state).
- Determinism: the resolver is byte-deterministic and cross-language co-signed (see `conformance/`); two honest resolvers
  converge, and that is the trust model.
