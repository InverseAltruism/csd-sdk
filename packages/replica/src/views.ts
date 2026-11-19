// The values a reader reads from a resolved state. Each is a lookup in cairnx-core's state or a call of its own
// selector; none restates a rule of the convention.
import { pickPrimaryName, type CairnXState } from "@inversealtruism/cairnx-core";

/** A token balance; an address the state does not list holds none. */
export function balanceOf(s: CairnXState, ticker: string, address: string) {
  const b = s.balances[ticker]?.[address];
  return { deployId: s.tokens[ticker]?.deployId ?? null, available: b?.available ?? "0", locked: b?.locked ?? "0" };
}

/** The primary name of an address, cairnx-core's pickPrimaryName. */
export const primaryOf = (s: CairnXState, address: string): string | null => pickPrimaryName(Object.values(s.names), address);
