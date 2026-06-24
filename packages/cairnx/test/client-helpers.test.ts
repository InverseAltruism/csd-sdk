// Phase 0.5 (shared-core de-dup): the pure client selectors lifted into cairnx-core (claimWindowAt,
// claimGraceOf, claimWindowOf, offerExpiryHeightOf) MUST agree with what the resolver actually does —
// otherwise the UI/wallet that now import them would gate differently from the chain. The dangerous one is
// offerExpiryHeightOf: it is a CLOSED FORM, while the resolver expires offers via an epoch-based
// effExpiry + sweepExpired. This test pins their equivalence by driving the REAL resolver: for a grid of
// (anchorHeight, expiresEpoch) it asserts the offer is "open" at offerExpiryHeightOf(...) − 1 and
// "expired" at offerExpiryHeightOf(...) — i.e. the helper returns the exact first sweep height. It also
// sanity-checks claimWindowAt / claimGraceOf / claimWindowOf against a real claim grant.
import assert from "node:assert/strict";
import {
  resolve,
  offer,
  deploy,
  mint,
  offerExpiryHeightOf,
  claimWindowAt,
  claimGraceOf,
  claimWindowOf,
  epochOf,
  V20_HEIGHT,
  V21_HEIGHT,
  MAX_OFFER_EPOCHS,
  TREASURY_ADDR,
  SCORE_CLAIM,
} from "../src/index.js";

let nextId = 1;
const nid = () => "0x" + (nextId++).toString(16).padStart(64, "0");
const D = "0x" + "d0".repeat(20);
const BUYER = "0x" + "b0".repeat(20);

// deploy → mint → an OPEN (taker-optional) CSD-priced token offer at `offH` with explicit raw `expEpoch`.
function offerAt(offH: number, expEpoch: number) {
  const T = "TKN";
  const ev: any[] = [];
  const P = (b: any, h: number, pt: Record<string, string>) => ({
    kind: "propose", id: nid(), proposer: D, uri: b.uri, payloadHash: b.payloadHash, height: h, pos: 1, expiresEpoch: 9e15, paidTo: pt,
  });
  ev.push(P(deploy({ ticker: T, decimals: 0, supply: "1000000", mint: "issuer" }), offH - 4, { [TREASURY_ADDR]: "100000000" }));
  ev.push(P(mint({ ticker: T, amount: "1000000" }), offH - 2, {}));
  const offerId = nid();
  const o = offer({ give: { ticker: T, amount: "10" }, want: { value: "1000" } });
  ev.push({ kind: "propose", id: offerId, proposer: D, uri: o.uri, payloadHash: o.payloadHash, height: offH, pos: 1, expiresEpoch: expEpoch, paidTo: {} });
  return { ev, offerId };
}
const claimEv = (offerId: string, who: string, h: number) => ({
  kind: "attest", txid: nid(), proposalId: offerId, attester: who, score: SCORE_CLAIM, confidence: 0, height: h, pos: 1, paidTo: {},
});
const statusAt = (ev: any[], tip: number, id: string) => resolve(ev, tip).offers[id]?.status;

let pass = 0;

// ── offerExpiryHeightOf ≡ the resolver's sweep, across the four V21 cases ───────────────────────────
// offerExpiryHeightOf(E,a) is the first height H at which sweepExpired(H) marks the offer expired, i.e.
// the resolver rejects an event AT height H (sweepExpired(ev.height) runs before each event, resolve.ts).
// resolve(ev, tip) ends with sweepExpired(tip+1), so the FINAL state shows the offer expired exactly when
// tip+1 >= expH — hence we probe at tip = expH-2 (sweep@expH-1 → open) and tip = expH-1 (sweep@expH → expired).
function expiryCase(name: string, offH: number, expEpoch: number) {
  const { ev, offerId } = offerAt(offH, expEpoch);
  const expH = offerExpiryHeightOf(expEpoch, offH);
  assert.equal(statusAt(ev, expH - 2, offerId), "open", `${name}: expected OPEN at sweep ${expH - 1} (tip ${expH - 2})`);
  assert.equal(statusAt(ev, expH - 1, offerId), "expired", `${name}: expected EXPIRED at sweep ${expH} (tip ${expH - 1})`);
  console.log(`  ✓ ${name}: offerExpiryHeightOf=${expH} — sweep@${expH - 1} open, sweep@${expH} expired`);
  pass++;
}
expiryCase("A below-V21 raw binds", 30_000, epochOf(30_000) + 10);
expiryCase("B <V21 anchor, cap fires @V21", 35_000, epochOf(35_000) + 1000);
expiryCase("C >=V21 raw <= cap", V21_HEIGHT + 100, epochOf(V21_HEIGHT + 100) + 100);
expiryCase("D >=V21 at the cap", V21_HEIGHT + 100, epochOf(V21_HEIGHT + 100) + MAX_OFFER_EPOCHS);
expiryCase("E raw lands ~V21", V21_HEIGHT - 600, epochOf(V21_HEIGHT) - 1);

// ── claimWindowAt / claimGraceOf / claimWindowOf vs a REAL claim grant ──────────────────────────────
function claimCase(name: string, claimH: number) {
  const { ev, offerId } = offerAt(claimH - 50, epochOf(claimH) + 100);
  ev.push(claimEv(offerId, BUYER, claimH));
  const o = resolve(ev, claimH).offers[offerId];
  assert.ok(o?.claimUntilHeight !== undefined, `${name}: expected a claim grant`);
  assert.equal(o!.claimUntilHeight! - claimH, claimWindowAt(claimH), `${name}: window mismatch`);
  assert.equal(claimWindowOf(o!.claimUntilHeight!), claimWindowAt(claimH), `${name}: claimWindowOf mismatch`);
  const expectGrace = claimH >= V20_HEIGHT ? 5 : 0;
  assert.equal(claimGraceOf(o!.claimUntilHeight!), expectGrace, `${name}: grace mismatch (want ${expectGrace})`);
  console.log(`  ✓ ${name}: claimUntil=${o!.claimUntilHeight} window=${claimWindowAt(claimH)} grace=${claimGraceOf(o!.claimUntilHeight!)}`);
  pass++;
}
claimCase("claim <V20 (window 15, grace 0)", V20_HEIGHT - 100);
claimCase("claim >=V20 (window 40, grace 5)", V20_HEIGHT + 5_000);

console.log(`\ncairnx-core client-helpers equivalence: ${pass}/${pass} passed`);
