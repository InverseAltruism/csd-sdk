# Run a CairnX market maker

CairnX has **no AMM and no escrow** — native CSD can't be pooled (CONVENTION §6). Liquidity is whoever
runs a *maker loop*. This guide is everything you need to join as a market maker, end to end. Anyone
may run one, against any token, with their own key. It builds only on the public package
[`@inversealtruism/cairnx-core`](https://www.npmjs.com/package/@inversealtruism/cairnx-core).

## How the market works (RFQ)

Post-v1.3 the CSD-priced market **is** an RFQ loop (CONVENTION §13/§15):

1. A buyer anchors a **bid** — "I'll pay *N* CSD for *X*" (public, on-chain).
2. A **maker** (you) answers with a **taker-bound offer**: you give *X*, want *N* CSD, `taker` = the
   bidder, tagged `bid: <bidId>`. Only that bidder can fill it — so there is **no same-block fill race**
   and a losing buyer can never forfeit a payment.
3. The bidder **fills** it: one atomic transaction pays you and delivers *X*, or nothing happens.

Open (non-taker-bound) CSD offers are rejected by consensus from v1.3 — that race-safety is *why* making
is RFQ. (v1.7 adds *claim-to-fill* open asks; until then, you answer bids.)

## Why make a market (v1.6 maker rebate)

From **v1.6** (`V16_HEIGHT`), every **bid-answered whole fill** pays the maker a **rebate**, taker-funded,
routed to you (`o.seller`):

```
maker rebate = 0.25 CSD  +  0.5% of the trade value      # flat reimburses your 0.25 CSD posting cost
```

The taker also pays **1.5%** to the protocol treasury (separate). So on a 1 CSD fill you receive the
1 CSD price **+ 0.255 CSD rebate**. Net maker economics:

```
net = Σ rebates earned  −  Σ anchor (propose) fees spent      # 0.25 CSD per offer/cancel you post
```

Each *filled* answer reimburses its own posting cost; the 0.5% margin covers answers that don't fill.
Fund a key once and a healthy market funds itself — that's the whole point of v1.6. Live maker P&L for
the reference bot is published at `/cairnx/mm-health` (and shown on the **Makers** tab at `/trade`).

## Quickstart

```bash
npm i @inversealtruism/cairnx-core @inversealtruism/csd-client
```

**1. Create a dedicated maker key** (never reuse your main key):

```bash
# any CSD wallet/CLI; you need its 32-byte privkey + 20-byte addr20
```

**2. Fund it** with the token inventory you'll sell + a little CSD for anchor fees (0.25 CSD per
quote). The reference bot halts loudly below a configurable CSD float so it never silently fails.

**3. Answer bids.** Each pass: read open bids, compute a robust reference price, and for each bid that
clears `ref + your margin`, anchor a taker-bound offer:

```js
import { offer } from "@inversealtruism/cairnx-core";
import { CsdClient } from "@inversealtruism/csd-client";

const client = new CsdClient({ baseUrl: "https://<node-or-proxy>/api/rpc" });
const bids = await fetch("https://<host>/cairnx/bids?status=open").then(r => r.json());

for (const b of bids) {
  if (!worthAnswering(b)) continue;                 // your pricing: only answer ≥ ref + margin
  const rec = offer({
    give: b.want,                                   // the token/amount the bidder wants
    want: { value: b.give.value },                  // the CSD they offered (or less, to compete)
    taker: b.bidder,                                // bind it to the bidder → race-free
    bid: b.id,                                       // link it (resolvers/UIs + the rebate)
  });
  // anchor `rec.uri` / `rec.payloadHash` as a Propose tx (fee ≥ 0.25 CSD), then submit.
  // when the bidder fills, you receive: price + (0.25 + 0.5%) rebate; treasury gets 1.5%.
}
```

`offer()` returns `{ record, uri, payloadHash }` — the canonical bytes to anchor. Build the Propose tx
with your CSD tx tooling (e.g. `@inversealtruism/csd-tx` `buildPropose`, or the reference
`buildAnchorTx`), sign with your maker key, and submit to the node `/tx/submit`.

## Safety rails the reference bot ships (and you should keep)

- **Robust reference price** — a volume-weighted median over a trailing window, excluding self-fills /
  dust, with a per-pass move clamp and an optional absolute band. A poisoned print can't teleport your
  quotes; a suspicious reference *halts the pass loudly* instead of quoting a bad number.
- **Per-UTC-day anchor budget** — a forced quote/cancel storm runs out of fuel, loudly.
- **Min-float halt** — below a CSD threshold the maker stops and surfaces "underfunded" rather than
  silently failing submits.
- **Short answer expiry + outstanding-answer cap** — a dead maker degrades gracefully; one wave of bids
  can't lock your whole book. Answers expire (consensus-enforced) and release their inventory lock.
- **One anchor per pass, persisted in-flight state** — the substrate has no child-pays-for-parent, so
  never chain a second anchor off an unconfirmed change output; a restart can't double-post.
- **Skip on a stale view** — never act when your indexer trails the node tip.

## Honest limits

- CSD has no liquid USD price; "value" math is in base units. CSD↔token is RFQ (2 signatures over a few
  blocks), never one-click — that's the no-escrow tradeoff, not a bug.
- Competition is on price and latency: answer under the bid, answer first. The only money a *losing*
  maker spends is its own anchor fee — the cost of quoting.
- Self-dealing the rebate is net-negative (you'd still owe the treasury fee + network fee), so it's not
  an exploit.

## Reference

- **Protocol:** [`CONVENTION.md`](https://github.com/InverseAltruism/csd-sdk/blob/master/packages/cairnx/CONVENTION.md) — §13 RFQ, §15 taker-binding, §8/§10 fees, §6 no-escrow.
- **Resolver + record builders:** [`@inversealtruism/cairnx-core`](https://github.com/InverseAltruism/csd-sdk/tree/master/packages/cairnx) (this package) — `offer`, `bid`, `deploy`, `mint`, `parseRecord`, `resolve`, `canonicalState`.
- **Read endpoints:** `/cairnx/bids`, `/cairnx/offers`, `/cairnx/quotes` (indicative ladder), `/cairnx/mm-health` (live maker P&L), `/cairnx/state` (byte-canonical state).
- **Determinism:** the resolver is byte-deterministic and cross-language co-signed (see `conformance/`); two honest resolvers converge — that's the trust model.
