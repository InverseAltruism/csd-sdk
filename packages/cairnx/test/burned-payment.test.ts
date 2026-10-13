// ptAmt (the resolver's paidTo reader), burnedPayment (what a refused record paid to the parties the
// protocol pays) and the single-sourced epochOf, as exported from the package root.
import assert from "node:assert/strict";
import { epochOf as codecEpochOf } from "@inversealtruism/csd-codec";
import {
  DEPLOY_FEE, FEE_BPS_V16, TREASURY_ADDR, burnedPayment, deploy, epochOf, mint, offer, ptAmt, resolve, tradeFee,
  type ChainEvent,
} from "../src/index.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log("  ok", name); };

const T = TREASURY_ADDR;
const A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20), P = "0x" + "cc".repeat(20), X = "0x" + "dd".repeat(20);
const csdOffer = (seller: string, payto: string) => ({ seller, want: { value: "100", payto } });

t("epochOf is csd-codec's selector, re-exported from the root", () => {
  assert.equal(epochOf, codecEpochOf);
  assert.deepEqual([0, 29, 30, 88_000].map((h) => epochOf(h)), [0, 0, 1, 2_933]);
});

t("ptAmt reads canonical decimal strings and nothing else", () => {
  assert.equal(ptAmt("0"), 0n);
  assert.equal(ptAmt("123456789012345678901"), 123456789012345678901n);
  for (const bad of ["0x10", "010", " 5", "5 ", "-1", "1e3", "", 5, 5n, null, undefined, {}]) assert.equal(ptAmt(bad), 0n, String(bad));
});

t("burnedPayment without an offer: the treasury leg only", () => {
  assert.deepEqual(burnedPayment({ [T]: "150", [A]: "999" }, B), { treasury: 150n, counterparty: 0n });
  assert.deepEqual(burnedPayment(undefined, B), { treasury: 0n, counterparty: 0n });
  assert.deepEqual(burnedPayment({}, B, null), { treasury: 0n, counterparty: 0n });
});

t("burnedPayment with an offer: seller and payto, each address once, third parties ignored", () => {
  assert.deepEqual(burnedPayment({ [T]: "2", [A]: "100", [P]: "7", [X]: "50" }, B, csdOffer(A, P)), { treasury: 2n, counterparty: 107n });
  assert.deepEqual(burnedPayment({ [T]: "2", [A]: "100", [X]: "50" }, B, csdOffer(A, A)), { treasury: 2n, counterparty: 100n });
});

t("burnedPayment never counts the payer's own outputs", () => {
  assert.deepEqual(burnedPayment({ [T]: "2", [A]: "100", [P]: "7" }, A, csdOffer(A, P)), { treasury: 2n, counterparty: 7n });
  assert.deepEqual(burnedPayment({ [T]: "2", [A]: "100" }, T, csdOffer(A, A)), { treasury: 0n, counterparty: 100n });
});

t("burnedPayment: a seller or payto that is the treasury counts once, in the treasury leg", () => {
  assert.deepEqual(burnedPayment({ [T]: "40" }, B, csdOffer(T, T)), { treasury: 40n, counterparty: 0n });
  assert.deepEqual(burnedPayment({ [T]: "40", [P]: "3" }, B, csdOffer(T, P)), { treasury: 40n, counterparty: 3n });
});

t("burnedPayment reads amounts with ptAmt: non-canonical outputs pay nothing", () => {
  assert.deepEqual(burnedPayment({ [T]: "0x10", [A]: "010" }, B, csdOffer(A, A)), { treasury: 0n, counterparty: 0n });
});

t("burnedPayment over a resolve() refusal: the second fill of a filled offer", () => {
  const h0 = 40_000, val = 100_000_000n, fee = tradeFee(val, FEE_BPS_V16);
  const dep = deploy({ ticker: "PAY", decimals: 0, supply: "1000", mint: "issuer" }), mnt = mint({ ticker: "PAY", amount: "1000" });
  const off = offer({ give: { ticker: "PAY", amount: "10" }, want: { value: val.toString() }, taker: B });
  const oid = "0x" + "03".padStart(64, "0");
  const pay = { [A]: val.toString(), [T]: fee.toString() };
  const att = (txid: string, h: number): ChainEvent => ({ kind: "attest", txid, proposalId: oid, attester: B, score: 100, confidence: 0, height: h, pos: 1, paidTo: pay });
  const events: ChainEvent[] = [
    { kind: "propose", id: "0x" + "01".padStart(64, "0"), proposer: A, uri: dep.uri, payloadHash: dep.payloadHash, height: h0, pos: 1, expiresEpoch: 9e15, paidTo: { [T]: DEPLOY_FEE.toString() } },
    { kind: "propose", id: "0x" + "02".padStart(64, "0"), proposer: A, uri: mnt.uri, payloadHash: mnt.payloadHash, height: h0 + 1, pos: 1, expiresEpoch: 9e15, paidTo: {} },
    { kind: "propose", id: oid, proposer: A, uri: off.uri, payloadHash: off.payloadHash, height: h0 + 2, pos: 1, expiresEpoch: 9e15, paidTo: {} },
    att("0x" + "04".padStart(64, "0"), h0 + 4), att("0x" + "05".padStart(64, "0"), h0 + 6),
  ];
  const st = resolve(events, h0 + 40);
  const log = st.events.filter((l) => l.kind === "fill");
  assert.deepEqual(log.map((l) => l.ok), [true, false], "fixture: the first fill applies, the second is refused");
  const o = st.offers[oid];
  assert.ok(o, "fixture: the offer is in state");
  assert.deepEqual(burnedPayment(pay, B, o), { treasury: fee, counterparty: val });
});

console.log(`burned-payment: ${pass} passed`);
