# Changelog

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
