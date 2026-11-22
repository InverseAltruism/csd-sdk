// CairnX name-history hints: the service half of the trustless name verifier.
//
// Given the full scanned event stream and a name, return the name-scoped set of chain txids a client must verify and
// replay. This module selects txids and checks nothing itself; everything it returns is an UNTRUSTED HINT. The checks
// are the client's: the Cairn Wallet's name verify (cairn-wallet src/core/namespv.ts) fetches each block the hints
// touch, requires its rebuilt merkle root to equal the header of a chain it PoW-verified itself, authenticates each
// signer, re-runs the same `resolve()` over those events and compares the result with the served (owner, addr). That
// defeats a fabricated mapping: a service has no signed, mined events for an address nobody registered.
//
// KNOWN RESIDUAL: inclusion-verified replay does not prove completeness. A service can WITHHOLD events: hide a later
// nxfer or nset so a stale real mapping shows, or hide the winning claim so a real, mined but losing claim resolves.
// The wallet keeps a loud caution and a second-source cross-check; this module makes no completeness claim.
//
// SUFFICIENCY INVARIANT (the property that makes the verify sound), proven by the equivalence fuzz in
// test/namehist.test.ts: for every name, replaying ONLY these events reproduces the SAME name record
// as replaying the full chain:
//     resolve(pick(events, nameHistory(events, name))).names[name]  ===  resolve(events).names[name]
// Erring toward INCLUDING a borderline event is safe (extra non-name events never change names[name]);
// OMITTING a relevant one is the only hazard, which the fuzz is built to surface. With `check`, a candidate that
// neither the full replay nor the scoped replay applied is dropped, and only when the drop leaves the scoped record
// unchanged (keepPruned). A bare ocancel is logged applied whether or not it cancels anything, so of a seller's
// ocancels only the first one after each of its kept offers, while that offer is open, stays. Of the address and
// profile records only the last applied one of each, when no transfer or sale follows it, stays (dropSuperseded).
// What can still grow the hints is applied records: a holder's other records while it holds the name (they stay
// after a transfer), and the third-party renewals a live lease accepts (test/namehist-prune.test.ts).
//
// EXCEPTION: the sufficiency invariant DOES NOT HOLD for a name whose ownership was set by a name-offer fill whose
// validity depends on state OUTSIDE the name's own events. Two classes: (1) a V17 OPEN-lane (non-taker) CSD
// claim-to-fill, valid only if the filler held a LIVE claim, and a claim's validity depends on the filler's GLOBAL
// live-claim count across OTHER offers (`liveN < MAX_ACTIVE_CLAIMS`); (2) a name-for-TOKEN offer fill, valid only if
// the buyer held enough of the want-token (their GLOBAL token balance). Both need events no name-scoped subset can
// contain, so a scoped replay can reach a DIFFERENT owner than the chain (accept a fill it rejected, or reject one it
// accepted). For both, nameHistory returns `scopedReplaySufficient:false` and the wallet MUST fail closed (never
// `verified`; a second source runs this same selector → the same subset, so it can't help). Only the common
// taker-bound CSD name sale is sound (taker in the offer record, payment in the fill tx): that is what the fuzz
// exercises; directed regression cases for BOTH unsound classes are in namehist.test.ts. The wallet refuses
// `verified` whenever this flag is false (cairn-wallet `src/core/namespv.ts`); from V28 the open lane's claim is
// `fclaim`.
//
// This is NOT a resolver mirror: it computes no ledger state. It is a pure selector that REUSES the
// canonical record parser to decide which txids matter for one name.
import { isName, nameCommit, parseRecord } from "@inversealtruism/cairnx-core";
import { resolve } from "@inversealtruism/cairnx-core";
import { EPOCH_LEN, isNameGive, isTokenWant, SCORE_CANCEL, SCORE_CLAIM, SCORE_FILL, type AppliedEvent, type CairnXState, type ChainEvent, type NameState, type ProposeEvent } from "@inversealtruism/cairnx-core";
import { applyOrder } from "./order.js";

export type NameEventKind = "name" | "nfinalize" | "ncommit" | "nxfer" | "nset" | "nrenew" | "nprofile" | "offer" | "fill" | "cancel" | "claim" | "fclaim" | "ocancel" | "attest"; // "attest" = an attest with a non-fill/cancel/claim score (labeled honestly, never defaulted to "fill"). "fclaim" = the V28+ open-lane reserve Propose, the fclaim-lane successor to "claim"; label vocabulary only here (this selector does not route the fill-attest-on-the-fclaim-txid, so a fclaim-lane name sale surfaces scopedReplaySufficient:false, failing closed).

export interface NameHistEntry {
  txid: string;     // the consensus txid the wallet must fetch + merkle-verify
  height: number;
  pos: number;
  kind: NameEventKind; // diagnostic only: the wallet re-derives meaning from the verified record itself
}

export interface NameHistory {
  name: string;
  events: NameHistEntry[];
  /** `false` when this name's ownership was decided by a name-offer fill whose on-chain validity depends on state
   *  OUTSIDE the name's own events, so a name-scoped replay can reach a DIFFERENT owner than the real chain (it can
   *  accept a fill the chain rejected, or reject one it accepted): the two classes of the header's EXCEPTION, and any
   *  difference the `check` compare finds. A wallet MUST NOT treat a scoped-replay match as `verified:true` when this
   *  is false: fail closed to a loud caution (a second source does not help: it runs the same selector → the same
   *  subset). */
  scopedReplaySufficient: boolean;
  caveat?: string;
}

/** Opt-in EXACT sufficiency check. When provided, nameHistory replays its
 *  own scoped subset through the real pinned `resolve()`, keeps only the records that replay or the full chain
 *  applied, and compares the resulting `names[name]` against the full chain's: any divergence flags
 *  `scopedReplaySufficient:false`. */
export interface NameHistoryCheck {
  /** the tip height BOTH replays are evaluated at (the caller's current tip). */
  tipHeight: number;
  /** the full-chain `resolve(events, tipHeight).names[name]`, when the caller already holds it (the
   *  service passes its memoized state record; `undefined` meaning "unregistered on the full chain" is
   *  meaningful and distinct from omission). Omit the KEY entirely (library mode) to have nameHistory
   *  compute the full side itself with one linear resolve(). */
  fullRecord?: NameState;
  /** `appliedIds(resolve(events, tipHeight).events)`, when the caller already holds that state (the service memoizes
   *  it per state). Omitted, nameHistory computes it with one linear resolve(). */
  fullApplied?: ReadonlySet<string>;
}

/** The ids (lowercased) of the events a replay applied: at least one `ok: true` entry in its log. A record with no
 *  entry, or only refused ones, changed nothing in that replay. */
export function appliedIds(log: readonly AppliedEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of log) if (e.ok) out.add(e.id.toLowerCase());
  return out;
}

/** A selected record and what its relevance to the name hangs on. */
interface Pick extends NameHistEntry {
  /** the record as the stream carries it: its raw id is resolve()'s tie-break, `txid` is lowercased */
  ev: ChainEvent;
  /** offers: the proposer; ocancels: the proposer, whose name offers it can cancel. */
  seller?: string;
  /** offers: a fill depends on state outside the name's events (open lane, or a token want). */
  unsound?: boolean;
  /** attests: the offer attested. */
  offer?: string;
  /** attests: a score-100 fill. */
  fill?: boolean;
  /** attests: a score-0 cancel. */
  cancel?: boolean;
  /** offers: the first height its own expiry closes it at. */
  openUntil?: number;
  /** ncommits: the commitment hash, which the reveals and finalizes that select it name. */
  commitHash?: string;
}

const eventId = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
const subset = (events: readonly ChainEvent[], ids: ReadonlySet<string>) => events.filter((e) => ids.has(eventId(e)));
const sameRecord = (a: NameState | undefined, b: NameState | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const NAME_KINDS = new Set<NameEventKind>(["name", "nfinalize", "nxfer", "nset", "nrenew", "nprofile", "offer"]);

/** Every record that can bear on `name`, chosen by its syntax alone: the name's own records, the offers giving it,
 *  the commits its reveals and finalizes name, the attests on those offers and the ocancels of their proposers. */
interface Candidates {
  picked: Map<string, Pick>;
  /** commitment hash -> the ids of the reveals and finalizes that name it (each listed once, never per commit) */
  revealsByHash: Map<string, string[]>;
}

function selectCandidates(events: readonly ChainEvent[], name: string): Candidates {
  const ncommitByHash = new Map<string, ProposeEvent[]>();
  const picked = new Map<string, Pick>();
  const reveals: Array<{ id: string; salt: string; proposer: string }> = [];
  const sellers = new Set<string>();
  const add = (ev: ChainEvent, kind: NameEventKind, extra: Partial<Pick> = {}): Pick => {
    const k = eventId(ev);
    let p = picked.get(k);
    if (!p) { p = { txid: k, height: ev.height, pos: ev.pos, kind, ev, ...extra }; picked.set(k, p); }
    return p;
  };

  // Pass 1: index ncommits, collect the name's own records and any offer that GIVES this name.
  for (const ev of events) {
    if (ev.kind !== "propose") continue;
    const rec = parseRecord(ev.uri, ev.payloadHash);
    if (!rec) continue;
    if (rec.t === "ncommit") {
      const list = ncommitByHash.get(rec.commit) ?? [];
      list.push(ev);
      ncommitByHash.set(rec.commit, list);
    } else if ((rec.t === "name" || rec.t === "nfinalize" || rec.t === "nxfer" || rec.t === "nset" || rec.t === "nrenew" || rec.t === "nprofile") && rec.name === name) {
      // `nprofile` sets names[name].profile and `nfinalize` promotes a reservation to an owned name: both are part
      // of the canonical record, so both must be in scope for the scoped replay to reproduce it.
      add(ev, rec.t);
      if ((rec.t === "name" || rec.t === "nfinalize") && typeof rec.salt === "string") reveals.push({ id: eventId(ev), salt: rec.salt, proposer: ev.proposer.toLowerCase() });
    } else if (rec.t === "offer" && isNameGive(rec.give) && rec.give.name === name) {
      // A fill is scoped-unsound if the offer is non-taker (claim-cap state) OR token-want (buyer balance).
      add(ev, "offer", {
        seller: ev.proposer.toLowerCase(), unsound: rec.taker === undefined || isTokenWant(rec.want),
        openUntil: (ev.expiresEpoch + 1) * EPOCH_LEN,
      });
      sellers.add(ev.proposer.toLowerCase());
    }
  }

  // Pass 2: the matching commit for each back-dated reveal or finalize (the reveal back-dates effectiveHeight to its
  // commit, and the commit-window check needs the commit present to validate the same way). Grouped by commitment
  // hash, so copies of one hash and reveals naming it cost their sum, not their product
  // (test/namehist-commit-bound.test.ts).
  const revealsByHash = new Map<string, string[]>();
  for (const r of reveals) {
    const h = nameCommit(name, r.salt, r.proposer);
    const ids = revealsByHash.get(h);
    if (ids) ids.push(r.id);
    else revealsByHash.set(h, [r.id]);
  }
  for (const h of revealsByHash.keys()) for (const c of ncommitByHash.get(h) ?? []) add(c, "ncommit", { commitHash: h });

  // Pass 3: attests on this name's offers (fill/cancel/claim), and any ocancel by a name-offer seller that could
  // release a name-offer's lock (a bare ocancel cancels ALL the seller's open offers; a name-targeted one hits this
  // name). A ticker-targeted ocancel can never touch a name offer.
  for (const ev of events) {
    if (ev.kind === "attest") {
      const offer = ev.proposalId.toLowerCase();
      if (picked.get(offer)?.kind !== "offer") continue;
      // an unknown score is labeled "attest" (diagnostic honesty), never defaulted to "fill"
      const kind: NameEventKind = ev.score === SCORE_FILL ? "fill" : ev.score === SCORE_CANCEL ? "cancel" : ev.score === SCORE_CLAIM ? "claim" : "attest";
      add(ev, kind, { offer, fill: ev.score === SCORE_FILL, cancel: ev.score === SCORE_CANCEL });
    } else if (sellers.size) {
      const rec = parseRecord(ev.uri, ev.payloadHash);
      if (rec?.t === "ocancel" && sellers.has(ev.proposer.toLowerCase()) && (rec.name === name || (rec.name === undefined && rec.ticker === undefined))) {
        add(ev, "ocancel", { seller: ev.proposer.toLowerCase() });
      }
    }
  }
  return { picked, revealsByHash };
}

/** resolve()'s apply order over the records as the stream carries them (raw ids, not the lowercased keys). */
const order = (a: Pick, b: Pick) => applyOrder(a.ev, b.ev);
const before = (a: Pick, b: Pick) => order(a, b) < 0;

/** The candidates a client must replay: a record either replay applied, whatever its kind. The name's own records and
 *  its offers stand on their own; an attest also needs its offer kept, and of the commits a kept reveal or finalize
 *  names only the earliest is kept (copies of a public hash are applied too). An ocancel is logged applied even when it cancels nothing, so per kept offer of its seller only the first
 *  one after the offer, before the offer closed (its expiry, or a fill or cancel a replay applied), is kept. A record
 *  that is a no-op in both replays changed nothing either replay can see; dropping it is
 *  checked by keepPruned. */
function keptIds({ picked, revealsByHash }: Candidates, applied: (id: string) => boolean): Set<string> {
  const kept = new Set<string>();
  for (const [id, p] of picked) if (NAME_KINDS.has(p.kind) && applied(id)) kept.add(id);
  for (const [id, p] of picked) if (!kept.has(id) && applied(id) && p.offer !== undefined && kept.has(p.offer)) kept.add(id);
  // A commitment hash is public once posted and a copy is logged applied too; a reveal or finalize needs only the
  // earliest commit of its hash (resolve() keeps the lowest height), so only that one is kept.
  const firstCommit = new Map<string, Pick>();   // commitment hash -> its earliest applied commit
  for (const [id, p] of picked) {
    if (p.kind !== "ncommit" || !applied(id)) continue;
    const cur = firstCommit.get(p.commitHash!);
    if (!cur || before(p, cur)) firstCommit.set(p.commitHash!, p);
  }
  for (const [h, ids] of revealsByHash) {
    const c = firstCommit.get(h);
    if (c && ids.some((r) => kept.has(r))) kept.add(c.txid);
  }
  const closes = new Map<string, number>();   // kept offer id -> first height it is no longer open
  for (const id of kept) {
    const p = picked.get(id)!;
    if (p.kind === "offer") closes.set(id, Math.min(closes.get(id) ?? Infinity, p.openUntil!));
    else if (p.offer !== undefined && (p.fill || p.cancel)) closes.set(p.offer, Math.min(closes.get(p.offer) ?? Infinity, p.height));
  }
  const ocancels = [...picked.values()].filter((p) => p.kind === "ocancel" && applied(p.txid)).sort(order);
  for (const [id, closesAt] of closes) {
    const o = picked.get(id)!;
    const first = ocancels.find((c) => c.seller === o.seller && before(o, c) && c.height < closesAt);
    if (first) kept.add(first.txid);
  }
  return kept;
}

/** The record fields each kind writes whole or clears when the scoped replay applies it (cairnx-core
 *  resolve/names.ts applyNset, applyNprofile and applyNxfer; resolve/attest.ts deliverNameToBuyer for a fill of the
 *  name's offer). Nothing in the replay reads `addr` or `profile`, so these writes decide them alone. `name` and
 *  `nfinalize` are left out: a recapture reservation is applied without touching the record. */
const WRITES: Partial<Record<NameEventKind, readonly ("nset" | "nprofile")[]>> = {
  nset: ["nset"], nprofile: ["nprofile"], nxfer: ["nset", "nprofile"], fill: ["nset", "nprofile"],
};

/** `kept` without each nset and nprofile that a later kept record the scoped replay applies overwrites or clears:
 *  the record's address is the last applied nset's after the last transfer or sale, or none, and so for the profile.
 *  The latest record of the walk stays, so the hints' highest height does not move. */
function dropSuperseded(picked: ReadonlyMap<string, Pick>, kept: ReadonlySet<string>, scopedApplied: (id: string) => boolean): Set<string> {
  const out = new Set(kept);
  const walk = [...kept].map((id) => picked.get(id)!).filter((p) => WRITES[p.kind]).sort((a, b) => order(b, a));
  const written = new Set<"nset" | "nprofile">();   // the fields a later applied record writes or clears
  for (const p of walk) {
    if ((p.kind === "nset" || p.kind === "nprofile") && written.has(p.kind)) out.delete(p.txid);
    if (scopedApplied(p.txid)) for (const f of WRITES[p.kind]!) written.add(f);
  }
  return out;
}

/** The first of `prunes` (subsets of `selected`, smallest first) whose replay gives `name` the record `selectedRecord`
 *  (the replay of all of `selected`), else `selected`: a prune never changes the record a client's replay of the hints
 *  reaches, and a rejected prune falls back to the next larger one (test/namehist-prune.test.ts). */
export function keepPruned(events: readonly ChainEvent[], name: string, tipHeight: number, selected: ReadonlySet<string>,
  prunes: readonly ReadonlySet<string>[], selectedRecord: NameState | undefined): ReadonlySet<string> {
  for (const kept of prunes) {
    if (kept.size === selected.size) return selected;
    if (sameRecord(resolve(subset(events, kept), tipHeight).names[name], selectedRecord)) return kept;
  }
  return selected;
}

/** The ordered, name-scoped txids a wallet must verify+replay to recompute `name`'s ownership. Without `check` nothing
 *  is replayed: the hints are every candidate and a fill on a scoped-unsound offer flags the name by its syntax. */
export function nameHistory(events: ChainEvent[], name: string, check?: NameHistoryCheck): NameHistory {
  if (!isName(name)) return { name, events: [], scopedReplaySufficient: true };
  const candidates = selectCandidates(events, name);
  const { picked } = candidates;
  const unsoundFill = (id: string) => { const p = picked.get(id)!; return p.fill === true && picked.get(p.offer!)?.unsound === true; };
  const all = new Set(picked.keys());
  let ids: ReadonlySet<string> = all;
  let scopedInsufficient: boolean;
  // The EXACT sufficiency compare, generalizing the class flags. The class flags
  // enumerate KNOWN out-of-scope dependencies (open-lane claim cap, buyer token balance); V25 added a third (the
  // proposer's global MAX_PENDING_REG pending-reservation cap, the forged-green `verified:true` shape), and any future
  // gate could add more. So the scoped subset is replayed through the real pinned resolve() and its names[name]
  // compared with the full chain's; any divergence, including "unregistered on the full chain but registered in the
  // scoped view", flags scopedReplaySufficient:false. Both records come out of the same materializer at the same tip,
  // so a stringify compare is sound. It holds at that tip; at a later tip only owner and address are claimed: a hold
  // granted by an fclaim (not selected) can keep an offer open in the full chain that the scoped replay cancels, so
  // `locked` may differ once a later offer expires (test/namehist-prune.test.ts, "documented limit").
  let compareInsufficient = false;
  if (check) {
    const scoped = resolve(subset(events, all), check.tipHeight);
    let full: CairnXState | undefined;
    const fullState = () => (full ??= resolve(events, check.tipHeight));
    const fullApplied = check.fullApplied ?? appliedIds(fullState().events);
    const fullRec = "fullRecord" in check ? check.fullRecord : fullState().names[name];
    const scopedApplied = appliedIds(scoped.events);
    // A record a stranger can anchor for a fee and that neither replay applies (a non-owner's nset, a refused offer
    // of the name and the attests on it, its proposer's ocancels) must not grow the hints past a wallet's cap or flag
    // the name. A record only one replay applies stays: it is how an out-of-scope dependency shows.
    const applied = (id: string) => fullApplied.has(id) || scopedApplied.has(id);
    // The superseded-record prune, else the applied-record prune alone, else the whole selection: a rejected
    // superseded-record prune serves no more than the applied-record prune.
    const appliedKept = keptIds(candidates, applied);
    const latest = dropSuperseded(picked, appliedKept, (id) => scopedApplied.has(id));
    ids = keepPruned(events, name, check.tipHeight, all, latest.size < appliedKept.size ? [latest, appliedKept] : [appliedKept], scoped.names[name]);
    // The class flags keep marking where an adversarially WITHHELD subset can diverge even when this server's own
    // subset does not, but only for a fill a replay applied: a refused fill decided nothing. Kept ids are applied
    // already; `applied(id)` matters only when keepPruned fell back to the whole selection, which no known record
    // shape reaches (out-of-scope fclaim holds are not selected; same-block fills and cancels close an offer first),
    // so no test drives it. It stays so the fallback keeps the same rule.
    scopedInsufficient = [...ids].some((id) => unsoundFill(id) && applied(id));
    compareInsufficient = !sameRecord(scoped.names[name], fullRec);
  } else {
    scopedInsufficient = [...all].some(unsoundFill);
  }

  // Apply order (height, then pos, then ordinal txid), purely for readability; resolve() re-sorts.
  const out = [...ids].map((id) => {
    const { txid, height, pos, kind } = picked.get(id)!;
    return { txid, height, pos, kind };
  }).sort((a, b) => a.height - b.height || a.pos - b.pos || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0));
  if (scopedInsufficient || compareInsufficient) {
    const caveat = scopedInsufficient
      ? "ownership was decided by a fill whose validity depends on out-of-name-scope state (a V17 open-lane claim's global claim-cap, or a name-for-token fill's buyer balance): a name-scoped replay cannot prove it; the wallet MUST fail closed (do not show verified) for this name"
      : "a name-scoped replay of this name's events reproduces a DIFFERENT record than the full chain: its validity depends on out-of-name-scope state (e.g. the proposer's global pending-reservation cap); the wallet MUST fail closed (do not show verified) for this name";
    return { name, events: out, scopedReplaySufficient: false, caveat };
  }
  return { name, events: out, scopedReplaySufficient: true };
}
