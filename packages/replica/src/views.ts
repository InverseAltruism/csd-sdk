// The values a reader reads from a resolved state. Each is a lookup in cairnx-core's state or a call of its own
// selector; none restates a rule of the convention. `./display` reads the same values from a served state.
import { ADDR_RE, nameView, pickPrimaryName, type CairnXState, type NameView } from "@inversealtruism/cairnx-core";

/** `a` in lower case when it is an address, else null. */
export const addressOf = (a: unknown): string | null => (typeof a === "string" && ADDR_RE.test(a.toLowerCase()) ? a.toLowerCase() : null);

/** A token balance; an address the state does not list holds none. */
export function balanceOf(s: { readonly tokens: Readonly<Record<string, { readonly deployId: string }>>; readonly balances: CairnXState["balances"] }, ticker: string, address: string) {
  const b = s.balances[ticker]?.[address];
  return { deployId: s.tokens[ticker]?.deployId ?? null, available: b?.available ?? "0", locked: b?.locked ?? "0" };
}

/** The primary name of an address, cairnx-core's pickPrimaryName. */
export const primaryOf = (s: CairnXState, address: string): string | null => pickPrimaryName(Object.values(s.names), address);

/** A name as cairnx-core's nameView shows it (CONVENTION section 35.4): its class, owner, address and profile; null for
 *  a string that does not match NAME_RE. */
export const nameOf = (s: Pick<CairnXState, "names">, name: string): NameView | null => nameView(s.names, name);
