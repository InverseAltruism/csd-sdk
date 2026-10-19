// Name records (v1.1+): commit-reveal registration, the v2.5 sealed reservation and v2.6 sealed recapture,
// finalize, transfer, set, profile and lease renewal, plus the lease arithmetic the other handlers read.
import { nameCommit } from "../records.js";
import {
  COMMIT_MAX_BLOCKS, MAX_PENDING_REG, NAME_GRACE_EPOCHS, NAME_TERM_EPOCHS, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS,
  V11_HEIGHT, V15_HEIGHT, V19_HEIGHT, V23_HEIGHT, V25_HEIGHT, V26_HEIGHT, ZERO_ADDR, epochOf, expiredClaimFee, nameRegFee,
  type NameCommitRecord, type NameFinalizeRecord, type NameProfileRecord, type NameRecord, type NameRenewRecord,
  type NameSetRecord, type NameXferRecord, type ProposeEvent,
} from "../types.js";
import type { NameRec, ResolveCtx } from "./context.js";

// ── v1.5 leases ── a name claimed pre-v1.5 is GRANDFATHERED one full term from activation
// (computed lazily — no state mutation at the activation boundary). A lease past its grace is
// LAPSED: the name is unowned again (premium re-claim; viaFill immunity does not survive a
// lapse — immunity protects a PAID basis, and an unpaid lease is an abandoned one).
const V15_EPOCH = epochOf(V15_HEIGHT);
export const paidThrough = (n: NameRec): number => n.paidThroughEpoch ?? (V15_EPOCH + NAME_TERM_EPOCHS);
export const lapsed = (n: NameRec, ep: number): boolean => ep > paidThrough(n) + NAME_GRACE_EPOCHS;
const inGrace = (n: NameRec, ep: number): boolean => ep > paidThrough(n) && !lapsed(n, ep);

// does anchor (effHeight, pos, id) STRICTLY precede an incumbent's (lowest wins)? The (effHeight, pos,
// id) lexicographic contest is the same at every name-displacement site; extracted so the comparator
// has one definition (ord/ev.id `<` is code-unit order, identical to the inline `ev.id < inc.id`).
const earlierAnchor = (effHeight: number, pos: number, id: string, inc: { effHeight: number; pos: number; id: string }): boolean =>
  effHeight < inc.effHeight || (effHeight === inc.effHeight && (pos < inc.pos || (pos === inc.pos && id < inc.id)));

export function applyNcommit(c: ResolveCtx, ev: ProposeEvent, rec: NameCommitRecord): void {
  const { commits, note } = c;
  const v11 = ev.height >= V11_HEIGHT;
  if (!v11) { note(ev, ev.id, "ncommit", false, "before v1.1 activation"); return; }
  const prev = commits.get(rec.commit);
  if (prev === undefined || ev.height < prev) commits.set(rec.commit, ev.height);
  note(ev, ev.id, "ncommit", true);
}

export function applyName(c: ResolveCtx, ev: ProposeEvent, rec: NameRecord, who: string, feeToTreasury: bigint): void {
  const { commits, names, recaptures, note, putName, voidOpenNameOffers } = c;
  const v11 = ev.height >= V11_HEIGHT;
  const v15 = ev.height >= V15_HEIGHT;
  const v25 = ev.height >= V25_HEIGHT;
  const v26 = ev.height >= V26_HEIGHT;
  if (!v11) { note(ev, ev.id, "name", false, "before v1.1 activation"); return; }
  // effective (anchor) height: a reveal back-dates to its commit height (front-run defense).
  // v2.5 couples the reveal window to REG_COMMIT_MAX_BLOCKS (the freeze), so no back-dated displacer
  // can arrive after nfinalize; below V25 the 8h COMMIT_MAX_BLOCKS window is unchanged (byte-identical).
  // v2.6 recapture reuses the same short window (its freeze == this window too). Since V26 >= V25 by
  // design, (v25 || v26) === v25, so this stays byte-identical below V25; the `|| v26` is a robustness
  // guard so the recapture freeze can never exceed its reveal window even under a misordered gate.
  const regWindow = (v25 || v26) ? REG_COMMIT_MAX_BLOCKS : COMMIT_MAX_BLOCKS;
  let effHeight = ev.height;
  if (rec.salt !== undefined) {
    const ch = nameCommit(rec.name, rec.salt, who);
    const cH = commits.get(ch);
    if (cH === undefined || cH >= ev.height || ev.height - cH > regWindow) {
      note(ev, ev.id, "name", false, "no valid in-window commit for this reveal"); return;
    }
    effHeight = cH;
  }
  const cur = names.get(rec.name);
  const epClaim = epochOf(ev.height);
  // v2.5: a pending reservation past its finalize window auto-expires — the name reopens (lazy, like a
  // lapsed lease). Below V25 no name is ever `pending`, so curActive === cur (pre-V25 byte-identical).
  const curActive = (cur && cur.pending && cur.finalizeBy !== undefined && ev.height > cur.finalizeBy) ? undefined : cur;
  // v1.5: a LAPSED lease makes the name unowned again — claimable by anyone at the
  // decaying premium (squat recapture). The prior holder's basis is void, BUT the premium
  // re-claim establishes a fresh PAID basis, so it is itself displacement-immune (viaFill):
  // without this, a griefer who pre-commits the name before the lapse could reveal a
  // back-dated claim within COMMIT_MAX_BLOCKS and take the just-reclaimed name from the
  // premium payer for only the base reg fee — stealing it AND bypassing the premium entirely.
  // (Recapture stays PAY-NOW until V26; a `pending` reservation holds no lease so it is never lapsed.)
  if (curActive && !curActive.pending && v15 && lapsed(curActive, epClaim)) {
    // v2.6 SEALED RECAPTURE: the lapsed-name reclaim is PAYMENT-FREE and reserves the name in the internal
    // `recaptures` map; the decaying premium moves to the winner-only nfinalize, so a lost recapture race
    // never burns the premium. Requires commit-reveal (salt). The lapsed record in `names` stays UNTOUCHED
    // (premium basis preserved; an abandoned reservation cannot bypass the premium). Below V26 this whole
    // branch is the unchanged pay-now reclaim (byte-identical).
    if (v26) {
      if (rec.salt === undefined) { note(ev, ev.id, "name", false, "v2.6: recapture requires a commit-reveal (salt)"); return; }
      const cr = recaptures.get(rec.name);
      const crActive = (cr && ev.height > cr.finalizeBy) ? undefined : cr;   // an expired reservation reopens
      // lowest (effHeight, pos, id) wins among recapture reservations (recaptures never carry viaFill).
      const better = !crActive || earlierAnchor(effHeight, ev.pos, ev.id, crActive);
      if (!better) { note(ev, ev.id, "name", false, "recapture already reserved (earlier anchor wins)"); return; }
      let myR = 0;                                                            // per-address recapture cap (anti-Sybil)
      for (const [nm, r] of recaptures) if (r.owner === who && nm !== rec.name && ev.height <= r.finalizeBy) myR++;
      if (myR >= MAX_PENDING_REG) { note(ev, ev.id, "name", false, "too many pending recaptures (max reached)"); return; }
      recaptures.set(rec.name, { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, finalizeBy: effHeight + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS });
      note(ev, ev.id, "name", true, crActive ? "recapture reserved (displaced prior reservation)" : "recapture reserved (pending finalize)");
      return;
    }
    // NOTE: this pay-now reclaim (the pre-V26 rule) is UNREACHABLE under production constants: the
    // earliest a lease can be `lapsed` is epoch > paidThrough + NAME_GRACE_EPOCHS, and the minimum
    // paidThrough (V15_EPOCH + NAME_TERM_EPOCHS) puts the first possible lapse near height ~316k, far
    // past V26 (51,200), so `v26` above is always true whenever `lapsed()` holds here. It is the
    // correct historical rule (mirrored in Python, kept for replay integrity), but no production event
    // sequence executes it, so no vector/fuzz can cover it.
    const fee = expiredClaimFee(rec.name, epClaim - (paidThrough(curActive) + NAME_GRACE_EPOCHS), ev.height);
    if (feeToTreasury < fee) { note(ev, ev.id, "name", false, "lapsed-name claim fee unpaid (decaying premium)"); return; }
    voidOpenNameOffers(rec.name, ev.height);
    putName(rec.name, { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, locked: false, viaFill: true, paidThroughEpoch: epClaim + NAME_TERM_EPOCHS });
    c.feesPaid += fee;
    note(ev, ev.id, "name", true, "lapsed lease re-claimed (premium)");
    return;
  }
  // v2.5 SEALED RESERVATION: the reveal is PAYMENT-FREE and creates a `pending` reservation; the reg fee
  // moves to a winner-only `nfinalize` (below). A losing reveal costs only its ~0.25 anchor. Registration
  // requires commit-reveal at V25 (no-salt direct-register is rejected: it can't be finalized).
  if (v25) {
    if (rec.salt === undefined) { note(ev, ev.id, "name", false, "v2.5: registration requires a commit-reveal (salt)"); return; }
    // lowest (effectiveHeight, pos, id) wins among live reservations/holders; a back-dated reveal displaces.
    // A finalized name (effHeight = its commit height, past the freeze) can never be displaced here: any
    // window-valid challenger has effHeight within REG_COMMIT_MAX_BLOCKS of now, hence strictly greater.
    const better = !curActive || (!curActive.viaFill && earlierAnchor(effHeight, ev.pos, ev.id, curActive));
    if (!better) { note(ev, ev.id, "name", false, curActive?.viaFill ? "name taken (purchased — not displaceable)" : "name taken (earlier anchor wins)"); return; }
    // per-address concurrent-reservation cap (anti-Sybil; excludes a re-reveal of THIS name; expired don't count).
    let myPending = 0;
    for (const [nm, n] of names) if (n.pending && n.owner === who && nm !== rec.name && n.finalizeBy !== undefined && ev.height <= n.finalizeBy) myPending++;
    if (myPending >= MAX_PENDING_REG) { note(ev, ev.id, "name", false, "too many pending reservations (max reached)"); return; }
    if (curActive) {
      voidOpenNameOffers(rec.name, ev.height);
    }
    putName(rec.name, { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, locked: false, pending: true, finalizeBy: effHeight + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS });
    note(ev, ev.id, "name", true, curActive ? "reserved (displaced prior reservation)" : "reserved (pending finalize)");
    return;
  }
  if (feeToTreasury < nameRegFee(rec.name, ev.height)) { note(ev, ev.id, "name", false, "name registration fee unpaid"); return; }
  const cand: NameRec = { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, locked: false,
    ...(v15 ? { paidThroughEpoch: epClaim + NAME_TERM_EPOCHS } : {}) };
  // lowest (effectiveHeight, pos, id) wins; a back-dated reveal can DISPLACE a squatter.
  // v1.3: displacement arbitrates claim-vs-claim ONLY — a record acquired by a paid fill
  // (viaFill, only ever set at v1.3+ fills) is immune, so a back-dated reveal can never
  // take a name from the innocent buyer of a completed sale (red-team H3).
  const better = !curActive || (!curActive.viaFill && earlierAnchor(effHeight, ev.pos, ev.id, curActive));
  if (!better) { note(ev, ev.id, "name", false, curActive?.viaFill ? "name taken (purchased — not displaceable)" : "name taken (earlier anchor wins)"); return; }
  if (curActive) {
    // displacement: void any open offer the wrongful holder made on this name. (The name
    // record itself is replaced below with locked:false, so the live name is never stuck;
    // releaseGive keeps lock-handling uniform with the cancel/expiry paths.)
    voidOpenNameOffers(rec.name, ev.height);
  }
  putName(rec.name, cand);
  c.feesPaid += nameRegFee(rec.name, ev.height);
  note(ev, ev.id, "name", true, curActive ? "displaced prior holder" : undefined);
}

export function applyNfinalize(c: ResolveCtx, ev: ProposeEvent, rec: NameFinalizeRecord, who: string, feeToTreasury: bigint): void {
  const { commits, names, recaptures, pendingNames, note, putName, voidOpenNameOffers } = c;
  const v25 = ev.height >= V25_HEIGHT;
  const v26 = ev.height >= V26_HEIGHT;
  // v2.5 winner-only register finalize: pay the reg fee AFTER the displacement contest is frozen, so a
  // losing reveal never pays. Promotes the reservation to a NORMAL registered name (NOT viaFill — a
  // finalized registration is not a purchase, and marking it viaFill would trip the wallet's namespv
  // caution on every fresh name; it is already displacement-immune by the freeze-window arithmetic).
  if (!v25) { note(ev, ev.id, "nfinalize", false, "before v2.5 activation"); return; }
  const n = names.get(rec.name);
  if (n && n.pending && n.owner === who) {
    // ── v2.5 REGISTRATION finalize (base fee) ──
    // salt binds the finalize to the reservation's own commit (self-contained; must re-derive that commit).
    const cH = commits.get(nameCommit(rec.name, rec.salt, who));
    if (cH === undefined || cH !== n.effHeight) { note(ev, ev.id, "nfinalize", false, "salt does not match the reservation commit"); return; }
    if (!(ev.height > n.effHeight + REG_COMMIT_MAX_BLOCKS)) { note(ev, ev.id, "nfinalize", false, "too early — displacement contest not yet frozen"); return; }
    if (n.finalizeBy !== undefined && ev.height > n.finalizeBy) { note(ev, ev.id, "nfinalize", false, "reservation expired"); return; }
    if (feeToTreasury < nameRegFee(rec.name, ev.height)) { note(ev, ev.id, "nfinalize", false, "name registration fee unpaid"); return; }
    // clear the reservation flags. `delete` (not `= undefined`) so the key is ABSENT, matching the
    // Python mirror's `.pop()` exactly: the materialization step rebuilds a fresh object either way,
    // so canonical output is unaffected, but this removes the JS-present-undefined vs Python-absent
    // asymmetry at the source instead of relying on every reader testing truthiness.
    delete n.pending;
    delete n.finalizeBy;
    pendingNames.delete(rec.name);
    n.paidThroughEpoch = epochOf(ev.height) + NAME_TERM_EPOCHS;
    c.feesPaid += nameRegFee(rec.name, ev.height);
    note(ev, ev.id, "nfinalize", true);
    return;
  }
  // ── v2.6 RECAPTURE finalize (decaying premium) ──
  // The reservation is in `recaptures`; the lapsed record is still in `names` (its paidThrough is the
  // premium basis). The winner pays the premium priced at the FINALIZE height (slightly more decayed =
  // favors the payer); the name becomes a NORMAL fresh lease (NOT viaFill — displacement-immune by the
  // freeze-window arithmetic, exactly like a registration finalize).
  const r = v26 ? recaptures.get(rec.name) : undefined;
  if (r && r.owner === who) {
    const cH = commits.get(nameCommit(rec.name, rec.salt, who));
    if (cH === undefined || cH !== r.effHeight) { note(ev, ev.id, "nfinalize", false, "salt does not match the recapture commit"); return; }
    if (!(ev.height > r.effHeight + REG_COMMIT_MAX_BLOCKS)) { note(ev, ev.id, "nfinalize", false, "too early — recapture contest not yet frozen"); return; }
    if (ev.height > r.finalizeBy) { note(ev, ev.id, "nfinalize", false, "recapture reservation expired"); return; }
    const cur = names.get(rec.name);
    const ep = epochOf(ev.height);
    if (!cur || cur.pending || !lapsed(cur, ep)) { recaptures.delete(rec.name); note(ev, ev.id, "nfinalize", false, "name is no longer lapsed"); return; }
    const fee = expiredClaimFee(rec.name, ep - (paidThrough(cur) + NAME_GRACE_EPOCHS), ev.height);
    if (feeToTreasury < fee) { note(ev, ev.id, "nfinalize", false, "recapture premium unpaid (decaying)"); return; }
    voidOpenNameOffers(rec.name, ev.height);
    putName(rec.name, { owner: who, effHeight: r.effHeight, pos: r.pos, id: r.id, height: r.height, locked: false, paidThroughEpoch: ep + NAME_TERM_EPOCHS });
    recaptures.delete(rec.name);
    c.feesPaid += fee;
    note(ev, ev.id, "nfinalize", true, "recapture finalized (premium)");
    return;
  }
  note(ev, ev.id, "nfinalize", false, "no matching pending reservation you own");
}

export function applyNxfer(c: ResolveCtx, ev: ProposeEvent, rec: NameXferRecord, who: string): void {
  const { names, note } = c;
  const v15 = ev.height >= V15_HEIGHT;
  const n = names.get(rec.name);
  if (!n || n.owner !== who) { note(ev, ev.id, "nxfer", false, "not the name owner"); return; }
  if (n.pending) { note(ev, ev.id, "nxfer", false, "name reservation not yet finalized"); return; }
  if (v15 && lapsed(n, epochOf(ev.height))) { note(ev, ev.id, "nxfer", false, "lease lapsed — claim it instead"); return; }
  if (n.locked) { note(ev, ev.id, "nxfer", false, "name is locked by an open offer"); return; }
  n.owner = rec.to.toLowerCase(); n.addr = undefined; n.profile = undefined; // ownership change clears the profile (doc 36)
  note(ev, ev.id, "nxfer", true);
}

export function applyNset(c: ResolveCtx, ev: ProposeEvent, rec: NameSetRecord, who: string): void {
  const { names, note } = c;
  const v15 = ev.height >= V15_HEIGHT;
  const v23 = ev.height >= V23_HEIGHT;
  const n = names.get(rec.name);
  if (!n || n.owner !== who) { note(ev, ev.id, "nset", false, "not the name owner"); return; }
  if (n.pending) { note(ev, ev.id, "nset", false, "name reservation not yet finalized"); return; }
  if (v15 && lapsed(n, epochOf(ev.height))) { note(ev, ev.id, "nset", false, "lease lapsed — claim it instead"); return; }
  if (v23 && rec.addr.toLowerCase() === ZERO_ADDR) n.addr = undefined;   // v2.3 unset: clear the record → name falls back to its owner
  else n.addr = rec.addr.toLowerCase();
  note(ev, ev.id, "nset", true);
}

export function applyNprofile(c: ResolveCtx, ev: ProposeEvent, rec: NameProfileRecord, who: string): void {
  const { names, note } = c;
  const v15 = ev.height >= V15_HEIGHT;
  const v19 = ev.height >= V19_HEIGHT;
  // v1.9 ENS-class identity (doc 36). INERT metadata — no value/fee/paidTo, never a send target
  // (the verified address stays in `nset`). Owner-gated, last-write-wins; an empty `p` clears it.
  // Cleared on every ownership change (nxfer/fill/reclaim) exactly like `addr`.
  if (!v19) { note(ev, ev.id, "nprofile", false, "before v1.9 activation"); return; }
  const n = names.get(rec.name);
  if (!n || n.owner !== who) { note(ev, ev.id, "nprofile", false, "not the name owner"); return; }
  if (n.pending) { note(ev, ev.id, "nprofile", false, "name reservation not yet finalized"); return; }
  if (v15 && lapsed(n, epochOf(ev.height))) { note(ev, ev.id, "nprofile", false, "lease lapsed — claim it instead"); return; }
  n.profile = Object.keys(rec.p).length ? { ...rec.p } : undefined;
  note(ev, ev.id, "nprofile", true);
}

export function applyNrenew(c: ResolveCtx, ev: ProposeEvent, rec: NameRenewRecord, who: string, feeToTreasury: bigint): void {
  const { names, note } = c;
  const v15 = ev.height >= V15_HEIGHT;
  if (!v15) { note(ev, ev.id, "nrenew", false, "nrenew needs v1.5"); return; }
  const n = names.get(rec.name);
  const ep = epochOf(ev.height);
  if (n && n.pending) { note(ev, ev.id, "nrenew", false, "name reservation not yet finalized"); return; }
  if (!n || lapsed(n, ep)) { note(ev, ev.id, "nrenew", false, "no live lease (lapsed names are claimed, not renewed)"); return; }
  // anyone may renew a LIVE lease (third-party gifting, ENS-style); in GRACE the owner
  // alone may — otherwise a squatter could extend a lapsing name they intend to take
  if (inGrace(n, ep) && who !== n.owner) { note(ev, ev.id, "nrenew", false, "grace period: only the owner may renew"); return; }
  if (feeToTreasury < nameRegFee(rec.name, ev.height)) { note(ev, ev.id, "nrenew", false, "renewal fee unpaid"); return; }
  n.paidThroughEpoch = paidThrough(n) + NAME_TERM_EPOCHS;
  c.feesPaid += nameRegFee(rec.name, ev.height);
  note(ev, ev.id, "nrenew", true, `paid through epoch ${n.paidThroughEpoch}`);
}
