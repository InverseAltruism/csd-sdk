// v2.8 fclaim (§31) B1 SCAFFOLDING test: the record parses + validates, and below V28_HEIGHT the fclaim is a
// pure no-op (no grant, no state change, byte-identical canonical state). The GRANT/fill semantics land in B2;
// this file guards only that B1 is additive and inert below the gate.
import assert from "node:assert/strict";
import { payloadHash, canonicalJson } from "@inversealtruism/csd-codec";
import {
  fclaim, deploy, mint, offer, parseRecord, resolve, canonicalState,
  fclaimHoldEnd, fclaimEpochFor, claimGraceOf, EPOCH_LEN, V28_HEIGHT,
  CLAIM_FILL_GRACE_BLOCKS, TREASURY_ADDR, DEPLOY_FEE,
} from "../src/index.js";
import type { ChainEvent } from "../src/index.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; };

const OFFER_ID = "0x" + "ab".repeat(32);

// ── record: builder round-trip, exact-key allowlist, isHash(offer) ──
const built = fclaim({ offer: OFFER_ID });
const back = parseRecord(built.uri, built.payloadHash);
ok(!!back && back.t === "fclaim" && back.offer === OFFER_ID, "fclaim builder round-trips through parseRecord");
ok(parseRecord(canonicalJson({ v: 1, t: "fclaim", offer: OFFER_ID, evil: "x" }), payloadHash({ v: 1, t: "fclaim", offer: OFFER_ID, evil: "x" })) === null, "extra key rejected (FCLAIM_KEYS exact-key)");
ok(parseRecord(canonicalJson({ v: 1, t: "fclaim", offer: "nope" }), payloadHash({ v: 1, t: "fclaim", offer: "nope" })) === null, "non-hash offer rejected (isHash)");
ok(parseRecord(canonicalJson({ v: 1, t: "fclaim", offer: OFFER_ID, expiresEpoch: 3 }), payloadHash({ v: 1, t: "fclaim", offer: OFFER_ID, expiresEpoch: 3 })) === null, "body expiresEpoch rejected (rides Propose.expires_epoch)");
ok(parseRecord(canonicalJson({ v: 1, t: "fclaim" }), payloadHash({ v: 1, t: "fclaim" })) === null, "missing offer key rejected (isHash(undefined))");

// ── below-gate no-op: an fclaim on a live open offer grants NO hold and changes NO canonical state ──
const A = "0x" + "11".repeat(20);
const H = V28_HEIGHT - 1_000; // just below the V28 placeholder (relative, per the generator discipline)
assert.ok(H < V28_HEIGHT, "test height is below the V28 placeholder");
const realOfferId = "0x" + "0f".repeat(32);
const dep = deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" });
const mnt = mint({ ticker: "AAA", amount: "1000" });
const off = offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000" } });
const pe = (id: string, b: { uri: string; payloadHash: string }, height: number, paidTo: Record<string, string> = {}): ChainEvent =>
  ({ kind: "propose", id, proposer: A, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 9_000_000, height, pos: 0, paidTo });
const base: ChainEvent[] = [
  pe("0x" + "01".repeat(32), dep, H, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  pe("0x" + "03".repeat(32), mnt, H),
  pe(realOfferId, off, H + 1),
];
const fEv = pe("0x" + "02".repeat(32), fclaim({ offer: realOfferId }), H + 2);

const without = resolve(base, H + 10);
const with_ = resolve([...base, fEv], H + 10);
ok(canonicalState(without) === canonicalState(with_), "below-V28 fclaim is a canonical no-op (byte-identical)");
const o = with_.offers[realOfferId];
ok(!!o && o.status === "open" && o.claimedBy === undefined && o.claimUntilHeight === undefined && o.claimTxid === undefined, "below-V28 fclaim grants NO hold (offer untouched)");
ok(!canonicalState(with_).includes('"fclaims"'), "fclaims is excluded from canonicalState");
ok((with_ as { fclaims: unknown }).fclaims !== undefined && Object.keys(with_.fclaims).length === 0, "resolve() returns an (empty, below-gate) fclaims map");

// ── selectors ──
ok(fclaimHoldEnd(3) === (3 + 1) * EPOCH_LEN - 1, "fclaimHoldEnd = (E+1)*EPOCH_LEN-1");
ok(fclaimEpochFor(60_000, 9_000_000) === Math.floor((60_000 + 45) / EPOCH_LEN), "fclaimEpochFor approximates the 45-block hold");
ok(fclaimEpochFor(60_000, 5) === 5, "fclaimEpochFor never exceeds the offer expiry");
ok(claimGraceOf(999_999, undefined) === CLAIM_FILL_GRACE_BLOCKS, "claimGraceOf legacy hold keeps its +grace");
ok(claimGraceOf(999_999, "0xdead") === 0, "claimGraceOf fclaim hold (claimTxid set) has grace 0");

console.log(`cairnx-core fclaim B1 scaffolding: ${pass} passed`);
