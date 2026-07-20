// Phase 0.5 (shared-core de-dup): the pure client selectors lifted into cairnx-core (claimWindowAt,
// claimGraceOf, claimWindowOf, offerExpiryHeightOf) MUST agree with what the resolver actually does —
// otherwise the UI/wallet that now import them would gate differently from the chain. The dangerous one is
// offerExpiryHeightOf: it is a CLOSED FORM, while the resolver expires offers via an epoch-based
// effExpiry + sweepExpired. This test pins their equivalence by driving the REAL resolver: for a grid of
// (anchorHeight, expiresEpoch) it asserts the offer is "open" at offerExpiryHeightOf(...) − 1 and
// "expired" at offerExpiryHeightOf(...) — i.e. the helper returns the exact first sweep height. It also
// sanity-checks claimWindowAt / claimGraceOf / claimWindowOf against a real claim grant.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  resolve,
  offer,
  deploy,
  mint,
  fclaim,
  fclaimEpochFor,
  offerExpiryHeightOf,
  claimWindowAt,
  claimGraceOf,
  claimWindowOf,
  FCLAIM_WINDOW_MIN,
  CLAIM_WINDOW_BLOCKS_V20,
  epochOf,
  V20_HEIGHT,
  V21_HEIGHT,
  V22_HEIGHT,
  V28_HEIGHT,
  EPOCH_LEN,
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
// v2.2 (V22): the cap is REMOVED for offers anchored >= V22 — offerExpiryHeightOf returns RAW (uncapped),
// and the resolver rests the offer to that raw expiry even when the duration far exceeds the old 168-epoch cap.
expiryCase("F >=V22 long duration uncapped (rests to raw)", V22_HEIGHT + 100, epochOf(V22_HEIGHT + 100) + 1000);
expiryCase("G >=V22 modest duration (still raw)", V22_HEIGHT + 100, epochOf(V22_HEIGHT + 100) + 50);

// ── v2.2 creation gate: over-cap REJECTED in [V21,V22) (history preserved), ACCEPTED when anchored >= V22 ──
function createCase(name: string, offH: number, expEpoch: number, expectOpen: boolean) {
  const { ev, offerId } = offerAt(offH, expEpoch);
  const st = statusAt(ev, offH + 1, offerId);
  assert.equal(st === "open", expectOpen, `${name}: expected ${expectOpen ? "OPEN (accepted)" : "rejected (undefined)"}, got ${st}`);
  console.log(`  ✓ ${name}: status@${offH + 1}=${st ?? "rejected"}`);
  pass++;
}
// duration MAX_OFFER_EPOCHS+50 epochs is OVER the old cap:
createCase("over-cap in [V21,V22) is REJECTED (V21 behavior preserved)", V21_HEIGHT + 100, epochOf(V21_HEIGHT + 100) + MAX_OFFER_EPOCHS + 50, false);
createCase("over-cap anchored >=V22 is ACCEPTED (cap removed)", V22_HEIGHT + 100, epochOf(V22_HEIGHT + 100) + MAX_OFFER_EPOCHS + 50, true);

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

// ── B6c (REBIND M6): claimWindowOf fclaim-aware vs REAL fclaim grants across a full epoch of grant
// heights. Properties (each read back from the resolver's own grant, never from generation math):
//   P1  the 1-arg (legacy) call is UNCHANGED on an fclaim's claimUntilHeight (still 40 - frozen inverse);
//   P2  the 2-arg call returns FCLAIM_WINDOW_MIN (46) whenever claimTxid is set;
//   P3  SAFETY: derived grant (claimUntilHeight - window) is never EARLIER than the true grant height,
//       so a claim-depth consumer (depth = tip - derivedGrant) can never OVER-state burial;
//   P4  STRICT IMPROVEMENT: the fclaim-aware window is > the legacy 40, so refusals strictly shrink;
//   P5  the true span claimUntilHeight - grantHeight stays inside [46, 75] (the symbolic bound the
//       constant was derived from). ──
{
  assert.equal(FCLAIM_WINDOW_MIN, 46, "FCLAIM_WINDOW_MIN = 40 + 5 + 1 = 46");
  for (let off = 0; off < EPOCH_LEN; off++) {
    const g = V28_HEIGHT + 120 + off;                       // grant heights sweeping a full epoch phase
    const { ev, offerId } = offerAt(g - 50, epochOf(g) + 100);
    const E = fclaimEpochFor(g, epochOf(g) + 100);          // the client grant path (uncapped by expiry here)
    const f = fclaim({ offer: offerId });
    ev.push({ kind: "propose", id: nid(), proposer: BUYER, uri: f.uri, payloadHash: f.payloadHash, height: g, pos: 1, expiresEpoch: E, paidTo: {} });
    const o = resolve(ev, g).offers[offerId];
    assert.ok(o?.claimTxid !== undefined && o?.claimUntilHeight !== undefined, `fclaim grant at ${g} must hold`);
    const cu = o!.claimUntilHeight!;
    assert.equal(claimWindowOf(cu), CLAIM_WINDOW_BLOCKS_V20, `P1 legacy 1-arg call unchanged at ${g}`);
    assert.equal(claimWindowOf(cu, o!.claimTxid), FCLAIM_WINDOW_MIN, `P2 fclaim-aware window at ${g}`);
    assert.ok(cu - claimWindowOf(cu, o!.claimTxid) >= g, `P3 derived grant never earlier than the true grant at ${g}`);
    assert.ok(claimWindowOf(cu, o!.claimTxid) > CLAIM_WINDOW_BLOCKS_V20, `P4 strictly wider than the legacy 40 at ${g}`);
    assert.ok(cu - g >= 46 && cu - g <= 75, `P5 true span ${cu - g} inside [46,75] at ${g}`);
  }
  console.log(`  ✓ B6c claimWindowOf fclaim-aware: P1..P5 hold across ${EPOCH_LEN} grant phases`);
  pass++;

  // MUTATION (red-first, executable forever): remove the fclaim branch -> the M6 bug returns (the 2-arg
  // call degrades to the legacy 40 and the derived grant is LATER than truth for early-phase grants).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const TSRC = path.join(here, "..", "src", "types.ts");
  const src = readFileSync(TSRC, "utf8");
  const lines = src.split("\n");
  const kept = lines.filter((l) => !l.includes("MUTATE_M6_FCLAIM_WINDOW"));
  assert.equal(kept.length, lines.length - 1, "mutation marker MUTATE_M6_FCLAIM_WINDOW must match exactly one line");
  const tmp = path.join(here, "..", "src", `__mutant_m6_${Date.now()}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try {
    const mod = await import(pathToFileURL(tmp).href) as typeof import("../src/types.js");
    assert.equal(mod.claimWindowOf(V28_HEIGHT + 300, "0x" + "f0".repeat(32)), CLAIM_WINDOW_BLOCKS_V20,
      "MUTATION[fclaim branch removed]: the 2-arg call degrades to the legacy 40 -> the branch is the sole fix for M6");
  } finally { unlinkSync(tmp); }
  console.log("  ✓ B6c MUTATION: removing the fclaim branch reverts to the M6 false-not-ready behavior");
  pass++;
}

console.log(`\ncairnx-core client-helpers equivalence: ${pass}/${pass} passed`);
