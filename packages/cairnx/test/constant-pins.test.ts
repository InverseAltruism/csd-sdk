// Behaviour pins for constants that no other suite in this package reaches: the activation height, the
// owner-only lease grace, the lapsed-name premium decay, the settlement domain (consensus) and the
// finalize signing band (client policy). Each boundary is a literal, so changing the constant fails here
// instead of moving the test with it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deploy, nameRenew, resolve, expiredClaimFee, finalizeWinnerCheck, DOMAIN, TREASURY_ADDR } from "../src/index.js";
import type { ChainEvent } from "../src/index.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; console.log("  ✓ " + name); };
const A = "0x" + "a1".repeat(20);
const PE = (id: string, built: { uri: string; payloadHash: string }, height: number, proposer: string, paidTo: Record<string, string> = {}): ChainEvent =>
  ({ kind: "propose", id, proposer, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch: 9e9, height, pos: 0, paidTo });

// Activation: events below 29,860 are ignored; a deploy at 29,860 (before fees, V11) creates the token.
const dep = deploy({ ticker: "ACT", decimals: 0, supply: "10", mint: "issuer" });
ok(resolve([PE("0x" + "01".repeat(32), dep, 29_860, A)], 29_900).tokens["ACT"] !== undefined, "a deploy at 29,860 is applied");
ok(resolve([PE("0x" + "01".repeat(32), dep, 29_859, A)], 29_900).tokens["ACT"] === undefined, "a deploy at 29,859 is ignored");

// Lease grace, on a real name from the committed corpus ("1", paid through epoch 9,826): its owner may
// renew through epoch 9,826 + 720 and not one epoch later. Fee: 15 CSD, the V24 rate for names of 1 to 3 chars.
{
  const corpus = JSON.parse(readFileSync(new URL("./vectors/replay-corpus.json", import.meta.url), "utf8"));
  const before = resolve(corpus.events, corpus.tipHeight).names["1"];
  assert.ok(before && before.paidThroughEpoch === 9_826, "fixture: name 1 is paid through epoch 9,826");
  const renewAt = (epoch: number) => {
    const h = epoch * 30;
    const ev = PE("0x" + "e9".repeat(32), nameRenew({ name: "1" }), h, before.owner, { [TREASURY_ADDR]: "1500000000" });
    return resolve([...corpus.events, ev], h).names["1"]?.paidThroughEpoch;
  };
  ok(renewAt(9_826 + 720) === 9_826 + 8_760, "the owner's renewal in the last grace epoch extends the lease");
  ok(renewAt(9_826 + 721) === 9_826, "a renewal one epoch after grace is refused (the name has lapsed)");
}

// Lapsed-name premium: 20x at the grace end, decaying to 1x over 720 epochs (integer math). The two
// middle points are where a 719- or 721-epoch decay would round to a different multiple.
{
  const base = 500_000_000n;   // 5 CSD: "alice" (5 chars) at a V24-era height
  const fee = (k: number) => expiredClaimFee("alice", k, 100_000);
  ok(fee(0) === 20n * base, "premium is 20x at the grace end");
  ok(fee(265) === 13n * base, "premium after 265 epochs is 13x");
  ok(fee(379) === 9n * base, "premium after 379 epochs is 9x");
  ok(fee(720) === base, "premium has decayed to 1x after 720 epochs");
}

ok(DOMAIN === "cairnx:v1", "the settlement domain is cairnx:v1");

// Finalize signing band for a reservation committed at 1,000: the resolver accepts a finalize mined in
// (1,008, 1,028]; signing at tip t mines at t+1 or later, so the client allows t in [1,011, 1,026].
{
  const st = { owner: A, pending: true, effectiveHeight: 1_000 } as Parameters<typeof finalizeWinnerCheck>[0];
  const safeAt = (t: number) => finalizeWinnerCheck(st, A, 1_000, t).safe;
  ok(!safeAt(1_010) && safeAt(1_011), "finalize band opens two blocks after the freeze ends");
  ok(safeAt(1_026) && !safeAt(1_027), "finalize band closes two blocks before the deadline");
}

console.log(`cairnx-core constant pins: ${pass} passed`);
