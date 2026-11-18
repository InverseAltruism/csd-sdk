// The replay's store (src/resolve/store.ts) on paths resolve() reaches rarely or not at all: an owner change of a
// pending reservation, sweeps whose heights fall below an earlier sweep's (NaN heights reorder the replay), and check
// mode refusing a field written past the store. Each read here runs with check mode on, so a read that differs from
// the plain walk throws.
import assert from "node:assert/strict";
import { REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, V21_HEIGHT, epochOf } from "../src/index.js";
import { createStore, type NameRec, type OfferRec } from "../src/resolve/store.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; };
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
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
  s.verify(true);
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
  s.verify(true);
}

// ── check mode refuses a field written past the store, and passes the same store fed through its writes ──
{
  const honest = createStore({ check: true });
  honest.addOffer(offer("0x" + "0b".repeat(32), 61_000, epochOf(61_000) + 5));
  honest.putName("delta", pending(A, 61_000));
  honest.verify(true);
  ok(true, "a store written through its functions passes the invariants");
  const s = createStore({ check: true });
  const o = offer("0x" + "0c".repeat(32), 61_000, epochOf(61_000) + 5);
  s.addOffer(o);
  (o as { status: string }).status = "cancelled";
  assert.throws(() => s.verify(true), /openOffers names .* which is not open/, "a status written past the store is caught");
  pass++;
  const t = createStore({ check: true });
  (t.names as Map<string, NameRec>).set("echo", pending(B, 61_000));
  assert.throws(() => t.verify(true), /pending echo is not in pendingNames/, "a reservation put past the store is caught");
  pass++;
  const u = createStore({ check: true });
  const n = pending(A, 61_000);
  u.putName("foxtrot", n);
  (n as { owner: string }).owner = B;
  assert.throws(() => u.pendingCount(B, "x", 61_002), /replay index check: reservations of/, "an owner written past the store is caught at the read");
  pass++;
}

console.log(`replay store: ${pass} passed`);
