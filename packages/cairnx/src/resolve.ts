// CairnX pure deterministic resolver (CONVENTION.md). (events, tipHeight) → CairnXState.
// No I/O, no clocks, no randomness, no float math on values: two resolvers fed the same chain
// prefix MUST produce byte-identical canonical state — that determinism IS the trust model. This is
// GUARDED (not merely asserted) by the JS⇄Python differential in conformance/: the raw regex-vs-regex
// check, the full parse gate, the nprofile cross-lang + constant-PARITY check, and the resolve fuzz —
// each byte-identical or the build fails.
//
// v1.1 adds: names (commit-reveal back-dated registrar + transfer + set + name offers) and
// protocol fees (deploy / name-reg / trade-taker) enforced by same-tx outputs to the treasury.
import { parseRecord } from "./records.js";
import {
  TREASURY_ADDR, V15_HEIGHT, V19_HEIGHT, V25_HEIGHT, V29_HEIGHT, beforeActivation, epochOf,
  type BalanceState, type BidState, type CairnXState, type ChainEvent, type NameState, type OfferState, type ProposeEvent,
  type TokenState,
} from "./types.js";
import { applyAttest } from "./resolve/attest.js";
import { createContext, ptAmt } from "./resolve/context.js";
import { applyBid, applyFclaim, applyOcancel, applyOffer } from "./resolve/market.js";
import {
  applyName, applyNcommit, applyNfinalize, applyNprofile, applyNrenew, applyNset, applyNxfer, lapsed, paidThrough,
} from "./resolve/names.js";
import { applyDeploy, applyMint, applyTmeta, applyTransfer } from "./resolve/tokens.js";

export { ptAmt };

// Ordinal (code-unit) string comparison — the ONLY comparator allowed anywhere in the resolver.
// localeCompare is ICU-collation-dependent and therefore non-reproducible across runtimes; a
// third-party (Rust/Go/…) resolver must be able to match byte-for-byte from plain byte order.
const ord = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function resolve(events: ChainEvent[], tipHeight: number): CairnXState {
  // consensus apply order: height asc; within a block all proposals (pos asc) then attests (pos asc);
  // final tiebreak = ordinal order of the lowercase 0x-hex id/txid (CONVENTION §3).
  const ordered = [...events].sort((a, b) =>
    a.height - b.height ||
    Number(a.kind === "attest") - Number(b.kind === "attest") ||
    a.pos - b.pos ||
    ord(
      a.kind === "propose" ? (a as ProposeEvent).id : (a as ChainEvent & { txid: string }).txid,
      b.kind === "propose" ? (b as ProposeEvent).id : (b as ChainEvent & { txid: string }).txid,
    ),
  );
  // v2.9 (§32, V29 / REBIND M4): drop a DUPLICATED event before apply. The ordering step above sorts but never
  // de-dupes, so a double-fed transaction (an overlapping scanner page: cairnx/src/scan.ts pushes pages verbatim)
  // applies twice and double-credits o.paid / o.delivered on the partial-fill path. A transaction has ONE identity
  // (a propose's id / an attest's txid), so a duplicate is the SAME id/txid appearing twice; the first in consensus
  // order is kept, the rest dropped. GATED on the event's OWN height (>= V29): below the gate NOTHING is dropped, so
  // every pre-V29 replay (incl. every pinned vector and the live tip) is byte-identical, and a duplicate pair shares
  // one txid == one block, so both copies always land on the SAME side of the gate. Still moves canonical state (a
  // duplicated feed no longer double-applies), so it rides the SAME gate as M5. The cairnx-service-side de-dup on
  // the attestation pull (scan.ts) is a separate, un-gated defensive change; only this resolve() half is gated.
  const eid = (e: ChainEvent): string => e.kind === "propose" ? (e as ProposeEvent).id : (e as ChainEvent & { txid: string }).txid;
  const seenIds = new Set<string>();
  const applied: ChainEvent[] = [];
  for (const e of ordered) {
    if (e.height >= V29_HEIGHT) { const k = eid(e); if (seenIds.has(k)) continue; seenIds.add(k); }
    applied.push(e);
  }

  const c = createContext();
  const { tokens, balances, names, recaptures, offers, bids, fclaims, log, note, sweepExpired } = c;
  let pendingBlock = -1;
  const applyPendingCancels = () => { for (const f of c.pendingCancels) f(); c.pendingCancels = []; };

  for (const ev of applied) {
    if (beforeActivation(ev.height)) continue;
    if (ev.height !== pendingBlock) { applyPendingCancels(); pendingBlock = ev.height; }
    sweepExpired(ev.height);
    const feeToTreasury = ev.kind === "propose" ? ptAmt((ev.paidTo ?? {})[TREASURY_ADDR]) : 0n;

    if (ev.kind === "propose") {
      const rec = parseRecord(ev.uri, ev.payloadHash);
      if (!rec) { note(ev, ev.id, "invalid", false, "unparseable/non-canonical record"); continue; }
      const who = ev.proposer.toLowerCase();
      switch (rec.t) {
        case "deploy": applyDeploy(c, ev, rec, who, feeToTreasury); break;
        case "mint": applyMint(c, ev, rec, who); break;
        case "transfer": applyTransfer(c, ev, rec, who); break;
        case "tmeta": applyTmeta(c, ev, rec, who); break;
        case "ncommit": applyNcommit(c, ev, rec); break;
        case "name": applyName(c, ev, rec, who, feeToTreasury); break;
        case "nfinalize": applyNfinalize(c, ev, rec, who, feeToTreasury); break;
        case "nxfer": applyNxfer(c, ev, rec, who); break;
        case "nset": applyNset(c, ev, rec, who); break;
        case "nprofile": applyNprofile(c, ev, rec, who); break;
        case "nrenew": applyNrenew(c, ev, rec, who, feeToTreasury); break;
        case "offer": applyOffer(c, ev, rec, who); break;
        case "bid": applyBid(c, ev, rec, who); break;
        case "ocancel": applyOcancel(c, ev, rec, who); break;
        case "fclaim": applyFclaim(c, ev, rec, who); break;
      }
    } else {
      applyAttest(c, ev);
    }
  }

  applyPendingCancels();   // flush the final block's deferred cancels before the closing sweep
  // Closing sweep at tipHeight + 1 (NOT tipHeight): materialized state must reflect everything expired AS OF
  // the tip, and an offer whose effExpiry epoch == epochOf(tip) is expired at the FIRST height of the next
  // epoch. Using tip+1 makes the materialized view agree with the event side (a fill submitted at tip+1 would
  // be rejected). Mirrored in cairnx_ref.py (sweep_expired(tip_height + 1)); pinned by the vectors.
  sweepExpired(tipHeight + 1);

  // ── materialize canonical state (sorted; values as decimal strings) ──
  const tokensOut: Record<string, TokenState> = {};
  for (const [t, tok] of [...tokens.entries()].sort(([a], [b]) => ord(a, b))) tokensOut[t] = { ...tok.meta, minted: tok.minted.toString() };
  const balancesOut: Record<string, Record<string, BalanceState>> = {};
  for (const [t, m] of [...balances.entries()].sort(([a], [b]) => ord(a, b))) {
    const inner: Record<string, BalanceState> = {};
    for (const [a, b] of [...m.entries()].sort(([x], [y]) => ord(x, y))) {
      if (b.available === 0n && b.locked === 0n) continue;
      inner[a] = { available: b.available.toString(), locked: b.locked.toString() };
    }
    if (Object.keys(inner).length) balancesOut[t] = inner;
  }
  const namesOut: Record<string, NameState> = {};
  const tipV15 = tipHeight >= V15_HEIGHT;
  const tipV19 = tipHeight >= V19_HEIGHT;
  const tipV25 = tipHeight >= V25_HEIGHT;
  const tipEpoch = epochOf(tipHeight);
  for (const [nm, n] of [...names.entries()].sort(([a], [b]) => ord(a, b))) {
    if (tipV25 && n.pending) {
      // v2.5 reservation: a minimal shape (no addr/viaFill/profile/lease — it holds none yet). The closing sweep
      // drops any reservation past finalizeBy, so a materialized `pending` name is always still finalizable
      // (finalizeBy > tipHeight). Emitted only at v2.5+ tips, so every pre-v2.5 canonical hash is byte-identical.
      namesOut[nm] = { name: nm, owner: n.owner, claimId: n.id, height: n.height, effectiveHeight: n.effHeight, locked: n.locked, pending: true as const, finalizeBy: n.finalizeBy! };
      continue;
    }
    namesOut[nm] = { name: nm, owner: n.owner, claimId: n.id, height: n.height, effectiveHeight: n.effHeight, locked: n.locked, ...(n.addr ? { addr: n.addr } : {}), ...(n.viaFill ? { viaFill: true as const } : {}),
      // v1.9 profile materialized at v1.9+ tips ONLY (the apply is also gated) → every pre-v1.9 canonical
      // hash stays byte-identical; absent when empty/unset.
      ...(tipV19 && n.profile ? { profile: n.profile } : {}),
      // lease fields exist only at v1.5+ tips so every pre-v1.5 canonical hash stays pinned
      ...(tipV15 ? { paidThroughEpoch: paidThrough(n), ...(lapsed(n, tipEpoch) ? { expired: true as const } : {}) } : {}) };
  }
  const offersOut: Record<string, OfferState> = {};
  for (const [id, o] of [...offers.entries()].sort(([a], [b]) => ord(a, b))) offersOut[id] = o;
  const bidsOut: Record<string, BidState> = {};
  for (const [id, b] of [...bids.entries()].sort(([a], [b2]) => ord(a, b2))) bidsOut[id] = b;
  // v2.6: the recapture reservations are a DIAGNOSTIC surface (like `events`) — EXCLUDED from canonicalState
  // (see below), so zero fork surface. The cairnx service exposes it so a wallet/UI can confirm it is still the
  // current recapture winner BEFORE spending the premium at nfinalize (a finalize by a reserver who was
  // displaced in the reserve->freeze window would burn the premium; this lets the client refuse that).
  const recapturesOut: Record<string, { owner: string; effectiveHeight: number; finalizeBy: number }> = {};
  for (const [nm, r] of [...recaptures.entries()].sort(([a], [b]) => ord(a, b))) recapturesOut[nm] = { owner: r.owner, effectiveHeight: r.effHeight, finalizeBy: r.finalizeBy };

  // v2.8: materialize the GRANTED fclaims (drop the `granted` flag; denials live only in the events log for the
  // money-safety audit). Sorted by txid for determinism. Diagnostic surface, EXCLUDED from canonicalState, so
  // every pre-V28 replay hash is byte-identical (no grants exist below the gate).
  const fclaimsOut: Record<string, { offer: string; proposer: string; expiresEpoch: number; height: number }> = {};
  for (const [txid, fc] of [...fclaims.entries()].sort(([a], [b]) => ord(a, b))) if (fc.granted) fclaimsOut[txid] = { offer: fc.offer, proposer: fc.proposer, expiresEpoch: fc.expiresEpoch, height: fc.height };
  return { tipHeight, tokens: tokensOut, balances: balancesOut, names: namesOut, offers: offersOut, bids: bidsOut, recaptures: recapturesOut, fclaims: fclaimsOut, events: log, feesPaid: c.feesPaid.toString() };
}

/** Canonical serialization of state (FORMAT 2) — byte-identical across honest resolvers.
 *  The canonical surface is the DATA ONLY: {tipHeight, tokens, balances, names, offers, bids,
 *  feesPaid}. The applied-event log is deliberately EXCLUDED — its free-text reason strings are
 *  implementation diagnostics, and making them normative would force every third-party resolver
 *  to reproduce English prose byte-for-byte. (Format 1, pre-2026-06-12, included the log and
 *  sorted with localeCompare; pinned format-1 hashes live in test/vectors/replay-hashes.json
 *  history.) Keys sort in ordinal (code-unit) order at every depth. */
export function canonicalState(s: CairnXState): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => ord(a, b)).map(([k, x]) => [k, sortKeys(x)]));
    }
    return v;
  };
  // `events`, `recaptures`, and `fclaims` are diagnostic surfaces, NOT canonical (recaptures + fclaims are
  // internal + wallet/UI-facing only). Excluding them keeps the hash byte-identical to history and to any
  // resolver that omits them; every pre-V28 replay hash is unchanged (no pre-V28 offer carries claimTxid).
  const { events: _events, recaptures: _recaptures, fclaims: _fclaims, ...data } = s;
  return JSON.stringify(sortKeys(data));
}
