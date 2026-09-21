// The active-expiry index must expire, cancel, and survive restart/reorg with the same canonical bytes.
import assert from "node:assert/strict";
import {
  ACTIVATION_HEIGHT, SCORE_CANCEL, TREASURY_ADDR, canonicalState, deploy, epochOf, mint, offer, resolve,
} from "../src/index.js";

let n = 0;
const nid = () => "0x" + (++n).toString(16).padStart(64, "0");
const D = "0x" + "d0".repeat(20);
const P = (b: { uri: string; payloadHash: string }, h: number, pos: number, exp: number, pt: Record<string, string> = {}) =>
  ({ kind: "propose" as const, id: nid(), proposer: D, uri: b.uri, payloadHash: b.payloadHash, height: h, pos, expiresEpoch: exp, paidTo: pt });

const base = 40_000;
const expSoon = epochOf(base) + 1;
const expLate = epochOf(base) + 40;
const events: any[] = [];
events.push(P(deploy({ ticker: "EXP", decimals: 0, supply: "1000000", mint: "issuer" }), base, 0, 9e15, { [TREASURY_ADDR]: "100000000" }));
events.push(P(mint({ ticker: "EXP", amount: "1000000" }), base + 1, 0, 9e15));
const soon: string[] = [];
for (let i = 0; i < 40; i++) {
  const id = nid();
  const o = offer({ give: { ticker: "EXP", amount: "1" }, want: { value: "1000" } });
  events.push({ kind: "propose", id, proposer: D, uri: o.uri, payloadHash: o.payloadHash, height: base + 2, pos: i, expiresEpoch: expSoon, paidTo: {} });
  soon.push(id);
}
const lateId = nid();
const late = offer({ give: { ticker: "EXP", amount: "1" }, want: { value: "1000" } });
events.push({ kind: "propose", id: lateId, proposer: D, uri: late.uri, payloadHash: late.payloadHash, height: base + 2, pos: 40, expiresEpoch: expLate, paidTo: {} });
const cancelAt = base + 3;
events.push({ kind: "attest", txid: nid(), proposalId: soon[0], attester: D, score: SCORE_CANCEL, confidence: 0, height: cancelAt, pos: 0, paidTo: {} });

const tip = (expSoon + 1) * 30;
const full = resolve(events, tip);
assert.equal(full.offers[soon[0]].status, "cancelled");
for (const id of soon.slice(1)) assert.equal(full.offers[id].status, "expired", id);
assert.equal(full.offers[lateId].status, "open");
assert.equal(canonicalState(resolve(events, tip)), canonicalState(full));

const prefix = events.slice(0, -1);
const prefixTip = cancelAt - 1;
assert.equal(canonicalState(resolve(prefix, prefixTip)), canonicalState(resolve(events.filter((e) => e.height <= prefixTip), prefixTip)));
assert.equal(resolve(prefix, prefixTip).offers[soon[0]].status, "open");

const below = [P(deploy({ ticker: "EARLY", decimals: 0, supply: "1", mint: "issuer" }), ACTIVATION_HEIGHT - 5, 0, 9e15, { [TREASURY_ADDR]: "100000000" })];
assert.equal(resolve(below, ACTIVATION_HEIGHT).tokens.EARLY, undefined);

console.log("expiry-index: canonical expiry, cancel, restart, and reorg prefix match");
