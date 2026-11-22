// The answers of /cairnx/state, /cairnx/name, /cairnx/resolve, /cairnx/name-history and /cairnx/profile as the CairnX
// resolver gives them: pure functions of one snapshot, with no environment, path, clock or network read
// (test/handlers.test.ts pins the imports), so any host answers the same bytes from the same state. The host owns the
// snapshot and its memos and writes the answer; a replica's own server decides when not to answer (read-routes.ts).
import { epochOf, resolveNameIn, type CairnXState } from "@inversealtruism/cairnx-core";
import type { NameHistory } from "./namehist.js";
import { leaseInfo } from "./nameview.js";

/** One published state and the derivations of it the host memoizes, each a function of the state it is given. */
export interface ReadSnapshot {
  state: CairnXState;
  /** canonicalState(s): the /cairnx/state bytes. */
  canonical: (s: CairnXState) => string;
  /** The name's history over the events `s` was resolved from (nameHistory, with the sufficiency compare against `s`). */
  history: (s: CairnXState, name: string) => NameHistory;
}

/** A status and the exact body text, written with the JSON headers. */
export interface ReadAnswer { status: number; body: string }

const json = (status: number, body: unknown): ReadAnswer => ({ status, body: JSON.stringify(body) });

// Forward resolution: the address a name receives at. The lookup, the refusal of a pending reservation included, is
// cairnx-core's resolveNameIn. Callers refuse a lapsed name.
const resolveName = (state: CairnXState, name: string) => resolveNameIn(state.names, name);

// A pending reservation is in state.names but is not a registered name (resolveNameIn refuses it): the 404 says so.
// The status stays 404, which is what clients read.
const nameNotFoundDetail = (state: CairnXState, name: string): string =>
  state.names[name]?.pending === true ? "name is reserved (pending finalize) - not yet registered" : "unregistered name";

export function readState({ state, canonical }: ReadSnapshot): ReadAnswer {
  return { status: 200, body: canonical(state) }; // the canonical state's bytes, without the event log
}

export function readName({ state }: ReadSnapshot, arg: string): ReadAnswer {
  // Object.hasOwn: "constructor" matches NAME_RE, and a bare state.names["constructor"] reads
  // Object.prototype.constructor, which would answer 200 for an unregistered name.
  const n = Object.hasOwn(state.names, arg) ? state.names[arg] : undefined;
  if (!n) return json(404, { ok: false, error: "unregistered name" });
  const offer = Object.values(state.offers).find((o) => o.status === "open" && "name" in o.give && o.give.name === arg);
  const tipEpoch = epochOf(state.tipHeight);
  // The current recapture reservation, if any, so a client can check it is still the winner before it pays the
  // premium at nfinalize (the reservation is not in the canonical state). Object.hasOwn for the reason above.
  const recapture = state.recaptures && Object.hasOwn(state.recaptures, arg) ? state.recaptures[arg] : null;
  return json(200, { ...n, offer: offer ?? null, recapture, tipHeight: state.tipHeight, tipEpoch, lease: leaseInfo(n, tipEpoch) });
}

export function readResolve({ state }: ReadSnapshot, arg: string): ReadAnswer {
  const r = resolveName(state, arg);
  return r ? json(200, { ok: true, ...r, tipHeight: state.tipHeight }) : json(404, { ok: false, error: nameNotFoundDetail(state, arg), name: arg });
}

export function readNameHistory({ state, history }: ReadSnapshot, arg: string): ReadAnswer {
  // The txids a wallet fetches and proves against its own headers, untrusted until it has, and the server's present
  // answer: `resolve` and `record` are what the wallet recomputes from the proven records and must match.
  const name = arg;
  const r = resolveName(state, name);
  if (!r) return json(404, { ok: false, error: nameNotFoundDetail(state, name), name });
  // The sufficiency compare runs against this snapshot's own full record, so a name whose name-scoped replay differs
  // from the full chain's is served with scopedReplaySufficient false, and a wallet fails closed on it.
  const hist = history(state, name);
  return json(200, {
    ok: true, name, tipHeight: state.tipHeight,
    resolve: r,                       // forward resolution (addr, owner, via, lapsed), which the wallet recomputes
    record: state.names[name],        // the whole NameState
    events: hist.events,
    // When false, a name-scoped replay cannot prove this name's ownership (namehist.ts); the wallet must not show it
    // as verified.
    scopedReplaySufficient: hist.scopedReplaySufficient,
    ...(hist.caveat ? { caveat: hist.caveat } : {}),
  });
}

export function readProfile({ state }: ReadSnapshot, arg: string): ReadAnswer {
  // The resolved `profile` map as shown. No send target lives in `profile` (the verified address is the nset's, at
  // /cairnx/resolve); the nprofile txids are in /cairnx/name-history for a client to prove. Empty {} when unset.
  const name = arg;
  const n = Object.hasOwn(state.names, name) ? state.names[name] : undefined;   // "constructor": as in readName
  if (!n) return json(404, { ok: false, error: "unregistered name", name });
  return json(200, { ok: true, name, owner: n.owner, profile: n.profile ?? {}, tipHeight: state.tipHeight });
}
