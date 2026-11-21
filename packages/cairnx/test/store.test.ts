// The replay's store (src/resolve/store.ts) on paths resolve() reaches rarely or not at all: an owner change of a
// pending reservation, sweeps and hold counts at heights below an earlier one's (NaN heights reorder the replay), the
// bulk-cancel and void candidates, check mode refusing a field written past the store, and the sweep's loop guard. Each read here runs with check mode on, so a read that differs from
// the plain walk throws.
import assert from "node:assert/strict";
import {
  DEPLOY_FEE, EPOCH_LEN, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, TREASURY_ADDR, V21_HEIGHT, V28_HEIGHT, V29_HEIGHT, deploy, epochOf,
  mint, offer as offerRecord, resolve, stateHash, type ChainEvent,
} from "../src/index.js";
import { createStore, type NameRec, type OfferRec } from "../src/resolve/store.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; };
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), FAR = 9_000_000_000;
const pending = (owner: string, effHeight: number): NameRec =>
  ({ owner, effHeight, pos: 0, id: "0x" + "11".repeat(32), height: effHeight + 1, locked: false, pending: true, finalizeBy: effHeight + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS });
const offer = (id: string, height: number, expiresEpoch: number): OfferRec =>
  ({ id, seller: A, give: { ticker: "AAA", amount: "1" }, want: { value: "1000", payto: A }, status: "open", expiresEpoch, height, feeBps: 150 });

// ── an owner change of a pending reservation moves it between the owners' caps ──
{
  const s = createStore({ check: true });
  const h = 61_000;
  s.putName("alpha", pending(A, h));
  s.putName("beta", pending(A, h));
  ok(s.pendingCount(A, "gamma", h + 2) === 2 && s.pendingCount(B, "gamma", h + 2) === 0, "two reservations count for their owner");
  s.setNameOwner("beta", s.names.get("beta")!, B);
  ok(s.pendingCount(A, "gamma", h + 2) === 1, "the old owner counts one after the change");
  ok(s.pendingCount(B, "gamma", h + 2) === 1, "the new owner counts the reservation it now holds");
  ok(s.pendingCount(B, "beta", h + 2) === 0, "a re-reveal of the same name is not counted");
  s.finalizeName("alpha", s.names.get("alpha")!);
  ok(s.pendingCount(A, "gamma", h + 2) === 0 && !("pending" in s.names.get("alpha")!), "a finalized name leaves the cap with its keys deleted");
  s.verify(61_002, true);
}

// ── sweeps below an earlier sweep's height take the plain walk ──
// After the V21 crossing an offer anchored below V21 is added (only reachable with heights out of order) and keyed at
// its capped epoch. A sweep below V21 must judge it by its raw expiry, as the walk does, and a later sweep, still below
// the high-water mark, must expire it once the raw expiry passes.
{
  const s = createStore({ check: true });
  const expired: string[] = [];
  const sweep = (h: number) => s.sweep(h, (o) => expired.push(o.id));
  const anchor = V21_HEIGHT - 9_000, ea = epochOf(anchor);
  sweep(V21_HEIGHT + 10);
  s.addOffer(offer("0x" + "0a".repeat(32), anchor, ea + 250));
  sweep(30 * (ea + 200));                                      // past the capped epoch ea + 168, before the raw ea + 250
  ok(s.offers.get("0x" + "0a".repeat(32))!.status === "open", "below V21 the raw expiry binds (not expired)");
  sweep(30 * (ea + 252));                                      // past the raw expiry, still below V21
  ok(s.offers.get("0x" + "0a".repeat(32))!.status === "expired" && expired.length === 1, "a later lower sweep expires it at its raw expiry");
  sweep(Number.NaN);
  ok(expired.length === 1, "a sweep at NaN expires nothing");
  s.verify(61_002, true);
}

// ── check mode refuses a field written past the store, and passes the same store fed through its writes ──
{
  const honest = createStore({ check: true });
  honest.addOffer(offer("0x" + "0b".repeat(32), 61_000, epochOf(61_000) + 5));
  honest.putName("delta", pending(A, 61_000));
  honest.verify(61_002, true);
  ok(true, "a store written through its functions passes the invariants");
  const s = createStore({ check: true });
  const o = offer("0x" + "0c".repeat(32), 61_000, epochOf(61_000) + 5);
  s.addOffer(o);
  (o as { status: string }).status = "cancelled";
  assert.throws(() => s.verify(61_002, true), /openOffers names .* which is not open/, "a status written past the store is caught");
  pass++;
  const t = createStore({ check: true });
  (t.names as Map<string, NameRec>).set("echo", pending(B, 61_000));
  assert.throws(() => t.verify(61_002, true), /pending echo is not in pendingNames/, "a reservation put past the store is caught");
  pass++;
  const u = createStore({ check: true });
  const n = pending(A, 61_000);
  u.putName("foxtrot", n);
  (n as { owner: string }).owner = B;
  assert.throws(() => u.pendingCount(B, "x", 61_002), /replay index check: reservations of/, "an owner written past the store is caught at the read");
  pass++;
}

// ── live holds: dropped when lapsed, re-added by a grant, read below the high-water mark by the walk ──
{
  const s = createStore({ check: true });
  const h = V28_HEIGHT + 100, E = epochOf(h) + 2, until = (E + 1) * EPOCH_LEN;
  const ids = [1, 2, 3, 4].map((i) => "0x" + String(i).padStart(2, "0").repeat(32));
  for (const id of ids) s.addOffer(offer(id, h - 10, FAR));
  for (const id of ids.slice(0, 3)) s.setClaim(s.offers.get(id)!, B, until, "0x" + "f".repeat(64));
  ok(s.liveHoldCount(B, h) === 3, "three live holds");
  ok(s.liveHoldCount(B, until + 5) === 0, "the holds lapse by height and are dropped");
  ok(s.liveHoldCount(B, h + 1) === 3, "a read below the high-water mark counts what the walk counts");
  const h2 = until + 10, E2 = epochOf(h2) + 2;
  s.setClaim(s.offers.get(ids[0]!)!, B, (E2 + 1) * EPOCH_LEN, "0x" + "e".repeat(64));
  ok(s.liveHoldCount(B, h2) === 1, "a re-grant after the lapse counts again");
  s.setOfferStatus(s.offers.get(ids[0]!)!, "filled");
  ok(s.liveHoldCount(B, h2) === 1, "below V29 a filled offer's live hold still counts");
  const v = createStore({ check: true });
  v.addOffer(offer(ids[3]!, V29_HEIGHT, FAR));
  v.setClaim(v.offers.get(ids[3]!)!, B, (epochOf(V29_HEIGHT) + 3) * EPOCH_LEN, "0x" + "d".repeat(64));
  v.setOfferStatus(v.offers.get(ids[3]!)!, "filled");
  ok(v.liveHoldCount(B, V29_HEIGHT + 1) === 0, "from V29 a filled offer's hold does not count");
  s.verify(h2, true);
}

// ── bulk-cancel candidates: the filter picks a set, a firm quote is never one, the walk's order is kept ──
{
  const s = createStore({ check: true });
  const h = V28_HEIGHT + 10, mk = (i: number, give: OfferRec["give"], extra: Partial<OfferRec> = {}): OfferRec =>
    ({ ...offer("0x" + i.toString(16).padStart(64, "0"), h, FAR), give, ...extra });
  const all = [mk(1, { ticker: "AAA", amount: "1" }), mk(2, { name: "alpha" }), mk(3, { ticker: "BBB", amount: "1" }),
    mk(4, { ticker: "AAA", amount: "1" }, { taker: B }), mk(5, { ticker: "AAA", amount: "1" }, { taker: B, height: V28_HEIGHT - 5 })];
  for (const o of all) s.addOffer(o);
  const ids = (os: OfferRec[]) => os.map((o) => o.id.slice(-1));
  ok(ids(s.ocancelTargets(A, "AAA")).join() === "1,5", "a ticker filter: that ticker's offers, the pre-V28 taker-bound one too");
  ok(ids(s.ocancelTargets(A, undefined, "alpha")).join() === "2", "a name filter: that name's offer");
  ok(ids(s.ocancelTargets(A)).join() === "1,2,3,5", "unfiltered: every cancellable offer, in insertion order; the V28+ firm quote never");
  s.setOfferStatus(all[0]!, "cancelled");
  ok(ids(s.ocancelTargets(A, "AAA")).join() === "5" && ids(s.ocancelTargets(B)).join() === "", "a closed offer leaves the candidates; another seller has none");
  s.setClaim(all[1]!, B, (epochOf(h) + 3) * EPOCH_LEN, "0x" + "c".repeat(64));
  ok(ids(s.voidTargets("alpha", h)).join() === "" && ids(s.voidTargets("alpha", (epochOf(h) + 3) * EPOCH_LEN)).join() === "2",
    "a live fclaim hold freezes a name offer against a void until it lapses");
  s.verify(h, true);
}

// ── target lists keep the walk's order (first insertion into the offers map) when a candidate set's own order differs:
//    an id re-set under another seller (a duplicated id) or dropped and added again ──
{
  const s = createStore({ check: true });
  const h = V28_HEIGHT + 10, id = (i: number) => "0x" + i.toString(16).padStart(64, "0");
  const X = offer(id(1), h, FAR);
  s.addOffer(X);
  s.addOffer({ ...offer(id(2), h, FAR), seller: B });
  s.addOffer({ ...offer(id(3), h, FAR), seller: B });
  s.addOffer({ ...X, seller: B });                                       // the same id again, now B's
  ok(s.ocancelTargets(B).map((o) => o.id.slice(-1)).join() === "1,2,3", "a bulk cancel lists in the offers map's order");
  const v = createStore({ check: true });
  const n1 = { ...offer(id(4), h, FAR), give: { name: "bravo" } }, n2 = { ...offer(id(5), h, FAR), give: { name: "bravo" } };
  v.addOffer(n1); v.addOffer(n2);
  v.setOfferStatus(n1, "cancelled");
  ok(v.voidTargets("bravo", h).map((o) => o.id.slice(-1)).join() === "5", "a closed offer leaves the name's candidates");
  v.addOffer({ ...n1, status: "open" });                                  // the same id again, open
  ok(v.voidTargets("bravo", h).map((o) => o.id.slice(-1)).join() === "4,5", "a void lists in the offers map's order");
}

// ── the sweep's loop guard: a due height that rounds below the height that pops its entry ──
// An offer keyed 2^53 - 297: (k + 1) * EPOCH_LEN rounds to a height whose epoch is still k, so the batch there pops
// nothing; the guard ends the loop and the batch at the asked height expires it, as one batch per sweep does.
{
  const k = 2 ** 53 - 297, d = (k + 1) * EPOCH_LEN;
  ok(epochOf(d) === k, "the computed due height of the entry falls in its own epoch (the case the guard exists for)");
  const s = createStore({ check: true });
  const o = offer("0x" + "ee".repeat(32), 90_002, k);
  s.addOffer(o);
  let released = 0;
  s.sweep(3e17, () => { released++; });
  ok(s.offers.get(o.id)?.status === "expired" && released === 1, "the sweep returns and expires the offer once, as the walk does");
  const S = "0x" + "71".repeat(20), P = (b: { uri: string; payloadHash: string }, h: number, pos: number, exp: number, paidTo = {}): ChainEvent =>
    ({ kind: "propose", id: "0x" + String(pos + h).padStart(64, "0"), proposer: S, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: exp, height: h, pos, paidTo });
  const ev = [P(deploy({ ticker: "GRD", decimals: 0, supply: "10", mint: "issuer" }), 90_000, 0, FAR, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
    P(mint({ ticker: "GRD", amount: "10" }), 90_001, 0, FAR), P(offerRecord({ give: { ticker: "GRD", amount: "3" }, want: { value: "1000" }, taker: "0x" + "72".repeat(20) }), 90_002, 0, k)];
  // the published cairnx-core 0.2.8 gives this stateHash for the same input
  ok(stateHash(resolve(ev, 3e17)) === "0xbbf78cf9c7fc161a63a7369bf41e6d0d6b6e1db0d4db29167bae7fb7b35b70ca", "resolve() at tip 3e17 equals 0.2.8");
}

console.log(`replay store: ${pass} passed`);
