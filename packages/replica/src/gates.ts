// The gate tables a reader compares (design sections 1 and 4): cairnx-core is a peer dependency and exports no
// version, so a process can load another core than the one this package was built against, or two cores. A table is
// every `ACTIVATION_HEIGHT` and `V<n>_HEIGHT` export of a core module; two tables differ when they differ in any gate
// at or below the tip.
import * as loaded from "@inversealtruism/cairnx-core";

export type Gates = Readonly<Record<string, number>>;
export type CoreModule = typeof import("@inversealtruism/cairnx-core");

/** The gate table this package was built and tested against. test/reader.test.ts keeps it equal to the workspace
 *  cairnx-core's, so at run time it differs from the loaded core's only when another cairnx-core is installed; a core
 *  with a new gate then answers RULES_DIFFER from that gate's height until this package is rebuilt against it. */
export const BUILT_GATES: Gates = Object.freeze({
  ACTIVATION_HEIGHT: 29_860, V11_HEIGHT: 29_960, V12_HEIGHT: 30_300, V13_HEIGHT: 31_100, V14_HEIGHT: 31_400,
  V15_HEIGHT: 32_000, V16_HEIGHT: 33_600, V17_HEIGHT: 34_000, V18_HEIGHT: 40_000, V19_HEIGHT: 36_700,
  V20_HEIGHT: 38_400, V21_HEIGHT: 40_100, V22_HEIGHT: 41_300, V23_HEIGHT: 52_000, V24_HEIGHT: 46_400,
  V25_HEIGHT: 46_440, V26_HEIGHT: 46_480, V27_HEIGHT: 46_520, V28_HEIGHT: 60_000, V29_HEIGHT: 88_000,
});

const GATE = /^(ACTIVATION|V[0-9]+)_HEIGHT$/;
/** The gate table of a core module (or of any object of gate names and heights). */
export function gatesOf(core: object): Gates {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(core)) if (GATE.test(k) && typeof v === "number") out[k] = v;
  return out;
}

/** Whether `a` and `b` differ in a gate at or below `tip`: one lacks a gate the other has there, or they place it at
 *  different heights at least one of which is at or below `tip`. */
export function gatesDiffer(a: Gates, b: Gates, tip: number): boolean {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (x !== y && ((x !== undefined && x <= tip) || (y !== undefined && y <= tip))) return true;
  }
  return false;
}

/** The tables open() holds: the loaded core's, the built one and a caller's core when its `resolve` is not the
 *  loaded one's. `two` is that case with the same table as the loaded core's (the note TWO_CORES). */
export function coreCheck(core: CoreModule | undefined, built: Gates = BUILT_GATES, mine: object = loaded) {
  const tables = [built, ...(core !== undefined && core.resolve !== (mine as CoreModule).resolve ? [gatesOf(core)] : [])];
  const own = gatesOf(mine);
  return {
    own,
    differ: (tip: number) => tables.some((t) => gatesDiffer(t, own, tip)),
    two: tables.length > 1 && !gatesDiffer(tables[1]!, own, Number.POSITIVE_INFINITY),
  };
}
