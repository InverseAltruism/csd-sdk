# Changelog

## 0.2.2

- `verifyFillSpv` fails closed when any id `offerEventIds` returns cannot be proven: `provenEvent` throws,
  returns null, or returns an event under another id. It used to drop that event from the grant replay, so a
  seller cancel whose block read failed replayed the offer as open. New refusal text: "an event on this offer
  could not be merkle-proven (<id>) - refusing, the replay would miss it"; the offer and fclaim keep their
  existing texts. The site's and the wallet's io return only ids they proved, so their honest fills do not move.
- New root export `countOtherHoldsAtGrant(candidates, target, me, closed?)`: the buyer's live holds on other
  offers at an fclaim's grant, the `myLiveHoldsAtGrant` count for `verifyFillSpv`. It counts only fclaims applied
  before the target (height, then position in the block), distinct offers, holds live at the grant height, and
  skips the `closed` set. The site and the wallet counted later fclaims too, so a buyer's fourth reservation
  (denied on the cap) made every earlier granted hold unfillable. An earlier fclaim the resolver denied is still
  counted (an over-count, which only refuses).
- `finalizeWinnerCheck` refuses a supplied `tip` that is not a non-negative safe integer ("the chain tip given
  (<tip>) is not a block height, so the finalize window cannot be checked"). A NaN, Infinity or fractional tip
  used to skip or pass both window comparisons and return safe. An omitted or null tip keeps the winner-only check.
- New root export `provenOfferRefusal(rec, { domain, height, expiresEpoch, seller })`: the admission check for a
  merkle-proven offer Propose. It refuses a domain other than `cairnx:v1` ("not a cairnx:v1 Propose (domain
  "<domain>")") and then returns the resolver's own creation note for every rule that needs no chain state
  (v1.2 shape before activation, the V13 to V17 open CSD offer ban, a treasury payee, an expiry outside the safe
  integer range or already past at the anchor, the V21 to V22 duration cap). `applyOffer` now reads those rules
  from the same function (`offerEnvelopeRefusal` in `src/resolve/market.ts`), in the same order with the same
  notes. The give's backing is chain state and is not checked.
- `bindOfferTerms`'s wantType leg (on by default) also binds a token want's price: for a proven token want the
  served `want.ticker` and `want.amount` must equal the record's, verbatim. `provenOfferTerms` carries them as
  `wantTicker` and `wantAmount`. Before, a token-priced offer served with another ticker or amount passed, and
  each caller (the site, cairn-sdk `preverifyOffer`) compared the price itself. Callers opting out with
  `{ give: false, wantType: false }` keep the earlier verdict.
- `resolve()` and canonical state are byte-identical to 0.2.1.

## 0.2.1

- Internal split, no behaviour change: `src/resolve.ts` keeps the replay loop and dispatches each record to
  handlers in `src/resolve/` (tokens, names, market, attest) over one shared state context. The exported names
  and their types are unchanged, and `resolve()` returns the same state, event log included, for the same input.
  Every consumer may stay on 0.2.0.

## 0.2.0

Breaking for callers that hand-build `ProvenOfferTerms` or rely on the old two-argument verdict; see Migration.

- `bindOfferTerms` checks the give and wantType legs by default. A served offer whose `give` (ticker, amount
  or name) or want type differs from the merkle-proven offer now counts as a mismatch with the two-argument
  call too. To opt out, pass `{ give: false, wantType: false }`: that returns the 0.1.44 two-argument verdict
  on every input. Opting out of one leg leaves the other on.
- Type change: with a leg on, the terms must come from `provenOfferTerms` or `bindProvenOffer` (the
  `MintedProvenOfferTerms` brand). A hand-built `ProvenOfferTerms` compiles only with both legs off (the new
  `LegacyBindOpts` type). At runtime, hand-built terms passed without the opt-out lack the give and wantType
  fields and are refused (the predicate returns `true`).
- Callers that already pass `{ give: true, wantType: true }` with minted terms get the same verdicts as before.
- Depends on csd-codec 0.1.18 (reject-more input canon, see `CONSENSUS_CHANGES.md`); `records.ts` imports
  the codec's well-formed UTF-16 predicate instead of its own copy, with the same verdicts.
- `resolve()` and canonical state are byte-identical to 0.1.44.

Migration. Callers that already pass `{ give: true, wantType: true }` with minted terms need no change (the
site's `swapguard.js`, the wallet's `wallet.ts` and cairn-sdk's `fillverify.ts` production path). These move
together with the 0.2.0 pin:
- cairn-sdk `test/fillverify.test.ts`: the two-argument assertions on hand-built terms expect the old default
  (the inflated give passing); pass `{ give: false, wantType: false }` there or expect the refusal.
- cairn-sdk `src/fillverify.ts`: the result's `terms` field is typed `ProvenOfferTerms`, which drops the mint
  brand, so a dApp passing it back to `bindOfferTerms` without the opt-out no longer compiles; type it
  `MintedProvenOfferTerms`.
- cairn `test/b7a-flip.test.mjs`: its two-argument call asserts the give leg is off; it now refuses.
- cairn-wallet `src/vendor/cairnx-spv.js` and `cairnx-spv.d.ts`: the vendored bundle keeps the 0.1.x
  contract (legs opt-in) until it is re-vendored from 0.2.0.

## 0.1.44

- `rfqFillAllIn(n, feeBps?)` (`cairnx-core/mm`) takes the offer's fee rate; omitted or null keeps
  `FEE_BPS_V16`, so every existing one-argument call returns the same number.
- `epochOf` now lives in `csd-codec` next to `EPOCH_LEN` and is re-exported from the root unchanged.
- New root exports, none read by `resolve()`: `ptAmt` (the resolver's own paidTo amount reader),
  `burnedPayment` (what a refused record paid to the treasury, and for a fill to the offer's seller and payto,
  never counting the payer) and `myProvenFillClosedOffer` (whether a buyer's own merkle-proven full fill closed
  the offer behind one of its fclaim holds, for the V29 cross-offer hold count).
- `resolve()` and canonical state are byte-identical to 0.1.43.

## 0.1.43

- New subpath `@inversealtruism/cairnx-core/mm` (ESM and CJS, built to `dist/mm/`). The root export, the
  resolver and every consensus file are unchanged; `dist/index.*` is byte-identical to 0.1.42.
- `mm` holds the market maker's non-consensus math in one place for the maker service and the site:
  `sizeBid`, `acceptBid`, `tierFor` (bid sizing against the indicative ladder), `tradeNotional` (contractual
  volume of a fill), `expScaled`, `sunriseTimeMult` and `sunriseCurve` (the Sunrise spot curve), and the
  RFQ all-in sums `rfqBuyAllIn` and `rfqFillAllIn`, and `priorBuyers` (the returning-buyer rule: buyers of fills
  of offers the maker sold) (built from `tradeFee`, `makerRebate`, `FEE_BPS_V16` and the
  codec's minimum fees).
- New Sunrise order pricing: `sunriseOrderCost` is the integral of the spot curve over an order, rounded up;
  `sunriseAnswerPrice` adds a flat margin and a per-token floor; `sunriseTokensFor` inverts it for a budget.
  `expm1Scaled` is the fixed-point e^z - 1 behind it (scale 1e18).
