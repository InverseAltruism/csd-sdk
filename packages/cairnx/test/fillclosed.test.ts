// myProvenFillClosedOffer: the cases of the site swapguard table and the wallet fill-holds suite, at the
// predicate level. Events are built from the package's own record builders, so the offer binds for real.
import assert from "node:assert/strict";
import {
  DEPLOY_FEE, SCORE_FILL, TREASURY_ADDR, V29_HEIGHT, deploy, epochOf, fclaim, feeBpsAt, mint, myProvenFillClosedOffer, offer,
  requiredFillOutputs, resolve, type OfferState, type ProvenAttest, type ProvenPropose,
} from "../src/index.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log("  ok", name); };

const SELLER = "0x" + "5e".repeat(20), ME = "0x" + "1a".repeat(20), ALICE = "0x" + "a1".repeat(20);
const V = "100000000", H_OFF = V29_HEIGHT + 5, G = H_OFF + 40;
const give = { ticker: "AAA", amount: "10" };

const offerEv = (rec: { uri: string; payloadHash: string }, id = "0x" + "0f".repeat(32)): ProvenPropose => ({
  kind: "propose", id, proposer: SELLER, uri: rec.uri, payloadHash: rec.payloadHash, expiresEpoch: epochOf(H_OFF) + 200,
  height: H_OFF, pos: 1, paidTo: {}, depth: 10,
});
const served = (ev: ProvenPropose, extra: Partial<OfferState> = {}): OfferState => ({
  id: ev.id, seller: SELLER, give, want: { value: V, payto: SELLER }, status: "open", expiresEpoch: ev.expiresEpoch,
  height: H_OFF, feeBps: feeBpsAt(H_OFF), paid: "0", delivered: "0", ...extra,
});
const paidToOf = (legs: { to: string; value: bigint }[] | null): Record<string, string> =>
  Object.fromEntries((legs ?? []).map((l) => [l.to, l.value.toString()]));

const whole = offerEv(offer({ give, want: { value: V, payto: SELLER } }));
const fcl = { id: "0x" + "c7".repeat(32), height: H_OFF + 10, offer: whole.id };
const fullPay = paidToOf(requiredFillOutputs(served(whole), BigInt(V)));
const fill = (paidTo: Record<string, string>, h = H_OFF + 20, by = ME, extra: Partial<ProvenAttest> = {}): ProvenAttest => ({
  kind: "attest", txid: "0x" + "f1".repeat(32), proposalId: fcl.id, attester: by, score: SCORE_FILL, confidence: 0,
  height: h, pos: 1, paidTo, depth: 5, ...extra,
});
const P = myProvenFillClosedOffer;

t("fixture: the full need-map pays payto, the treasury fee and the maker rebate", () => {
  assert.deepEqual(Object.keys(fullPay).sort(), [SELLER, TREASURY_ADDR].sort());
  assert.ok(BigInt(fullPay[SELLER]!) > BigInt(V), "payto leg carries the rebate on top of want.value");
});

t("my full fill of the proven offer, between the fclaim and a V29+ grant, closes it", () => {
  assert.equal(P(fill(fullPay), fcl, whole, ME, G), true);
});

t("the site swapguard table: every other shape stays counted", () => {
  assert.equal(P(fill(fullPay, H_OFF + 20, ALICE), fcl, whole, ME, G), false);                     // not my fill
  assert.equal(P(fill(fullPay, H_OFF + 10), fcl, whole, ME, G), false);                            // same block as the fclaim
  assert.equal(P(fill(fullPay, G), fcl, whole, ME, G), false);                                      // in the grant block
  assert.equal(P(fill(fullPay), fcl, whole, ME, V29_HEIGHT - 1), false);                            // grant below V29
  assert.equal(P(fill(fullPay, H_OFF + 20, ME, { score: 0 }), fcl, whole, ME, G), false);           // not a fill
  assert.equal(P(fill(fullPay, H_OFF + 20, ME, { proposalId: "0x" + "c8".repeat(32) }), fcl, whole, ME, G), false);
  assert.equal(P(fill(fullPay), { ...fcl, offer: "0x" + "c9".repeat(32) }, whole, ME, G), false);
  assert.equal(P(fill(fullPay), fcl, null, ME, G), false);
});

t("the V29 gate alone decides: the same fill closes at a grant of V29_HEIGHT, not one block earlier", () => {
  const base = V29_HEIGHT - 60;
  const early = { ...offerEv(offer({ give, want: { value: V, payto: SELLER } }), "0x" + "0c".repeat(32)), height: base };
  const pay = paidToOf(requiredFillOutputs({ ...served(early), height: base, feeBps: feeBpsAt(base) }, BigInt(V)));
  const f = { id: fcl.id, height: base + 10, offer: early.id };
  assert.equal(P(fill(pay, base + 20), f, early, ME, V29_HEIGHT), true);
  assert.equal(P(fill(pay, base + 20), f, early, ME, V29_HEIGHT - 1), false);
});

t("the wallet suite's shapes: missing fee leg, short payment, no fill, unbound or non-offer events", () => {
  const { [TREASURY_ADDR]: _fee, ...noFee } = fullPay;
  void _fee;
  assert.equal(P(fill(noFee), fcl, whole, ME, G), false);
  assert.equal(P(fill({ ...fullPay, [SELLER]: (BigInt(fullPay[SELLER]!) - 1n).toString() }), fcl, whole, ME, G), false);
  assert.equal(P(null, fcl, whole, ME, G), false);
  assert.equal(P(fill(fullPay), fcl, { ...whole, payloadHash: "0x" + "00".repeat(32) }, ME, G), false);
  assert.equal(P(fill(fullPay), fcl, fill(fullPay), ME, G), false);
});

t("a partial-lane offer: a full payment closes it, a part payment leaves it counted", () => {
  const part = offerEv(offer({ give, want: { value: V, payto: SELLER }, min: "1000000" }), "0x" + "0e".repeat(32));
  const f = { ...fcl, offer: part.id };
  const pay = (x: bigint) => paidToOf(requiredFillOutputs(served(part, { min: "1000000" }), x));
  assert.equal(P(fill(pay(BigInt(V))), f, part, ME, G), true);
  assert.equal(P(fill(pay(1_000_000n)), f, part, ME, G), false);
});

t("a token-priced offer carries no value and is never proven closed", () => {
  const tok = offerEv(offer({ give, want: { ticker: "BBB", amount: "5" } }), "0x" + "0d".repeat(32));
  assert.equal(P(fill({}), { ...fcl, offer: tok.id }, tok, ME, G), false);
});

t("ids and addresses compare case-insensitively; overpayment still closes", () => {
  const up = (s: string) => "0x" + s.slice(2).toUpperCase();
  assert.equal(P(fill(fullPay, H_OFF + 20, up(ME), { proposalId: up(fcl.id) }), { ...fcl, offer: up(whole.id) }, whole, up(ME), G), true);
  assert.equal(P(fill({ ...fullPay, [SELLER]: (BigInt(fullPay[SELLER]!) * 2n).toString() }), fcl, whole, ME, G), true);
});

t("outputs are read as the resolver reads them: a non-canonical amount pays nothing", () => {
  const hex = Object.fromEntries(Object.entries(fullPay).map(([k, v]) => [k, "0x" + BigInt(v).toString(16)]));
  assert.equal(P(fill(hex), fcl, whole, ME, G), false);
});

t("against resolve(): holds the predicate proves closed are the ones the V29 cap stops counting", () => {
  const H_C = V29_HEIGHT + 30, H_F = V29_HEIGHT + 40, H_G = V29_HEIGHT + 50, TIP = V29_HEIGHT + 60;
  let n = 0; const nid = () => "0x" + (++n).toString(16).padStart(64, "0");
  const prop = (who: string, rec: { uri: string; payloadHash: string }, h: number, expiresEpoch: number, paidTo: Record<string, string> = {}): ProvenPropose =>
    ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, expiresEpoch, height: h, pos: n, paidTo, depth: 1 });
  const world = (filled: boolean) => {
    n = 0;
    const ev: (ProvenPropose | ProvenAttest)[] = [
      prop(SELLER, deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H_OFF - 2, 9e9, { [TREASURY_ADDR]: DEPLOY_FEE.toString() }),
      prop(SELLER, mint({ ticker: "AAA", amount: "1000" }), H_OFF - 1, 9e9),
    ];
    const offers = [0, 1, 2, 3].map(() => prop(SELLER, offer({ give, want: { value: V, payto: SELLER } }), H_OFF, 9e9));
    ev.push(...offers);
    const holds = offers.slice(0, 3).map((o) => prop(ME, fclaim({ offer: o.id }), H_C, epochOf(H_C) + 2));
    ev.push(...holds);
    const fills = holds.map((c, i) => ({ ...fill(paidToOf(requiredFillOutputs(served(offers[i]!), BigInt(V))), H_F), txid: nid(), proposalId: c.id, pos: n }));
    if (filled) ev.push(...fills);
    const fourth = prop(ME, fclaim({ offer: offers[3]!.id }), H_G, epochOf(H_G) + 2);
    ev.push(fourth);
    const granted = resolve(ev, TIP).fclaims[fourth.id] !== undefined;
    const closed = holds.map((c, i) => P(fills[i]!, { id: c.id, height: c.height, offer: offers[i]!.id }, offers[i]!, ME, H_G));
    return { granted, closed };
  };
  const done = world(true), open = world(false);
  assert.equal(done.granted, true, "three closed holds do not deny the fourth claim");
  assert.deepEqual(done.closed, [true, true, true]);
  assert.equal(open.granted, false, "three live holds on open offers deny it");
});

console.log(`fillclosed: ${pass} passed`);
