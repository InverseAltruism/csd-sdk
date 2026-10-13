# Changelog

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
