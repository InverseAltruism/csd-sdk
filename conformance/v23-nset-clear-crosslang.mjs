// v23-nset-clear-crosslang.mjs — V23 "unset" (nset to the ZERO address clears the record at height >= V23)
// + the forward-resolution & primary-recompute invariants the feature depends on. Proven byte-identical
// against BOTH the JS resolver (cairnx-core dist) and the INDEPENDENT Python reference (cairnx_ref.py),
// plus semantic assertions on the JS side. A determinism fork (gate height, the sentinel compare, the
// owner/lapse gate, the primary tiebreak) OR a wrong forward-resolution fallback would diverge here.
//
// Forward resolution under test (consensus): a name receives at `addr ?? owner`. So:
//   • register TEST.csd (no nset)            -> resolves to its OWNER
//   • owner nsets TEST -> some addr          -> resolves to that addr
//   • TEST is TRANSFERRED / BOUGHT (nxfer)   -> owner changes, addr CLEARS -> resolves to the NEW OWNER
//   • owner nsets TEST -> ZERO at height<V23 -> addr = 0x000..0 (old behavior; a "burn" pointer)
//   • owner nsets TEST -> ZERO at height>=V23 -> addr CLEARED -> resolves to the OWNER again (the unset)
import { spawnSync } from "node:child_process";
import {
  resolve, canonicalState, nameClaim, nameSet, nameXfer,
  V11_HEIGHT, V23_HEIGHT, V25_HEIGHT, ZERO_ADDR, TREASURY_ADDR, nameRegFee,
  NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS, EPOCH_LEN,
} from "../packages/cairnx/dist/index.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ FAIL: " + n)); if (c) console.log("  ✓ " + n); };

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const CAR = "0x" + "c3".repeat(20);
let seq = 0;
const txid = () => "0x" + String(++seq).padStart(64, "0");
const prop = (height, who, built, paidTo = {}) => ({
  kind: "propose", id: txid(), proposer: who, uri: built.uri, payloadHash: built.payloadHash,
  expiresEpoch: 9_999_999, height, pos: 0, paidTo,
});
const regFee = (name, h) => ({ [TREASURY_ADDR]: nameRegFee(name, h).toString() });
const reg = (h, who, name) => prop(h, who, nameClaim({ name }), regFee(name, h));
const setA = (h, who, name, addr) => prop(h, who, nameSet({ name, addr }));
const xfer = (h, who, name, to) => prop(h, who, nameXfer({ name, to }));

// JS vs Python canonical-state byte-identity (the fork check) for one event list + tip.
const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const pyCanon = (ev, tip) => {
  const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname],
    { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status) throw new Error(r.stderr);
  return JSON.parse(r.stdout).resolve[0];
};
const both = (label, ev, tip) => ok(`${label}: JS≡Python`, jsCanon(ev, tip) === pyCanon(ev, tip));
// the consensus send target = addr if set, else owner (mirrors service.resolveName)
const sendTarget = (ev, tip, name) => { const n = resolve(ev, tip).names[name]; return n ? (n.addr ?? n.owner) : null; };
const ownerOf = (ev, tip, name) => resolve(ev, tip).names[name]?.owner ?? null;
// primaryName, computed exactly as the resolver's service.primaryName (oldest self-pointing, by
// effectiveHeight then claimId). NOTE: the materialized NameState exposes `effectiveHeight`/`claimId`
// (resolve.ts emits `effectiveHeight: n.effHeight, claimId: n.id`), NOT the internal `effHeight`/`id`.
function primaryName(ev, tip, a) {
  const st = resolve(ev, tip); let best = null;
  for (const n of Object.values(st.names)) {
    if (n.owner !== a || n.addr !== a || n.expired === true || n.locked) continue;
    if (!best || n.effectiveHeight < best.effectiveHeight ||
        (n.effectiveHeight === best.effectiveHeight && n.claimId < best.claimId)) best = n;
  }
  return best ? best.name : null;
}

const PRE = Math.min(V25_HEIGHT, V23_HEIGHT) - 50;   // registration band: below V25 (pay-now OWNED, not a
                                                     // reservation) AND below V23 (so the pre-gate nset->ZERO
                                                     // literal case still holds); all >= V11.
const POST = V23_HEIGHT + 5;   // above the V23 gate (the CLEAR)
const TIP = V23_HEIGHT + 100;

console.log(`v23 nset-clear / forward-resolution (V11=${V11_HEIGHT}, V23=${V23_HEIGHT}, ZERO=${ZERO_ADDR.slice(0, 8)}…):`);

// ── 1. forward resolution: register (no nset) resolves to OWNER ──
{ const ev = [reg(PRE, ALICE, "test")];
  ok("register, no nset -> resolves to owner", sendTarget(ev, TIP, "test") === ALICE);
  both("register-no-nset", ev, TIP); }

// ── 2. owner nsets to a real addr -> resolves to that addr ──
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", BOB)];
  ok("nset -> real addr resolves there", sendTarget(ev, TIP, "test") === BOB);
  both("nset-real", ev, TIP); }

// ── 3. ★ THE USER'S CASE: buy/transfer TEST.csd -> resolves to the NEW OWNER ──
// nxfer is the transfer primitive (a paid offer fill clears addr + sets owner the same way).
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", ALICE), xfer(PRE + 2, ALICE, "test", BOB)];
  ok("after transfer/buy: owner is the buyer", ownerOf(ev, TIP, "test") === BOB);
  ok("after transfer/buy: addr CLEARED (no stale pointer)", resolve(ev, TIP).names["test"].addr == null);
  ok("after transfer/buy: send resolves to the NEW OWNER", sendTarget(ev, TIP, "test") === BOB);
  both("transfer-resolves-to-new-owner", ev, TIP); }
// new owner then re-points it at themselves -> still resolves to them
{ const ev = [reg(PRE, ALICE, "test"), xfer(PRE + 2, ALICE, "test", BOB), setA(PRE + 3, BOB, "test", BOB)];
  ok("new owner nsets self -> resolves to new owner", sendTarget(ev, TIP, "test") === BOB);
  both("new-owner-self-nset", ev, TIP); }
// a stranger cannot re-point a name they don't own
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, BOB, "test", BOB)];
  ok("non-owner nset is rejected (still resolves to owner)", sendTarget(ev, TIP, "test") === ALICE);
  both("non-owner-nset-rejected", ev, TIP); }

// ── 4. the V23 gate: nset->ZERO is a BURN pointer below the gate, a CLEAR at/after it ──
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", ZERO_ADDR)];
  ok("PRE-V23 nset->ZERO sets 0x000..0 (old behavior, byte-identical)", sendTarget(ev, TIP, "test") === ZERO_ADDR);
  both("pre-v23-zero-is-literal", ev, TIP); }
{ const ev = [reg(PRE, ALICE, "test"), setA(POST, ALICE, "test", ZERO_ADDR)];
  ok("V23 nset->ZERO CLEARS -> resolves to owner", sendTarget(ev, TIP, "test") === ALICE);
  ok("V23 cleared name has addr == undefined", resolve(ev, TIP).names["test"].addr == null);
  both("v23-zero-clears", ev, TIP); }
// boundary: exactly at V23_HEIGHT clears (>= gate); one below is literal
{ const evAt = [reg(PRE, ALICE, "test"), setA(V23_HEIGHT, ALICE, "test", ZERO_ADDR)];
  const evBelow = [reg(PRE, ALICE, "test"), setA(V23_HEIGHT - 1, ALICE, "test", ZERO_ADDR)];
  ok("boundary: height==V23 clears", sendTarget(evAt, TIP, "test") === ALICE);
  ok("boundary: height==V23-1 is literal 0x0", sendTarget(evBelow, TIP, "test") === ZERO_ADDR);
  both("v23-boundary-at", evAt, TIP); both("v23-boundary-below", evBelow, TIP); }

// ── 5. clear-then-reset: clear, then re-nset to a real addr, restores resolution ──
{ const ev = [reg(PRE, ALICE, "test"), setA(POST, ALICE, "test", CAR), setA(POST + 1, ALICE, "test", ZERO_ADDR), setA(POST + 2, ALICE, "test", BOB)];
  ok("clear then re-nset restores the new addr", sendTarget(ev, TIP, "test") === BOB);
  both("clear-then-reset", ev, TIP); }

// ── 6. ★ THE PRIMARY SWITCH the unset enables ──
// ALICE owns A (older) + B (newer), both pointed at self -> primary is the OLDEST (A). Clearing A at V23
// drops it from the candidate set -> primary becomes B. (The /names switch UI does exactly: clear old + set new.)
// fixture deliberately has the OLDEST name alphabetically LAST (zzz registered first, aaa second), so the
// assertion exercises the effectiveHeight tiebreak — not just code-unit name order.
{ const ev = [
    reg(PRE, ALICE, "zzz"), setA(PRE + 1, ALICE, "zzz", ALICE),       // OLDEST, alphabetically last
    reg(PRE + 2, ALICE, "aaa"), setA(PRE + 3, ALICE, "aaa", ALICE),   // newer, alphabetically first
  ];
  ok("primary is the OLDEST self-pointing name by effectiveHeight (zzz, NOT alphabetical aaa)", primaryName(ev, TIP, ALICE) === "zzz");
  const switched = [...ev, setA(POST, ALICE, "zzz", ZERO_ADDR)];   // un-point the old primary
  ok("after clearing zzz, primary switches to aaa", primaryName(switched, TIP, ALICE) === "aaa");
  ok("cleared zzz still resolves to its owner (sends safe)", sendTarget(switched, TIP, "zzz") === ALICE);
  both("primary-before-switch", ev, TIP); both("primary-after-switch", switched, TIP); }

// ── 7. only the owner can unset; a non-owner ZERO nset is rejected (no grief) ──
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", ALICE), setA(POST, BOB, "test", ZERO_ADDR)];
  ok("non-owner cannot clear someone else's record", sendTarget(ev, TIP, "test") === ALICE);
  both("non-owner-clear-rejected", ev, TIP); }

// ── 8. ★ EQUAL-effectiveHeight primary tiebreak by claimId, then clear the lower (audit: the one load-bearing
// switch path with zero automated coverage — primaryName is not in canonicalState so the fuzz never sees it) ──
{ const ev = [
    reg(PRE, ALICE, "nameone"), reg(PRE, ALICE, "nametwo"),           // SAME height -> equal effectiveHeight
    setA(PRE + 1, ALICE, "nameone", ALICE), setA(PRE + 1, ALICE, "nametwo", ALICE),
  ];
  ok("equal-height primary tiebreak picks the lower claimId (nameone, registered first)", primaryName(ev, TIP, ALICE) === "nameone");
  const sw = [...ev, setA(POST, ALICE, "nameone", ZERO_ADDR)];
  ok("clearing the lower-claimId primary switches to nametwo", primaryName(sw, TIP, ALICE) === "nametwo");
  both("equal-height-tiebreak", ev, TIP); both("equal-height-tiebreak-cleared", sw, TIP); }

// ── 9. clear the NEWER of two -> primary STAYS the oldest (no spurious identity flip) ──
{ const ev = [
    reg(PRE, ALICE, "old"), setA(PRE + 1, ALICE, "old", ALICE),
    reg(PRE + 2, ALICE, "new"), setA(PRE + 3, ALICE, "new", ALICE),
  ];
  ok("primary is the older name (old)", primaryName(ev, TIP, ALICE) === "old");
  const sw = [...ev, setA(POST, ALICE, "new", ZERO_ADDR)];            // clear the NON-primary newer name
  ok("clearing a non-primary name leaves primary unchanged (still old)", primaryName(sw, TIP, ALICE) === "old");
  both("clear-newer-primary-unchanged", sw, TIP); }

// ── 10. double-clear is idempotent ──
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", ALICE), setA(POST, ALICE, "test", ZERO_ADDR), setA(POST + 1, ALICE, "test", ZERO_ADDR)];
  ok("double-clear stays cleared (resolves to owner)", sendTarget(ev, TIP, "test") === ALICE);
  ok("double-clear leaves addr undefined", resolve(ev, TIP).names["test"].addr == null);
  both("double-clear", ev, TIP); }

// ── 11. clearing a never-nset name == a name that received no nset at all (the absent-addr invariant that
// makes the change need NO tip-gate; if one impl emitted addr:null vs the other omitting it, this forks) ──
{ const regEv = reg(PRE, ALICE, "test");                              // SAME registration event (same claimId) in both
  const cleared = [regEv, setA(POST, ALICE, "test", ZERO_ADDR)];
  const neverSet = [regEv];
  ok("clear-never-nset resolves to owner", sendTarget(cleared, TIP, "test") === ALICE);
  ok("a cleared never-nset name is byte-identical to a never-set name", jsCanon(cleared, TIP) === jsCanon(neverSet, TIP));
  both("clear-never-nset", cleared, TIP); }

// ── 12. clear-then-reset-to-SELF -> primary candidacy RETURNS ──
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", ALICE), setA(POST, ALICE, "test", ZERO_ADDR), setA(POST + 1, ALICE, "test", ALICE)];
  ok("clear then re-point at self restores the addr", sendTarget(ev, TIP, "test") === ALICE);
  ok("clear then re-point at self restores primary candidacy", primaryName(ev, TIP, ALICE) === "test");
  both("clear-then-reset-self", ev, TIP); }

// ── 13. clear THEN transfer -> new owner, addr stays absent (composes the new clear with nxfer's addr-clear) ──
{ const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", ALICE), setA(POST, ALICE, "test", ZERO_ADDR), xfer(POST + 1, ALICE, "test", BOB)];
  ok("clear-then-nxfer: owner is the new owner", ownerOf(ev, TIP, "test") === BOB);
  ok("clear-then-nxfer: resolves to the new owner (no stale pointer)", sendTarget(ev, TIP, "test") === BOB);
  both("clear-then-nxfer", ev, TIP); }

// ── 14. clearing a LAPSED name is REJECTED (the clear sits AFTER the v15 lapse gate; if a refactor moved it
// above the gate, one impl would clear + the other reject = fork) ──
{ const LAPSE_H = PRE + (NAME_TERM_EPOCHS + NAME_GRACE_EPOCHS + 2) * EPOCH_LEN;   // past term + grace
  const ev = [reg(PRE, ALICE, "test"), setA(PRE + 1, ALICE, "test", ALICE), setA(LAPSE_H, ALICE, "test", ZERO_ADDR)];
  const tip = LAPSE_H + 5;
  ok("clear on a LAPSED name is rejected (addr unchanged, NOT cleared)", resolve(ev, tip).names["test"].addr === ALICE);
  ok("the lapsed name materializes expired", resolve(ev, tip).names["test"].expired === true);
  both("clear-lapsed-rejected", ev, tip); }

console.log(`\nv23 nset-clear cross-lang: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
