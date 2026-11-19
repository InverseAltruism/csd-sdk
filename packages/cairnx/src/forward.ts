// Forward resolution (CONVENTION §35.4): the address a payment to a name goes to, and the view of a name a reader shows.
// Neither writes state. Both read only `names` of a resolve() result, so the tip enters through the `expired` flag that
// resolve() computes at the tip's epoch; a caller that needs another tip replays at it. Reverse resolution is
// pickPrimaryName (primary.ts).
import { NAME_RE, RESERVED_NAMES, type NameState } from "./types.js";

/** Where a payment to `name` goes: its `nset` address, else its owner. `lapsed` is the name's `expired` (§17): the
 *  address is the record's, and a sender refuses it. */
export interface ResolvedName { name: string; addr: string; via: "nset" | "owner"; lapsed: boolean; owner: string }

/** The address `name` receives at in `names`, or null when `names` holds no such own key or holds a pending reservation
 *  (§28), which confers no address. The key is looked up as given: a caller normalizes its input first. */
export function resolveNameIn(names: Record<string, NameState>, name: string): ResolvedName | null {
  // An own-key test, not `names[name]`: `names` is a plain object and `constructor` matches NAME_RE, so a bare index
  // on an unregistered `constructor` reads Object.prototype.constructor.
  if (!Object.hasOwn(names, name)) return null;
  const n = names[name];
  if (!n) return null;
  if (n.pending) return null;
  return { name, addr: n.addr ?? n.owner, via: n.addr ? "nset" : "owner", lapsed: n.expired === true, owner: n.owner };
}

/** The classes of `nameView`: `free` is a name absent from `names`; `reserved` one in RESERVED_NAMES, whose record does
 *  not parse (§9), so it is never in `names`. */
export type NameViewState = "held" | "pending" | "lapsed" | "free" | "reserved";

/** A name as a reader shows it. `addr` and `profile` are a held name's only: a pending or lapsed name gives no address,
 *  and its profile is not the word of a current owner (§35.3). `owner` is the reserver of a pending name and the last
 *  owner of a lapsed one. `paidThroughEpoch` is null where the state carries none (a pending name, a tip below V15). */
export interface NameView {
  name: string; state: NameViewState; owner: string | null; addr: string | null;
  profile: Record<string, string>; paidThroughEpoch: number | null;
}

/** The view of `name` in `names`, or null when `name` does not match NAME_RE. Built on resolveNameIn: a held name's
 *  `addr` is its address. */
export function nameView(names: Record<string, NameState>, name: string): NameView | null {
  if (typeof name !== "string" || !NAME_RE.test(name)) return null;
  const none = { owner: null, addr: null, profile: {}, paidThroughEpoch: null };
  if (RESERVED_NAMES.has(name)) return { name, state: "reserved", ...none };
  const n = Object.hasOwn(names, name) ? names[name] : undefined;
  if (!n) return { name, state: "free", ...none };
  const r = resolveNameIn(names, name);   // null for a present name only when it is a pending reservation
  if (r === null) return { name, state: "pending", ...none, owner: n.owner };
  const paidThroughEpoch = n.paidThroughEpoch ?? null;
  if (r.lapsed) return { name, state: "lapsed", ...none, owner: n.owner, paidThroughEpoch };
  return { name, state: "held", owner: n.owner, addr: r.addr, profile: { ...n.profile }, paidThroughEpoch };
}
